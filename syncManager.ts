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
// Em syncManager.ts

export async function trySync() {
  const pending = await getPendingRecords();

  for (const item of pending) {
    try {
      // 1. Cria registro
      const newRecord = await apiFetch("/api/records", {
        method: "POST",
        body: JSON.stringify(item.payload),
      });

      // --- INÍCIO DA ALTERAÇÃO ---
      // Dispara um evento global avisando que o ID temporário foi trocado pelo ID real do servidor
      const event = new CustomEvent('syncSuccess', {
        detail: {
          tempId: item.payload.tempId, // O ID temporário que o frontend conhece
          newId: newRecord.id,         // O novo ID numérico retornado pelo backend
        }
      });
      window.dispatchEvent(event);
      // --- FIM DA ALTERAÇÃO ---

      // 2. Sobe fotos BEFORE (agora usando o newRecord.id correto)
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
      console.log("Registro sincronizado:", item.id, "-> Novo ID:", newRecord.id);
    } catch (err) {
      console.warn("Falha ao sincronizar:", item.id, err);
    }
  }
}

// Auto-sync quando a internet volta
window.addEventListener("online", trySync);
setInterval(trySync, 30000);
