import express from "express";
import * as wa from "./whatsapp.js";

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: "20mb" }));

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
  const provided = req.get("x-api-key") || req.query.key;
  if (provided !== configured) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true, status: wa.state.status }));

// Poll this from the AIM Settings > "Link WhatsApp" screen while status is
// "qr", then stop once it flips to "connected".
app.get("/qr", requireApiKey, (_req, res) => {
  if (wa.state.status === "connected") return res.json({ status: "connected", phone: wa.state.phone });
  if (!wa.state.qrDataUrl) return res.json({ status: "waiting" });
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

app.post("/send", requireApiKey, async (req, res) => {
  try {
    const { phone, message, pdfBase64, fileName } = req.body || {};
    if (!phone) return res.status(400).json({ error: "phone is required" });
    await wa.sendMessage({ phone, message, pdfBase64, fileName });
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === "NOT_CONNECTED" ? 409 : err.code === "BAD_REQUEST" ? 400 : 500;
    console.error("[send] failed:", err.message);
    res.status(status).json({ error: err.message });
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
// own Settings > WhatsApp screen. Visit as /?key=<API_KEY> to use this
// directly; the key is never embedded in the page itself, only forwarded
// from the URL you already had to know.
app.get("/", (req, res) => {
  const key = String(req.query.key || "");
  res.send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Link WhatsApp</title></head>
<body style="font-family: system-ui; text-align:center; padding-top:60px;">
  <h2 id="title">Loading…</h2>
  <img id="qr" style="display:none; width:280px; height:280px;" />
  <p id="phone" style="color:#666;"></p>
  <script>
    const KEY = ${JSON.stringify(key)};
    async function poll() {
      const r = await fetch('/qr', { headers: { 'x-api-key': KEY } });
      const data = await r.json();
      const title = document.getElementById('title');
      const img = document.getElementById('qr');
      const phone = document.getElementById('phone');
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
        title.textContent = 'Starting…';
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

wa.start();
app.listen(PORT, () => console.log(`WhatsApp server listening on http://localhost:${PORT}`));
