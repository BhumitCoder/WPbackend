/**
 * The rules this service is held to, checked without a WhatsApp connection.
 *
 * Everything here was a production symptom first: a crash-loop whose entire
 * diagnosis was `code: 5`, invoices arriving twice, and recipients left on
 * "Waiting for this message" while the shop was told the bill had sent.
 *
 * Run: npm test
 */
import { describeFailure } from "../src/whatsapp.js";
import { reconnectPlan, backoffMs, REASON } from "../src/reconnect.js";
import { claimSend, completeSend, releaseSend, CLAIM_STALE_MS } from "../src/sendOnce.js";
import { jsonForScript } from "../src/escapeForScript.js";

let passed = 0;
const failures = [];
function assert(ok, what) {
  if (ok) passed += 1;
  else failures.push(what);
}

/* ══════ Why it would not start ══════════════════════════════════════════
   Firestore answers a read for a document that isn't there with
   `exists: false`, not an error. So NOT_FOUND on the very first read can only
   mean the named database this service is pointed at does not exist in the
   project whose service account it was handed — which is what happened: the
   database name belonged to one shop and the key to another. */
{
  const msg = describeFailure({ code: 5, message: "5 NOT_FOUND: " });
  assert(msg.includes("omimpex"), "names the database it was looking for");
  assert(/FIRESTORE_DATABASE_ID/.test(msg), "names the setting that changes it");
  assert(/service account/i.test(msg), "and says the key may be the wrong half instead");
  assert(
    !/NOT_FOUND|grpc|code 5/i.test(msg),
    "without making the reader decode gRPC to get there — got: " + msg,
  );

  for (const code of [7, 16]) {
    const m = describeFailure({ code, message: "denied" });
    assert(/refused/i.test(m), `code ${code} reads as a refusal`);
    assert(!/has no database/i.test(m), `code ${code} is not reported as a missing database`);
  }

  assert(
    describeFailure(new Error("socket hang up")) === "socket hang up",
    "an unrecognised failure is passed through unchanged",
  );
  assert(typeof describeFailure(undefined) === "string", "and nothing throws on an empty failure");
}

/* ══════ What to do when the socket closes ═══════════════════════════════ */
{
  /* THE one that matters. 440 means another socket has taken this session
     over. Reconnecting takes it back, which closes the other with a 440,
     which takes it back — both half-alive, WhatsApp unsure which to deliver
     through, and the recipient sitting on a message they cannot fetch. */
  const replaced = reconnectPlan(REASON.connectionReplaced, 0);
  assert(replaced.action === "stop", "a replaced session STOPS — got " + replaced.action);
  assert(
    /taken over|another connection/i.test(replaced.reason),
    "and says a second instance is the cause",
  );

  /* Refused outright. Retrying cannot help and may make it worse. */
  assert(reconnectPlan(REASON.forbidden, 0).action === "stop", "a 403 stops too");

  /* Dead credentials: only a new scan fixes these, and retrying the old ones
     reproduces the failure forever. */
  for (const code of [REASON.loggedOut, REASON.badSession, REASON.multideviceMismatch]) {
    assert(
      reconnectPlan(code, 0).action === "reset-session",
      `${code} clears the session for a fresh QR`,
    );
  }

  /* And the opposite mistake, which costs a trip to the owner's phone: a
     dropped connection must NEVER wipe a good session. */
  for (const code of [
    REASON.timedOut,
    REASON.connectionClosed,
    REASON.unavailableService,
    undefined,
  ]) {
    assert(reconnectPlan(code, 0).action === "reconnect", `${code} keeps the session and dials again`);
  }

  /* The normal step straight after pairing — delaying it makes linking feel
     broken. */
  const restart = reconnectPlan(REASON.restartRequired, 3);
  assert(restart.action === "reconnect", "a restart-required reconnects");
  assert(restart.delayMs === 0, "immediately, however many attempts came before");

  /* A tight reconnect loop is how a blip becomes a ban. */
  assert(backoffMs(0) === 2000, "the first retry waits 2s");
  assert(backoffMs(1) > backoffMs(0), "and each one waits longer");
  assert(backoffMs(50) === 60000, "up to a ceiling, so it never gives up entirely");
  assert(backoffMs(-5) === 2000, "and a nonsense attempt count cannot produce a busy loop");
  assert(
    reconnectPlan(REASON.connectionClosed, 4).delayMs === backoffMs(4),
    "the transport case actually uses the backoff",
  );
}

/* ══════ Sending a bill once ═════════════════════════════════════════════
   The app mints a stable clientMessageId per bill and resends it on every
   retry; its outbox is built on the promise that a retry is safe. This
   service used to ignore the field entirely, so the promise was not kept.

   A fake Firestore, because the behaviour under test is the CONTRACT —
   create() fails when the document already exists, atomically — and that
   contract is what the real client provides. */
{
  const makeDb = () => {
    const docs = new Map();
    return {
      docs,
      collection: (name) => ({
        doc: (id) => {
          const key = `${name}/${id}`;
          return {
            async create(data) {
              if (docs.has(key)) {
                const e = new Error("ALREADY_EXISTS");
                e.code = 6;
                throw e;
              }
              docs.set(key, { ...data });
            },
            async get() {
              return { exists: docs.has(key), data: () => docs.get(key) };
            },
            async set(data, opts) {
              docs.set(key, opts?.merge ? { ...(docs.get(key) ?? {}), ...data } : { ...data });
            },
            async delete() {
              docs.delete(key);
            },
          };
        },
      }),
    };
  };

  {
    const db = makeDb();
    const first = await claimSend(db, "bill-1", 1000);
    assert(first.state === "claimed", "the first attempt owns the send");

    const second = await claimSend(db, "bill-1", 1200);
    assert(second.state === "in-flight", "a retry arriving mid-send does not send a second copy");

    await completeSend(db, "bill-1", { messageId: "M1" }, 1500);
    const third = await claimSend(db, "bill-1", 9000);
    assert(
      third.state === "done",
      "and once it has gone out, a later retry is answered rather than resent",
    );
    assert(third.result?.messageId === "M1", "with what the first send produced");
  }

  /* The failure that would be worse than no dedupe: a claim outliving a send
     that did NOT happen means the bill can never be sent again. */
  {
    const db = makeDb();
    await claimSend(db, "bill-2", 1000);
    await releaseSend(db, "bill-2");
    const again = await claimSend(db, "bill-2", 1100);
    assert(again.state === "claimed", "a released claim lets a real retry through");
  }

  /* And a process that died mid-send must not block the bill forever. */
  {
    const db = makeDb();
    await claimSend(db, "bill-3", 1000);
    const stale = await claimSend(db, "bill-3", 1000 + CLAIM_STALE_MS + 1);
    assert(stale.state === "claimed", "a claim from a dead process is taken over eventually");
    const notYet = await claimSend(db, "bill-3", 1000 + CLAIM_STALE_MS + 2);
    assert(notYet.state === "in-flight", "but only once it is genuinely stale");
  }

  /* Two tills pressing Send on the same bill at the same moment. */
  {
    const db = makeDb();
    const [a, b] = await Promise.all([claimSend(db, "bill-4", 1), claimSend(db, "bill-4", 1)]);
    const winners = [a, b].filter((r) => r.state === "claimed");
    assert(
      winners.length === 1,
      "exactly one of two simultaneous attempts wins — got " + winners.length,
    );
  }
}

/* ══════ The setup page cannot be made to run someone else's script ═══════ */
{
  const out = jsonForScript("</script><script>alert(1)</script>");
  assert(!out.includes("</script>"), "a key cannot close the script block it sits in");
  assert(!out.includes("<"), "nor smuggle a tag in at all — got: " + out);
  assert(jsonForScript("abc-123") === '"abc-123"', "an ordinary key is left readable");

  const sep = String.fromCharCode(0x2028);
  const escaped = jsonForScript("a" + sep + "b");
  assert(!escaped.includes(sep), "and a line separator cannot truncate the statement");
}

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✅ all rules held\n");
