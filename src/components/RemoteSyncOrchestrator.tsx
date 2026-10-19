/**
 * Headless orchestrator that runs the multi-device sync loop AND the
 * scheduled-backup tick listener.
 *
 * Mounted once at the App root (post-auth). Manages the lifecycle of:
 *   - `startRemoteSync` / `stopRemoteSync` based on auth and bootstrap
 *   - `ensureTickListenerStarted` (so the Rust timer's tick events reach
 *     the snapshot sender) on app start
 *
 * Renders nothing. All state lives in module-scoped vars inside
 * remoteSync.ts / scheduler.ts.
 *
 * NOTE: Multi-device sync is now available to all authenticated users.
 * Plan checks have been removed — KumaDrive is a free application.
 */
import { useEffect } from "react";
import { useAuthStore } from "@/stores/authStore";
import { useFileStore } from "@/stores/fileStore";
import { useLicenseStore } from "@/stores/licenseStore";
import { startRemoteSync, stopRemoteSync } from "@/lib/sync/remoteSync";
import {
  applyIntervalChange,
  ensureTickListenerStarted,
  stopBackupSchedule,
} from "@/lib/backup/scheduler";
import { getStorageChannelId } from "@/lib/telegram/channelManager";

export default function RemoteSyncOrchestrator(): null {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const bootstrapComplete = useFileStore((s) => s.bootstrapComplete);
  const lastIndexMsgId = useFileStore((s) => s.lastIndexMsgId);
  const intervalMinutes =
    useLicenseStore((s) => s.license?.scheduledBackupIntervalMinutes) ?? null;

  // Effect 1 — bootstrap listener for backup ticks. Runs once on mount,
  // tears down on unmount.
  //
  // O cleanup SÓ desliga o listener de ticks. Ele NÃO chama
  // `stopBackupSchedule()`: sob StrictMode o React monta, desmonta e
  // remonta, e este Effect roda o `cleanup` no meio. Como o Effect 2
  // (o único que chama `applyIntervalChange`) tem deps
  // `[isAuthenticated, intervalMinutes]`, que não mudam no remount, ele
  // NÃO re-executa — então parar o timer Rust aqui deixava o estado
  // "listener ativo, timer parado", e o backup agendado nunca disparava
  // de novo. O timer é parado pela sessão (Effect 2) e no logout.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureTickListenerStarted();
      } catch (err) {
        if (!cancelled) console.warn("[RemoteSyncOrchestrator] tick listener failed:", err);
      }
    })();
    return () => {
      cancelled = true;
      // Só o listener; o timer Rust fica sob controle do Effect 2.
    };
  }, []);

  // Effect 2a — SESSÃO. Para timer e listener no logout / unmount.
  //
  // Deps SÓ `[isAuthenticated]`, de propósito. Este era o bug CRÍTICO da
  // auditoria: no logout o `ProtectedRoute` desmonta o
  // RemoteSyncOrchestrator no MESMO commit do re-render, então o corpo do
  // effect NUNCA roda com `!isAuthenticated` — só os cleanups. Sem
  // cleanup, o timer Rust ficava vivo para sempre após o logout e a cada
  // intervalo o `onTick` rodava deslogado, gerando `toast.error "O backup
  // agendado não pôde ser concluído"` para sempre.
  //
  // E era também o MAJOR da verificação round-2: quando o cleanup ficava
  // numa effect com deps `[isAuthenticated, intervalMinutes]`, a PRIMEIRA
  // troca de intervalo executava o cleanup — que faz `unlisten()` do
  // `kumadrive://backup-tick` — e nada o re-executava (o Effect 1, único
  // dono do `ensureTickListenerStarted`, tem deps `[]`). Timer morto +
  // listener morto até logout/restart. NÃO colocar `intervalMinutes`
  // nestas deps é a correção.
  //
  // Sob StrictMode (mount→unmount→mount) o cleanup roda e o effect
  // RE-EXECUTA no remount. Duas proteções: `stopBackupSchedule()` zera
  // `currentIntervalMinutes` de forma SÍNCRONA (o guard de idempotência
  // de `applyIntervalChange` não engole o restart do remount) e expõe a
  // `stopInFlight` promise, da qual `applyIntervalChange` espera — sem
  // isso o `start` do remount era despachado ANTES do `stop` que ainda
  // resolvia o round-trip do unlisten, e o start chegava ao Rust primeiro
  // para ser abortado logo depois.
  useEffect(() => {
    if (!isAuthenticated) {
      void stopBackupSchedule();
    }
    return () => {
      void stopBackupSchedule();
    };
  }, [isAuthenticated]);

  // Effect 2b — INTERVALO. Empurra o novo intervalo para o timer Rust.
  //
  // SEM cleanup: é esta a correção do MAJOR acima. Trocar de intervalo
  // não precisa parar nada à mão — `start_backup_scheduler` no Rust chama
  // `stop_backup_scheduler_internal` antes de criar o timer novo
  // (lib.rs:184), então basta despachar o start com o intervalo novo. E
  // o listener de ticks não é tocado aqui: dono é o Effect 1.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (intervalMinutes === null || intervalMinutes <= 0) {
      void applyIntervalChange(null);
      return;
    }
    void applyIntervalChange(intervalMinutes);
  }, [isAuthenticated, intervalMinutes]);

  // Effect 3 — react to auth + bootstrap changes. Start the remote sync
  // loop when all pre-conditions are met; stop on any pre-condition failing.
  // Multi-device sync is now available to ALL authenticated users.
  useEffect(() => {
    if (!isAuthenticated || !bootstrapComplete) {
      stopRemoteSync();
      return;
    }

    let cancelled = false;
    let retryHandle: ReturnType<typeof setTimeout> | null = null;

    async function tryStart(): Promise<void> {
      if (cancelled) return;
      try {
        const phone = useAuthStore.getState().phoneNumber;
        const channelId = await getStorageChannelId(phone);
        if (cancelled) return;
        if (channelId) {
          startRemoteSync(channelId);
        }
      } catch (err) {
        console.warn(
          "[RemoteSyncOrchestrator] channel id not ready, retrying in 2s:",
          err,
        );
        retryHandle = setTimeout(tryStart, 2000);
      }
    }

    void tryStart();

    return () => {
      cancelled = true;
      if (retryHandle) clearTimeout(retryHandle);
      stopRemoteSync();
    };
  }, [isAuthenticated, bootstrapComplete, lastIndexMsgId]);

  return null;
}
