// Pembungkus IndexedDB kecil. Kalau IndexedDB tidak tersedia, jatuh ke memori (hilang saat reload).

const NAME = 'superband';
const STORES = ['songs', 'files'];
let dbPromise = null;
const memory = { songs: new Map(), files: new Map() };
let useMemory = false;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      useMemory = true;
      resolve(null);
      return;
    }
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      useMemory = true;
      resolve(null);
    };
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  if (useMemory) return fn(null, memory[store]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Penyimpanan gagal (mungkin penuh)'));
  });
}

export const db = {
  put: (store, key, value) => run(store, 'readwrite', (os, mem) => (os ? os.put(value, key) : mem.set(key, value))),
  get: (store, key) => run(store, 'readonly', (os, mem) => (os ? os.get(key) : { result: mem.get(key) })).then((r) => (useMemory ? r.result : r)),
  del: (store, key) => run(store, 'readwrite', (os, mem) => (os ? os.delete(key) : mem.delete(key))),
  all: (store) => run(store, 'readonly', (os, mem) => (os ? os.getAll() : { result: [...mem.values()] })).then((r) => (useMemory ? r.result : r)),
  keys: (store) => run(store, 'readonly', (os, mem) => (os ? os.getAllKeys() : { result: [...mem.keys()] })).then((r) => (useMemory ? r.result : r)),
};

export function requestPersist() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
