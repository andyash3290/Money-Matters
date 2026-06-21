import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js';
import { SEED_TRANSACTIONS } from './seed-data.js';

export const mode = isFirebaseConfigured ? 'cloud' : 'local';

function makeLocalStore(key, seed) {
  let items = [];
  const subscribers = [];
  const raw = localStorage.getItem(key);
  if (raw) {
    try { items = JSON.parse(raw); } catch(e) { items = seed ? seed.slice() : []; }
  } else if (seed) {
    items = seed.slice();
  }
  function persist() { localStorage.setItem(key, JSON.stringify(items)); }
  function notify() { subscribers.forEach(cb => cb(items.slice())); }
  return {
    subscribe(cb) { subscribers.push(cb); cb(items.slice()); return () => { const i = subscribers.indexOf(cb); if (i>=0) subscribers.splice(i,1); }; },
    add(obj) { const withId = {...obj, id: obj.id || ('id' + Date.now() + Math.floor(Math.random()*100000))}; items.push(withId); persist(); notify(); return withId.id; },
    update(id, patch) { const i = items.findIndex(x => x.id === id); if (i>=0) { items[i] = {...items[i], ...patch}; persist(); notify(); } },
    remove(id) { items = items.filter(x => x.id !== id); persist(); notify(); },
    replaceAll(newItems) { items = newItems; persist(); notify(); },
    getAll() { return items.slice(); }
  };
}

function buildLocalAdapter() {
  const transactions = makeLocalStore('expenseDashboard_v1', SEED_TRANSACTIONS);
  const assets = makeLocalStore('expenseDashboard_assets_v1', []);
  const assetEntries = makeLocalStore('expenseDashboard_assetEntries_v1', []);
  const authSubscribers = [];
  const fakeUser = {uid: 'local-user', email: 'local'};
  return {
    mode: 'local',
    auth: {
      onAuthChange(cb) { authSubscribers.push(cb); cb(fakeUser); return () => {}; },
      signIn() { return Promise.resolve(fakeUser); },
      signOut() { return Promise.resolve(); },
      currentUser: fakeUser
    },
    transactions,
    assets,
    assetEntries
  };
}

async function buildCloudAdapter() {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js');
  const authMod = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js');
  const fsMod = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js');

  const app = initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  await authMod.setPersistence(auth, authMod.browserLocalPersistence);
  const db = fsMod.getFirestore(app);
  try { await fsMod.enableIndexedDbPersistence(db); } catch(e) { /* multiple tabs open, ignore */ }

  let uid = null;

  function collectionFor(name) {
    return fsMod.collection(db, 'users', uid, name);
  }

  function makeCloudStore(name, seed) {
    let seeded = false;
    return {
      subscribe(cb) {
        const colRef = collectionFor(name);
        return fsMod.onSnapshot(colRef, async (snap) => {
          if (!seeded && seed && seed.length) {
            seeded = true;
            if (snap.empty) {
              const batch = fsMod.writeBatch(db);
              seed.forEach(item => { batch.set(fsMod.doc(colRef, item.id), item); });
              await batch.commit();
              return; // onSnapshot will fire again with the seeded data
            }
          }
          const items = snap.docs.map(d => ({...d.data(), id: d.id}));
          cb(items);
        });
      },
      async add(obj) {
        const ref = await fsMod.addDoc(collectionFor(name), obj);
        return ref.id;
      },
      async update(id, patch) {
        await fsMod.updateDoc(fsMod.doc(collectionFor(name), id), patch);
      },
      async remove(id) {
        await fsMod.deleteDoc(fsMod.doc(collectionFor(name), id));
      },
      async replaceAll(newItems) {
        const colRef = collectionFor(name);
        const existing = await fsMod.getDocs(colRef);
        const batch = fsMod.writeBatch(db);
        existing.docs.forEach(d => batch.delete(d.ref));
        newItems.forEach(item => batch.set(fsMod.doc(colRef, item.id || undefined), item));
        await batch.commit();
      }
    };
  }

  const transactions = makeCloudStore('transactions', SEED_TRANSACTIONS);
  const assets = makeCloudStore('assets', []);
  const assetEntries = makeCloudStore('assetEntries', []);

  return {
    mode: 'cloud',
    auth: {
      onAuthChange(cb) {
        return authMod.onAuthStateChanged(auth, (user) => { uid = user ? user.uid : null; cb(user); });
      },
      signIn(email, password) { return authMod.signInWithEmailAndPassword(auth, email, password); },
      signOut() { return authMod.signOut(auth); },
      get currentUser() { return auth.currentUser; }
    },
    transactions,
    assets,
    assetEntries
  };
}

export async function createDataAdapter() {
  if (mode === 'cloud') {
    try {
      return await buildCloudAdapter();
    } catch (e) {
      console.error('Firebase init failed, falling back to local mode:', e);
      return buildLocalAdapter();
    }
  }
  return buildLocalAdapter();
}
