import { addPendingRecord, getPendingRecords, deletePendingRecord } from "./db";
import { apiFetch } from "./api"; // usa seu helper existente

// Cria novo registro com fotos "Antes"
export async function queueRecord(recordPayload: any, photosBefore: File[]) {
  const record = {
    id: crypto.randomUUID(),
    payload: recordPayload,
    photosBefore,
    photosAfter: [],
    status: "pending",
    createdAt: Date.now(), // útil pra debug e ordenação
  };
  await addPendingRecord(record);
  trySync();
}

// Adiciona fotos "Depois" a um registro já existente
export async function addAfterPhotosToPending(recordId: string, photosAfter: File[]) {
  const pending = await getPendingRecords();
  const record = pending.find(r => r.payload.tempId === recordId || r.id === recordId);

  if (record) {
    record.photosAfter.push(...photosAfter);
    await addPendingRecord(record); // sobrescreve no IndexedDB
    trySync();
  } else {
    // Se já subiu, manda direto
    try {
      const fd = new FormData();
      fd.append("phase", "AFTER");
      photosAfter.forEach(f => fd.append("files", f));
      await apiFetch(`/api/records/${recordId}/photos`, { method: "POST", body: fd });
    } catch (err) {
      console.error("Falha ao enviar fotos AFTER direto:", err);
    }
  }
}

// Processa fila
export async function trySync() {
  const pending = await getPendingRecords();
  console.log("trySync rodando, registros pendentes:", pending.length);

  for (const item of pending) {
    try {
      // 🔑 Remove o tempId antes de mandar pro backend
      const { tempId, ...cleanPayload } = item.payload;

      // 1. Cria registro no backend
      const newRecord = await apiFetch("/api/records", {
        method: "POST",
        body: JSON.stringify(cleanPayload),
      });

      // 2. Sobe fotos BEFORE
      if (item.photosBefore?.length) {
        const fd = new FormData();
        fd.append("phase", "BEFORE");
        item.photosBefore.forEach(f => fd.append("files", f));
        await apiFetch(`/api/records/${newRecord.id}/photos`, { method: "POST", body: fd });
      }

      // 3. Sobe fotos AFTER
      if (item.photosAfter?.length) {
        const fd = new FormData();
        fd.append("phase", "AFTER");
        item.photosAfter.forEach(f => fd.append("files", f));
        await apiFetch(`/api/records/${newRecord.id}/photos`, { method: "POST", body: fd });
      }

      // 4. Remove da fila
      await deletePendingRecord(item.id);
      console.log("✅ Registro sincronizado:", item.id);
    } catch (err) {
      console.warn("⚠️ Falha ao sincronizar:", item.id, err);
    }
  }
}

// Auto-sync quando a internet volta
window.addEventListener("online", trySync);
setInterval(trySync, 30000);
