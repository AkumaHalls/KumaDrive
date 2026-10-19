/**
 * useBackupProgressStore — singleton (zustand) store that any caller can
 * write to and the bottom-right progress overlay can read from.
 *
 * Why a store, not a hook state
 * -----------------------------
 * The backup runner lives in lib/backup/runner.ts and gets invoked from
 * three places:
 *   1. The "Run backup now" button in BackupSection.tsx
 *   2. The Rust scheduler's `kumadrive://backup-tick` event
 *   3. (Future) a tray menu "Backup now" item
 *
 * All three need to drive the same overlay — so the source of truth has
 * to outlive any single component's lifetime. The user can also
 * navigate AWAY from Settings while a backup is running, and the overlay
 * should stay visible. A zustand store survives unmount.
 *
 * The runner doesn't import this directly — instead, the hook layer
 * (useBackupRunner) translates onProgress callbacks into setState calls
 * here. Keeps the runner pure.
 */
import { create } from "zustand";

export type BackupRunStatus = "idle" | "walking" | "uploading" | "done" | "failed" | "cancelled";

export interface BackupProgressState {
  /** True while a run is in flight (between runBackup() start and end). */
  active: boolean;
  /** Coarse-grained phase for the overlay label. */
  status: BackupRunStatus;
  /** "manual" or "auto" — used to label the overlay. */
  triggeredBy: "manual" | "auto" | null;
  /** Unix-ms when the current run started. */
  startedAt: number | null;
  /** Unix-ms when the run finished (set when active flips back to false). */
  finishedAt: number | null;
  /** Files processed so far (uploaded + failed). */
  uploaded: number;
  /** Total files queued for upload. Unknown until the walker finishes. */
  total: number;
  /** Absolute path of the file currently being processed (best-effort). */
  currentFile: string;
  /** Summary from the most-recent completed run. Survives until the next run. */
  lastResult: {
    filesUploaded: number;
    filesSkipped: number;
    filesFailed: number;
    status: "success" | "partial" | "failed";
  } | null;
  /** Error message if the run failed. */
  error: string | null;
  /**
   * Per-chunk retry state, surfaced to the overlay so a FLOOD_WAIT
   * pause looks like progress ("Retrying 3/5 — waiting 30s") rather
   * than a frozen counter. Cleared when the chunk succeeds, when the
   * file moves on, or when the run finishes.
   */
  retry: {
    /** 1-indexed attempt that just failed. */
    attempt: number;
    /** Total attempts allowed. */
    maxAttempts: number;
    /** Milliseconds we are about to wait before the next attempt. */
    waitMs: number;
    /** Telegram's FLOOD_WAIT, if this retry was triggered by one. */
    floodSeconds: number | null;
  } | null;

  // Actions
  start: (triggeredBy: "manual" | "auto") => void;
  setWalking: () => void;
  setProgress: (info: { uploaded: number; total: number; currentFile: string }) => void;
  setRetry: (info: {
    attempt: number;
    maxAttempts: number;
    waitMs: number;
    floodSeconds: number | null;
  }) => void;
  clearRetry: () => void;
  finish: (result: {
    filesUploaded: number;
    filesSkipped: number;
    filesFailed: number;
    status: "success" | "partial" | "failed";
    error: string | null;
  }) => void;
  fail: (error: string) => void;
  cancel: () => void;
  /**
   * Handler de cancelamento do run ATUAL, registrado pelo caminho dono
   * do run (o hook manual ou o scheduler). O overlay chama isto pelo seu
   * botão Cancelar — antes, o overlay não tinha botão nenhum, então um
   * backup AGENDADO era impossível de cancelar em qualquer tela.
   */
  setCancelHandler: (fn: (() => void) | null) => () => void;
  cancelRun: () => void;
  /** Clear the last-result so the overlay can auto-dismiss. */
  clear: () => void;
}

/**
 * Handler do cancelamento do run atual. Variável de módulo (fora do
 * state) para não provocar re-render a cada troca de função.
 *
 * O overlay chama `cancelRun()` pelo botão Cancelar. Cada caminho dono
 * do run registra o próprio abort aqui:
 *   - useBackupRunner (manual) → aborta o AbortController do hook
 *   - scheduler.onTick (agendado) → aborta o AbortController do tick
 *
 * Sem isto, um backup AGENDADO era in-cancelável em qualquer tela: o
 * overlay não tinha botão e o /settings só cancelava runs manuais.
 */
let cancelRunHandler: (() => void) | null = null;

export const useBackupProgressStore = create<BackupProgressState>((set) => ({
  active: false,
  status: "idle",
  triggeredBy: null,
  startedAt: null,
  finishedAt: null,
  uploaded: 0,
  total: 0,
  currentFile: "",
  lastResult: null,
  error: null,
  retry: null,

  start: (triggeredBy) => {
    // Um run novo descarta o handler do run anterior: sem isto, um
    // handler órfão de um run cancelado/finalizado poderia abortar o
    // run seguinte quando o usuário clicasse Cancelar no overlay.
    cancelRunHandler = null;
    set({
      active: true,
      status: "walking",
      triggeredBy,
      startedAt: Date.now(),
      finishedAt: null,
      uploaded: 0,
      total: 0,
      currentFile: "",
      error: null,
      retry: null,
    });
  },

  setWalking: () => set({ status: "walking", uploaded: 0, total: 0, retry: null }),

  setProgress: ({ uploaded, total, currentFile }) =>
    set({ status: "uploading", uploaded, total, currentFile, retry: null }),

  setRetry: (info) => set({ retry: info }),

  clearRetry: () => set({ retry: null }),

  finish: (result) =>
    set({
      active: false,
      status: result.status === "failed" ? "failed" : "done",
      finishedAt: Date.now(),
      // `lastResult` é SEMPRE sobrescrito, inclusive numa falha. Como
      // `clear()` não o apaga mais, mantê-lo de um run anterior fazia a
      // tela de Backup mostrar "412 enviados, 0 sem alterações" logo
      // abaixo de "Último backup: agora" depois de um run que falhou
      // com 0 arquivos — parecendo que a falha tinha enviado 412.
      lastResult: {
        filesUploaded: result.filesUploaded,
        filesSkipped: result.filesSkipped,
        filesFailed: result.filesFailed,
        status: result.status,
      },
      error: result.error,
      uploaded: result.filesUploaded + result.filesFailed,
      total: result.filesUploaded + result.filesFailed + result.filesSkipped,
    }),

  // Falha inesperada (throw, não status): zera os contadores para que o
  // resumo herdado de um run anterior não seja apresentado como se fosse
  // desta tentativa. `filesUploaded: 0` reflete a verdade — não sabemos
  // quanto subiu, e afirmar "0" é melhor que afirmar o número errado.
  fail: (error) =>
    set({
      active: false,
      status: "failed",
      finishedAt: Date.now(),
      lastResult: {
        filesUploaded: 0,
        filesSkipped: 0,
        filesFailed: 0,
        status: "failed",
      },
      error,
    }),

  cancel: () =>
    set({
      active: false,
      status: "cancelled",
      finishedAt: Date.now(),
    }),

  // O handler fica em variável de MÓDULO, não no state: uma função no
  // state mudaria de identidade a cada `set` e dispararia re-render em
  // todo subscriber (o overlay inteiro) sem necessidade.
  //
  // O retorno é um DISPOSER que só anula o handler se ele ainda for o
  // MESMO que foi registrado. Sem essa condição, o `finally` de um run
  // cancelado limpava o handler de um run que tivesse começado durante o
  // dreno daquele — o Cancelar do overlay ficava mudo (clique chamava
  // `cancelRun()` com handler null: nenhum efeito, nenhum feedback).
  setCancelHandler: (fn) => {
    cancelRunHandler = fn;
    return () => {
      if (cancelRunHandler === fn) cancelRunHandler = null;
    };
  },
  cancelRun: () => {
    const fn = cancelRunHandler;
    cancelRunHandler = null;
    if (fn) fn();
  },

  /**
   * Limpa o estado de EXIBIÇÃO do overlay. Chamado pelo auto-dismiss
   * depois de um run concluído.
   *
   * NÃO toca `lastResult`: esse campo pertence ao `finish()` e é
   * consumido por Configurações → Backup do Dispositivo, que mostra
   * "X enviados, Y sem alterações" ao lado de "Último backup". Limpar
   * aqui fazia esse resumo sumir 6 segundos depois de aparecer — o
   * docstring de `lastResult` promete que ele sobrevive até o próximo
   * run, e este método quebrava essa promessa.
   *
   * Também NÃO mexe em `active` — e isso é OBRIGATÓRIO, não
   * acidente: `active` é a fonte da verdade de "um backup está em
   * voo" (`useBackupRunner`, `useBackupSchedule.isRunning` e a guarda
   * de `scheduler.onTick` leem ele). `clear()` roda no auto-dismiss do
   * overlay; se ele zerasse `active`, o botão "Fazer backup agora"
   * ficaria liberado durante um run agendado e um clique iniciaria um
   * run manual por cima (resetando o overlay e sequestrando o Cancelar).
   */
  clear: () =>
    set({
      status: "idle",
      finishedAt: null,
      uploaded: 0,
      total: 0,
      currentFile: "",
      error: null,
      retry: null,
    }),
}));