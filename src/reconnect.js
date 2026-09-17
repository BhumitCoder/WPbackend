/**
 * What to do when the socket closes.
 *
 * This used to be one line — reconnect unless we were logged out, immediately,
 * forever — and that line is the reason bills arrive as "Waiting for this
 * message". Two failures hide in it.
 *
 * **Reconnecting on 440 (connectionReplaced) is the ping-pong.** 440 means
 * another socket has taken this session over. Reconnecting takes it back, which
 * closes the other one with a 440, which takes it back... Both sockets stay
 * half-alive, WhatsApp does not know which one to deliver through, and the
 * recipient's client sits on a message it can see but cannot fetch. A session
 * that has been replaced must stop and say so.
 *
 * **Reconnecting with no delay is how a blip becomes a ban.** A service that
 * cannot connect and retries in a tight loop looks exactly like an attack.
 *
 * Pure, and separate from the socket, because every branch below is a rule
 * about somebody's business account that ought to be checkable without a
 * WhatsApp connection to break.
 */

/** Baileys' DisconnectReason, spelled out so this file needs no import to be
 *  read — and so a test does not have to boot the library to check a rule. */
export const REASON = {
  loggedOut: 401,
  forbidden: 403,
  timedOut: 408,
  multideviceMismatch: 411,
  connectionClosed: 428,
  connectionReplaced: 440,
  badSession: 500,
  unavailableService: 503,
  restartRequired: 515,
};

const BASE_MS = 2000;
const MAX_MS = 60000;

/**
 * How long to wait before attempt number `attempts` (0 = the first retry).
 *
 * Doubling from 2s to a one-minute ceiling. The ceiling matters more than the
 * curve: a service left disconnected overnight must still be trying in the
 * morning, and must not have spent the night hammering WhatsApp to get there.
 */
export function backoffMs(attempts) {
  const n = Math.max(0, Math.floor(attempts));
  return Math.min(BASE_MS * 2 ** n, MAX_MS);
}

/**
 * @param {number|undefined} statusCode  from lastDisconnect.error.output.statusCode
 * @param {number} attempts  consecutive failures so far
 * @returns {{action: "reconnect"|"reset-session"|"stop", delayMs: number, reason: string}}
 *
 * - `reconnect`    keep the saved session and dial again.
 * - `reset-session` the session is no longer valid: wipe it so a fresh QR can
 *                   be scanned. Never done for a transport-level failure —
 *                   wiping a good session because the WiFi dropped costs the
 *                   shop a trip to the owner's phone.
 * - `stop`         do nothing until a person acts. The rarest, and the one the
 *                  old code never had.
 */
export function reconnectPlan(statusCode, attempts = 0) {
  const delayMs = backoffMs(attempts);

  switch (statusCode) {
    /* Someone removed this device in WhatsApp > Linked Devices, or WhatsApp
       invalidated it. The creds are dead; only a new scan fixes it. */
    case REASON.loggedOut:
      return { action: "reset-session", delayMs: 0, reason: "logged out — a new QR scan is needed" };

    /* The session is corrupt or was never completed properly. Same remedy,
       and retrying the old creds just reproduces it. */
    case REASON.badSession:
      return { action: "reset-session", delayMs: 0, reason: "the saved session is not usable" };
    case REASON.multideviceMismatch:
      return {
        action: "reset-session",
        delayMs: 0,
        reason: "multi-device mismatch — the session must be linked again",
      };

    /* Another socket owns this session now. Taking it back starts the
       ping-pong that leaves recipients on "Waiting for this message" — so
       this is the one case that stops and waits for a person. Two copies of
       this service running against one number is the usual cause. */
    case REASON.connectionReplaced:
      return {
        action: "stop",
        delayMs: 0,
        reason:
          "this session was taken over by another connection — something else is signed in as " +
          "this number. Reconnecting here would fight it for the session and messages would " +
          "stop being delivered. Stop the other instance, then restart this one.",
      };

    /* WhatsApp is refusing this account outright. Retrying cannot help and
       may make it worse. */
    case REASON.forbidden:
      return {
        action: "stop",
        delayMs: 0,
        reason: "WhatsApp refused this account (403) — it needs attention on the phone itself",
      };

    /* The normal handshake step right after pairing. Immediate, on purpose:
       backing off here just makes linking feel broken. */
    case REASON.restartRequired:
      return { action: "reconnect", delayMs: 0, reason: "restart required after pairing" };

    /* Everything else — dropped connection, timeout, WhatsApp having a
       moment, or no status code at all — is a transport problem. Keep the
       session and dial again, slower each time. */
    default:
      return {
        action: "reconnect",
        delayMs,
        reason: statusCode ? `connection closed (${statusCode})` : "connection closed",
      };
  }
}
