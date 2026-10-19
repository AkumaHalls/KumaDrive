/**
 * useBackupRunner — React hook that drives `runBackup()` for the
 * "Run backup now" button, and pipes progress into the singleton
 * `useBackupProgressStore` so a global overlay can show it.
 *
 * State shape
 * -----------
 * Local: `AbortController` for cancel + a `isRunning` flag for the
 *   triggering button's spinner.
 * Global (via backupProgressStore): active / uploaded / total /
 *   currentFile / lastResult — consumed by BackupProgressOverlay
 *   regardless of where the run was kicked off from.
 *
 * Cancellation: clicking the overlay's Cancel button aborts the local
 * AbortController; the runner sees it on the next file boundary.
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { runBackup, type BackupTrigger } from "@/lib/backup/runner";
import { useBackupProgressStore } from "@/stores/backupProgressStore";

export interface UseBackupRunner {
  /** True iff a manual run is currently in flight (triggered by THIS hook). */
  isRunning: boolean;
  /** Trigger a manual backup right now. No-op if already running. */
  runNow: () => Promise<void>;
  /** Cancel the in-flight manual run. */
  cancel: () => void;
}

export function useBackupRunner(): UseBackupRunner {
  const [isRunning, setIsRunning] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  // Verdadeiro entre o clique em "Cancelar" e o fim do run. Sem isso o
  // `finish()` sobrescreveria o status de cancelado.
  const cancelledRef = useRef(false);

  const start = useBackupProgressStore((s) => s.start);
  const setProgress = useBackupProgressStore((s) => s.setProgress);
  const finish = useBackupProgressStore((s) => s.finish);
  const fail = useBackupProgressStore((s) => s.fail);
  const cancelStore = useBackupProgressStore((s) => s.cancel);
  const setCancelHandler = useBackupProgressStore((s) => s.setCancelHandler);

  const runNow = useCallback(async () => {
    // Duas guardas, não uma. A antiga checava SÓ `isRunning` (estado
    // LOCAL deste hook) — e o botão era desabilitado por
    // `indexQueueState === "backup-running"`, um campo que o PRÓPRIO
    // IndexQueue sobrescreve para "saving"/"idle" já no primeiro
    // `enqueueSave` do run agendado. Resultado: durante quase todo um
    // backup agendado o botão ficava liberado, o clique partia um run
    // MANUAL por cima, o `start("manual")` resetava o overlay e o
    // `setCancelHandler` substituía o do tick — o Cancelar do overlay
    // passava a apontar para o controller manual (apenas enfileirado no
    // BackupMutex). Clicar abortava o manual (no-op) e deixava o
    // agendado rodando para sempre sem cancelamento possível.
    //
    // `progress.active` é o dono da verdade: é setado por `start()` e
    // limpo só por `finish`/`fail`/`cancel`, independentemente de quem
    // iniciou o run.
    const progress = useBackupProgressStore.getState();
    if (isRunning || progress.active) {
      // O botão já aparece desabilitado enquanto isso, mas o clique
      // programático (teclado/automação) ainda pode passar. Sem este
      // aviso, o segundo disparo simplesmente sumiria. O agendador NÃO
      // passa por aqui — ele chama `runBackup` diretamente, com a própria
      // guarda de run ativo em `scheduler.ts`.
      toast.info("Já existe um backup em andamento.");
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    cancelledRef.current = false;
    setIsRunning(true);
    start("manual");
    // Registra o cancelamento com o overlay: o botão Cancelar do painel
    // chama `cancelRun()` da store, que despacha para cá. Sem isto o
    // overlay não teria como abortar o run manual (só o botão do
    // /settings conhecia o controller).
    //
    // A lógica é inline (não reutiliza `cancel`) porque `cancel` é um
    // useCallback definido DEPOIS deste — referenciá-lo aqui criaria uma
    // dependência para frente nas deps do `useCallback` de `runNow`.
    //
    // `setCancelHandler` devolve um disposer CONDICIONAL: anula o handler
    // só se ele ainda for o registrado. Sem isso, o `finally` deste run
    // cancelado apagava o handler de um run que tivesse começado durante
    // o dreno (cancel → active=false → tick passa pela guarda do
    // scheduler) — o Cancelar do overlay ficava mudo durante o run
    // agendado todo.
    const disposeCancelHandler = setCancelHandler(() => {
      controller.abort();
      cancelledRef.current = true;
      cancelStore();
    });
    try {
      const result = await runBackup({
        triggeredBy: "manual" as BackupTrigger,
        signal: controller.signal,
        onProgress: (p) => setProgress(p),
      });

      // Cancelamento ATRASADO vs. run 100% concluído. O cancel chega por
      // fora do loop: a janela entre o último `await` do último arquivo e
      // a checagem aqui é real (inclui o `enqueueSave` do último arquivo).
      // Se o usuário clica Cancelar durante esse trecho, `abort()` é
      // no-op (nada mais a abortar), `cancelStore()` grava "cancelled" —
      // e o runner retorna um run COMPLETO. Sem a checagem de
      // completude, o overlay anunciava "Backup cancelado — 412 enviados
      // mantidos" para um run que terminou 100%, e `lastResult` ficava
      // defasado (o resumo do /settings mostrava o run ANTERIOR).
      //
      // `!result.walkTruncated` fecha o buraco do outro lado. A caminhada
      // TRUNCA a lista no abort (walker.ts), então `totalFound` vira
      // limite inferior — e a igualdade abaixo passava a ser verdadeira
      // trivialmente: cancelar durante a verredura de pastas terminava
      // como "Backup concluído" com toast de sucesso, contradizendo o
      // clique do usuário.
      const fullyCompleted =
        !result.walkTruncated &&
        result.filesUploaded + result.filesSkipped === result.totalFound &&
        result.filesFailed === 0;

      if (cancelledRef.current && !fullyCompleted) {
        toast.info("Backup cancelado", {
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

      // O runner NÃO lança: todo guard e falha de upload sai como
      // `status` + `error` no resultado. Sem este bloco o erro ficava
      // preso no store, e o usuário clicasse "Fazer backup agora" sem
      // ver absolutamente nada acontecer.
      if (result.status === "failed") {
        toast.error("O backup não pôde ser concluído", {
          description: result.error ?? "Erro desconhecido.",
          duration: 10000,
        });
      } else if (result.status === "partial") {
        // `partial` carrega um aviso que não pode ser engolido: hoje
        // significa "os arquivos subiram mas o manifesto não foi
        // gravado", então o próximo run reenvia tudo. O `finish()` do
        // store mapeia qualquer coisa ≠ "failed" para `status: "done"`,
        // e o overlay só renderiza `error` quando o status é "failed" —
        // sem este ramo, a degradação que eu criei no runner morria
        // aqui e o usuário veria um verde "concluído".
        toast.warning("Backup concluído com ressalvas", {
          description:
            result.error ??
            "Alguns arquivos podem ser enviados novamente na próxima execução.",
          duration: 12000,
        });
      } else if (result.filesUploaded === 0 && result.filesFailed === 0) {
        toast.success("Backup concluído", {
          description: `${result.filesSkipped} arquivo(s) já estavam atualizados. Nada novo para enviar.`,
        });
      } else {
        const parts = [
          `${result.filesUploaded} enviado(s)`,
          `${result.filesSkipped} sem alteração`,
        ];
        if (result.filesFailed > 0) parts.push(`${result.filesFailed} com falha`);
        toast.success("Backup concluído", {
          description: parts.join(" · "),
        });
      }

      if (result.missingFolders?.length) {
        toast.warning("Algumas pastas de origem não foram encontradas", {
          description: result.missingFolders.join("\n"),
          duration: 10000,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The runner is supposed to never throw — failures surface in
      // result.status. This catch is a safety net for unexpected throws.
      fail(msg);
      toast.error("O backup falhou inesperadamente", {
        description: msg,
      });
    } finally {
      setIsRunning(false);
      controllerRef.current = null;
      // Handler órfão: sem isto, clicar Cancelar num run futuro antes do
      // `start()` re-registrar poderia abortar o controller antigo (já
      // terminado, no-op) e gravar "cancelled" na store errada. O
      // disposer é condicional — não apaga o handler de um run iniciado
      // durante o dreno deste.
      disposeCancelHandler();
    }
  }, [isRunning, start, setProgress, finish, fail, cancelStore, setCancelHandler]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    cancelStore();
    // `cancelStore` marca "cancelled" na hora, mas o runner ainda está
    // no meio do arquivo atual: quando ele desfaz, `finish()` roda e
    // sobrescreve o status para "done". O usuário via "Backup cancelado"
    // e, um instante depois, "Backup concluído — N enviados" — parecendo
    // que o cancelamento não funcionou.
    //
    // `cancelledRef` faz o `finish` respeitar o cancelamento. É local a
    // este hook porque `controllerRef.current` já é nullado no `finally`.
    cancelledRef.current = true;
  }, [cancelStore]);

  return {
    isRunning,
    runNow,
    cancel,
  };
}