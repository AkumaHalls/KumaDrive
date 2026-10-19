/**
 * IndexQueuePill — indicador flutuante do estado da fila de índice.
 *
 * Por que vive num arquivo próprio (e não dentro do DriveLayout):
 * este pill é o ÚNICO aviso de "falha ao salvar o índice" e o único
 * acesso ao botão "Tentar novamente". Ele fica preso ao `/drive`
 * historicamente, mas `/settings` é ROTA IRMÃ — não filha do
 * DriveLayout. Ou seja: com o pill preso ao DriveLayout, um hard-error
 * do índice não tinha indicador nenhum enquanto o usuário estava em
 * Configurações, inclusive na tela de Backup, que é justamente onde
 * ele fica esperando um backup longo.
 *
 * Mesmo padrão aplicado ao `BackupProgressOverlay` e ao `<Toaster />`:
 * feedback global mora na raiz do App, não dentro de uma rota.
 */
import React from "react";
import { AlertTriangle, Cloud, Shield, Loader2, RefreshCw } from "lucide-react";
import { useFileStore } from "@/stores/fileStore";
import { useAuthStore } from "@/stores/authStore";
import { cn } from "@/lib/utils";

export const IndexQueuePill = React.memo(function IndexQueuePill() {
  const isSyncing = useFileStore((state) => state.isSyncing);
  const indexQueueState = useFileStore((state) => state.indexQueueState);
  const indexQueueRetryInSec = useFileStore((state) => state.indexQueueRetryInSec);
  const indexQueueError = useFileStore((state) => state.indexQueueError);

  if (
    indexQueueState !== "failed" &&
    indexQueueState !== "retrying" &&
    (!isSyncing || indexQueueState !== "saving") &&
    indexQueueState !== "syncing-remote" &&
    indexQueueState !== "backup-running"
  ) {
    return null;
  }

  return (
    <div
      title={
        indexQueueState === "failed"
          ? indexQueueError ?? "Falha ao salvar o índice — clique para tentar novamente"
          : indexQueueState === "retrying" && indexQueueError
          ? indexQueueError
          : indexQueueState === "syncing-remote"
          ? "Sincronização ao vivo entre dispositivos"
          : indexQueueState === "backup-running"
          ? "Backup em andamento"
          : undefined
      }
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 rounded-full select-none animate-in fade-in duration-200 border text-xs",
        indexQueueState === "failed"
          ? "bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700/50 text-amber-800 dark:text-amber-200"
          : indexQueueState === "syncing-remote" || indexQueueState === "backup-running"
          ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-200"
          : "bg-[#edf2fc] dark:bg-[#282a2c] border-transparent text-[#444746] dark:text-[#c4c7c5]"
      )}
    >
      {indexQueueState === "failed" ? (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      ) : indexQueueState === "syncing-remote" ? (
        <Cloud className="h-3.5 w-3.5 shrink-0" />
      ) : indexQueueState === "backup-running" ? (
        <Shield className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#0b57d0] shrink-0" />
      )}
      <span className="text-[11px] font-semibold">
        {indexQueueState === "failed"
          ? "Falha ao salvar"
          : indexQueueState === "retrying" && indexQueueRetryInSec > 0
          ? `Tentando novamente em ${indexQueueRetryInSec}s`
          : indexQueueState === "syncing-remote"
          ? "Sincronizado"
          : indexQueueState === "backup-running"
          ? "Backup em andamento"
          : "Sincronizando"}
      </span>
      {indexQueueState === "failed" && (
        <button
          type="button"
          onClick={() => {
            const fn = (window as any).__kumadriveRetryIndex;
            const phone = useAuthStore.getState().phoneNumber;
            if (typeof fn === "function" && phone) {
              import("@/lib/secure/vault").then(({ getSecret, channelIdKey, VAULT_KEY_CHANNEL_ID }) =>
                getSecret(channelIdKey(phone))
                  .then((cid) => cid || getSecret(VAULT_KEY_CHANNEL_ID))
                  .then((cid) => cid && fn(cid))
                  .catch(() => fn(phone))
              );
            }
          }}
          className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-200/80 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 text-[10px] font-semibold uppercase tracking-wide cursor-pointer"
        >
          <RefreshCw className="h-3 w-3" />
          Tentar novamente
        </button>
      )}
    </div>
  );
});

export default IndexQueuePill;