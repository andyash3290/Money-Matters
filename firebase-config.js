// Fill these in from Firebase Console > Project Settings > General > Your apps > Web app.
// Leave as-is (with PASTE_YOUR markers) to run in local-only mode with no cloud sync.
export const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID"
};

export const isFirebaseConfigured = !Object.values(firebaseConfig).some(v => String(v).startsWith("PASTE_YOUR"));
