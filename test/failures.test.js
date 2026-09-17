/**
 * What the service says when it cannot start.
 *
 * Written after a production crash-loop whose entire diagnosis was the token
 * `code: 5`, buried under sixty lines of gRPC and OpenTelemetry stack frames.
 * The cause was a one-line configuration mismatch. These assertions are about
 * the sentence, because the sentence is what anyone actually has to act on.
 *
 * Run: npm test
 */
import { describeFailure } from "../src/whatsapp.js";

let passed = 0;
const failures = [];
function assert(ok, what) {
  if (ok) passed += 1;
  else failures.push(what);
}

/* ── code 5 is a missing DATABASE, never a missing document ──────────────
   Firestore answers a read for a document that isn't there with
   `exists: false`, not an error. So NOT_FOUND on the very first read can only
   mean the named database this service is pointed at does not exist in the
   project whose service account it was handed — which is what happened: the
   database name belonged to one shop and the key to another. */
{
  const msg = describeFailure({ code: 5, message: "5 NOT_FOUND: " });
  assert(
    msg.includes(process.env.FIRESTORE_DATABASE_ID || "omimpex"),
    "names the database it was looking for",
  );
  assert(
    /FIRESTORE_DATABASE_ID/.test(msg),
    "names the setting that changes it",
  );
  assert(
    /service account/i.test(msg),
    "and says the other half of the pair — the key — may be the wrong one instead",
  );
  assert(
    !/NOT_FOUND|grpc|code 5/i.test(msg),
    "without making the reader decode gRPC to get there — got: " + msg,
  );
}

/* A refused key is a different problem with a different fix, and must not be
   reported as a missing database. */
{
  for (const code of [7, 16]) {
    const msg = describeFailure({ code, message: "denied" });
    assert(/refused/i.test(msg), `code ${code} reads as a refusal`);
    assert(
      !/does not exist|has no database/i.test(msg),
      `code ${code} is not reported as a missing database`,
    );
  }
}

/* Anything else keeps its own message rather than being flattened into a
   guess. A wrong guess costs more than no guess. */
{
  assert(
    describeFailure(new Error("socket hang up")) === "socket hang up",
    "an unrecognised failure is passed through unchanged",
  );
  assert(
    typeof describeFailure(undefined) === "string",
    "and nothing throws on a failure with no message at all",
  );
}

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("  ✅ failures explain themselves\n");
