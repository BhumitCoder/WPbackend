import admin from "firebase-admin";

// Same project + named database the AIM frontend itself uses — see
// src/lib/firebase.ts (DATABASE_ID) and src/lib/teamAdmin.ts in the main app.
// Must match exactly, or this writes into a database the app never looks at.
//
// One codebase serves more than one shop, and each shop is a different named
// database in a different Firebase project, so this cannot be a constant that
// only a redeploy can change. Set FIRESTORE_DATABASE_ID on the host; the
// default is what this service was pinned to before it was configurable.
export const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "omimpex";

let dbInstance = null;
let serviceAccountProjectId = null;

/** Which Firebase project the configured key actually belongs to. Null until
 *  the key has been parsed — i.e. until the first getDb(). */
export function getProjectId() {
  return serviceAccountProjectId;
}

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
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_KEY is set but is not valid JSON — paste the whole service " +
          `account file as one line, quotes and all (${err.message})`,
      );
    }
    serviceAccountProjectId = serviceAccount.project_id ?? null;
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }

  dbInstance = admin.firestore();
  dbInstance.settings({ databaseId: DATABASE_ID });
  return dbInstance;
}
