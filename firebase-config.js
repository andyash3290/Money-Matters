// Fill these in from Firebase Console > Project Settings > General > Your apps > Web app.
// Leave as-is (with PASTE_YOUR markers) to run in local-only mode with no cloud sync.
export const firebaseConfig = {
  apiKey: "AIzaSyAlcks6nflO93zqJPYKOU8YS8o5-ST-xRg",
  authDomain: "money-matters-928d1.firebaseapp.com",
  projectId: "money-matters-928d1",
  storageBucket: "money-matters-928d1.firebasestorage.app",
  messagingSenderId: "232954702819",
  appId: "1:232954702819:web:27032869cbda8ba7448ed6"
};

export const isFirebaseConfigured = !Object.values(firebaseConfig).some(v => String(v).startsWith("PASTE_YOUR"));
