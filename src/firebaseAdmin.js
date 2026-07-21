import admin from "firebase-admin";

// Same project + named database the AIM frontend itself uses — see
// src/lib/firebase.ts (DATABASE_ID) and src/lib/teamAdmin.ts in the main app.
// Must match exactly, or this writes into a database the app never looks at.
const DATABASE_ID = "kinteshmobileacce";

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_KEY is not set — add the Firebase Admin SDK service account " +
          "JSON as an environment variable (see .env.example) before the WhatsApp session store can work.",
      );
    }
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }

  dbInstance = admin.firestore();
  dbInstance.settings({ databaseId: DATABASE_ID });
  return dbInstance;
}
