/**
 * Device backup runner — the orchestrator that does the actual work.
 *
 * Pipeline (driven by `runBackup({triggeredBy})`):
 *   1. Acquire the module-level Promise-chain mutex (Tier 1 — T3.1). Auto-
 *      tick + manual click serialize; the second caller waits.
 *   2. Read the user's source-folder config from the licenseStore.
 *   3. Walk each source folder via the Rust `read_dir_recursive` command.
 *   4. Diff the fresh walk against the local manifest (mtime + size).
 *      If the manifest was corrupt, refuse to upload (Tier 1 — T3.2).
 *   5. Upload changed/new files via the existing `uploadFileToTelegram`,
 *      one at a time. After each successful upload:
 *        a. Persist the manifest (so a crash mid-run doesn't lose progress).
 *        b. Build a TeleFile and write it to the fileStore (Tier 1 — T1.1).
 *        c. enqueueSave the optimistic files array through the shared
 *           IndexQueue (same coalescing/serialization as regular uploads).
 *   6. Post the audit row to the backend at `/api/backup/log` with the
 *      run summary (filesUploaded / filesSkipped / filesFailed / status).
 *
 * Why this isn't a single Tauri command
 * -------------------------------------
 * The work is mostly JS-side because it touches existing pieces:
 * uploadFileToTelegram, fileStore, the index-queue, logEvent. Putting it
 * in Rust would mean re-implementing all of those. Keeping it JS-side is
 * the right level for now.
 *
 * Concurrency / cancellation
 * --------------------------
 * Two layers:
 *   - The Promise-chain mutex (T3.1) serializes concurrent `runBackup`
 *     invocations so they cannot race on file uploads.
 *   - The AbortSignal exposed via `useBackupRunner` lets the user cancel
 *     cleanly between uploads. Aborting mid-upload lets the current
 *     upload finish (can't safely kill a Telegram upload mid-stream)
 *     and then bails.
 */

import { uploadFileToTelegram } from "../telegram/uploader";
import { useFileStore } from "@/stores/fileStore";
import { useLicenseStore } from "@/stores/licenseStore";
import { useAuthStore } from "@/stores/authStore";
import { useBackupProgressStore } from "@/stores/backupProgressStore";
import { getClient } from "../telegram/client";
import { getSecret, VAULT_KEY_CHANNEL_ID, channelIdKey } from "../secure/vault";
import { logEvent } from "../events";
import {
  diffAgainstManifest,
  emptyManifest,
  guessMimeFromName,
  isManifestCorrupt,
  loadManifest,
  recordUpload,
  saveManifest,
  type BackupManifest,
} from "./manifest";
import { sanitizeFolderSegment, walkSourceFolders } from "./walker";
import { detectOS, getDeviceName } from "../secure/deviceInfo";
import { enqueueSave } from "../storage/indexQueue";
import {
  describeTelegramError,
  isAuthError,
  isSoftAuthError,
} from "../telegram/authErrors";
import { isRunAbortError } from "../telegram/rateLimit";
import { reconstructMissingFolders } from "../storage/metadataStore";
import type { TeleFile } from "../types";

/**
 * Breather entre lotes. Antes era um sleep FIXO de 2s a cada 3 arquivos
 * (≈200s de espera ociosa num backup de 300 arquivos). Agora o breather é
 * ADAPTATIVO: a base é curta (BACKUP_BREATHER_BASE_MS) e só escalamos para
 * o valor antigo (BACKUP_BREATHER_MAX_MS) quando um retry/FLOOD_WAIT
 * realmente aconteceu neste lote — ou seja, só pagamos a pausa longa
 * quando o Telegram de fato sinalizou rate-limit.
 */
const BACKUP_BATCH_SIZE = 3;
const BACKUP_BREATHER_BASE_MS = 250;
const BACKUP_BREATHER_MAX_MS = 2_000;

/**
 * Quantos uploads de arquivos rodam em paralelo no backup.
 *
 * O `uploadFileToTelegram` já faz o backoff de FLOOD_WAIT por chunk; o
 * limite aqui é o mesmo pool de ~3 que o envio normal (uploadManager)
 * usa, para não saturar a conexão MTProto nem o rate-limit por segundo do
 * Telegram. As escritas (manifesto / índice) continuam SERIALIZADAS no
 * passo de commit de cada arquivo, então o paralelismo é só de rede+disco
 * de leitura.
 */
const BACKUP_UPLOAD_CONCURRENCY = 3;

/**
 * A cada quantos arquivos reavaliamos o gate de bootstrap.
 *
 * Precisa ser grande o bastante para não reintroduzir o stall de 8s por
 * arquivo, e pequeno o bastante para que um gate que abra no meio do run
 * seja aproveitado em vez de deixar o resto dos arquivos órfãos.
 */
const BOOTSTRAP_GATE_RETRIES = 50;

/**
 * Hard cap on the channel-side folderPath string. Telegram documents
 * cap the caption at 1024 chars; the `kumadrive_file:${JSON.stringify(
 * {folder})}:` wrapper adds ~30 chars on top of the path, so we cap
 * the path at 900 to leave headroom. A path this long means the
 * source tree is deeply nested (50+ levels) — almost always a
 * missing exclude (e.g. user picked a folder that includes
 * node_modules or .git). The runner surfaces the cap violation as a
 * per-file error so the rest of the run continues; the user sees the
 * specific file path in the overlay's error and can either add an
 * exclude or shorten the source tree.
 */
const FOLDER_PATH_MAX_LENGTH = 900;

/**
 * Sleep that can be cancelled by an AbortSignal. Used by the
 * per-batch breather so a user-initiated cancel doesn't wait up
 * to BACKUP_BREATHER_MS for the breather to finish.
 */
function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Wait until `bootstrapComplete=true` on the file store, capped at `timeoutMs`.
 * Local copy of the helper in uploadManager.ts — we can't import it because
 * uploadManager imports a lot of upload-only state and we don't want a circular
 * dependency. Same shape, same semantics.
 */
async function waitForBootstrap(timeoutMs: number = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (useFileStore.getState().bootstrapComplete) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return useFileStore.getState().bootstrapComplete;
}

/**
 * Lightweight extension → MIME lookup. Imported from `./manifest` (the
 * canonical home — same map backs the cold-start manifest-merge path in
 * bootstrap, so live uploads and reconciled entries always agree).
 */

/**
 * Module-level Promise-chain mutex (Tier 1 — T3.1).
 *
 * Serializes `runBackup` calls so concurrent invocations (e.g. auto-tick
 * firing while the user clicked "Run now") don't double-upload the same
 * files. Same shape as `metadataStore.ts` Mutex; kept inline to avoid a
 * cross-module import. The second caller WAITS in the queue rather than
 * being dropped — better than silently dropping a manual run.
 */
class BackupMutex {
  private promise: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void;
    const nextPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentPromise = this.promise;
    this.promise = currentPromise.then(() => nextPromise);
    await currentPromise;
    return release!;
  }
}

const backupMutex = new BackupMutex();

/** What triggered this run. */
export type BackupTrigger = "manual" | "auto";

/** Result of one backup run. */
export interface BackupRunResult {
  triggeredBy: BackupTrigger;
  /** Folder structure root used (e.g. "/KumaDrive Backups/MacBook Pro"). */
  deviceRoot: string;
  /** Total files considered (walked from disk). */
  totalFound: number;
  /**
   * True quando a caminhada foi INTERROMPIDA pelo cancelamento.
   *
   * Quando true, `totalFound` é um limite INFERIOR (a lista `walked` foi
   * truncada), então `uploaded + skipped === totalFound` não prova nada.
   * Os wrappers precisam disto para não reportar "Backup concluído" num
   * run que o usuário acabou de cancelar durante a caminhada.
   */
  walkTruncated: boolean;
  /** Files actually uploaded this run. */
  filesUploaded: number;
  /** Files skipped because unchanged since last backup. */
  filesSkipped: number;
  /** Files that failed to upload. */
  filesFailed: number;
  /** Source folders that didn't exist on disk anymore. */
  missingFolders: string[];
  /**
   * Arquivos de 0 bytes encontrados e ignorados (a API do Telegram não
   * armazena arquivos vazios — ver walker.ts / WalkResult.emptySkipped).
   */
  emptySkipped: number;
  /** Audit-row id, if backend POST succeeded. */
  auditJobId: string | null;
  /** Aggregate status. */
  status: "success" | "partial" | "failed";
  /** First error message, if any. */
  error: string | null;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Unix-ms timestamp when the run finished. */
  finishedAt: number;
}

/** Options for one run. */
export interface RunBackupOptions {
  triggeredBy: BackupTrigger;
  /** Allow the caller to abort the run (e.g. user clicked Cancel). */
  signal?: AbortSignal;
  /** Notified after each successful file upload. */
  onProgress?: (info: { uploaded: number; total: number; currentFile: string }) => void;
}

/**
 * Resolve the Telegram channel id from the local vault (the same path
 * uploadManager uses). Mirrors that helper inline to avoid a circular
 * import — both modules are loaded on app boot.
 */
async function resolveChannelId(): Promise<string | null> {
  try {
    const phoneNumber = useAuthStore.getState().phoneNumber;
    if (phoneNumber) {
      const k = channelIdKey(phoneNumber);
      const fromPhoneKey = await getSecret(k);
      if (fromPhoneKey) return fromPhoneKey;
    }
    return await getSecret(VAULT_KEY_CHANNEL_ID);
  } catch {
    return null;
  }
}

/**
 * Compute the per-device folder namespace.
 *   /KumaDrive Backups/<sanitized-device-name>/
 *
 * Sanitization (sanitizeFolderSegment) strips Windows-illegal characters
 * and trims to 64 chars. Falls back to "device" if the result is empty
 * (defensive — should never happen given getDeviceName's behavior).
 */
export function buildDeviceFolder(): string {
  const os = detectOS();
  const name = getDeviceName();
  const segment = sanitizeFolderSegment(`${name} (${os})`);
  return `/KumaDrive Backups/${segment}`;
}

/**
 * Run a backup. Wraps the inner body in a module-level Promise-chain mutex
 * (Tier 1 — T3.1) so concurrent callers serialize. Auto-tick + manual click
 * cannot race; the second caller waits in the queue rather than being dropped.
 *
 * After each successful upload (Tier 1 — T1.1), the runner writes the new
 * TeleFile to the in-memory file store AND routes an `enqueueSave` through
 * the shared IndexQueue — exactly the optimistic-merge pattern
 * uploadManager.ts:216-272 uses for regular uploads. Files appear in the
 * file browser IMMEDIATELY (no cold-start dance), and concurrent index
 * writes (backup + user rename) coalesce via the queue's pending slot.
 *
 * If the manifest was corrupt on the last `loadManifest` (sentinel set),
 * the runner short-circuits with `status: "failed"` instead of doing a
 * full re-upload that the dedup helpers can't reason about.
 */
export async function runBackup(opts: RunBackupOptions): Promise<BackupRunResult> {
  const release = await backupMutex.acquire();
  try {
    return await runBackupInner(opts);
  } finally {
    release();
  }
}

async function runBackupInner(opts: RunBackupOptions): Promise<BackupRunResult> {
  const startedAt = Date.now();
  const folders = useLicenseStore.getState().backupFolders ?? { paths: [], excludes: [] };

  const baseResult: BackupRunResult = {
    triggeredBy: opts.triggeredBy,
    deviceRoot: buildDeviceFolder(),
    totalFound: 0,
    walkTruncated: false,
    filesUploaded: 0,
    filesSkipped: 0,
    filesFailed: 0,
    missingFolders: [],
    emptySkipped: 0,
    auditJobId: null,
    status: "failed",
    error: null,
    durationMs: 0,
    finishedAt: 0,
  };

  // Guard: no folders configured.
  if (!folders.paths || folders.paths.length === 0) {
    return {
      ...baseResult,
      error: "Selecione pelo menos uma pasta em Configurações → Backup do Dispositivo antes de fazer o backup.",
      status: "failed",
      durationMs: Date.now() - startedAt,
      finishedAt: Date.now(),
    };
  }

  // Build the per-source-root display basename once. If two configured
  // roots share a basename (e.g. /Users/me/Documents and /Volumes/ext/
  // Documents), they would silently collide in the Backups tree at
  //   /KumaDrive Backups/<device>/Documents/...
  // because reconstructMissingFolders only sees the slash-joined path —
  // a single "Documents" folder would absorb files from both roots.
  // To prevent that, we prefix the second (third, …) collision with the
  // source root's parent directory's basename, e.g. "ext-Documents".
  // The full keying is the root's normalized absolute path, so re-running
  // the same config produces the same display name (idempotent).
  const rootDisplayBasename = buildRootDisplayNames(folders.paths);

  const resolvedChannelId = await resolveChannelId();
  if (!resolvedChannelId) {
    return {
      ...baseResult,
      error: "O canal de armazenamento não está pronto. Faça login novamente para concluir a configuração.",
      status: "failed",
      durationMs: Date.now() - startedAt,
      finishedAt: Date.now(),
    };
  }
  // Captura num `const` não-nulo: o narrowing de `resolvedChannelId` não
  // sobrevive para dentro das closures dos workers.
  const channelId: string = resolvedChannelId;

  // Ensure the Telegram client is connected before starting.
  try {
    const client = getClient();
    if (!client.connected) {
      await client.connect();
    }
  } catch (err) {
    // Sessão expirada é o caso mais comum e o mais confuso: sem isto o
    // usuário via "Telegram client unreachable: AUTH_KEY_UNREGISTERED" e
    // ficava tentando o backup de novo sem saber que precisava deslogar.
    const rawMessage = err instanceof Error ? err.message : String(err);
    const error = isAuthError(err) || isSoftAuthError(err)
      ? describeTelegramError(err)
      : `Não foi possível conectar ao Telegram: ${rawMessage}`;
    return {
      ...baseResult,
      error,
      status: "failed",
      durationMs: Date.now() - startedAt,
      finishedAt: Date.now(),
    };
  }

  // Walk the source folders.
  let walk: Awaited<ReturnType<typeof walkSourceFolders>>;
  try {
    walk = await walkSourceFolders(folders, { signal: opts.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...baseResult,
      error: `Falha ao ler as pastas de origem: ${msg}`,
      status: "failed",
      durationMs: Date.now() - startedAt,
      finishedAt: Date.now(),
    };
  }
  const walked = walk.files;
  // Propaga o "a caminhada foi truncada pelo cancel?" até o resultado. Os
  // wrappers usam isto junto com `totalFound` para decidir se um cancel
  // tardio representa um run completo ou não — sem isto, cancelar durante
  // a caminhada terminava como "Backup concluído" (ver WalkResult).
  const walkTruncated = walk.truncatedByAbort;

  // Pastas de origem que não puderam ser lidas. Antes isto era um loop
  // vazio (`void p; void walkedAbs;`) e `missingFolders` era SEMPRE `[]`:
  // uma pasta ilegível produzia `walked = []` e o run terminava com
  // `status: "success"` sem ter lido um único arquivo. O usuário via
  // "backup concluído" e não tinha como saber que nada foi espelhado.
  const missingFolders: string[] = [...walk.unreadableRoots];

  // Arquivos de 0 bytes que o walker pulou (ver WalkResult.emptySkipped).
  // Informamos no console e no resultado; NÃO contam como falha — o backup
  // prossegue normalmente.
  const emptySkippedCount = walk.emptySkipped.length;
  if (emptySkippedCount > 0) {
    console.warn(
      `[backup.runner] ${emptySkippedCount} arquivo(s) de 0 byte ignorado(s); ` +
        `a API do Telegram não armazena arquivos vazios:`,
      walk.emptySkipped.slice(0, 20),
      emptySkippedCount > 20 ? `… (+${emptySkippedCount - 20})` : "",
    );
  }

  // Se TODAS as pastas configuradas falharam, isto é um erro de
  // configuração, não um no-op — não faz sentido reportar sucesso.
  if (
    missingFolders.length > 0 &&
    missingFolders.length === folders.paths.length &&
    folders.paths.length > 0
  ) {
    return {
      ...baseResult,
      error:
        "Nenhuma das pastas de origem pôde ser lida. Verifique se os " +
        "caminhos ainda existem e se você tem permissão de acesso:\n" +
        missingFolders.join("\n"),
      status: "failed",
      durationMs: Date.now() - startedAt,
      finishedAt: Date.now(),
    };
  }

  // Diff against the manifest.
  let manifest = await loadManifest();
  // Tier 1 — T3.2: if the manifest was corrupt, refuse to upload. The
  // quarantined value is preserved under a backup key in the vault for the
  // user to inspect. Without this gate, a corrupt manifest silently cascades
  // into a full re-upload that the dedup helpers can't reason about.
  if (isManifestCorrupt()) {
    return {
      ...baseResult,
      error: "O manifesto do backup está corrompido — o envio foi interrompido para não sobrescrever dados.",
      status: "failed",
      durationMs: Date.now() - startedAt,
      finishedAt: Date.now(),
    };
  }
  if (!manifest.deviceName) {
    manifest = {
      ...manifest,
      deviceName: getDeviceName(),
      deviceOs: detectOS(),
    };
  }
  const diff = diffAgainstManifest(manifest, walked);

  let firstError: string | null = null;
  // Quantas vezes a gravação do manifesto falhou neste run. O manifesto é
  // o que impede o re-upload na próxima execução; se ele não persistiu,
  // o backup vai repetir trabalho na próxima vez e o usuário precisa
  // saber disso em vez de ver "sucesso" toda noite.
  let manifestSaveFailures = 0;

  // Gate de bootstrap. Reavaliado no primeiro arquivo e a cada
  // `BOOTSTRAP_GATE_RETRIES` arquivos, e NÃO dentro do `for` original.
  //
  // Duas falhas que as versões anteriores tiveram:
  //   1) esperar dentro do `for`: se o gate nunca destravasse, cada um dos
  //      N arquivos pagava 8s → 200 arquivos = ~27 min parados.
  //   2) resolver UMA vez antes do loop: se desse `false`, o `else` rodava
  //      para TODOS os arquivos — os 200 subiam para o Telegram, o run
  //      devolvia "success", e NENHUM entrava no índice. Todos órfãos
  //      até o orphan-scan do próximo cold start.
  let bootstrapGateReady = false;
  // Inicia defasado para que a PRIMEIRA checagem aconteça já no primeiro
  // arquivo (com 0 - (-50) >= 50). Com o loop sequencial antigo o gate era
  // checado em i=0 via `i % N === 0`; sem esta defasagem, os primeiros
  // ~49 arquivos enviados ficariam fora do índice até o próximo cold start.
  let bootstrapGateCheckedAt = -BOOTSTRAP_GATE_RETRIES;

  // Contadores compartilhados pelos workers do pool. O JS é single-threaded,
  // então não há corrida: cada `await` é um ponto de suspensão, mas as
  // atualizações de contador acontecem entre awaits, sem interleave.
  let uploadedCount = 0;
  let failedCount = 0;
  // Contador monotônico de retries/FLOOD_WAIT observados desde o último
  // breather. Um booleano global era resetado por qualquer worker, podendo
  // descartar o sinal de retry de outro worker concorrente.
  let retriesSinceBreather = 0;
  // Abort cooperativo: um worker que encontra erro fatal de sessão marca
  // isto; os demais param de pegar novos arquivos.
  let abortRun = false;
  // Índice compartilhado do próximo arquivo a processar.
  let nextIndex = 0;
  const totalToProcess = diff.toUpload.length;

  // Fila de commits (promise-chain). O envio dos arquivos é PARALELO, mas
  // os passo de commit (gravar manifesto + mesclar índice) precisam rodar
  // SERIALIZADOS: `manifest` é uma variável compartilhada reatribuída por
  // inteiro, e o índice não pode coalescer escritas fora de ordem. Cada
  // worker enfileira seu commit aqui; a fila garante ordem FIFO.
  let commitChain: Promise<void> = Promise.resolve();
  function enqueueCommit(task: () => Promise<void>): Promise<void> {
    const next = commitChain.then(task, task);
    // Não deixa uma rejeição travar a cadeia para os próximos commits.
    commitChain = next.catch(() => {});
    return next;
  }

  /**
   * Processa UM arquivo: monta o folderPath, envia, grava manifesto,
   * mescla no índice e trata erros.
   *
   * Segurança entre workers: o JS é single-threaded, então não há corrida
   * de dados real. O único cuidado é que `manifest` é reatribuído por
   * inteiro (`manifest = recordUpload(manifest, ...)`) em vez de sofrer
   * mutação parcial — assim dois workers nunca corrompem o objeto
   * compartilhado, mesmo intercalando seus `await`.
   */
  async function uploadOneFile(i: number): Promise<void> {
    const file = diff.toUpload[i];
    // Atualiza o rótulo do overlay só UMA vez por arquivo (na primeira
    // notificação de progresso), não a cada chunk: com 3 workers em
    // paralelo, atualizar por-chunk faria o rótulo piscar entre os
    // arquivos concorrentes. Uma vez por arquivo mantém o rótulo estável.
    let announcedCurrentFile = false;
    // Build the channel-side folder path. Mirror the source tree under
    // the device root, preserving nested folder structure. Example:
    //   sourceRoot: /Users/me/Documents
    //   sourcePath: /Users/me/Documents/Work/report.pdf
    //   relPath:    Work/report.pdf  (from the walker, already relative
    //                                to the user's chosen source folder)
    //   → channel folder: /KumaDrive Backups/MacBook Pro/Documents/Work
    //   → channel name:   report.pdf
    //
    // The user picks "/Users/me/Documents" as their backup source, so the
    // channel-side root includes the "Documents" segment — this way the
    // backup preserves the user's local hierarchy (Documents/Work/...) and
    // they can see all their picked source folders side-by-side under
    // /KumaDrive Backups/<device>/.
    //
    // Two bugs this used to have:
    //   1. relUnderSource was the FULL FILE PATH (Work/report.pdf), used as
    //      a folder path. That created a folder named "Work/report.pdf"
    //      literally, which Telegram treated as a single weird folder.
    //   2. The sourceRoot basename (Documents) was never inserted, so files
    //      lived directly under deviceRoot with no top-level folder label.
    //
    // The walker already returns relPath = path-within-source-root; we just
    // take dirname(relPath) for the folder, basename(relPath) for the name.
    //
    // Three hardening checks added (Tasks #12, #13, #14):
    //   - pickSourceRoot must find a match. If it returns null, the
    //     walker has handed us a file outside every configured root
    //     (excludes are filtered earlier, so a non-match here is a
    //     walker bug). We throw a per-file error instead of silently
    //     flattening the file under deviceRoot.
    //   - The display basename is looked up from `rootDisplayBasename`
    //     (built once at the start of the run) so basename collisions
    //     across multiple source roots don't collapse into one folder.
    //   - The final folderPath is length-capped at 900 chars; Telegram's
    //     documented caption ceiling is 1024 and we want headroom for
    //     the `kumadrive_file:{...}` JSON wrapper.
    // O `try` começa AQUI, e não só no `uploadFileToTelegram`: os dois
    // throw de hardening abaixo ficavam FORA dele, então escapavam de
    // `runBackupInner` faziam `runBackup` rejeitar, e o `BackupRunResult`
    // nunca era construído — sem `filesUploaded`, sem `missingFolders`,
    // sem `status`. Um único arquivo com path profundo (o caso node_
    // modules que o próprio comentário cita) matava um backup que já
    // tinha espelhado centenas de arquivos, e o usuário recebia só
    // "falhou". Os comentários diziam "fail-loud per file"; o código
    // abortava o run inteiro.
    try {
      const sourceRoot = pickSourceRoot(file.absPath, folders.paths);
      if (!sourceRoot) {
        throw new Error(
          `walker produced ${file.absPath} which does not match any configured ` +
          `source folder (${folders.paths.join(", ")}). This indicates a walker ` +
          `or exclude-filter bug — refusing to upload rather than flatten the ` +
          `file under the device root.`,
        );
      }
      // pickSourceRoot returns the normalized form (forward-slashes, no
      // trailing slash) — same form buildRootDisplayNames stored the map
      // key under, so the lookup keys directly without re-normalizing.
      const relUnderSource = stripPrefix(file.absPath, sourceRoot);
      const sourceBasename = rootDisplayBasename.get(sourceRoot) ?? "";
      // Compute channel-side folder. relUnderSource starts with "/" so we
      // strip it; then take everything except the trailing filename segment.
      const relClean = relUnderSource.replace(/^\/+/, "");
      const relSegments = relClean.split("/").filter(Boolean);
      const fileName = relSegments.pop() ?? file.absPath.split(/[\\/]/).pop() ?? file.absPath;
      const relFolderSegments = relSegments;
      const channelFolderSegments = [
        sourceBasename,
        ...relFolderSegments,
      ].filter(Boolean);
      const folderPath =
        channelFolderSegments.length > 0
          ? `${baseResult.deviceRoot}/${channelFolderSegments.join("/")}`
          : baseResult.deviceRoot;

      // Length cap. Telegram documents cap the caption at 1024 chars; the
      // `kumadrive_file:${JSON.stringify({folder})}:` wrapper adds ~30
      // chars on top of the path, so we cap the path at 900 to leave
      // headroom. A path this long means a deeply-nested source — the
      // user almost certainly has a folder like "node_modules" they meant
      // to exclude.
      if (folderPath.length > FOLDER_PATH_MAX_LENGTH) {
        throw new Error(
          `folderPath length ${folderPath.length} exceeds ${FOLDER_PATH_MAX_LENGTH}-char ` +
          `cap (source path too deeply nested: ${file.absPath}). Add an exclude ` +
          `pattern or shorten the source tree depth.`,
        );
      }

      const message = await uploadFileToTelegram(
        channelId,
        fileName,
        file.size,
        file.absPath,
        folderPath,
        // onProgress — antes era `undefined`. Agora atualiza o rótulo do
        // overlay com o arquivo em envio, mas só na primeira notificação
        // (ver `announcedCurrentFile` acima) para não piscar entre os 3
        // workers concorrentes.
        (uploadedBytes, totalBytes) => {
          void uploadedBytes;
          void totalBytes;
          if (!announcedCurrentFile) {
            announcedCurrentFile = true;
            useBackupProgressStore.setState({ currentFile: file.absPath });
          }
        },
        // onRetry — surface FLOOD_WAIT / network retries to the progress
        // store so the overlay shows "Retrying 3/5 — waiting 30s" instead
        // of a frozen counter. Keeps the user informed during a long
        // single-file stall. We pull the action fresh on each callback
        // so a re-render or HMR doesn't capture a stale reference.
        (e) => {
          // Sinaliza ao breather adaptativo que este lote precisou de
          // retry → a pausa de lote escala para o valor longo.
          retriesSinceBreather++;
          useBackupProgressStore.getState().setRetry({
            attempt: e.attempt,
            maxAttempts: e.maxAttempts,
            waitMs: e.waitMs,
            floodSeconds: e.floodSeconds,
          });
        },
      );
      const messageId = Number((message as any)?.id);
      if (!Number.isFinite(messageId) || messageId <= 0) {
        throw new Error(
          `upload returned no usable message id: ${JSON.stringify(message).slice(0, 120)}`,
        );
      }
      // Commit serializado: manifesto + índice. Roda na fila `commitChain`
      // para que a reatribuição de `manifest` e a escrita do índice não
      // intercalem entre os 3 workers paralelos.
      await enqueueCommit(async () => {
      manifest = recordUpload(manifest, file.absPath, {
        mtimeMs: file.mtimeMs,
        size: file.size,
        messageId,
        folderPath,
      });
      // O manifesto é a memória do backup: sem ele o próximo run não sabe
      // que este arquivo já foi espelhado e reenvia. Contabilizamos a
      // falha em vez de deixar `saveManifest` engolir, para que o
      // resultado final saia como "partial" com aviso — e não como um
      // "sucesso" que se repete indefinidamente.
      try {
        await saveManifest(manifest);
      } catch (manifestErr) {
        manifestSaveFailures++;
        console.warn("[backup.runner] manifest save failed:", manifestErr);
      }

      // Tier 1 — T1.1: write the new TeleFile to the in-memory file store
      // AND route an enqueueSave through the shared IndexQueue. Mirrors the
      // optimistic-merge pattern in uploadManager.ts:216-272 — the file
      // appears in the file browser IMMEDIATELY (no cold-start dance), and
      // concurrent index writes (backup + user rename) coalesce via the
      // queue's pending slot.
      //
      // Bootstrap gate: if recovery hasn't finished, skip the index save
      // (the file is already on Telegram — the next orphan scan picks it up).
      const newTeleFile: TeleFile = {
        // Deterministic id keyed on the Telegram messageId. Different from
        // regular uploads (which use `file_<uuid>`) so dedup-by-messageId
        // and dedupeByContentKey can identify these as backup entries.
        id: `backup_${messageId}`,
        name: fileName,
        size: file.size,
        mime: guessMimeFromName(fileName),
        folderPath,
        messageId,
        channelId,
        uploadedAt: Date.now(),
        starred: false,
        trashed: false,
      };

      // Gate resolvido UMA vez, antes do loop.
      //
      // Antes esta chamada ficava dentro do `for`: se o bootstrap nunca
      // completasse o gate, cada um dos N arquivos pagava até 8s de
      // espera. Com 200 arquivos eram ~27 minutos parados, e o overlay
      // mostrava "Fazendo backup — N / M" sem indicar que estava
      // aguardando. Uma vez checado o gate, ele está aberto ou não —
      // reconsultar por arquivo não traz informação nova.
      //
      // Reavaliamos a cada `BOOTSTRAP_GATE_RETRIES` arquivos em vez de
      // fixar o resultado: fixar `false` antes do loop fazia TODOS os
      // arquivos pularem o índice, e o run devolvia "success" com nada
      // gravado. Se continuarmos sem gate, `bootstrapGateReady` fica
      // `false` e o índice é deixado para o orphan-scan — o
      // comportamento seguro.
      // Gate reavaliado periodicamente. `bootstrapGateCheckedAt` guarda o
      // último índice em que checamos, para não reconsultar por arquivo.
      if (!bootstrapGateReady && i - bootstrapGateCheckedAt >= BOOTSTRAP_GATE_RETRIES) {
        bootstrapGateCheckedAt = i;
        bootstrapGateReady = await waitForBootstrap(8000);
      }
      if (bootstrapGateReady) {
        const existingFiles = useFileStore.getState().files;
        // Reconstruct any missing virtual folders BEFORE adding the new
        // file, so the optimistic array mirrors what `healAndSave` would
        // produce on cold start. Without this, the file appears in the
        // browser at its full folder path but the parent folder entries
        // don't exist yet — so the user clicks into a "missing" folder.
        const { healedFiles: withFolders } = reconstructMissingFolders(
          [...existingFiles, newTeleFile],
          channelId,
        );
        const optimisticFiles = [
          ...withFolders.filter(
            (f) => f.id !== newTeleFile.id || f.messageId !== messageId
          ),
          newTeleFile,
        ];
        useFileStore.getState().setFiles(optimisticFiles);

        try {
          await enqueueSave(channelId, optimisticFiles);
        } catch (indexErr) {
          // Same hard-error rollback as uploadManager.ts:280-305. The file
          // is already on Telegram — only the metadata index write failed.
          // Remove the optimistic entry from the store so the UI reflects
          // reality; the next cold start will recover it via the orphan scan.
          const isHard =
            /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|CHANNEL_PRIVATE|PEER_ID_INVALID|CHAT_WRITE_FORBIDDEN|JSON/i.test(
              (indexErr as Error)?.message ?? ""
            );
          if (isHard) {
            const rolled = useFileStore
              .getState()
              .files.filter((f) => f.id !== newTeleFile.id);
            useFileStore.getState().setFiles(rolled);
            console.warn(
              `[backup.runner] index save hard-error for ${file.absPath}; rolled back:`,
              (indexErr as Error).message,
            );
          } else {
            console.warn(
              `[backup.runner] index save transient error for ${file.absPath}:`,
              (indexErr as Error).message ?? indexErr,
            );
          }
        }
      } else {
        console.warn(
          `[backup.runner] bootstrap not ready; skipping in-memory merge for ${file.absPath}. ` +
          `The orphan scan will pick this file up on the next cold start.`,
        );
      }
      }); // fim do enqueueCommit

      uploadedCount++;
      opts.onProgress?.({
        uploaded: uploadedCount + failedCount,
        total: totalToProcess,
        currentFile: file.absPath,
      });

      // Per-batch breather ADAPTATIVO. Antes era um sleep fixo de 2s a
      // cada 3 arquivos. Agora só pausamos de verdade quando o lote
      // recente precisou de um retry/FLOOD_WAIT (`retriesSinceBreather`), e
      // nesse caso escalamos para o valor longo; no caminho comum a pausa
      // é curta (BACKUP_BREATHER_BASE_MS). Sem breather após o último
      // arquivo e sem contar arquivos falhos como "sucesso do lote". O
      // sleep é interrompível: um cancel curto-circuita.
      if (
        uploadedCount > 0 &&
        uploadedCount % BACKUP_BATCH_SIZE === 0 &&
        i < totalToProcess - 1
      ) {
        const hadRetry = retriesSinceBreather > 0;
        const breatheMs = hadRetry ? BACKUP_BREATHER_MAX_MS : BACKUP_BREATHER_BASE_MS;
        retriesSinceBreather = 0;
        console.log(
          `[backup.runner] breather: ${uploadedCount}/${totalToProcess} done; ` +
          `pausing ${breatheMs}ms (${hadRetry ? "escalado apos retry" : "base"})`,
        );
        await interruptibleSleep(breatheMs, opts.signal);
      }
    } catch (err) {
      failedCount++;
      const msg = err instanceof Error ? err.message : String(err);
      firstError ??= msg;
      console.warn(`[backup.runner] failed to upload ${file.absPath}:`, msg);
      // Persist progress before bailing on a hard error. Não pode
      // propagar: o `catch` acima já contabilizou a falha do arquivo e
      // o loop precisa seguir para os demais. Uma falha ao gravar o
      // manifesto é contabilizada à parte e transforma o resultado em
      // "partial".
      try {
        await saveManifest(manifest);
      } catch (manifestErr) {
        manifestSaveFailures++;
        console.warn("[backup.runner] manifest save (error path) failed:", manifestErr);
      }
      opts.onProgress?.({
        uploaded: uploadedCount + failedCount,
        total: totalToProcess,
        currentFile: file.absPath,
      });

      // If this is a HARD Telegram error (session revoked, auth key
      // unregistered, channel private, etc.), every subsequent file will
      // fail with the same error. Bail out now so the user gets a clear
      // "session expired" message instead of 218 confusing failures and
      // an indefinite wait. Without this short-circuit, a revoked session
      // turns into a multi-minute loop of identical errors.
      if (isRunAbortError(err)) {
        firstError ??=
          "Sessão do Telegram expirada. Reconecte sua conta em Configurações → Conta do Telegram e execute o backup novamente.";
        // Marca o run para abortar. A CONTAGEM dos arquivos pulados é feita
        // UMA vez, depois que todos os workers em voo drenarem (ver o
        // bloco após Promise.all). Somar aqui contaria arquivos que outros
        // workers já enviaram (índices fora de ordem no pool) e/ou seria
        // somado várias vezes se 2 workers falhassem com o mesmo erro.
        abortRun = true;
      }
      // Continue with the rest for transient errors — partial is better than nothing.
    }
  }

  // Pool de uploaders. `nextIndex` é o índice compartilhado; cada worker
  // pega o próximo até esgotar, ou para quando o run é abortado/cancelado.
  // O trabalho paralelo é só de rede + leitura de disco; as escritas
  // (manifesto/índice) acontecem dentro de `uploadOneFile` e são seguras
  // porque cada worker só entra nelas após o seu próprio `await` de rede,
  // e o `manifest` é reatribuído por inteiro (sem mutação parcial).
  async function worker(): Promise<void> {
    while (true) {
      if (abortRun || opts.signal?.aborted) return;
      const i = nextIndex++;
      if (i >= totalToProcess) return;
      await uploadOneFile(i);
    }
  }

  if (opts.signal?.aborted) {
    firstError ??= "Cancelled by user.";
  } else {
    const workerCount = Math.min(BACKUP_UPLOAD_CONCURRENCY, totalToProcess);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  // Normalização do relatório pós-dreno: conta os arquivos que NUNCA foram
  // processados (pulados pelo abort/cancel) exatamente uma vez, depois que
  // todos os workers em voo terminaram. `processed` nunca passa do total.
  {
    const processed = uploadedCount + failedCount;
    if (processed < totalToProcess && (abortRun || opts.signal?.aborted)) {
      const skipped = totalToProcess - processed;
      if (abortRun) {
        console.warn(
          `[backup.runner] hard Telegram error; aborting run. ${skipped} files skipped (processed ${processed}/${totalToProcess}).`,
        );
      }
      failedCount += skipped;
    }
  }

  const filesUploaded = uploadedCount;
  const filesFailed = failedCount;

  // Aggregate status. Order matters:
  //   1. Any filesFailed → "partial" (if some uploaded) or "failed" (if none did).
  //      The previous ordering checked `unchanged > 0` BEFORE checking `filesFailed`,
  //      which silently hid a 0-uploaded + 18-unchanged + 218-failed run as
  //      "success" — the user saw "Backup complete — nothing changed" and never
  //      realised their Telegram session was revoked and 218 files failed.
  //   2. No-op (everything unchanged, nothing failed) → "success".
  //   3. All-uploaded → "success".
  //   4. `manifestSaveFailures > 0` degrada para "partial" mesmo sem
  //      falha de upload: os arquivos subiram, mas o manifesto não foi
  //      gravado, então o próximo run vai reenviá-los. Sem isso o
  //      usuário veria "sucesso" toda noite enquanto o canal enche de
  //      duplicatas.
  let status: BackupRunResult["status"];
  if (filesFailed > 0 && filesUploaded > 0) status = "partial";
  else if (filesFailed > 0) status = "failed";
  else if (manifestSaveFailures > 0) status = "partial";
  else if (filesUploaded > 0) status = "success";
  else status = "success"; // no-op run: nothing to upload, nothing failed

  if (manifestSaveFailures > 0) {
    const msg =
      `O backup enviou os arquivos, mas não conseguiu gravar o registro do que foi ` +
      `espelhado (${manifestSaveFailures}x). Na próxima execução alguns arquivos podem ` +
      `ser enviados novamente.`;
    firstError ??= msg;
    console.warn(`[backup.runner] ${msg}`);
  }

  // Audit job id — backend removed, set null.
  const auditJobId: string | null = null;
  void auditJobId; // unused but kept for structural compatibility

  // Log an event for the activity timeline.
  try {
    logEvent({
      type: status === "failed" ? "backup.failed" : "backup.completed",
      payload: {
        uploaded: filesUploaded,
        skipped: diff.unchanged.length,
        failed: filesFailed,
        deviceRoot: baseResult.deviceRoot,
      },
    });
  } catch {
    // logEvent is fire-and-forget; ignore its own errors.
  }

  // Update the fileStore timestamp so the UI re-renders the "Last backup"
  // label. The store setter is a no-op when bootstrap hasn't completed.
  //
  // Só quando o run NÃO falhou por completo. Antes era incondicional, e
  // a tela de Backup mostrava "Último backup: há instantes" logo depois
  // de um run que enviou ZERO arquivos e falhou — impressionando sucesso
  // exatamente quando houve falha total. `partial` conta como backup
  // (alguma coisa subiu), então só o "failed" puro é excluído.
  if (status !== "failed") {
    useFileStore.getState().setLastBackupAt(Date.now());
  }

  return {
    triggeredBy: opts.triggeredBy,
    deviceRoot: baseResult.deviceRoot,
    totalFound: walked.length,
    walkTruncated,
    filesUploaded,
    filesSkipped: diff.unchanged.length,
    filesFailed,
    missingFolders,
    emptySkipped: emptySkippedCount,
    auditJobId,
    status,
    error: firstError,
    durationMs: Date.now() - startedAt,
    finishedAt: Date.now(),
  };
}

/** Find which source-root this absPath belongs to. */
function pickSourceRoot(absPath: string, roots: string[]): string | null {
  const normalized = absPath.replace(/\\/g, "/");
  let best: string | null = null;
  for (const r of roots) {
    const rn = r.replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized === rn || normalized.startsWith(rn + "/")) {
      if (!best || rn.length > best.length) best = rn; // longest match wins
    }
  }
  return best;
}

/**
 * Compute the per-source-root display basename used to build the
 * channel-side folder tree under `/KumaDrive Backups/<device>/<display>/`.
 *
 * Defaults to the basename of the root (the user's chosen source folder),
 * matching the existing "mirror the source's own folder name" convention
 * (see the comment at runBackupInner's per-file folderPath computation).
 *
 * When two configured roots share a basename, the SECOND occurrence (and
 * beyond) is prefixed with the parent directory's basename, e.g.:
 *
 *   /Users/me/Documents       → "Documents"
 *   /Volumes/ext/Documents    → "ext-Documents"
 *
 * The map is keyed on the normalized absolute path, so re-running with
 * the same config produces the same display name (idempotent — no drift
 * between backup runs).
 */
function buildRootDisplayNames(roots: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const seenBasenames = new Map<string, number>();
  for (const r of roots) {
    const rn = r.replace(/\\/g, "/").replace(/\/$/, "");
    const parts = rn.split("/").filter(Boolean);
    const base = parts[parts.length - 1] ?? "";
    const display = sanitizeFolderSegment(base);
    // Two-collision prefix: parent basename + "-" + base. Edge case:
    // the root is "/" or has no parent (rare — user can't actually pick
    // that), so we fall back to "root" as the parent label.
    const parent = parts.length >= 2 ? parts[parts.length - 2] : "root";
    const seen = seenBasenames.get(display) ?? 0;
    seenBasenames.set(display, seen + 1);
    if (seen === 0) {
      map.set(rn, display);
    } else {
      map.set(rn, sanitizeFolderSegment(`${parent}-${base}`));
    }
  }
  return map;
}

/** Strip a directory prefix, return the remainder with leading slash. */
function stripPrefix(absPath: string, prefix: string): string {
  const a = absPath.replace(/\\/g, "/");
  const p = prefix.replace(/\\/g, "/").replace(/\/$/, "");
  if (a === p) return "";
  return a.startsWith(p + "/") ? a.slice(p.length) : a;
}

// Re-export for the React hook.
export { emptyManifest };
export type { BackupManifest };