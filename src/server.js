import express from "express";
import { timingSafeEqual } from "node:crypto";
import * as wa from "./whatsapp.js";
import { jsonForScript } from "./escapeForScript.js";

const PORT = process.env.PORT || 3000;
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));

/** Constant-time, and length-safe: timingSafeEqual throws on a length
 *  mismatch, which would otherwise leak the key's length through a 500. */
function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// Every route below except /health and the plain setup page is a real
// action against the shop's WhatsApp account (read the QR to link a device,
// send as them, log them out) — without this, anyone who finds this URL
// could hijack the connection. AIM's Settings page calls these server-to-
// server with the key attached, so it's never exposed to a browser.
function requireApiKey(req, res, next) {
  const configured = process.env.API_KEY;
  if (!configured) {
    return res.status(500).json({ error: "Server misconfigured — API_KEY is not set" });
  }
  if (!sameSecret(req.get("x-api-key") || req.query.key, configured)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Unauthenticated on purpose — it is what an uptime pinger calls. It reports
// why the service is not connected when there is a reason, because the
// alternative is reading a host's log to find one line of cause under sixty
// lines of gRPC stack.
app.get("/health", (_req, res) =>
  res.json({
    ok: !wa.state.lastError,
    status: wa.state.status,
    ...(wa.state.halted ? { halted: true } : null),
    ...(wa.state.lastError ? { error: wa.state.lastError } : null),
  }),
);

// Poll this from the AIM Settings > "Link WhatsApp" screen while status is
// "qr", then stop once it flips to "connected".
app.get("/qr", requireApiKey, (_req, res) => {
  if (wa.state.status === "connected")
    return res.json({ status: "connected", phone: wa.state.phone });
  // "Waiting" with a reason attached, so the Settings screen can stop spinning
  // and say what is wrong instead of implying the QR is on its way.
  if (!wa.state.qrDataUrl) {
    return res.json({
      status: "waiting",
      ...(wa.state.halted ? { halted: true } : null),
      ...(wa.state.lastError ? { error: wa.state.lastError } : null),
    });
  }
  res.json({ status: "qr", qr: wa.state.qrDataUrl });
});

app.post("/disconnect", requireApiKey, async (_req, res) => {
  try {
    await wa.disconnect();
    res.json({ ok: true });
  } catch (err) {
    console.error("[disconnect] failed:", err);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

/**
 * A status code per kind of failure, because the caller acts on each one
 * differently: the app's outbox decides from this whether a bill may be
 * retried automatically, must wait for a person, or should never be queued at
 * all. Collapsing them all into 500 is how a wrong phone number ended up in a
 * retry queue forever.
 */
const SEND_STATUS = {
  NOT_CONNECTED: 409, // the link is down — nothing was sent, safe to retry
  IN_FLIGHT: 409, // the same bill is mid-send — do not send a second copy
  BAD_REQUEST: 400,
  NOT_ON_WHATSAPP: 422, // a real answer about the number: no retry will fix it
};

app.post("/send", requireApiKey, async (req, res) => {
  try {
    const { phone, message, pdfBase64, fileName, clientMessageId } = req.body || {};
    if (!phone) return res.status(400).json({ error: "phone is required" });
    const result = await wa.sendMessage({ phone, message, pdfBase64, fileName, clientMessageId });
    /* `acknowledged` is the honest part: true means WhatsApp's servers have
       confirmed the message, not merely that this process handed it over.
       `deduped` means this exact bill had already gone out and was not sent a
       second time. */
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = SEND_STATUS[err.code] ?? 500;
    console.error(`[send] failed (${err.code ?? "unknown"}):`, err.message);
    res.status(status).json({ error: err.message, code: err.code ?? null });
  }
});

// Starting point for the receive side — returns everything received so far,
// optionally filtered to one phone number. Refine once the real requirement
// (store per-party? push to AIM live? auto-reply?) is decided.
app.get("/messages", requireApiKey, (req, res) => {
  const { phone } = req.query;
  if (phone) {
    const jid = wa.toJid(phone);
    return res.json(wa.state.receivedMessages.filter((m) => m.from === jid));
  }
  res.json(wa.state.receivedMessages);
});

// Manual fallback setup page for local/dev use — the real interface is AIM's
// own Settings > WhatsApp screen. Visit as /?key=<API_KEY>.
//
// Note what this costs: a key in a URL is a key in browser history, in this
// host's access log, and in the Referer header of anything this page fetches
// from elsewhere. It is here because linking a device has to be possible when
// the app itself cannot reach the service — but AIM's own Settings page is the
// way to do this, and rotating API_KEY after using this page is cheap.
app.get("/", (req, res) => {
  const key = String(req.query.key || "");
  res.set({
    // Nothing on this page loads from anywhere else, and nothing should embed
    // it: the QR is a login. Both of those are said out loud rather than left
    // to the browser's defaults.
    "Content-Security-Policy":
      "default-src 'none'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Link WhatsApp</title></head>
<body style="font-family: system-ui; text-align:center; padding-top:60px;">
  <h2 id="title">Loading…</h2>
  <img id="qr" style="display:none; width:280px; height:280px;" />
  <p id="phone" style="color:#666;"></p>
  <p id="why" style="color:#b91c1c; max-width:520px; margin:12px auto; font-size:14px;"></p>
  <script>
    const KEY = ${jsonForScript(key)};
    async function poll() {
      const r = await fetch('/qr', { headers: { 'x-api-key': KEY } });
      const data = await r.json();
      const title = document.getElementById('title');
      const img = document.getElementById('qr');
      const phone = document.getElementById('phone');
      const why = document.getElementById('why');
      why.textContent = data && data.error ? data.error : '';
      if (r.status === 401) {
        title.textContent = 'Unauthorized — open this page as /?key=YOUR_API_KEY';
        img.style.display = 'none';
        return;
      }
      if (data.status === 'connected') {
        title.textContent = 'Connected ✅';
        phone.textContent = data.phone ? ('as +' + data.phone) : '';
        img.style.display = 'none';
      } else if (data.status === 'qr') {
        title.textContent = 'Scan with WhatsApp > Linked Devices';
        img.src = data.qr;
        img.style.display = 'inline-block';
        phone.textContent = '';
      } else {
        title.textContent = data.halted ? 'Stopped — needs attention' : 'Starting…';
        img.style.display = 'none';
        phone.textContent = '';
      }
    }
    poll();
    setInterval(poll, 3000);
  </script>
</body>
</html>`);
});

wa.startSafely();
const server = app.listen(PORT, () =>
  console.log(`WhatsApp server listening on http://localhost:${PORT}`),
);

/* A host replacing this process sends SIGTERM and then waits. Closing the
   WhatsApp socket deliberately tells WhatsApp this device is going away,
   rather than leaving it to time out a connection that is already gone —
   which is one of the states that ends in a session being taken over. */
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`[server] ${signal} — shutting down`);
    server.close(() => {
      try {
        wa.state.sock?.end(undefined);
      } catch {
        /* going away regardless */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
