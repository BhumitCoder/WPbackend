# WhatsApp bridge

Sends bills and statements from the shop's own WhatsApp number, linked by QR
the same way WhatsApp Web is. One process, one shop, one linked device.

The app (AIM) never talks to WhatsApp directly — it calls this service
server-to-server with `x-api-key`. Nothing here is safe to expose to a browser
except `/health`.

## Configuration

| Variable | Required | What it is |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | yes | The whole Admin SDK service-account JSON, on one line. The WhatsApp session lives in Firestore so it survives a redeploy. |
| `FIRESTORE_DATABASE_ID` | no | The **named** database to use. Defaults to `omimpex`. |
| `API_KEY` | yes | Shared secret. Must equal the app's `WHATSAPP_SERVICE_API_KEY`. |
| `PORT` | no | Defaults to 3000; hosts usually set this. |

**The service account and the database must belong to the same project.** They
are set independently, so they can drift apart — and when they do, Firestore
answers every read with `5 NOT_FOUND`, because a missing *database* is an error
while a missing *document* is just `exists: false`. That mismatch crash-looped
this service in production. It now reports the mismatch on `/health` instead of
exiting.

## Endpoints

| | |
|---|---|
| `GET /health` | No key. `{ ok, status, halted?, error? }` — point an uptime pinger here. |
| `GET /qr` | `{ status: "connected" \| "qr" \| "waiting", qr?, phone?, error? }`. The QR **is a login** to the account: never show it to anyone but the owner. |
| `POST /send` | `{ phone, message?, pdfBase64?, fileName?, clientMessageId? }` |
| `POST /disconnect` | A real WhatsApp logout, and the way to clear a halt. |
| `GET /messages` | Recent inbound, in memory only. |

### `POST /send`

Returns `{ ok: true, deduped, acknowledged, messageId }`.

- **`acknowledged`** is the honest bit. Baileys resolves a send the moment it
  hands the bytes to its own socket, which is not delivery — reporting that as
  success is why a bill could be marked sent while the recipient saw "Waiting
  for this message". This waits up to 15s for WhatsApp's own server ack.
  `false` means handed over but unconfirmed.
- **`deduped`** means this `clientMessageId` had already been sent and was not
  sent again. Always pass one: the app mints a stable id per bill and reuses it
  on every retry, and without it a retried send is a second invoice for the
  customer.

Failures carry a `code`, and the status says what to do with them:

| Status | `code` | Meaning |
|---|---|---|
| 409 | `NOT_CONNECTED` | Link is down. Nothing was sent — safe to retry. |
| 409 | `IN_FLIGHT` | The same bill is mid-send. Do not send another. |
| 422 | `NOT_ON_WHATSAPP` | The number is not on WhatsApp. No retry will fix it. |
| 400 | `BAD_REQUEST` | Nothing to send. |

## When the socket closes

Not every close means the same thing, and treating them alike is what produced
the two worst symptoms this service has had.

- **440 `connectionReplaced` halts the service.** Something else signed in as
  this number. Reconnecting takes the session back, which kicks the other one,
  which takes it back — both half-alive, and recipients stuck on "Waiting for
  this message". Usually two copies of this service running. Stop the other,
  then `POST /disconnect` or restart.
- **403 halts too.** WhatsApp is refusing the account; that needs the phone.
- **401 / 500 / 411** wipe the saved session so a fresh QR can be scanned.
- **Everything else** keeps the session and dials again, 2s doubling to 60s. A
  dropped connection must never cost the shop a re-scan.

`/health` reports `halted: true` with the reason when the service is waiting
for a person.

## Running

```
npm install
npm test          # the rules above, no WhatsApp connection needed
npm start         # needs a .env file; hosts run `node src/server.js` instead
```

`GET /?key=<API_KEY>` is a fallback page for linking a device when the app
cannot reach the service. A key in a URL ends up in browser history and access
logs — use the app's Settings screen instead where you can, and rotate
`API_KEY` afterwards if you use this.
