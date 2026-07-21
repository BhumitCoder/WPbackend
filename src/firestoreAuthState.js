import { initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import P from "pino";
import { getDb } from "./firebaseAdmin.js";

// One shop = one WhatsApp session for now. If this ever needs to serve more
// than one business, key everything below by a real session id instead.
const SESSION_ID = "default";

const serialize = (value) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
const deserialize = (value) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

// Firestore doc IDs can't contain "/", which some signal key ids do (e.g. app
// state sync keys) — swap it out for something safe and reversible-enough
// (we never need to reverse it, only look it up by the same id again).
const keyDocId = (type, id) => `${type}--${id}`.replace(/\//g, "__");

/**
 * Same shape Baileys' own useMultiFileAuthState returns — { state, saveCreds }
 * — just backed by Firestore instead of local files, so the session survives
 * a host restart/redeploy with no local disk to lose (Render free tier wipes
 * it on every redeploy).
 */
export async function useFirestoreAuthState() {
  const db = getDb();
  const credsRef = db.doc(`waSessions/${SESSION_ID}`);
  const keysCol = db.collection(`waSessions/${SESSION_ID}/keys`);

  const credsSnap = await credsRef.get();
  const creds = credsSnap.exists ? deserialize(credsSnap.data().json) : initAuthCreds();

  const rawKeyStore = {
    async get(type, ids) {
      const data = {};
      await Promise.all(
        ids.map(async (id) => {
          const snap = await keysCol.doc(keyDocId(type, id)).get();
          if (snap.exists) data[id] = deserialize(snap.data().json);
        }),
      );
      return data;
    },
    async set(data) {
      const entries = Object.entries(data).flatMap(([type, idMap]) =>
        Object.entries(idMap).map(([id, value]) => ({ type, id, value })),
      );
      // Chunk well under Firestore's 500-ops-per-batch limit — signal key
      // updates are normally a handful at a time, but never assume that.
      for (let i = 0; i < entries.length; i += 400) {
        const batch = db.batch();
        for (const { type, id, value } of entries.slice(i, i + 400)) {
          const ref = keysCol.doc(keyDocId(type, id));
          if (value) batch.set(ref, { json: serialize(value) });
          else batch.delete(ref);
        }
        await batch.commit();
      }
    },
  };

  const saveCreds = () => credsRef.set({ json: serialize(creds) });

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(rawKeyStore, P({ level: "silent" })),
    },
    saveCreds,
  };
}

/** Wipes the stored session (creds + every key doc) so the next start()
 * generates a genuinely fresh QR — used on disconnect, and when the phone's
 * own "Remove linked device" invalidates the old creds. */
export async function clearSession() {
  const db = getDb();
  const credsRef = db.doc(`waSessions/${SESSION_ID}`);
  const keysCol = db.collection(`waSessions/${SESSION_ID}/keys`);

  const keyDocs = await keysCol.listDocuments();
  for (let i = 0; i < keyDocs.length; i += 400) {
    const batch = db.batch();
    for (const ref of keyDocs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
  await credsRef.delete();
}
