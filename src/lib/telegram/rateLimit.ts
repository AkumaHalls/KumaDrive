/**
 * Telegram rate-limit (FLOOD_WAIT_X) and transient-error helpers.
 *
 * Used by uploader, downloader, and the IndexQueue so that FLOOD_WAIT
 * handling is consistent across every Telegram call site.
 *
 * Telegram returns FLOOD_WAIT_X in two flavors:
 *   - As an RPC error: err.message === "A wait of X seconds is required (caused by ...)"
 *   - As an explicit error class name like FLOOD_WAIT_30
 *   - Sometimes embedded in `err.seconds` (GramJS error object)
 *
 * Per the user's chosen policy: block-and-wait with the indicated time, capped
 * so we never freeze the UI on a long wait. Dois tetos existem:
 *   - FLOOD_WAIT_CAP_SECONDS (30s) para caminhos INTERATIVOS (upload por
 *     chunk, download), onde desistir rápido é preferível a congelar a UI.
 *   - FLOOD_WAIT_MAX_CAP_SECONDS (900s) para caminhos NÃO-interativos
 *     (IndexQueue), onde retentar antes do prazo exigido AGRAVA o flood.
 */

/**
 * Cap on a single FLOOD_WAIT backoff for INTERACTIVE paths (upload de
 * arquivo por chunk, download, chamadas que o usuário está olhando).
 *
 * Por que existe: o Telegram pode exigir 300s+ e não queremos congelar a
 * UI por tanto tempo. Num upload de arquivo, esperar 30s e retentar é
 * razoável — se ainda estiver em flood, o retry devolve outro FLOOD_WAIT
 * e o ciclo se repetc com um novo atraso.
 *
 * IMPORTANTE: este teto é CURTO de propósito e só vale para o caminho que
 * prefere desistir rápido. Ele NÃO deve ser usado onde retentar antes do
 * prazo agrava o flood — ver FLOOD_WAIT_MAX_CAP_SECONDS.
 */
export const FLOOD_WAIT_CAP_SECONDS = 30;

/**
 * Cap no FLOOD_WAIT de caminhos NÃO-interativos que precisam esperar de
 * verdade (o IndexQueue é o caso central).
 *
 * Por que existe e por que é 900s: retentar ANTES do prazo que o Telegram
 * pediu não "tenta de novo" — ele RENOVA e AUMENTA o flood. O log real de
 * campo mostrou exatamente isto:
 *
 *   INDEX_QUEUE_GIVE_UP last_err=A wait of 125 seconds is required
 *   ... minutos depois ...
 *   INDEX_PIN_FAIL chunk=0 reason=A wait of 600 seconds is required
 *   ... e depois ...
 *   INDEX_PIN_FAIL chunk=12 reason=A wait of 884 seconds is required
 *
 * A cada ciclo de 30s o app reenviava os 18 chunks do índice; cada
 * reenvio prematuro escalava o prazo exigido (125 → 282 → 600 → 884s).
 * O índice nunca convergia e a cota de mensagens ficava estourada — o
 * backup seguinte caía em FLOOD_WAIT e a UI mostrava "falha de conexão",
 * culpando a rede por um flood que o próprio app criou.
 *
 * 900s é o teto da espera: acima disso desistimos e devolvemos erro, em
 * vez de esperar indefinidamente. É longo, mas é o preço de convergir.
 */
export const FLOOD_WAIT_MAX_CAP_SECONDS = 900;

/**
 * Returns the FLOOD_WAIT delay (in seconds) Telegram is asking for, or null
 * if this error is not a FLOOD_WAIT.
 */
export function parseFloodWaitSeconds(err: any): number | null {
  if (!err) return null;

  // 1. GramJS error.seconds (most reliable, set on FloodWaitError objects)
  if (typeof err.seconds === "number" && err.seconds > 0) {
    return err.seconds;
  }

  // 2. Explicit class name "FloodWaitError" or similar with seconds
  const className = err?.constructor?.name || err?.name || "";
  if (/FloodWait/i.test(className) && typeof err.seconds === "number") {
    return err.seconds;
  }

  // 3. Message pattern: "A wait of X seconds is required"
  const msg: string = typeof err === "string"
    ? err
    : (err.message || err.errorMessage || err.error?.errorMessage || "");

  const m1 = /A wait of (\d+) seconds? is required/i.exec(msg);
  if (m1) return Math.max(1, parseInt(m1[1], 10));

  // 4. Compact pattern: "FLOOD_WAIT_30" or "FLOOD_WAIT (30)"
  const m2 = /FLOOD_WAIT[_ ]+(\d+)/i.exec(msg);
  if (m2) return Math.max(1, parseInt(m2[1], 10));

  return null;
}

/**
 * Cap the wait so we never block longer than the caller tolerates.
 *
 * `capSeconds` default é o teto CURTO (interativo). Chamadores
 * não-interativos (IndexQueue) passam `FLOOD_WAIT_MAX_CAP_SECONDS` para
 * esperar o prazo real que o Telegram exigiu — retentar antes disso só
 * agrava o flood.
 */
export function clampFloodWait(seconds: number, capSeconds: number = FLOOD_WAIT_CAP_SECONDS): number {
  return Math.min(seconds, capSeconds);
}

const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed out/i,
  /network/i,
  /fetch/i,
  /socket/i,
  /disconnect(ed)?/i,
  /reset/i,
  /econnreset/i,
  /etimedout/i,
  /enotfound/i,
  /econnrefused/i,
  /handshake/i,
  /abort/i,
  /temporar(y|ily)/i,
  /try again/i,
  /429/,
  /flood/i,
  /too many/i,
];

/**
 * Returns true if the error is transient (network / rate-limit / timeout)
 * and worth retrying. Returns false for hard errors that should bubble up
 * (auth lost, channel missing, deserialization, etc.).
 */
export function isTransientError(err: any): boolean {
  if (parseFloodWaitSeconds(err) != null) return true;
  const msg: string =
    typeof err === "string"
      ? err
      : (err?.message || err?.errorMessage || err?.error?.errorMessage || "");
  return TRANSIENT_PATTERNS.some((p) => p.test(msg));
}

const HARD_PATTERNS: RegExp[] = [
  /AUTH_KEY_UNREGISTERED/i,
  /SESSION_REVOKED/i,
  /USER_DEACTIVATED/i,
  /CHANNEL_PRIVATE/i,
  /CHAT_WRITE_FORBIDDEN/i,
  /PEER_ID_INVALID/i,
  /INPUT_PEER_INVALID/i,
  /MSG_ID_INVALID/i,
  /MESSAGE_DELETE_FORBIDDEN/i,
  /MESSAGE_EDIT_FORBIDDEN/i,
  /FILE_PARTS_INVALID/i,
  /FILE_ID_INVALID/i,
  /JSON/i, // JSON parse errors in our own code
];

export function isHardError(err: any): boolean {
  const msg: string =
    typeof err === "string"
      ? err
      : (err?.message || err?.errorMessage || err?.error?.errorMessage || "");
  return HARD_PATTERNS.some((p) => p.test(msg));
}

/**
 * Subconjunto de `isHardError` que representa falha FATAL de sessão/canal — as
 * únicas que justificam abortar um backup inteiro.
 *
 * Erros de DADOS POR ARQUIVO (ex.: `FILE_PARTS_INVALID`, `FILE_ID_INVALID`,
 * `MSG_ID_INVALID`) são "hard" para fins de retry — não adianta repetir a
 * chamada — mas NÃO significam que a sessão morreu. Antes, o runner usava
 * `isHardError` para decidir abortar: um único arquivo inválido (ex.: um
 * arquivo de 0 bytes gerava `FilePartsInvalid`) derrubava o run TODO e a UI
 * mostrava "Sessão do Telegram expirada. Reconecte sua conta", culpando a
 * sessão por um problema de arquivo e deixando o resto dos arquivos sem envio.
 *
 * `isHardError` continua sendo o predicado de retry (e do indexQueue); o
 * runner de backup usa `isRunAbortError` para a decisão de abortar.
 */
const RUN_ABORT_PATTERNS: RegExp[] = [
  /AUTH_KEY_UNREGISTERED/i,
  /SESSION_REVOKED/i,
  /USER_DEACTIVATED/i,
  /CHANNEL_PRIVATE/i,
  /CHAT_WRITE_FORBIDDEN/i,
  /PEER_ID_INVALID/i,
  /INPUT_PEER_INVALID/i,
];

export function isRunAbortError(err: any): boolean {
  const msg: string =
    typeof err === "string"
      ? err
      : (err?.message || err?.errorMessage || err?.error?.errorMessage || "");
  return RUN_ABORT_PATTERNS.some((p) => p.test(msg));
}

/**
 * Compute the backoff delay for a transient retry.
 *
 * FLOOD_WAIT errors use the time Telegram told us to wait (clamped to
 * `floodCapSeconds`). Other transient errors use exponential backoff with
 * jitter, capped at 8s.
 *
 * @param floodCapSeconds Teto do FLOOD_WAIT. O padrão é o teto curto
 *   (interativo). Caminhos não-interativos passam o teto longo para
 *   respeitar o prazo exigido e não agravar o flood.
 */
export function computeRetryDelay(
  attempt: number,
  err: any,
  floodCapSeconds: number = FLOOD_WAIT_CAP_SECONDS,
): number {
  const flood = parseFloodWaitSeconds(err);
  if (flood != null) {
    return clampFloodWait(flood, floodCapSeconds) * 1000 + Math.floor(Math.random() * 250);
  }
  const base = Math.min(8000, 500 * Math.pow(2, attempt));
  return base + Math.floor(Math.random() * 250);
}

/**
 * Callback signature for retry events. Fired once per attempt that
 * will be retried (i.e. not on the final attempt or on success). Used
 * by the uploader to surface "Retrying 3/5 (FLOOD_WAIT 30s)" to the
 * progress store, so the BackupProgressOverlay can show the user the
 * upload is making progress instead of looking stuck.
 */
export type TelegramRetryEvent = {
  /** 1-indexed attempt number that just failed. */
  attempt: number;
  /** Total attempts allowed. */
  maxAttempts: number;
  /** Milliseconds we are about to wait before the next attempt. */
  waitMs: number;
  /** Telegram's FLOOD_WAIT, if this retry was triggered by one. */
  floodSeconds: number | null;
  /** The error that just failed. */
  error: any;
};

/**
 * Run `fn` with Telegram-aware retry semantics.
 *
 * - Transient errors (FLOOD_WAIT, timeout, network) → wait the right amount, retry.
 * - Hard errors → throw immediately.
 *
 * @param fn           The async operation to run.
 * @param label        Used in thrown error messages so we know which call failed.
 * @param maxAttempts  Cap on total attempts. Defaults to 5.
 * @param onRetry      Optional callback fired once per transient error
 *                     that will be retried. The BackupProgressOverlay
 *                     uses this to show "Retrying 3/5 (FLOOD_WAIT 30s)"
 *                     instead of a frozen progress bar.
 * @param floodCapSeconds Teto do FLOOD_WAIT para ESTA chamada.
 *
 *   O padrão (`FLOOD_WAIT_CAP_SECONDS` = 30s) é o teto CURTO — usado hoje
 *   pelo uploader (pacing espelhado do Teledrive original: um rate-limit
 *   real faz o arquivo falhar rápido e o run seguir, em vez de pendurar
 *   o backup numa espera longa).
 *
 *   O teto LONGO (`FLOOD_WAIT_MAX_CAP_SECONDS` = 900s) é usado pelo
 *   `IndexQueue` (caminho NÃO-interativo do índice): lá o commit precisa
 *   esperar o prazo que o Telegram exigiu para convergir — retentar cedo
 *   reenviaria a epoch inteira e ESCALARIA o flood (o log de campo mostrou
 *   125s → 600s → 884s na era em que o índice era reescrito por arquivo).
 *
 *   NÃO reintroduzir o teto longo no uploader: o que já foi tentado (v0.2.7)
 *   e revertido de propósito ao espelhar o upstream (v0.2.10).
 */
export async function withTelegramRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number = 5,
  onRetry?: (event: TelegramRetryEvent) => void,
  floodCapSeconds: number = FLOOD_WAIT_CAP_SECONDS,
): Promise<T> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (isHardError(err)) {
        // Bubble up hard errors immediately; no point retrying.
        throw err;
      }
      if (attempt >= maxAttempts) {
        throw new Error(
          `[${label}] Failed after ${maxAttempts} attempts: ${err?.message ?? err}`
        );
      }
      const delay = computeRetryDelay(attempt, err, floodCapSeconds);
      // eslint-disable-next-line no-console
      console.warn(
        `[${label}] transient error (attempt ${attempt}/${maxAttempts}); waiting ${Math.round(delay / 100) / 10}s →`,
        err?.message ?? err
      );
      onRetry?.({
        attempt,
        maxAttempts,
        waitMs: delay,
        floodSeconds: parseFloodWaitSeconds(err),
        error: err,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable but keeps the TS compiler happy.
  throw lastErr;
}
