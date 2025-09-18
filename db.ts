import { openDB } from "idb";

const DB_NAME = "crbApp";
const STORE_NAME = "pendingRecords";

export async function getDB() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    },
  });
}

export async function addPendingRecord(record: any) {
  const db = await getDB();
  await db.put(STORE_NAME, record);
}

export async function getPendingRecords() {
  const db = await getDB();
  return db.getAll(STORE_NAME);
}

export async function deletePendingRecord(id: string) {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
}
