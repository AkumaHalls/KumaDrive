/**
 * Backup scheduler — JS-side wrapper around the Rust timer commands.
 *
 * The Rust side (src-tauri/src/lib.rs) owns the timer via
 * `start_backup_scheduler(interval_minutes)` / `stop_backup_scheduler()`.
 * When the timer fires, it emits a `kumadrive://backup-tick` Tauri event
 * into the webview. This module:
 *   1. Forwards interval changes to Rust.
 *   2. Listens for tick events and dispatches them to `runBackup` (the
 *      real device-backup orchestrator in `./runner`).
 *   3. Surfaces status to the React layer (currently via fileStore).
 *
 * The interval value is the source of truth in `licenseStore.license.
 * scheduledBackupIntervalMinutes` — when the user picks a new interval,
 * `setProSchedule` updates both the backend AND triggers
 * `applyIntervalChange(intervalMinutes)` here so the timer restarts with
 * the new value.
 *
 * Replaces the previous "metadata-only snapshot" pipeline. The old
 * `takeSnapshot` is preserved in `./snapshot` for the historical audit
 * trail (the text-message breadcrumb it posts is still useful as a
 * timestamped marker in the channel), but it is no longer the active
 * "what runs when the timer fires" path. That's `runBackup` now — it
 * actually walks source folders and uploads real files.
 */
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { runBackup } from "./runner";
import { useAuthStore } from "@/stores/authStore";
import { useFileStore } from "@/stores/fileStore";
import { useBackupProgressStore } from "@/stores/backupProgressStore";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

let tickUnlisten: UnlistenFn | null = null;
let currentIntervalMinutes: number | null = null;

/**
 * `stopBackupSchedule()` em voo. Usado para SERIALIZAR stop → start.
 *
 * Sem isto havia uma corrida real (MAJOR da verificação round-2): o
 * cleanup do effect de sessão chama `void stopBackupSchedule()`, que
 * suspendia no `await unlisten()` — e, enquanto o round-trip do unlisten
 * não resolvia, o remount do StrictMode (ou a troca de intervalo)
 * despachava `start_backup_scheduler` primeiro. O `stop` chegava DEPOIS
 * e abortava o timer recém-criado no Rust: timer morto até logout ou
 * restart do app. `applyIntervalChange` agora espera esta promise antes
 * de despachar o start.
 */
let stopInFlight: Promise<void> | null = null;

/**
 * Pending `ensureTickListenerStarted` call, shared across invocations.
 *
 * Sob StrictMode o React monta → desmonta → remonta de forma SÍNCRONA.
 * Sem este memo, as duas chamadas entravam em `await listen(...)` ao
 * mesmo tempo. Quando a segunda resolvia, a primeira ainda não tinha
 * gravado `tickUnlisten`, então o cleanup cedo não achava nada — e o
 * listener da primeira chamada ficava VIVAZADO para sempre (nunca
 * removível). Resultado: cada tick disparava `onTick` duas vezes, dois
 * runs serializados e dois toasts "Backup agendado concluído".
 */
let tickListenerPromise: Promise<void> | null = null;

/**
 * Apply a new interval. Pass null to stop the timer entirely. Pass a
 * positive integer (1..10080) to (re)start it with the new cadence.
 *
 * Idempotent: calling with the same value is a no-op (Rust timer handles
 * the case of restarting with the same interval — start first calls stop,
 * so any interval change is honored).
 */
export async function applyIntervalChange(intervalMinutes: number | null): Promise<void> {
  // Espera um stop em voo. No remount do StrictMode, o cleanup do effect de
  // sessão dispara `stopBackupSchedule()` (que suspende no unlisten) e o
  // setup do effect de intervalo chama isto — sem a espera, o `start` era
  // despachado primeiro e o `stop` que chegava depois abortava o timer
  // novo no Rust.
  if (stopInFlight) {
    try {
      await stopInFlight;
    } catch {
      /* o stop já logou o próprio erro */
    }
  }
  // Re-checa o guard DEPOIS de esperar: o intervalo pode ter mudado
  // enquanto aguardávamos o stop.
  if (intervalMinutes === currentIntervalMinutes) {
    return;
  }
  currentIntervalMinutes = intervalMinutes;
  try {
    if (intervalMinutes === null || intervalMinutes <= 0) {
      await invoke("stop_backup_scheduler");
      return;
    }
    await invoke("start_backup_scheduler", { intervalMinutes });
  } catch (err) {
    console.warn("[backup.scheduler] Tauri command failed:", err);
    currentIntervalMinutes = null; // back to "unknown" so a retry is possible
    throw err;
  }
}

/**
 * Start listening for tick events. Idempotent: tears down any existing
 * listener first so a re-start (e.g. on logout/login) doesn't double-fire.
 *
 * Concurrency-safe via `tickListenerPromise`: um segundo chamador enquanto
 * a primeira chamada ainda espera o `listen` recebe a MESMA promise, então
 * só existe um `listen` em voo por vez.
 */
export async function ensureTickListenerStarted(): Promise<void> {
  if (tickListenerPromise) {
    return tickListenerPromise;
  }
  tickListenerPromise = (async () => {
    try {
      if (tickUnlisten) {
        await tickUnlisten();
        tickUnlisten = null;
      }
      tickUnlisten = await listen("kumadrive://backup-tick", async () => {
        await onTick();
      });
    } finally {
      tickListenerPromise = null;
    }
  })();
  return tickListenerPromise;
}

/**
 * Stop listening for tick events and stop the Rust timer. Used by logout.
 */
export async function stopBackupSchedule(): Promise<void> {
  // Sincrono ANTES dos awaits — este detalhe evita um engolir do restart
  // sob StrictMode. `stopBackupSchedule` é invocado do cleanup do Effect
  // 2a como `void stopBackupSchedule()`: o corpo executa até o primeiro
  // `await` e devolve. O remount síncrono do StrictMode re-executa o
  // effect e chama `applyIntervalChange(intervalMinutes)` — se
  // `currentIntervalMinutes` ainda guardasse o valor antigo (ex.: 60), o
  // guard de idempotência de `applyIntervalChange` engolia o restart, o
  // invoke do stop resolvia depois, zerava a variável, e o timer Rust
  // ficava morto até o usuário trocar o intervalo. Zerando antes de
  // qualquer await, o guard do remount sempre deixa o restart passar.
  currentIntervalMinutes = null;
  const work = (async () => {
    if (tickUnlisten) {
      await tickUnlisten();
      tickUnlisten = null;
    }
    try {
      await tauriInvoke("stop_backup_scheduler");
    } catch (err) {
      console.warn("[backup.scheduler] stop_backup_scheduler failed:", err);
    }
  })();
  // Expõe o stop EM VOO. `applyIntervalChange` espera esta promise antes
  // de despachar o start — sem isso, no remount do StrictMode o `start`
  // saía primeiro (o cleanup só suspenderia no `await unlisten`) e chegava
  // ao Rust antes do `stop`, que então abortava o timer recém-criado.
  stopInFlight = work;
  try {
    await work;
  } finally {
    if (stopInFlight === work) stopInFlight = null;
  }
}

/**
 * Tick handler. Called by the Tauri event listener. Runs the real device
 * backup (walker → manifest diff → incremental upload → audit row).
 *
 * Pipes progress into the singleton progress store so the bottom-right
 * overlay can render the run regardless of whether the user is on the
 * Settings page or browsing files.
 *
 * Três defesas que a versão anterior não tinha (auditoria click-path):
 *
 *   1. GUARDA DE AUTH — o timer Rust é do PROCESSO, não da sessão. Sem
 *      esta checagem, um usuário que desloga sem fechar o app continuava
 *      recebendo ticks a cada intervalo, e `runBackup` falhava no guard
 *      de pastas (zeradas no logout) gerando `toast.error` "O backup
 *      agendado não pôde ser concluído" para sempre.
 *
 *   2. GUARDA DE RUN ATIVO — o `BackupMutex` serializa o trabalho, mas o
 *      `start()` + `setIndexQueueState("backup-running")` gravavam ESTADO
 *      da UI imediatamente, antes do mutex. Um tick durante um backup
 *      manual zera o overlay ("Verificando pastas… 0/0"), depois o run
 *      manual anuncia "done", e aí o tick roda inteiro e o overlay pisca
 *      de volta — o usuário via o backup "concluir" e recomeçar sozinho.
 *
 *   3. SINAL DE CANCELAMENTO — antes, o backup agendado era impossível de
 *      cancelar em qualquer tela (o overlay não tem botão e o /settings
 *      só cancela runs manuais). Agora cada tick registra o próprio
 *      AbortController na store via `setCancelHandler`, e o botão
 *      Cancelar do overlay despacha para cá.
 */
async function onTick(): Promise<void> {
  // (1) Só roda logado. O timer Rust sobrevive ao logout dentro do mesmo
  // processo; sem isto o usuário deslogado recebia erro de backup a cada
  // intervalo, para sempre.
  if (!useAuthStore.getState().isAuthenticated) {
    await invoke("log_vault_state", {
      state: "BACKUP_TICK_SKIP reason=logged_out",
    }).catch(() => {});
    return;
  }

  // (2) Só roda se não houver outro backup em andamento. O overlay e o
  // pill ficariam se alternando entre dois runs, e o usuário veria um
  // backup "concluir" e recomeçar.
  const progress = useBackupProgressStore.getState();
  if (progress.active) {
    await invoke("log_vault_state", {
      state: "BACKUP_TICK_SKIP reason=run_in_progress",
    }).catch(() => {});
    return;
  }

  const setIndexQueueState = useFileStore.getState().setIndexQueueState;
  const start = useBackupProgressStore.getState().start;
  const setProgress = useBackupProgressStore.getState().setProgress;
  const finish = useBackupProgressStore.getState().finish;
  const setCancelHandler = useBackupProgressStore.getState().setCancelHandler;
  const cancelStore = useBackupProgressStore.getState().cancel;

  // O `indexQueueState` pertence ao IndexQueue, não ao scheduler. Salvamos
  // o valor de entrada e o `finally` o devolve APENAS se a nossa marcação
  // ainda estiver de pé — devolver `"idle"` fixo apagava um estado
  // pré-existente (ex.: um "failed" sticky) quando o run não chamava
  // `enqueueSave` nenhuma vez (no-op: tudo inalterado).
  const previousQueueState = useFileStore.getState().indexQueueState;
  setIndexQueueState("backup-running");
  start("auto");
  // O overlay ganhou um botão Cancelar; aqui registramos o caminho
  // AGENDADO. Antes, um backup de horas era impossível de interromper
  // em qualquer tela — o overlay era só-leitura e o /settings só
  // cancelava runs manuais.
  //
  // `setCancelHandler` devolve um disposer CONDICIONAL: ele só anula o
  // handler se este ainda for o registrado. Sem isso, o `finally` de um
  // tick cancelado apagava o handler de um run que tivesse começado
  // durante o dreno — o Cancelar do overlay ficava mudo (clique chamava
  // `cancelRun()` com handler null: nenhum efeito, nenhum feedback).
  const controller = new AbortController();
  const disposeCancelHandler = setCancelHandler(() => {
    controller.abort();
    cancelStore();
  });
  try {
    const result = await runBackup({
      triggeredBy: "auto",
      signal: controller.signal,
      onProgress: (p) => setProgress(p),
    });
    // Cancelamento atrasado (mesmo caso do caminho manual em
    // useBackupRunner): o usuário pode clicar Cancelar no overlay durante
    // o último trecho sem await do run. Aí o `abort()` é no-op,
    // `cancelStore()` grava "cancelled" — e um `finish()` depois disso
    // SOBRESCREVERIA para "done", anunciando "concluído" logo depois de
    // "cancelado". Checamos ANTES do finish justamente por isso. Se o
    // run terminou COMPLETO, o resumo é a verdade e prevalece.
    //
    // `!result.walkTruncated` é obrigatório: a caminhada trunca a lista no
    // abort, então `totalFound` vira limite INFERIOR e a igualdade abaixo
    // era verdadeira TRIVIALMENTE — cancelar durante a caminhada terminava
    // como "Backup concluído" com toast de sucesso.
    const fullyCompleted =
      !result.walkTruncated &&
      result.filesUploaded + result.filesSkipped === result.totalFound &&
      result.filesFailed === 0;
    if (controller.signal.aborted && !fullyCompleted) {
      toast.info("Backup agendado cancelado", {
        description: `${result.filesUploaded} arquivo(s) já enviados antes do cancelamento foram mantidos.`,
      });
      return;
    }

    finish({
      filesUploaded: result.filesUploaded,
      filesSkipped: result.filesSkipped,
      filesFailed: result.filesFailed,
      status: result.status,
      error: result.error,
    });

    // Mesmo argumento do `catch`: um agendamento que roda sem ninguém
    // olhando precisa dizer o que aconteceu. Sem isto, o backup podia
    // falhar toda noite e o usuário nunca souberia.
    //
    // Ramo `partial` (manifesto não gravado → próximo run reenvia TUDO)
    // é degradação com cara de sucesso — no caminho manual já tínhamos o
    // `toast.warning`, e aqui faltava.
    if (result.status === "failed") {
      toast.error("O backup agendado não pôde ser concluído", {
        description: result.error ?? "Erro desconhecido.",
        duration: 12000,
      });
    } else if (result.status === "partial") {
      toast.warning("Backup agendado concluído com ressalvas", {
        description: result.error
          ? `${result.filesUploaded} enviado(s), mas o índice não foi totalmente gravado: ${result.error}`
          : `${result.filesUploaded} enviado(s), mas o índice não foi totalmente gravado.`,
        duration: 12000,
      });
    } else {
      toast.success("Backup agendado concluído", {
        description:
          result.filesUploaded > 0
            ? `${result.filesUploaded} arquivo(s) enviados · ${result.filesSkipped} sem alteração`
            : `${result.filesSkipped} arquivo(s) já estavam atualizados.`,
      });
    }

    if (result.missingFolders?.length) {
      toast.warning("Pastas de origem inacessíveis no backup agendado", {
        description: result.missingFolders.join("\n"),
        duration: 12000,
      });
    }
  } catch (err) {
    console.warn("[backup.scheduler] onTick failed:", err);
    finish({
      filesUploaded: 0,
      filesSkipped: 0,
      filesFailed: 0,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    // Backup agendado rodando com o usuário provavelmente longe da tela.
    // Sem este aviso, uma falha só aparecia se ele abrisse a tela de
    // Backup — podia passar semanas sem rodar e sem ninguém saber.
    toast.error("O backup agendado falhou", {
      description: err instanceof Error ? err.message : String(err),
      duration: 12000,
    });
  } finally {
    // Handler órfão deste tick. O disposer só anula se o handler ainda
    // for o nosso — um run iniciado durante o dreno (cancel → active=false
    // → tick passa pela guarda) registrou o dele depois e sobrevive.
    disposeCancelHandler();
    // Desfaz a nossa escrita RESTAURANDO o valor de entrada, mas só se
    // ninguém mais tiver escrito desde então. Três formas de errar que
    // já foram estudadas:
    //
    //  a) Restaurar incondicionalmente (versão original): se durante o
    //     run a fila terminasse em "failed" (último `enqueueSave` em
    //     hard-error), o finally regravava por cima — o pill deixava de
    //     mostrar "Falha ao salvar" e sumia o botão "Tentar novamente".
    //
    //  b) Restaurar STALE: se no início do tick a fila estava em
    //     "retrying" e, durante o run, ela CONCLUIU (→ "idle"), a
    //     restauração regravava "retrying" — pill preso em "Tentando
    //     novamente em Xs" com o countdown já parado, até uma transição
    //     futura que podia nunca vir.
    //
    //  c) Restaurar `"idle"` fixo (correção intermediária): se a fila já
    //     estava em "failed" ANTES do tick (sticky: sem retryTimer, não
    //     auto-restaura) e o run era no-op (nunca chamou `enqueueSave`),
    //     a condição ainda via a nossa marcação e o `"idle"` fixo apagava
    //     o "failed" pré-existente.
    //
    // Snapshot + condição cobrem tudo: a condição descarta (a) e (b)
    // (só restauramos se ninguém escreveu durante o run); o snapshot
    // descarta (c) (restauramos o valor REAL de entrada). O IndexQueue é
    // o dono do campo — o scheduler só desfaz o que ele próprio marcou.
    if (useFileStore.getState().indexQueueState === "backup-running") {
      setIndexQueueState(previousQueueState);
    }
  }
}