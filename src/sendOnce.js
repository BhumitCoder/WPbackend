/**
 * Sending a bill once, even when the same bill is asked for twice.
 *
 * The app already mints a stable `clientMessageId` per bill and resends it on
 * every retry — its outbox is built around the promise that a retry is safe.
 * This service ignored that field completely, so the promise was not kept: a
 * send whose HTTP reply was lost (a timeout, a sleeping host, a 502) was
 * retried and the customer got their invoice twice.
 *
 * The claim lives in Firestore rather than in memory because the process this
 * runs in restarts constantly — a free host sleeps it, a redeploy replaces it —
 * and an in-memory guard forgets exactly the sends it was there to remember.
 *
 * `create()` is the whole mechanism: Firestore fails it if the document
 * already exists, atomically, so two requests racing for the same id cannot
 * both win.
 */

/** A claim still marked "sending" after this is assumed to belong to a process
 *  that died mid-send. Generous: the alternative to waiting is a duplicate. */
export const CLAIM_STALE_MS = 5 * 60 * 1000;

/** Claims are kept this long so a late retry is still recognised, then become
 *  eligible for deletion. Set a Firestore TTL policy on `expiresAt` to have
 *  that happen without anyone remembering to do it. */
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const COLLECTION = "waSendClaims";

/**
 * @returns {Promise<{state: "claimed"|"done"|"in-flight", claimedAt?: number, result?: object}>}
 *
 * - `claimed`   this caller owns the send and must finish or release it.
 * - `done`      it already went out. Do not send it again; tell the caller so.
 * - `in-flight` someone else is sending it right now. Neither send nor claim.
 */
export async function claimSend(db, id, now = Date.now()) {
  const ref = db.collection(COLLECTION).doc(id);
  try {
    await ref.create({
      state: "sending",
      startedAt: now,
      expiresAt: new Date(now + CLAIM_TTL_MS),
    });
    return { state: "claimed" };
  } catch (err) {
    // ALREADY_EXISTS (6) is the normal outcome of a retry, not a fault.
    if (err?.code !== 6) throw err;
  }

  const snap = await ref.get();
  const claim = snap.exists ? snap.data() : null;
  if (!claim) {
    // Deleted between the create and the read — treat as ours to try again.
    return { state: "claimed" };
  }
  if (claim.state === "sent") {
    return { state: "done", result: claim.result ?? null, claimedAt: claim.startedAt };
  }
  if (now - (claim.startedAt ?? 0) < CLAIM_STALE_MS) {
    return { state: "in-flight", claimedAt: claim.startedAt };
  }
  /* Stale: the process that claimed it is gone. Taking it over risks a
     duplicate, and refusing forever guarantees a bill that never sends. Five
     minutes is long enough that a live send has finished or the process that
     owned it is not coming back. */
  await ref.set(
    { state: "sending", startedAt: now, takenOverFrom: claim.startedAt ?? null },
    { merge: true },
  );
  return { state: "claimed" };
}

/** It went out. Recorded so a later retry of the same bill is answered, not resent. */
export async function completeSend(db, id, result, now = Date.now()) {
  await db
    .collection(COLLECTION)
    .doc(id)
    .set(
      { state: "sent", finishedAt: now, result: result ?? null, expiresAt: new Date(now + CLAIM_TTL_MS) },
      { merge: true },
    );
}

/** It did not go out. The claim is dropped so a retry is a real attempt and
 *  not a false "already sent" — the failure mode that would silently stop a
 *  bill ever reaching anyone. */
export async function releaseSend(db, id) {
  await db.collection(COLLECTION).doc(id).delete();
}
