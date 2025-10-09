import { addPendingRecord, getPendingRecords, deletePendingRecord } from "./db";
import { apiFetch } from "./api";

// Cria novo registro com fotos "Antes"
export async function queueRecord(recordPayload: any, photosBefore: File[]) {
  const record = {
    id: crypto.randomUUID(),
    payload: recordPayload,
    photosBefore,
    photosAfter: [],
    status: "pending",
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

      // Busca no localStorage pelo ID real que foi salvo pelo trySync.
      const realId = localStorage.getItem(`sync_map_${recordId}`) || recordId;
      
      await apiFetch(`/api/records/${realId}/photos`, { method: "POST", body: fd });

    } catch (err) {
      console.error("Falha ao enviar fotos AFTER direto:", err);
      throw err; 
    }
  }
}

// Processa fila
export async function trySync() {
  const pending = await getPendingRecords();

  for (const item of pending) {
    try {
      // 1. Cria registro
      const newRecord = await apiFetch("/api/records", {
        method: "POST",
        body: JSON.stringify(item.payload),
      });

      // Salva o mapeamento do ID temporário para o ID real no localStorage.
      localStorage.setItem(`sync_map_${item.payload.tempId}`, newRecord.id);

      // 2. Sobe fotos BEFORE (usando o newRecord.id correto)
      if (item.photosBefore?.length) {
        const fd = new FormData();
        fd.append("phase", "BEFORE");
        item.photosBefore.forEach(f => fd.append("files", f));
        await apiFetch(`/api/records/${newRecord.id}/photos`, { method: "POST", body: fd });
      }

      // 3. Sobe fotos AFTER (se já existirem na fila)
      if (item.photosAfter?.length) {
        const fd = new FormData();
        fd.append("phase", "AFTER");
        item.photosAfter.forEach(f => fd.append("files", f));
        await apiFetch(`/api/records/${newRecord.id}/photos`, { method: "POST", body: fd });
      }

      // 4. Remove da fila
      await deletePendingRecord(item.id);
      console.log("Registro sincronizado:", item.payload.tempId, "-> Novo ID:", newRecord.id);
      
      // A LINHA ABAIXO PRECISA SER ATIVADA:
      localStorage.removeItem(`sync_map_${item.payload.tempId}`);

    } catch (err) {
      console.warn("Falha ao sincronizar:", item.id, err);
    }
  }
}

// Auto-sync
window.addEventListener("online", trySync);
setInterval(trySync, 30000);
