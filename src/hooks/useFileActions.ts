import { getSecret, VAULT_KEY_CHANNEL_ID, channelIdKey } from "../lib/secure/vault";
import {
  deleteTelegramMessage,
  folderIdForPath,
  fullPathForFolder,
  findFoldersByPath,
} from "../lib/storage/metadataStore";
import { useFileStore } from "../stores/fileStore";
import { useAuthStore } from "../stores/authStore";
import { TeleFile } from "../lib/types";
import { toast } from "sonner";
import { cacheFileOffline, removeOfflineCache } from "../lib/storage/offlineStorage";
import { invoke } from "@tauri-apps/api/core";
import { enqueueSave, flushAllQueues, retryQueue } from "../lib/storage/indexQueue";
import { useCallback, useMemo } from "react";
import { logEvent } from "../lib/events";


/**
 * ActionQueue — serializes offline-toggle operations (which touch local FS)
 * so a single file can't have two concurrent download/remove flows.
 *
 * Index writes are no longer serialized here. The IndexQueue owns all
 * index persistence and coalesces concurrent actions automatically.
 */
class ActionQueue {
  private queue: (() => Promise<any>)[] = [];
  private running = false;

  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const res = await task();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.running) return;
    this.running = true;
    useFileStore.getState().setIsOperating(true);

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        try {
          await task();
        } catch (err) {
          console.error("Error executing queued task:", err);
        }
      }
    }

    this.running = false;
    useFileStore.getState().setIsOperating(false);
  }
}

const fileActionQueue = new ActionQueue();

const DIRECTORY_MIMES = new Set(["inode/directory", "application/x-directory"]);

function isFolder(file: TeleFile): boolean {
  return DIRECTORY_MIMES.has(file.mime);
}

function normalizeFolderPath(path: string): string {
  if (!path || path === "/") return "/";
  return `/${path.split("/").filter(Boolean).join("/")}`;
}

function getFolderFullPath(folder: TeleFile): string {
  const parentPath = normalizeFolderPath(folder.folderPath);
  return parentPath === "/" ? `/${folder.name}` : `${parentPath}/${folder.name}`;
}

function isSameOrDescendantPath(path: string, parentPath: string): boolean {
  const normalizedPath = normalizeFolderPath(path);
  const normalizedParentPath = normalizeFolderPath(parentPath);
  return normalizedPath === normalizedParentPath || normalizedPath.startsWith(`${normalizedParentPath}/`);
}

/**
 * Push a snapshot of the current files array onto the rollback ring.
 * Each call to `applyOptimistic` does this BEFORE mutating, so each action
 * gets its own independent rollback target (replaces the old global
 * `originalFilesBeforeOptimistic` which only worked for the first action).
 */
function pushSnapshotForRollback(): void {
  useFileStore.getState().pushSnapshot();
}

/**
 * Pop the most recent rollback snapshot and restore the files array to it.
 * Called when an action's index save fails with a HARD error.
 */
function rollbackToLastSnapshot(): boolean {
  const snap = useFileStore.getState().popSnapshot();
  if (!snap) return false;
  useFileStore.getState().setFiles(snap);
  return true;
}

type ApplyOptimisticOptions = {
  skipRollbackOnHardError?: boolean;
  eventType?: string;
  eventPayload?: Record<string, unknown>;
  /**
   * Id do toast de loading criado pelo chamador. Quando presente, os
   * `toast.error` internos usam esse id para SUBSTITUIR o loading
   * pendurante — senão o loading ficaria órfão na tela para sempre.
   */
  toastId?: string | number;
};

/**
 * Marca um erro como "já notificado com toast" para o catch externo não
 * emitir um segundo `toast.error` para a MESMA falha (bug da auditoria
 * round 4: dois vermelhos para um só erro).
 */
function markToasted<T>(e: T): T {
  if (e && typeof e === "object") (e as any).kumadriveToasted = true;
  return e;
}

/**
 * Optimistically apply a new files array and persist it to Telegram.
 *
 * - Pushes a rollback snapshot BEFORE the optimistic update so each call
 *   has its own independent rollback target.
 * - Routes the persistence through the IndexQueue, which coalesces
 *   concurrent calls into a single Telegram edit. Transient errors
 *   (FLOOD_WAIT, timeout) stay optimistic and retry indefinitely; hard
 *   errors trigger a rollback to the snapshot.
 * - Quando `options.toastId` é passado, os `toast.error` internos
 *   substituem o loading do chamador (mesmo id) e marcam o erro com
 *   `kumadriveToasted` para o catch externo não duplicar o aviso.
 */
async function applyOptimistic(
  channelId: string,
  nextFiles: TeleFile[],
  options: ApplyOptimisticOptions = {}
): Promise<void> {
  const store = useFileStore.getState();

  // Suppress writes before bootstrap completes. Bootstrap reads the
  // authoritative index from Telegram and populates the store; if a user
  // action fires before that, persisting our optimistic state would
  // overwrite Telegram with a partial / stale index and lose data on
  // the next restart. The user can retry the action once bootstrap
  // completes (which takes < 1s in practice).
  if (!store.bootstrapComplete && store.files.length === 0) {
    await invoke("log_vault_state", {
      state: `ACTION_SUPPRESSED_PRE_BOOTSTRAP files=${nextFiles.length}`,
    }).catch(() => {});
    if (!options.skipRollbackOnHardError) {
      rollbackToLastSnapshot();
    }
    // Substitui o loading pendurante (mesmo id) quando o chamador criou um.
    toast.error(
      "Ainda estamos carregando seu drive — tente novamente em instantes.",
      options.toastId ? { id: options.toastId } : undefined
    );
    // Marca o erro: já avisamos com toast, o catch externo não deve repetir.
    throw markToasted(new Error("Bootstrap not complete"));
  }

  pushSnapshotForRollback();
  store.setFiles(nextFiles);
  store.setSyncing(true);

  try {
    await enqueueSave(channelId, nextFiles);
    // Commit succeeded (or is being transparently retried). Clear this
    // snapshot from the ring — the optimistic state is now canonical.
    useFileStore.getState().popSnapshot();
    await invoke("log_vault_state", {
      state: `ACTION_OK files=${nextFiles.length}`,
    }).catch(() => {});
    // Audit-log this action. Fire-and-forget — failures never interrupt
    // the user's flow. Caller passes `eventType` for known actions;
    // falls back to a generic type for un-tagged callers (none today,
    // but keeps the hook forward-compatible).
    if (options.eventType) {
      logEvent({
        type: options.eventType,
        payload: { fileCount: nextFiles.length, ...(options.eventPayload ?? {}) },
      });
    }
  } catch (err: any) {
    if (options.skipRollbackOnHardError) {
      await invoke("log_vault_state", {
        state: `ACTION_HARD_ERR_NO_ROLLBACK: ${err?.message ?? err}`,
      }).catch(() => {});
      throw err;
    }
    // Hard error path: roll back to the pre-action snapshot.
    const rolled = rollbackToLastSnapshot();
    await invoke("log_vault_state", {
      state: `ACTION_HARD_ERR rolled=${rolled}: ${err?.message ?? err}`,
    }).catch(() => {});
    // Mesmo id do loading do chamador → o vermelho substitui o loading em
    // vez de virar um toast órfão ao lado dele.
    toast.error(
      `Falha ao salvar e a alteração foi desfeita: ${err?.message ?? "Erro desconhecido"}`,
      options.toastId ? { id: options.toastId } : undefined
    );
    // Já emitimos o toast — o catch externo não deve emitir outro.
    throw markToasted(err);
  } finally {
    useFileStore.getState().setSyncing(false);
  }
}

if (typeof window !== "undefined") {
  // Best-effort flush on tab close. The queue resolves any pending entries
  // so callers don't hang. We don't try to await (browsers can't).
  window.addEventListener("beforeunload", () => {
    void flushAllQueues();
  });

  // Expose a tiny dev hook so the diagnostics page can force a retry.
  (window as any).__kumadriveRetryIndex = (channelId: string) =>
    retryQueue(channelId);

  // Emergency gate release. If bootstrap ever wedges past its safety nets
  // (Tauri IPC deadlock, hung GramJS request, etc.), the user can open
  // DevTools and run `__kumadriveForceBootstrapComplete()` to flip the gate
  // so drag/drop/rename/delete work again. This should never normally need
  // to run — the dead-man switch in bootstrap.ts handles it — but it's a
  // cheap last-resort escape hatch.
  (window as any).__kumadriveForceBootstrapComplete = () => {
    useFileStore.getState().setBootstrapComplete(true);
    console.warn(
      "[kumadrive] bootstrapComplete forced to true via dev hook — gate bypassed"
    );
  };
}

/**
 * Envolve `applyOptimistic` com o ciclo completo de feedback:
 * loading → sucesso OU erro (nunca os dois, nunca órfão).
 *
 * Por que não basta mover o `toast.success` para depois do `await`: em
 * erro transitório (FLOOD_WAIT de até ~600s) o `await` fica pendurado
 * em retry e a confirmação nunca apareceria. Criando UM toast de loading
 * com id fixo, tanto o sucesso quanto o erro (emitido pelo próprio
 * `applyOptimistic` com o MESMO id) SUBSTITUEM o loading — e o verde só
 * aparece de fato quando o índice comita, eliminando o "sucesso falso"
 * seguido de vermelho.
 */
async function applyOptimisticWithFeedback(
  channelId: string,
  nextFiles: TeleFile[],
  options: ApplyOptimisticOptions,
  messages: { pending: string; success: string; errorFallback: string },
): Promise<void> {
  const tid = toast.loading(messages.pending);
  try {
    await applyOptimistic(channelId, nextFiles, { ...options, toastId: tid });
    toast.success(messages.success, { id: tid });
  } catch (err: any) {
    // `applyOptimistic` já emitiu o toast dele com o MESMO id (marcação
    // `kumadriveToasted`) — só avisamos quando o erro veio de antes dela
    // (getChannelId, arquivo não encontrado, etc.).
    if (!err?.kumadriveToasted) {
      toast.error(err?.message || messages.errorFallback, { id: tid });
      markToasted(err);
    }
    throw err;
  }
}

export function useFileActions() {
  const isOperating = useFileStore((state) => state.isOperating);
  const currentFolder = useFileStore((state) => state.currentFolder);
  const phoneNumber = useAuthStore((state) => state.phoneNumber);

  const getChannelId = useCallback(async () => {
    let cid: string | null = null;
    if (phoneNumber) {
      cid = await getSecret(channelIdKey(phoneNumber));
    }
    if (!cid) {
      cid = await getSecret(VAULT_KEY_CHANNEL_ID);
    }
    if (!cid) {
      toast.error("O canal de armazenamento do Telegram não está configurado");
      // Toast já emitido — marca para o catch de cada ação não duplicar.
      throw markToasted(new Error("Channel ID missing"));
    }
    return cid;
  }, [phoneNumber]);

  const createFolder = useCallback(async (name: string) => {
    if (!name.trim()) return;
    try {
      const channelId = await getChannelId();
      const trimmed = name.trim();

      // No-op if a folder with the same full path already exists. With the
      // pre-fix code, the UI would happily create a second `Code` folder
      // every time the user typed the same name — and `reconstructMissingFolders`
      // would also re-create one on the next bootstrap. This guard closes that
      // loop at the user-facing entry point.
      const files = useFileStore.getState().files;
      const targetParent = normalizeFolderPath(currentFolder);
      const newFullPath =
        targetParent === "/" ? `/${trimmed}` : `${targetParent}/${trimmed}`;
      if (findFoldersByPath(files, newFullPath).length > 0) {
        toast.info(`A pasta "${trimmed}" já existe`);
        return;
      }

      const newFolder: TeleFile = {
        // Deterministic id keyed on the full path. Mirrors the canonical
        // scheme used by `reconstructMissingFolders` in metadataStore.ts —
        // every cold start computing this folder arrives at the same id,
        // so the dedup pass on recovery (collapseDuplicateFolders) does not
        // see two different ids for the same path. A random id here would
        // create one entry per cold start with no way to dedupe later.
        id: folderIdForPath(newFullPath),
        name: trimmed,
        size: 0,
        mime: "inode/directory",
        folderPath: currentFolder,
        messageId: 0,
        channelId,
        uploadedAt: Date.now(),
        starred: false,
        trashed: false,
      };

      // Feedback (loading → sucesso/erro) fica no wrapper: o verde só
      // aparece quando o índice comita, e em hard error o próprio
      // `applyOptimistic` substitui o loading pelo vermelho (sem toast
      // duplicado e sem "sucesso" falso antes da falha).
      await applyOptimisticWithFeedback(
        channelId,
        [...files, newFolder],
        { eventType: "folder.created", eventPayload: { name: trimmed } },
        {
          pending: "Criando pasta…",
          success: `Pasta "${trimmed}" criada com sucesso`,
          errorFallback: "Não foi possível criar a pasta",
        }
      );
    } catch (err: any) {
      console.error("Failed to create folder:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível criar a pasta");
    }
  }, [currentFolder, getChannelId]);

  const renameFile = useCallback(async (fileId: string, newName: string) => {
    if (!newName.trim()) return;
    try {
      const channelId = await getChannelId();
      const allFiles = useFileStore.getState().files;
      const fileToRename = allFiles.find((f) => f.id === fileId);
      if (!fileToRename) throw new Error("Arquivo não encontrado");

      const isFolderRename = fileToRename.mime === "inode/directory" || fileToRename.mime === "application/x-directory";

      let oldPath = "";
      let newPath = "";
      if (isFolderRename) {
        // Match by path, not by id — every folder entry sharing the same
        // full path gets renamed together. With duplicates, matching by id
        // would only rename one entry and leave the others at the old name,
        // which is exactly what produced the "stale folder" bug.
        oldPath = fullPathForFolder(fileToRename);
        const trimmedName = newName.trim();
        newPath = fileToRename.folderPath === "/"
          ? `/${trimmedName}`
          : `${fileToRename.folderPath}/${trimmedName}`;
      }

      const updatedFiles = allFiles.map((f) => {
        if (isFolderRename) {
          // Apply rename to ALL folder entries sharing the old full path
          // (handles duplicates from the pre-fix bootstrap bug).
          if (isFolder(f) && fullPathForFolder(f) === oldPath) {
            return { ...f, name: newName.trim() };
          }
          // Children whose folderPath equals the old folder path get moved.
          if (f.folderPath === oldPath) {
            return { ...f, folderPath: newPath };
          }
          // Descendants (subfolders / files inside subfolders) get the new prefix.
          if (f.folderPath.startsWith(oldPath + "/")) {
            return { ...f, folderPath: newPath + f.folderPath.substring(oldPath.length) };
          }
          return f;
        }
        // File (non-folder) rename: id-based rename still works because
        // each uploaded file has exactly one entry per messageId now.
        if (f.id === fileId) {
          return { ...f, name: newName.trim() };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "file.renamed", eventPayload: { name: fileToRename.name } },
        {
          pending: "Renomeando…",
          success: "Renomeado com sucesso",
          errorFallback: "Não foi possível renomear",
        }
      );
    } catch (err: any) {
      console.error("Failed to rename:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível renomear");
    }
  }, [getChannelId]);

  const toggleStar = useCallback(async (file: TeleFile) => {
    try {
      const channelId = await getChannelId();
      const allFiles = useFileStore.getState().files;
      const currentFile = allFiles.find((f) => f.id === file.id);
      const nextStarred = currentFile ? !currentFile.starred : !file.starred;

      const updatedFiles = allFiles.map((f) =>
        f.id === file.id ? { ...f, starred: nextStarred } : f
      );

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: nextStarred ? "file.starred" : "file.unstarred", eventPayload: { name: file.name } },
        {
          pending: "Salvando…",
          success: nextStarred ? "Adicionado aos favoritos" : "Removido dos favoritos",
          errorFallback: "Não foi possível atualizar os favoritos",
        }
      );
    } catch (err: any) {
      console.error("Failed to toggle star:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível atualizar os favoritos");
    }
  }, [getChannelId]);

  const moveToTrash = useCallback(async (file: TeleFile) => {
    try {
      const channelId = await getChannelId();
      const isFolder = file.mime === "inode/directory" || file.mime === "application/x-directory";
      const allFiles = useFileStore.getState().files;

      const folderPathPrefix = file.folderPath === "/"
        ? `/${file.name}`
        : `${file.folderPath}/${file.name}`;

      const updatedFiles = allFiles.map((f) => {
        if (f.id === file.id || (isFolder && (f.folderPath === folderPathPrefix || f.folderPath.startsWith(folderPathPrefix + "/")))) {
          return { ...f, trashed: true };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "file.trashed", eventPayload: { name: file.name } },
        {
          pending: "Movendo para a lixeira…",
          success: `"${file.name}" movido para a lixeira`,
          errorFallback: "Não foi possível mover para a lixeira",
        }
      );
    } catch (err: any) {
      console.error("Failed to move to trash:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível mover para a lixeira");
    }
  }, [getChannelId]);

  const restoreFromTrash = useCallback(async (file: TeleFile) => {
    try {
      const channelId = await getChannelId();
      const isFolder = file.mime === "inode/directory" || file.mime === "application/x-directory";
      const allFiles = useFileStore.getState().files;

      const folderPathPrefix = file.folderPath === "/"
        ? `/${file.name}`
        : `${file.folderPath}/${file.name}`;

      const updatedFiles = allFiles.map((f) => {
        if (f.id === file.id || (isFolder && (f.folderPath === folderPathPrefix || f.folderPath.startsWith(folderPathPrefix + "/")))) {
          return { ...f, trashed: false };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "file.restored", eventPayload: { name: file.name } },
        {
          pending: "Restaurando…",
          success: `"${file.name}" restaurado`,
          errorFallback: "Não foi possível restaurar",
        }
      );
    } catch (err: any) {
      console.error("Failed to restore from trash:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível restaurar");
    }
  }, [getChannelId]);

  const archiveFile = useCallback(async (file: TeleFile) => {
    try {
      const channelId = await getChannelId();
      const isFolder = file.mime === "inode/directory" || file.mime === "application/x-directory";
      const allFiles = useFileStore.getState().files;

      const folderPathPrefix = file.folderPath === "/"
        ? `/${file.name}`
        : `${file.folderPath}/${file.name}`;

      const updatedFiles = allFiles.map((f) => {
        if (f.id === file.id || (isFolder && (f.folderPath === folderPathPrefix || f.folderPath.startsWith(folderPathPrefix + "/")))) {
          return { ...f, archived: true, starred: false };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "file.archived", eventPayload: { name: file.name } },
        {
          pending: "Arquivando…",
          success: `"${file.name}" arquivado`,
          errorFallback: "Não foi possível arquivar",
        }
      );
    } catch (err: any) {
      console.error("Failed to archive:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível arquivar");
    }
  }, [getChannelId]);

  const unarchiveFile = useCallback(async (file: TeleFile) => {
    try {
      const channelId = await getChannelId();
      const isFolder = file.mime === "inode/directory" || file.mime === "application/x-directory";
      const allFiles = useFileStore.getState().files;

      const folderPathPrefix = file.folderPath === "/"
        ? `/${file.name}`
        : `${file.folderPath}/${file.name}`;

      const updatedFiles = allFiles.map((f) => {
        if (f.id === file.id || (isFolder && (f.folderPath === folderPathPrefix || f.folderPath.startsWith(folderPathPrefix + "/")))) {
          return { ...f, archived: false };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "file.unarchived", eventPayload: { name: file.name } },
        {
          pending: "Desarquivando…",
          success: `"${file.name}" movido de volta ao Meu Drive`,
          errorFallback: "Não foi possível desarquivar",
        }
      );
    } catch (err: any) {
      console.error("Failed to unarchive:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível desarquivar");
    }
  }, [getChannelId]);

  const deletePermanently = useCallback(async (fileId: string) => {
    try {
      const channelId = await getChannelId();
      const allFiles = useFileStore.getState().files;
      const fileToDelete = allFiles.find((f) => f.id === fileId);
      if (!fileToDelete) throw new Error("Arquivo não encontrado");

      const isFolder = fileToDelete.mime === "inode/directory" || fileToDelete.mime === "application/x-directory";

      let targets: TeleFile[] = [];
      let active: TeleFile[] = [];

      if (isFolder) {
        const folderPathPrefix = fileToDelete.folderPath === "/"
          ? `/${fileToDelete.name}`
          : `${fileToDelete.folderPath}/${fileToDelete.name}`;

        targets = allFiles.filter((f) => f.id === fileId || f.folderPath === folderPathPrefix || f.folderPath.startsWith(folderPathPrefix + "/"));
        active = allFiles.filter((f) => f.id !== fileId && f.folderPath !== folderPathPrefix && !f.folderPath.startsWith(folderPathPrefix + "/"));
      } else {
        targets = [fileToDelete];
        active = allFiles.filter((f) => f.id !== fileId);
      }

      await applyOptimisticWithFeedback(
        channelId,
        active,
        { eventType: "file.deleted", eventPayload: { fileId } },
        {
          pending: "Excluindo…",
          success: "Excluído permanentemente",
          errorFallback: "Não foi possível excluir",
        }
      );

      // After the index commits, asynchronously delete offline caches and
      // Telegram messages in the background. If the index save had failed,
      // applyOptimistic would have rolled back and we'd never reach here.
      void (async () => {
        try {
          await Promise.allSettled(targets.map((f) => removeOfflineCache(f.id)));
          const deletionPromises = targets
            .filter((f) => f.messageId && f.messageId !== 0)
            .map((f) =>
              deleteTelegramMessage(channelId, f.messageId).catch((err) => {
                console.warn(
                  `[deletePermanently] Could not delete message ${f.messageId} for "${f.name}":`,
                  err?.message || err
                );
              })
            );
          await Promise.allSettled(deletionPromises);
          logEvent({ type: "file.deleted.acknowledged", payload: { fileId } });
        } catch (err) {
          console.error("[deletePermanently] Background deletion error:", err);
        }
      })();
    } catch (err: any) {
      console.error("Failed to delete permanently:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível excluir");
    }
  }, [getChannelId]);

  const emptyTrash = useCallback(async () => {
    try {
      const channelId = await getChannelId();
      const allFiles = useFileStore.getState().files;
      const trashed = allFiles.filter((f) => f.trashed);
      const active = allFiles.filter((f) => !f.trashed);

      if (trashed.length === 0) {
        toast.info("A lixeira já está vazia");
        return;
      }

      await applyOptimisticWithFeedback(
        channelId,
        active,
        { eventType: "files.deleted", eventPayload: { count: trashed.length } },
        {
          pending: `Esvaziando a lixeira…`,
          success: `Lixeira esvaziada — ${trashed.length} item(ns) excluído(s) permanentemente`,
          errorFallback: "Não foi possível esvaziar a lixeira",
        }
      );

      // After the index commits, asynchronously clear cache & delete telegram messages in background
      void (async () => {
        try {
          await Promise.allSettled(trashed.map((f) => removeOfflineCache(f.id)));
          const deletionPromises = trashed
            .filter((f) => f.messageId && f.messageId !== 0)
            .map((f) =>
              deleteTelegramMessage(channelId, f.messageId).catch((err) => {
                console.warn(
                  `[emptyTrash] Could not delete message ${f.messageId} for "${f.name}":`,
                  err?.message || err
                );
              })
            );
          await Promise.allSettled(deletionPromises);
        } catch (err) {
          console.error("[emptyTrash] Background deletion error:", err);
        }
      })();
    } catch (err: any) {
      console.error("Failed to empty trash:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível esvaziar a lixeira");
    }
  }, [getChannelId]);

  const moveMultipleToTrash = useCallback(async (fileIds: string[]) => {
    if (fileIds.length === 0) return;
    try {
      const channelId = await getChannelId();
      const files = useFileStore.getState().files;
      const fileIdSet = new Set(fileIds);
      const targetFiles = files.filter((f) => fileIdSet.has(f.id));

      const folderPrefixes = targetFiles
        .filter(isFolder)
        .map(getFolderFullPath);

      const updatedFiles = files.map((f) => {
        const isInTarget = fileIdSet.has(f.id);
        const isInTrashedFolder = folderPrefixes.some(
          (prefix) => f.folderPath === prefix || f.folderPath.startsWith(prefix + "/")
        );
        if (isInTarget || isInTrashedFolder) {
          return { ...f, trashed: true };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "files.trashed", eventPayload: { count: fileIds.length } },
        {
          pending: `Movendo ${fileIds.length} itens para a lixeira…`,
          success: `${fileIds.length} item(ns) movido(s) para a lixeira`,
          errorFallback: "Não foi possível mover os itens para a lixeira",
        }
      );
    } catch (err: any) {
      console.error("Failed to move multiple to trash:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível mover os itens para a lixeira");
    }
  }, [getChannelId]);

  const restoreMultipleFromTrash = useCallback(async (fileIds: string[]) => {
    if (fileIds.length === 0) return;
    try {
      const channelId = await getChannelId();
      const files = useFileStore.getState().files;
      const fileIdSet = new Set(fileIds);
      const targetFiles = files.filter((f) => fileIdSet.has(f.id));

      const folderPrefixes = targetFiles
        .filter(isFolder)
        .map(getFolderFullPath);

      const updatedFiles = files.map((f) => {
        const isInTarget = fileIdSet.has(f.id);
        const isInRestoredFolder = folderPrefixes.some(
          (prefix) => f.folderPath === prefix || f.folderPath.startsWith(prefix + "/")
        );
        if (isInTarget || isInRestoredFolder) {
          return { ...f, trashed: false };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "files.restored", eventPayload: { count: fileIds.length } },
        {
          pending: `Restaurando ${fileIds.length} itens…`,
          success: `${fileIds.length} item(ns) restaurado(s)`,
          errorFallback: "Não foi possível restaurar os itens",
        }
      );
    } catch (err: any) {
      console.error("Failed to restore multiple from trash:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível restaurar os itens");
    }
  }, [getChannelId]);

  const deleteMultiplePermanently = useCallback(async (fileIds: string[]) => {
    if (fileIds.length === 0) return;
    try {
      const channelId = await getChannelId();
      const files = useFileStore.getState().files;
      const fileIdSet = new Set(fileIds);
      const targetFiles = files.filter((f) => fileIdSet.has(f.id));
      
      const folderPrefixes = targetFiles
        .filter(isFolder)
        .map(getFolderFullPath);

      const isTargetOrInFolder = (f: TeleFile) => {
        return fileIdSet.has(f.id) || folderPrefixes.some(
          (prefix) => f.folderPath === prefix || f.folderPath.startsWith(prefix + "/")
        );
      };

      const targets = files.filter(isTargetOrInFolder);
      const active = files.filter((f) => !isTargetOrInFolder(f));

      await applyOptimisticWithFeedback(
        channelId,
        active,
        { eventType: "files.deleted", eventPayload: { count: fileIds.length } },
        {
          pending: `Excluindo ${fileIds.length} itens…`,
          success: `${fileIds.length} item(ns) excluído(s) permanentemente`,
          errorFallback: "Não foi possível excluir os itens",
        }
      );

      // After the index commits, asynchronously clear cache & delete telegram messages in background
      void (async () => {
        try {
          await Promise.allSettled(targets.map((f) => removeOfflineCache(f.id)));
          const deletionPromises = targets
            .filter((f) => f.messageId && f.messageId !== 0)
            .map((f) =>
              deleteTelegramMessage(channelId, f.messageId).catch((err) => {
                console.warn(
                  `[deleteMultiplePermanently] Could not delete message ${f.messageId} for "${f.name}":`,
                  err?.message || err
                );
              })
            );
          await Promise.allSettled(deletionPromises);
        } catch (err) {
          console.error("[deleteMultiplePermanently] Background deletion error:", err);
        }
      })();
    } catch (err: any) {
      console.error("Failed to delete multiple permanently:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível excluir os itens");
    }
  }, [getChannelId]);

  const archiveMultiple = useCallback(async (fileIds: string[]) => {
    if (fileIds.length === 0) return;
    try {
      const channelId = await getChannelId();
      const files = useFileStore.getState().files;
      const fileIdSet = new Set(fileIds);
      const targetFiles = files.filter((f) => fileIdSet.has(f.id));

      const folderPrefixes = targetFiles
        .filter(isFolder)
        .map(getFolderFullPath);

      const updatedFiles = files.map((f) => {
        const isInTarget = fileIdSet.has(f.id);
        const isInArchivedFolder = folderPrefixes.some(
          (prefix) => f.folderPath === prefix || f.folderPath.startsWith(prefix + "/")
        );
        if (isInTarget || isInArchivedFolder) {
          return { ...f, archived: true, starred: false };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "files.archived", eventPayload: { count: fileIds.length } },
        {
          pending: `Arquivando ${fileIds.length} itens…`,
          success: `${fileIds.length} item(ns) arquivado(s)`,
          errorFallback: "Não foi possível arquivar os itens",
        }
      );
    } catch (err: any) {
      console.error("Failed to archive multiple:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível arquivar os itens");
    }
  }, [getChannelId]);

  const starMultiple = useCallback(async (fileIds: string[]) => {
    if (fileIds.length === 0) return;
    try {
      const channelId = await getChannelId();
      const files = useFileStore.getState().files;
      const fileIdSet = new Set(fileIds);
      const targetFiles = files.filter((f) => fileIdSet.has(f.id));

      const folderPrefixes = targetFiles
        .filter(isFolder)
        .map(getFolderFullPath);

      const updatedFiles = files.map((f) => {
        const isInTarget = fileIdSet.has(f.id);
        const isInTargetFolder = folderPrefixes.some(
          (prefix) => f.folderPath === prefix || f.folderPath.startsWith(prefix + "/")
        );
        if ((isInTarget || isInTargetFolder) && !f.trashed && !f.archived) {
          return { ...f, starred: true };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "files.starred", eventPayload: { count: fileIds.length } },
        {
          pending: `Salvando ${fileIds.length} itens…`,
          success: `${fileIds.length} item(ns) adicionado(s) aos favoritos`,
          errorFallback: "Não foi possível salvar os itens nos favoritos",
        }
      );
    } catch (err: any) {
      console.error("Failed to star multiple:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível salvar os itens nos favoritos");
    }
  }, [getChannelId]);

  const unarchiveMultiple = useCallback(async (fileIds: string[]) => {
    if (fileIds.length === 0) return;
    try {
      const channelId = await getChannelId();
      const files = useFileStore.getState().files;
      const fileIdSet = new Set(fileIds);
      const targetFiles = files.filter((f) => fileIdSet.has(f.id));

      const folderPrefixes = targetFiles
        .filter(isFolder)
        .map(getFolderFullPath);

      const updatedFiles = files.map((f) => {
        const isInTarget = fileIdSet.has(f.id);
        const isInArchivedFolder = folderPrefixes.some(
          (prefix) => f.folderPath === prefix || f.folderPath.startsWith(prefix + "/")
        );
        if (isInTarget || isInArchivedFolder) {
          return { ...f, archived: false };
        }
        return f;
      });

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "files.unarchived", eventPayload: { count: fileIds.length } },
        {
          pending: `Movendo ${fileIds.length} itens de volta ao Meu Drive…`,
          success: `${fileIds.length} item(ns) movido(s) para o Meu Drive`,
          errorFallback: "Não foi possível desarquivar os itens",
        }
      );
    } catch (err: any) {
      console.error("Failed to unarchive multiple:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível desarquivar os itens");
    }
  }, [getChannelId]);

  const toggleOffline = useCallback(async (file: TeleFile) => {
    return fileActionQueue.enqueue(async () => {
      try {
        const channelId = await getChannelId();
        const allFiles = useFileStore.getState().files;
        const currentFile = allFiles.find((f) => f.id === file.id);
        const nextOffline = currentFile ? !currentFile.offline : !file.offline;

        if (nextOffline) {
          toast.info(`Baixando "${file.name}" para uso offline…`);
          await cacheFileOffline(channelId, file.messageId, file.id);
        } else {
          await removeOfflineCache(file.id);
        }

        // Update the offline flag through the same optimistic + queue path
        // as every other action. This way a flood-wait on the index write
        // doesn't block the user, and the toggle stays consistent with the
        // visible files array.
        const updatedFiles = useFileStore
          .getState()
          .files.map((f) =>
            f.id === file.id ? { ...f, offline: nextOffline } : f
          );
        await applyOptimisticWithFeedback(
          channelId,
          updatedFiles,
          { eventType: "file.offlineToggled", eventPayload: { name: file.name, offline: nextOffline } },
          {
            pending: nextOffline ? "Ativando offline…" : "Removendo do offline…",
            success: nextOffline
              ? `"${file.name}" agora está disponível offline`
              : `"${file.name}" não está mais disponível offline`,
            errorFallback: "Não foi possível atualizar o status offline",
          }
        );
      } catch (err: any) {
        console.error("Failed to toggle offline availability:", err);
        if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível atualizar o status offline");
      }
    });
  }, [getChannelId]);

  const moveMultipleFilesOrFolders = useCallback(async (fileIds: string[], targetFolderPath: string) => {
    if (fileIds.length === 0) return;
    try {
      const channelId = await getChannelId();
      const normalizedTargetPath = normalizeFolderPath(targetFolderPath);
      
      const files = useFileStore.getState().files;
      const selectedIdSet = new Set(fileIds);
      const selectedFiles = files.filter((f) => selectedIdSet.has(f.id));

      if (selectedFiles.length === 0) {
        toast.info("Nada para mover");
        return;
      }

      if (normalizedTargetPath !== "/") {
        const targetFolderExists = files.some(
          (f) => isFolder(f) && getFolderFullPath(f) === normalizedTargetPath
        );
        if (!targetFolderExists) {
          throw new Error("A pasta de destino não existe mais.");
        }
      }

      const selectedFolders = selectedFiles.filter(isFolder);
      const selectedFolderPaths = selectedFolders.map((folder) => ({
        folder,
        fullPath: getFolderFullPath(folder),
      }));

      for (const { folder, fullPath } of selectedFolderPaths) {
        if (isSameOrDescendantPath(normalizedTargetPath, fullPath)) {
          throw new Error(`Não é possível mover a pasta "${folder.name}" para dentro dela mesma ou de suas subpastas.`);
        }
      }

      const rootSelectedIds = new Set<string>();
      for (const file of selectedFiles) {
        const filePath = isFolder(file) ? getFolderFullPath(file) : normalizeFolderPath(file.folderPath);
        const isCoveredBySelectedParent = selectedFolderPaths.some(
          ({ folder, fullPath }) => folder.id !== file.id && isSameOrDescendantPath(filePath, fullPath)
        );

        if (!isCoveredBySelectedParent) {
          rootSelectedIds.add(file.id);
        }
      }

      const movedRootFolders = selectedFolders
        .filter((folder) => rootSelectedIds.has(folder.id))
        .map((folder) => {
          const oldFullPath = getFolderFullPath(folder);
          const newFullPath = normalizedTargetPath === "/"
            ? `/${folder.name}`
            : `${normalizedTargetPath}/${folder.name}`;
          return { folder, oldFullPath, newFullPath };
        });
      
      const updatedFiles = files.map((f) => {
        // Files/folers explicitly selected: re-home them.
        if (rootSelectedIds.has(f.id)) {
          if (normalizeFolderPath(f.folderPath) === normalizedTargetPath) return f;
          return { ...f, folderPath: normalizedTargetPath };
        }

        for (const { oldFullPath, newFullPath } of movedRootFolders) {
          // Apply the path shift to EVERY folder entry sharing the old full
          // path — handles duplicates from the pre-fix bootstrap bug. Files
          // (non-folders) match by their `folderPath` field as before.
          if (isFolder(f) && fullPathForFolder(f) === oldFullPath) {
            return { ...f, folderPath: newFullPath };
          }
          const currentPath = normalizeFolderPath(f.folderPath);
          if (currentPath === oldFullPath) {
            return { ...f, folderPath: newFullPath };
          }
          if (currentPath.startsWith(`${oldFullPath}/`)) {
            return { ...f, folderPath: `${newFullPath}${currentPath.substring(oldFullPath.length)}` };
          }
        }

        return f;
      });

      const hasChanges = updatedFiles.some((file, index) => file !== files[index]);
      if (!hasChanges) {
        toast.info("Os itens já estão nessa pasta");
        return;
      }

      await applyOptimisticWithFeedback(
        channelId,
        updatedFiles,
        { eventType: "files.moved", eventPayload: { count: fileIds.length, target: targetFolderPath } },
        {
          pending: `Movendo ${fileIds.length} itens…`,
          success: `${fileIds.length} item(ns) movido(s)`,
          errorFallback: "Não foi possível mover os itens",
        }
      );
    } catch (err: any) {
      console.error("Failed to move items:", err);
      if (!err?.kumadriveToasted) toast.error(err.message || "Não foi possível mover os itens");
    }
  }, [getChannelId]);

  return useMemo(() => ({
    isOperating,
    createFolder,
    renameFile,
    toggleStar,
    moveToTrash,
    restoreFromTrash,
    archiveFile,
    unarchiveFile,
    deletePermanently,
    emptyTrash,
    moveMultipleToTrash,
    restoreMultipleFromTrash,
    deleteMultiplePermanently,
    starMultiple,
    archiveMultiple,
    unarchiveMultiple,
    toggleOffline,
    moveMultipleFilesOrFolders,
  }), [
    isOperating,
    createFolder,
    renameFile,
    toggleStar,
    moveToTrash,
    restoreFromTrash,
    archiveFile,
    unarchiveFile,
    deletePermanently,
    emptyTrash,
    moveMultipleToTrash,
    restoreMultipleFromTrash,
    deleteMultiplePermanently,
    starMultiple,
    archiveMultiple,
    unarchiveMultiple,
    toggleOffline,
    moveMultipleFilesOrFolders,
  ]);
}
