import type { LocalTransfer, StoredFile } from "../types";

const DB_NAME = "zxdrop-local";
const STORE = "transfers";
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putTransfer(transfer: StoredFile): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(transfer);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listTransfers(): Promise<LocalTransfer[]> {
  const db = await openDatabase();
  const result = await new Promise<StoredFile[]>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6)
    .map(({ blob: _blob, ...transfer }) => transfer);
}

export async function getStoredFile(id: string): Promise<StoredFile | undefined> {
  const db = await openDatabase();
  const result = await new Promise<StoredFile | undefined>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}
