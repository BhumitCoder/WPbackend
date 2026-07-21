import P from "pino";
import QRCode from "qrcode";
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { useFirestoreAuthState, clearSession } from "./firestoreAuthState.js";

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
};

// Sending immediately after the socket has just (re)connected — the most
// common trigger being Render's free tier spinning the whole process back up
// from a cold start after 15+ minutes idle — hands the message to Baileys
// successfully (so our /send reports ok:true) before WhatsApp's own delivery
// pipeline has finished resyncing this session, and the recipient's client
// can sit on "Waiting for this message" for a long time as a result. A short
// grace period after reconnecting, before this process will actually send
// anything, gives that resync a chance to finish first. This does not fully
// eliminate the problem (WhatsApp's delivery infra is outside this process'
// control either way) — the real fix is not letting the service go to sleep
// in the first place (see README: external uptime ping on /health).
const POST_CONNECT_GRACE_MS = 6000;

// Sent-message delivery tracking — purely observational (nothing here
// retries or blocks anything) so a stuck delivery shows up in the logs
// pointing at WhatsApp-side congestion rather than looking like a silent,
// unexplained failure the next time this comes up.
const pendingAcks = new Map(); // messageId -> { to: string, sentAt: number, status: number }
const PENDING_ACK_WARN_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function phoneFromJid(jid) {
  if (!jid) return null;
  return jid.split("@")[0].split(":")[0];
}

// Set while our own disconnect() is driving a logout, so the
// connection.update handler below doesn't ALSO race to clear the session
// and restart — disconnect() already does both, in order.
let manualDisconnectInFlight = false;

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
  const { state: authState, saveCreds } = await useFirestoreAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: authState,
    version,
    logger: P({ level: "silent" }),
  });
  state.sock = sock;

  sock.ev.on("creds.update", () => {
    saveCreds().catch((err) => console.error("[whatsapp] saveCreds failed:", err));
  });

  sock.ev.on("connection.update", async (update) => {
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
      console.log("[whatsapp] connected:", state.phone);
    }

    if (connection === "close") {
      state.status = "disconnected";
      state.phone = null;
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      console.log("[whatsapp] connection closed — logged out:", loggedOut);
      // Any other close reason (network blip, server restart) is expected to
      // reconnect using the saved session, same as WhatsApp Web reconnecting
      // in a browser tab. Logged-out is the only case needing a fresh QR —
      // manualDisconnect already handles that case itself (see below), so
      // this only needs to cover the *unexpected* logged-out event (e.g. the
      // shop owner removes the linked device from their phone directly).
      if (manualDisconnectInFlight) {
        // disconnect() below already owns clearSession + restart for this case.
      } else if (!loggedOut) {
        start();
      } else {
        // The phone's own "Linked Devices > Remove" was used, bypassing our
        // /disconnect route — stale creds are now invalid, so wipe them and
        // reconnect fresh so the Settings page has a new QR ready to go.
        clearSession()
          .catch((err) => console.error("[whatsapp] clearSession failed:", err))
          .finally(() => start());
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const entry = {
        from: msg.key.remoteJid,
        text: extractText(msg.message),
        timestamp: Number(msg.messageTimestamp) * 1000,
      };
      state.receivedMessages.push(entry);
      if (state.receivedMessages.length > 500) state.receivedMessages.shift();
      console.log("[whatsapp] incoming:", entry.from, entry.text);
    }
  });

  // Observational only — Baileys resolves sendMessage() as soon as it hands
  // the message to its own socket, not once WhatsApp actually delivers it.
  // This is what actually reports whether a send made it out for real, so a
  // stuck delivery shows up here (pointing at WhatsApp-side congestion, most
  // often right after a cold reconnect) instead of looking like our own code
  // silently failed.
  sock.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      const tracked = pendingAcks.get(key.id);
      if (!tracked) continue;
      if (typeof update.status === "number") tracked.status = update.status;
      // status >= 2 is Baileys' SERVER_ACK or later — WhatsApp's servers
      // have it, delivery is now out of this process' hands either way.
      if (tracked.status >= 2) {
        pendingAcks.delete(key.id);
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
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        console.error("[whatsapp] logout failed (clearing session anyway):", err);
      }
    }
    await clearSession();
    await start();
  } finally {
    manualDisconnectInFlight = false;
  }
}

function trackDelivery(sent, jid) {
  if (!sent?.key?.id) return;
  const entry = { to: jid, sentAt: Date.now(), status: 0 };
  pendingAcks.set(sent.key.id, entry);
  setTimeout(() => {
    const tracked = pendingAcks.get(sent.key.id);
    if (!tracked) return; // already acknowledged — nothing to warn about
    console.warn(
      `[whatsapp] message to ${jid} still not acknowledged by WhatsApp ${PENDING_ACK_WARN_MS / 1000}s ` +
        "after sending — this is WhatsApp-side delivery congestion (common right after this service " +
        "wakes from being idle), not a failure in the send call itself.",
    );
  }, PENDING_ACK_WARN_MS);
}

export async function sendMessage({ phone, message, pdfBase64, fileName }) {
  if (state.status !== "connected") {
    const err = new Error("WhatsApp not connected — scan the QR code first");
    err.code = "NOT_CONNECTED";
    throw err;
  }

  // Just reconnected (e.g. Render's free tier waking this process back up
  // from a cold start) — give WhatsApp's own session resync a moment before
  // handing it anything to deliver. See POST_CONNECT_GRACE_MS above.
  const sinceConnect = Date.now() - (state.connectedAt ?? 0);
  if (sinceConnect < POST_CONNECT_GRACE_MS) {
    await sleep(POST_CONNECT_GRACE_MS - sinceConnect);
  }

  const jid = toJid(phone);

  if (pdfBase64) {
    const sent = await state.sock.sendMessage(jid, {
      document: Buffer.from(pdfBase64, "base64"),
      mimetype: "application/pdf",
      fileName: fileName || "document.pdf",
      caption: message || "",
    });
    trackDelivery(sent, jid);
    return;
  }
  if (message) {
    const sent = await state.sock.sendMessage(jid, { text: message });
    trackDelivery(sent, jid);
    return;
  }
  const err = new Error("Provide `message` and/or `pdfBase64`");
  err.code = "BAD_REQUEST";
  throw err;
}
