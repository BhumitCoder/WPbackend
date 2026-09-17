/**
 * Put a value inside a <script> block without letting it escape.
 *
 * `JSON.stringify` on its own is not enough, and the setup page was the proof:
 * it does not escape `/`, so an API key of `</script><script>…` closed the
 * block and ran whatever came after it. A reflected XSS, on the same origin
 * that serves this API, triggered by anyone who could get a shopkeeper to open
 * a link. What made it worth someone's time is what the page shows: the QR
 * code IS a login to the business's WhatsApp account.
 *
 * The two line separators are a different hazard with the same shape. U+2028
 * and U+2029 are ordinary characters inside a JSON string but line terminators
 * to a JavaScript parser, so a value containing one truncates the statement it
 * was embedded in. They are built here from their character codes rather than
 * typed, because a raw one of them in this file would break this file — which
 * is exactly what happened on the first attempt at writing it.
 */

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const SEPARATORS = new RegExp("[" + LS + PS + "]", "g");

export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(SEPARATORS, (c) => (c === LS ? "\\u2028" : "\\u2029"));
}
