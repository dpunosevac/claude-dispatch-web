// Minimal promise wrapper over IndexedDB.

const DB_NAME = "claude-dispatch";
const DB_VERSION = 1;

let dbp = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("kv");
      db.createObjectStore("jobs", { keyPath: "job" });
      db.createObjectStore("turns", { keyPath: ["job", "turn"] });
      db.createObjectStore("machines", { keyPath: "machine" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function store(name, mode = "readonly") {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, key) {
  return req((await store(name)).get(key));
}

export async function put(name, value, key) {
  return req((await store(name, "readwrite")).put(value, key));
}

export async function del(name, key) {
  return req((await store(name, "readwrite")).delete(key));
}

export async function all(name) {
  return req((await store(name)).getAll());
}

export async function turnsFor(job) {
  const range = IDBKeyRange.bound([job, -Infinity], [job, Infinity]);
  return req((await store("turns")).getAll(range));
}

export async function clearAll() {
  const db = await openDb();
  const names = ["kv", "jobs", "turns", "machines"];
  const tx = db.transaction(names, "readwrite");
  for (const n of names) tx.objectStore(n).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
