import P from "pino";
import QRCode from "qrcode";
import makeWASocket, { fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { useFirestoreAuthState, clearSession } from "./firestoreAuthState.js";
import { DATABASE_ID, getProjectId, getDb } from "./firebaseAdmin.js";
import { reconnectPlan } from "./reconnect.js";
import { claimSend, completeSend, releaseSend } from "./sendOnce.js";

// receivedMessages is in-memory only (fine — it's a rolling recent-activity
// log, not the source of truth). The WhatsApp session itself (creds.json +
// keys) lives in Firestore via useFirestoreAuthState, so it survives a host
// restart/redeploy with no local disk involved at all.
export const state = {
  sock: null,
  status: "disconnected", // "disconnected" | "qr" | "connected"
  qrDataUrl: null,
  phone: null, // e.g. "919978581685" once connected
  receivedMessages: [],
  connectedAt: null,
  // Why the service is not connected, in words, when there is a reason worth
  // reporting. /health returns it, so the shop can see the cause without
  // anyone reading a host's log.
  lastError: null,
  // Set when reconnecting on our own would make things worse — a session
  // taken over by another connection, or an account WhatsApp is refusing.
  // Nothing clears this but a person.
  halted: false,
};

// Sending immediately after the socket has just (re)connected hands the
// message to Baileys successfully before WhatsApp's own delivery pipeline has
// finished resyncing this session, and the recipient's client can sit on
// "Waiting for this message" as a result. A short grace period gives that
// resync a chance to finish first.
const POST_CONNECT_GRACE_MS = 6000;

/**
 * How long a send waits for WhatsApp's servers to acknowledge it.
 *
 * Baileys resolves sendMessage() the moment it hands the bytes to its own
 * socket — which is not delivery, and reporting it as success is why a bill
 * could be marked sent while the customer saw "Waiting for this message". The
 * server ack is the first point at which WhatsApp, not this process, owns the
 * message. Waiting for it makes /send slower and honest; the alternative is
 * fast and wrong.
 */
const ACK_WAIT_MS = 15000;

/** messageId -> resolve, for sends currently waiting on an ack. */
const ackWaiters = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function phoneFromJid(jid) {
  if (!jid) return null;
  return jid.split("@")[0].split(":")[0];
}

/**
 * Say what actually went wrong, in a sentence somebody can act on.
 *
 * The failure this was written for printed sixty lines of gRPC and
 * OpenTelemetry stack frames and one useful token: `code: 5`. Firestore
 * returns NOT_FOUND for a missing DATABASE, never for a missing document — a
 * document that isn't there comes back as `exists: false`. So code 5 on the
 * first read means the named database this service is pointed at does not
 * exist in the project whose service account it was given, and the two were
 * almost certainly taken from different shops.
 */
export function describeFailure(err) {
  if (err?.code === 5) {
    const project = getProjectId();
    return (
      `Firestore has no database named "${DATABASE_ID}"` +
      (project ? ` in project "${project}"` : "") +
      ". The database name and the service account must belong to the same shop — " +
      "set FIRESTORE_DATABASE_ID to this project's database, or supply the service " +
      "account for the project that owns that database."
    );
  }
  if (err?.code === 7 || err?.code === 16) {
    return (
      `Firestore refused the service account (code ${err.code}). Check it has not been ` +
      `revoked and that it is allowed to reach the database "${DATABASE_ID}".`
    );
  }
  return err?.message || String(err);
}

/* Bringing the socket up depends on two things outside this process —
   Firestore for the saved session, and WhatsApp for the protocol version — and
   either can be down or misconfigured. Before this, a failure in start() was an
   unhandled rejection, which Node turns into an exit, which the host turns into
   a restart, which fails identically: the service crash-looped and the reason
   scrolled past inside a stack trace. Now it backs off and keeps the HTTP
   server up, so /health can say why. */
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;
let retryAttempt = 0;
let startInFlight = false;

/**
 * Which socket is the current one.
 *
 * Every socket captures the generation it was born into and checks it before
 * touching shared state. Without this, a socket that is closing can still be
 * delivering events while its replacement is connecting, and the older one's
 * "close" wipes the newer one's "connected" — the service reports itself
 * disconnected while a perfectly good socket is attached, and every send is
 * refused by a check on a status that is simply out of date.
 */
let generation = 0;

/** Consecutive close-driven reconnects, for the backoff. Reset on a real connection. */
let closeAttempts = 0;

/** Set while our own disconnect() is driving a logout, so the connection.update
 *  handler doesn't ALSO race to clear the session and restart — disconnect()
 *  already does both, in order. */
let manualDisconnectInFlight = false;

/**
 * Detach and close a socket for good.
 *
 * The old code replaced state.sock and walked away. The previous socket kept
 * its listeners, kept its keep-alive timer, and kept its claim on the session —
 * so a few reconnects in, several sockets were live on one WhatsApp account,
 * each one's existence closing the others with `connectionReplaced`. That is
 * the ping-pong the shop sees as "Waiting for this message".
 */
function teardown(sock) {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("messages.upsert");
    sock.ev.removeAllListeners("messages.update");
  } catch {
    /* an already-dead emitter is exactly what we wanted */
  }
  try {
    sock.end(undefined);
  } catch {
    /* ditto */
  }
}

/** The only way this module should be started or restarted. */
export function startSafely(reason = "startup") {
  if (startInFlight) return;
  if (state.halted) {
    console.error(`[whatsapp] not starting (${reason}) — halted: ${state.lastError}`);
    return;
  }
  startInFlight = true;
  start()
    .then(() => {
      retryAttempt = 0;
      state.lastError = null;
    })
    .catch((err) => {
      state.lastError = describeFailure(err);
      const wait = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_MAX_MS);
      retryAttempt += 1;
      console.error(`[whatsapp] could not start (${reason}): ${state.lastError}`);
      console.error(`[whatsapp] retrying in ${Math.round(wait / 1000)}s (attempt ${retryAttempt})`);
      setTimeout(() => startSafely("retry"), wait).unref?.();
    })
    .finally(() => {
      startInFlight = false;
    });
}

export function toJid(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function extractText(message) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

export async function start() {
  // Whatever was attached before this point is no longer the current socket,
  // whether it knows it or not.
  teardown(state.sock);
  state.sock = null;
  const myGeneration = ++generation;

  const { state: authState, saveCreds } = await useFirestoreAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: authState,
    version,
    logger: P({ level: "silent" }),
    /* Baileys marks the account "online" by default, and WhatsApp stops
       sending push notifications to a phone whose account is already online
       somewhere. So the shop owner quietly stops being notified of their own
       customers' messages the moment this service connects, and blames the
       app. This service sends bills; it does not need to appear online. */
    markOnlineOnConnect: false,
  });
  state.sock = sock;

  /** Anything from a socket that has been replaced is history, not news. */
  const current = () => myGeneration === generation;

  sock.ev.on("creds.update", () => {
    saveCreds().catch((err) => console.error("[whatsapp] saveCreds failed:", err));
  });

  sock.ev.on("connection.update", async (update) => {
    if (!current()) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.qrDataUrl = await QRCode.toDataURL(qr);
      state.status = "qr";
    }

    if (connection === "open") {
      state.status = "connected";
      state.qrDataUrl = null;
      state.phone = phoneFromJid(sock.user?.id);
      state.connectedAt = Date.now();
      state.lastError = null;
      closeAttempts = 0;
      console.log("[whatsapp] connected:", state.phone);
    }

    if (connection === "close") {
      state.status = "disconnected";
      state.phone = null;
      teardown(sock);
      if (state.sock === sock) state.sock = null;

      // disconnect() owns clearSession + restart for a logout it asked for.
      if (manualDisconnectInFlight) return;

      const code = lastDisconnect?.error?.output?.statusCode;
      const plan = reconnectPlan(code, closeAttempts);
      console.log(`[whatsapp] connection closed — ${plan.reason} -> ${plan.action}`);

      if (plan.action === "stop") {
        state.halted = true;
        state.lastError = plan.reason;
        return;
      }

      closeAttempts += 1;

      if (plan.action === "reset-session") {
        clearSession()
          .catch((err) => console.error("[whatsapp] clearSession failed:", err))
          .finally(() => startSafely("reset-session"));
        return;
      }

      setTimeout(() => startSafely("reconnect"), plan.delayMs).unref?.();
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (!current() || type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const entry = {
        from: msg.key.remoteJid,
        text: extractText(msg.message),
        timestamp: Number(msg.messageTimestamp) * 1000,
      };
      state.receivedMessages.push(entry);
      if (state.receivedMessages.length > 500) state.receivedMessages.shift();
      /* Deliberately NOT logging the number or the text. These are the shop's
         customers writing to the shop, and a hosting provider's log viewer is
         not a place that conversation belongs. The count is enough to know the
         receive side is alive. */
      console.log(`[whatsapp] incoming message (${state.receivedMessages.length} held)`);
    }
  });

  /* The ack is what a send actually waits on — see ACK_WAIT_MS. Baileys
     resolves sendMessage() when it hands the bytes to its socket; status >= 2
     is SERVER_ACK, the first point at which WhatsApp's servers have it and
     delivery is out of this process' hands. */
  sock.ev.on("messages.update", (updates) => {
    if (!current()) return;
    for (const { key, update } of updates) {
      const waiter = ackWaiters.get(key.id);
      if (!waiter) continue;
      if (typeof update.status === "number" && update.status >= 2) {
        ackWaiters.delete(key.id);
        waiter(update.status);
      }
    }
  });
}

/** Owner-initiated disconnect from the AIM Settings page — a real WhatsApp
 * logout (removes this device from the phone's own Linked Devices list),
 * not just forgetting the local session, so it can't silently keep
 * receiving/sending after the owner thinks it's off. */
export async function disconnect() {
  manualDisconnectInFlight = true;
  const sock = state.sock;
  state.sock = null;
  state.status = "disconnected";
  state.phone = null;
  state.qrDataUrl = null;
  // A deliberate disconnect is also the way out of a halt: the person has
  // acted, which is exactly what a halt was waiting for.
  state.halted = false;
  state.lastError = null;
  closeAttempts = 0;
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        console.error("[whatsapp] logout failed (clearing session anyway):", err.message);
      }
      teardown(sock);
    }
    await clearSession();
    // Best effort, and deliberately not awaited: the logout itself has already
    // succeeded by here, and if bringing a fresh socket up fails then the retry
    // loop is the right place for that — not a 500 on a request that did its job.
    startSafely("after-disconnect");
  } finally {
    manualDisconnectInFlight = false;
  }
}

/** Resolves with the ack status, or null if WhatsApp did not acknowledge in time. */
function waitForAck(messageId) {
  if (!messageId) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(messageId);
      resolve(null);
    }, ACK_WAIT_MS);
    timer.unref?.();
    ackWaiters.set(messageId, (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * @returns {Promise<{deduped: boolean, acknowledged: boolean, messageId: string|null}>}
 */
export async function sendMessage({ phone, message, pdfBase64, fileName, clientMessageId }) {
  if (!pdfBase64 && !message) throw fail("Provide `message` and/or `pdfBase64`", "BAD_REQUEST");
  if (state.status !== "connected") {
    throw fail(
      state.halted
        ? `WhatsApp is not connected — ${state.lastError}`
        : "WhatsApp not connected — scan the QR code first",
      "NOT_CONNECTED",
    );
  }

  /* Claimed BEFORE the grace sleep and before the send. The window this closes
     is a retry arriving while the first attempt is still in the sleep below —
     which is exactly when a slow send gets retried. */
  let db = null;
  if (clientMessageId) {
    db = getDb();
    const claim = await claimSend(db, clientMessageId);
    if (claim.state === "done") {
      return { deduped: true, acknowledged: true, messageId: claim.result?.messageId ?? null };
    }
    if (claim.state === "in-flight") {
      throw fail(
        "This message is already being sent — wait for that attempt to finish",
        "IN_FLIGHT",
      );
    }
  }

  try {
    // Just reconnected — give WhatsApp's own session resync a moment before
    // handing it anything to deliver. See POST_CONNECT_GRACE_MS.
    const sinceConnect = Date.now() - (state.connectedAt ?? 0);
    if (sinceConnect < POST_CONNECT_GRACE_MS) {
      await sleep(POST_CONNECT_GRACE_MS - sinceConnect);
    }

    const jid = toJid(phone);

    /* A number that is not on WhatsApp accepts a send and delivers nothing — a
       black hole that looks exactly like success. Shops keep landlines and
       mistyped numbers in their party records, so this is not rare. Asked once,
       here, so the answer is a sentence the counter can act on. */
    const [known] = (await state.sock.onWhatsApp(jid)) ?? [];
    if (!known?.exists) {
      throw fail(
        `${phone} is not on WhatsApp — check the number saved for this party`,
        "NOT_ON_WHATSAPP",
      );
    }

    const content = pdfBase64
      ? {
          document: Buffer.from(pdfBase64, "base64"),
          mimetype: "application/pdf",
          fileName: fileName || "document.pdf",
          caption: message || "",
        }
      : { text: message };

    const sent = await state.sock.sendMessage(known.jid ?? jid, content);
    const messageId = sent?.key?.id ?? null;
    const ack = await waitForAck(messageId);

    if (ack === null) {
      console.warn(
        `[whatsapp] no acknowledgement from WhatsApp within ${ACK_WAIT_MS / 1000}s — the message ` +
          "was handed over but WhatsApp has not confirmed receiving it",
      );
    }

    if (db && clientMessageId) {
      await completeSend(db, clientMessageId, { messageId, ack });
    }
    return { deduped: false, acknowledged: ack !== null, messageId };
  } catch (err) {
    /* The claim must go when the send does not, or this bill can never be sent
       again — a dedupe that outlives its send is worse than no dedupe. */
    if (db && clientMessageId) {
      await releaseSend(db, clientMessageId).catch((e) =>
        console.error("[whatsapp] could not release the send claim:", e.message),
      );
    }
    throw err;
  }
}
