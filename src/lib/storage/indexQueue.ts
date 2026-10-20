/**
 * IndexQueue — per-channel async FIFO queue that owns ALL index persistence
 * to Telegram. This is the single writer rule for the index per channelId.
 *
 * Design goals:
 *   1. Coalesce: many rapid `enqueue(state)` calls collapse into ONE Telegram
 *      write (latest state wins). This is what eliminates the FLOOD_WAIT
 *      cascade — 50 user actions in 5s become 1 edit, not 50 sends.
 *   2. Serialize: only one Telegram index write happens at a time per channel,
 *      so we never produce overlapping duplicate index messages.
 *   3. FLOOD_WAIT-aware: when Telegram asks us to wait X seconds, we wait
 *      (capped) and then retry, instead of failing and re-queueing.
 *   4. Hybrid rollback: transient errors (FLOOD_WAIT, timeout, network) keep
 *      the optimistic UI and retry indefinitely. Hard errors propagate so the
 *      caller can roll back the optimistic state.
 *   5. Observable: surfaces queue state (`idle|saving|retrying|failed`) plus a
 *      retry countdown to the fileStore so the topbar can show accurate
 *      "Syncing / Retrying in 12s / Failed — Retry" feedback.
 *
 * The queue is keyed by channelId so multiple accounts (future-proofing)
 * don't share state.
 */

import { Api } from "telegram";
import { getClient } from "../telegram/client";
import {
  withTimeout,
  pickCoherentIndexSet,
  type ParsedIndexChunk,
} from "./metadataStore";
import { useFileStore } from "../../stores/fileStore";
import {
  computeRetryDelay,
  isHardError,
  parseFloodWaitSeconds,
  FLOOD_WAIT_MAX_CAP_SECONDS,
} from "../telegram/rateLimit";
import { invoke } from "@tauri-apps/api/core";

import type { TeleFile } from "../types";

/**
 * Telegram recusa mensagens com mais de 4096 caracteres (erro
 * 400: MESSAGE_TOO_LONG).
 *
 * O código usava um CHUNK_SIZE fixo (10 arquivos por mensagem). Isso
 * quebrava com nomes de arquivo ou caminhos longos: um TeleFile
 * serializado tem ~350 chars com nome curto, mas passa de 500 com
 * nomes descritivos e pastas profundas — 10 deles estouravam o limite.
 * O sintoma era o índice nunca sendo gravado e todo retry devolvendo
 * MESSAGE_TOO_LONG.
 *
 * Agora o corte é calculado a partir do tamanho REAL do payload de cada
 * arquivo, com folga para o wrapper JSON. CHUNK_MAX vira apenas um teto
 * superior para não gerar milhares de mensagens minúsculas.
 */
const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Teto de arquivos por chunk, independente do tamanho. */
const CHUNK_MAX_FILES = 25;

/**
 * Monta o JSON exato que será enviado e devolve o comprimento, para que o
 * caller possa decidir se cabe. Espelha a montagem feita em sendFallback
 * (mesmas chaves, mesma ordem não é relevante para o tamanho).
 */
function indexPayloadLength(
  files: TeleFile[],
  chunkIndex: number,
  totalChunks: number,
): number {
  return JSON.stringify({
    kumadrive_index: true,
    version: 1,
    chunkIndex,
    totalChunks,
    files,
  }).length;
}

/**
 * Divide `state` em chunks que cabem no limite do Telegram.
 *
 * Acrescenta arquivo a arquivo e fecha o chunk assim que o payload
 * ultrapassar o limite. Um arquivo isolado maior que o limite (prático
 * impossível, mas possível com um nome patológico) fica sozinho num
 * chunk — melhor receber MESSAGE_TOO_LONG num único arquivo do que
 * perder o índice inteiro.
 */
function chunkIndexBySize(state: TeleFile[]): TeleFile[][] {
  const chunks: TeleFile[][] = [];
  let current: TeleFile[] = [];
  // totalChunks é estimado durante o corte; overestimate deixa o payload
  // maior, o que só torna o corte mais conservador.-safe.
  const estimatedTotal = Math.max(1, Math.ceil(state.length / CHUNK_MAX_FILES));

  for (const file of state) {
    const candidate = current.length + 1 <= CHUNK_MAX_FILES &&
      indexPayloadLength([...current, file], chunks.length, estimatedTotal) <=
        TELEGRAM_MESSAGE_LIMIT;

    if (candidate) {
      current.push(file);
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
      current = [];
    }
    current.push(file);
  }

  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push([]);

  // Validação final: se algum chunk ainda estourar (totalChunks real maior
  // que o estimado), re-corta com o total exato. Uma passada é suficiente
  // porque o número de dígitos de totalChunks não muda o resultado de
  // forma relevante, mas o laço protege contra patologias.
  for (let pass = 0; pass < 2; pass++) {
    const total = chunks.length;
    const over = chunks.findIndex(
      (c) => indexPayloadLength(c, 0, total) > TELEGRAM_MESSAGE_LIMIT,
    );
    if (over === -1) break;

    // Re-corta todos os chunks estourados usando o total real.
    for (let i = 0; i < chunks.length; i++) {
      if (indexPayloadLength(chunks[i], i, total) <= TELEGRAM_MESSAGE_LIMIT) continue;
      const pieces = splitOversizedChunk(chunks[i], total);
      chunks.splice(i, 1, ...pieces);
      i += pieces.length - 1;
    }
  }

  return chunks;
}

/** Divide um chunk que estourou o limite, respeitando o total real. */
function splitOversizedChunk(chunk: TeleFile[], totalChunks: number): TeleFile[][] {
  const out: TeleFile[][] = [];
  let current: TeleFile[] = [];
  for (const file of chunk) {
    const candidate = current.length + 1 <= CHUNK_MAX_FILES &&
      indexPayloadLength([...current, file], out.length, totalChunks) <=
        TELEGRAM_MESSAGE_LIMIT;
    if (candidate) {
      current.push(file);
      continue;
    }
    if (current.length > 0) {
      out.push(current);
      current = [];
    }
    current.push(file);
  }
  if (current.length > 0) out.push(current);
  if (out.length === 0) out.push(chunk);
  return out;
}
/** Fetch + edit + pin timeouts (ms). */
const FETCH_TIMEOUT_MS = 5000;
const EDIT_TIMEOUT_MS = 8000;
const PIN_TIMEOUT_MS = 4000;
const DELETE_TIMEOUT_MS = 5000;

/**
 * Cap on transient (FLOOD_WAIT / timeout / network) retries before the
 * queue gives up and surfaces a hard error. The previous design retried
 * forever, which manifested as a stuck "Retrying in 30s" pill on the
 * topbar during FLOOD_WAIT storms and silently held the user's
 * optimistic state without ever confirming persistence. With this cap,
 * after 5 transient failures the queue rejects the entry — `useFileActions`
 * rolls back the optimistic state, the topbar shows "Save failed", and
 * the user can hit the manual retry button to try again with a fresh
 * budget.
 */
const MAX_TRANSIENT_RETRIES = 5;

/**
 * Orçamento TOTAL de esperas de FLOOD_WAIT numa janela deslizante.
 *
 * Por que por tempo e não por número de esperas: zerar um CONTADOR a cada
 * sucesso não impede flood persistente. O padrão real de campo é "um
 * commit passa, o próximo é recusado" — o contador zerava no sucesso e
 * reiniciava em 1, então um teto de 3 NUNCA era atingido e o loop seguia
 * por horas (cada espera pode ser de até 900s).
 *
 * Somando o TEMPO já gasto esperando, o teto passa a valer mesmo com
 * sucessos intercalados: depois de 45 min acumulados aguardando flood,
 * desistimos e devolvemos erro em vez de esperar indefinidamente.
 */
const FLOOD_WAIT_TOTAL_BUDGET_MS = 45 * 60 * 1000;

/**
 * Janela sem NENHUM flood após a qual o orçamento é considerado renovado.
 * Um período longo sem recusa significa que o flood realmente passou —
 * só então é seguro zerar o gasto acumulado.
 */
const FLOOD_WAIT_RESET_WINDOW_MS = 10 * 60 * 1000;

interface QueueEntry {
  state: TeleFile[];
  /** Resolve handler for the caller of `enqueue`. */
  resolve: () => void;
  reject: (err: any) => void;
}

class ChannelQueue {
  private pending: QueueEntry | null = null;
  private retryingEntry: QueueEntry | null = null;
  private inflight: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCountdownTimer: ReturnType<typeof setInterval> | null = null;
  private retryAttempt = 0;
  /** Tempo total já aguardado em FLOOD_WAIT nesta janela (ms). */
  private floodWaitSpentMs = 0;
  /** Timestamp do último FLOOD_WAIT visto (para renovar a janela). */
  private lastFloodAt = 0;
  private lastError: any = null;
  private readonly channelId: string;

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  enqueue(state: TeleFile[]): Promise<void> {
    // Coalesce: replace any pending entry with the new state. If something is
    // currently inflight, this becomes the *next* state to write.
    return new Promise<void>((resolve, reject) => {
      // Resolve any superseded pending entry — its state was overwritten by
      // a newer call, so its caller can stop waiting on this exact snapshot.
      // The new entry's promise will resolve when *its* state commits.
      if (this.pending) {
        this.pending.resolve();
      }
      this.pending = {
        state,
        resolve,
        reject,
      };
      // Mirror the latest pending state to the store snapshot too — this is
      // what surfaces in the topbar's "Retrying" pill.
      this.updateStoreState();
      void this.drain();
    });
  }

  /** Force an immediate drain — used on logout / shutdown. */
  async flush(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.retryCountdownTimer) {
      clearInterval(this.retryCountdownTimer);
      this.retryCountdownTimer = null;
    }
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        // Already failed; ignore.
      }
    }
    // Resolve any pending entries so callers don't hang.
    if (this.pending) this.pending.resolve();
    if (this.retryingEntry) this.retryingEntry.resolve();
    this.pending = null;
    this.retryingEntry = null;
    this.retryAttempt = 0;
    // Zera também o orçamento de flood: o flush encerra o ciclo, então o
    // próximo não deve herdar o gasto acumulado de esperas.
    this.floodWaitSpentMs = 0;
    this.lastFloodAt = 0;
    this.lastError = null;
    this.updateStoreState();
  }

  private updateStoreState(): void {
    const store = useFileStore.getState();
    if (this.lastError && this.retryTimer == null) {
      store.setIndexQueueState("failed");
      store.setIndexQueueError(
        typeof this.lastError === "string"
          ? this.lastError
          : this.lastError?.message ?? String(this.lastError)
      );
      store.setIndexQueueRetryInSec(0);
    } else if (this.retryTimer != null) {
      store.setIndexQueueState("retrying");
      // Error message stays so users can see *why* we're retrying.
      if (this.lastError) {
        store.setIndexQueueError(
          parseFloodWaitSeconds(this.lastError) != null
            ? "Telegram rate limit — retrying"
            : this.lastError?.message ?? String(this.lastError)
        );
      }
    } else if (this.pending) {
      store.setIndexQueueState("saving");
      store.setIndexQueueError(null);
      store.setIndexQueueRetryInSec(0);
    } else {
      store.setIndexQueueState("idle");
      store.setIndexQueueError(null);
      store.setIndexQueueRetryInSec(0);
    }
  }

  private async drain(): Promise<void> {
    // If already draining, just return — the next entry has already replaced
    // the pending slot and will be picked up when the current pass finishes.
    if (this.inflight) return;

    // FLOOD_WAIT ativo: NÃO drena agora. Sem esta guarda, qualquer
    // `enqueueSave` que chegasse durante a espera longa chamava `drain()`,
    // encontrava `inflight === null` e commitava o `retryingEntry` na hora —
    // reenviando os N chunks do índice muito ANTES do prazo exigido pelo
    // Telegram. Isso renova e agrava o flood (foi o mecanismo exato que
    // produziu a escalada 125s → 600s → 884s no log de campo), anulando
    // toda esta correção. Um `enqueue` durante a espera apenas substitui
    // `pending` (coalesce); o timer armado drena quando o prazo vencer.
    if (this.retryTimer) return;

    this.inflight = (async () => {
      try {
        // Drain loop: keep committing while there's something to commit.
        // This handles the retrying-entry + newly-enqueued entries flow.
        while (this.retryingEntry || this.pending) {
          // The entry to commit is whichever is "older" — the retrying one
          // first (we promised to retry it), then any newly enqueued ones.
          // In practice the retrying entry has a slightly older snapshot, but
          // both are equivalent for index semantics: the latest state wins on
          // the next operation anyway.
          const entry = this.retryingEntry ?? this.pending!;
          this.retryingEntry = null;
          this.pending = null;
          // NOTE: retryAttempt is intentionally NOT reset here. It must
          // accumulate across transient failures so the cap below actually
          // fires. The previous code reset it to 0 on every drain iteration,
          // which made the cap unreachable and let a stuck queue retry
          // forever. Reset only on success (line 218) or hard error.
          this.lastError = null;
          this.updateStoreState();

          try {
            await this.commitOnce(entry.state);
            entry.resolve();
            // Reset retry counter on success — fresh attempt budget for the
            // next entry. NÃO zeramos o orçamento de flood aqui: um sucesso
            // isolado não prova que o flood passou (o padrão de campo é
            // "um commit passa, o próximo é recusado"). O orçamento só é
            // renovado por FLOOD_WAIT_RESET_WINDOW_MS sem nenhum flood.
            this.retryAttempt = 0;
          } catch (err: any) {
            this.lastError = err;
            if (isHardError(err)) {
              this.retryingEntry = null;
              this.retryAttempt = 0;
              // Hard error também zera o orçamento de flood: o ciclo
              // acabou, o próximo não deve herdar o gasto deste.
              this.floodWaitSpentMs = 0;
              this.lastFloodAt = 0;
              entry.reject(err);
              this.updateStoreState();
              // `continue`, não `break` — e este detalhe é o fix REAL. O
              // comentário anterior (que eu escrevi) dizia "`break` sai do
              // while; o código abaixo vê que ainda há `pending` e faz o
              // drain continuar". Não existe código abaixo: o `while` é o
              // último bloco do `try`, e depois dele só há o `finally` —
              // que apenas nulla `inflight`. Ou seja, `break` e `return`
              // eram funcionalmente IDÊNTICOS, e a promessa do comentário
              // não se cumpría.
              //
              // O cenário que ficava preso: `commitOnce` A falha com hard
              // error enquanto o usuário dispara a ação B. O `enqueue` de B
              // chamou `drain()` e caiu no early-return de `if
              // (this.inflight) return` — ninguém mais chama `drain`. Com
              // `break`, A era rejeitada, `inflight` virava null, e B
              // ficava em `pending` para SEMPRE: a promise de B nunca
              // resolvia nem rejeitava, então o `finally` de
              // `applyOptimistic` (que faz `setSyncing(false)`) nunca
              // rodava, e a barra ficava em "Salvando…" indefinidamente.
              //
              // `continue` re-avalia a condição do `while`, que drena a
              // entrada pendente na hora. Terminação garantida: cada
              // iteração consome `this.pending` antes do commit, então não
              // há como voltar ao topo sem consumir uma entrada nova.
              continue;
            }
            // Transient: scheduleRetry increments retryAttempt internally
            // and may itself trigger a drain when the timer fires. We do
            // NOT increment here — that would double-count. The cap is
            // checked inside scheduleRetry so we surface "Save failed"
            // before firing yet another doomed retry.
            this.retryingEntry = entry;
            this.scheduleRetry(err);
            return;
          }
        }
      } finally {
        this.inflight = null;
        this.updateStoreState();
      }
    })();
  }

  private scheduleRetry(err: any): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.retryCountdownTimer) {
      clearInterval(this.retryCountdownTimer);
      this.retryCountdownTimer = null;
    }

    // FLOOD_WAIT é uma ESPERA, não uma falha: o Telegram está dizendo
    // "espere X e a próxima passa". Tratamos em ramo próprio para que
    // (a) espere o prazo REAL exigido (teto longo) e (b) não consuma o
    // orçamento de retries transitórios. O limite é um ORÇAMENTO DE TEMPO
    // numa janela deslizante (não um contador zerado a cada sucesso, que
    // permitiria flood persistente por horas).
    const floodSeconds = parseFloodWaitSeconds(err);
    if (floodSeconds != null) {
      const now = Date.now();

      // Janela renovada: passou tempo suficiente SEM flood desde a última
      // recusa. Isso indica que o flood realmente cessou, então o gasto
      // acumulado deixa de contar.
      if (this.lastFloodAt > 0 && now - this.lastFloodAt > FLOOD_WAIT_RESET_WINDOW_MS) {
        this.floodWaitSpentMs = 0;
      }
      this.lastFloodAt = now;

      // Espera o prazo que o Telegram pediu, com teto LONGO. Retentar
      // antes do prazo renova/agrava o flood (é o que causava a escalada
      // 125s → 600s → 884s no log de campo).
      const floodDelayMs =
        computeRetryDelay(this.retryAttempt, err, FLOOD_WAIT_MAX_CAP_SECONDS);

      // Orçamento estourado: desistir é melhor que ficar aguardando por
      // horas com o índice sem convergir. Devolve erro para o caller
      // (rollback otimista / "Salvar falhou" com botão de retry manual).
      if (this.floodWaitSpentMs + floodDelayMs > FLOOD_WAIT_TOTAL_BUDGET_MS) {
        const wrapped = new Error(
          `Index save failed: FLOOD_WAIT excedeu o orçamento de ${Math.round(
            FLOOD_WAIT_TOTAL_BUDGET_MS / 60000,
          )}min de espera (última recusa: ${floodSeconds}s)`,
        );
        void invoke("log_vault_state", {
          state: `INDEX_QUEUE_GIVE_UP flood_budget_ms=${this.floodWaitSpentMs} last_err=${err?.message ?? String(err)}`,
        }).catch(() => {});
        if (this.retryingEntry) {
          const entry = this.retryingEntry;
          this.retryingEntry = null;
          this.floodWaitSpentMs = 0;
          this.lastFloodAt = 0;
          this.retryAttempt = 0;
          entry.reject(wrapped);
        }
        this.updateStoreState();
        return;
      }

      this.floodWaitSpentMs += floodDelayMs;
      void invoke("log_vault_state", {
        state: `INDEX_FLOOD_WAIT wait=${Math.round(floodDelayMs / 1000)}s asked=${floodSeconds}s budget_used_ms=${this.floodWaitSpentMs}`,
      }).catch(() => {});

      const deadline = Date.now() + floodDelayMs;
      useFileStore.getState().setIndexQueueRetryInSec(Math.ceil(floodDelayMs / 1000));
      this.retryCountdownTimer = setInterval(() => {
        const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        useFileStore.getState().setIndexQueueRetryInSec(secs);
        if (secs <= 0 && this.retryCountdownTimer) {
          clearInterval(this.retryCountdownTimer);
          this.retryCountdownTimer = null;
        }
      }, 500);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.retryCountdownTimer) {
          clearInterval(this.retryCountdownTimer);
          this.retryCountdownTimer = null;
        }
        void this.drain();
      }, floodDelayMs);
      this.updateStoreState();
      return;
    }

    // Transitória NÃO-flood (rede/timeout): aqui sim é um retry que pode
    // "gastar" orçamento, com backoff curto.
    // Increment BEFORE computing the delay so the cap is correct.
    this.retryAttempt++;

    // If we've burned the retry budget, give up. Surface a hard error to
    // the caller so the optimistic state rolls back (if any) and the UI
    // shows "Save failed" with a manual retry button — instead of an
    // invisible infinite-loop retry the user can't act on.
    if (this.retryAttempt > MAX_TRANSIENT_RETRIES) {
      const wrapped = new Error(
        `Index save failed after ${MAX_TRANSIENT_RETRIES} transient retries: ${
          err?.message ?? String(err)
        }`
      );
      void invoke("log_vault_state", {
        state: `INDEX_QUEUE_GIVE_UP retries=${MAX_TRANSIENT_RETRIES} last_err=${
          err?.message ?? String(err)
        }`,
      }).catch(() => {});
      // Reject the entry that was being retried. Caller's `applyOptimistic`
      // catches this and rolls back the optimistic state — the user sees
      // their action "fail" cleanly instead of silently bouncing back.
      if (this.retryingEntry) {
        const entry = this.retryingEntry;
        this.retryingEntry = null;
        this.retryAttempt = 0;
        this.floodWaitSpentMs = 0;
        this.lastFloodAt = 0;
        entry.reject(wrapped);
      }
      this.updateStoreState();
      return;
    }

    const delayMs = computeRetryDelay(this.retryAttempt, err);

    const deadline = Date.now() + delayMs;
    // Update countdown every 500ms so the UI can show "Retrying in 12s".
    useFileStore.getState().setIndexQueueRetryInSec(Math.ceil(delayMs / 1000));
    this.retryCountdownTimer = setInterval(() => {
      const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      useFileStore.getState().setIndexQueueRetryInSec(secs);
      if (secs <= 0 && this.retryCountdownTimer) {
        clearInterval(this.retryCountdownTimer);
        this.retryCountdownTimer = null;
      }
    }, 500);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.retryCountdownTimer) {
        clearInterval(this.retryCountdownTimer);
        this.retryCountdownTimer = null;
      }
      void this.drain();
    }, delayMs);

    this.updateStoreState();
  }

  /**
   * One Telegram round-trip that writes the given file state to the channel.
   * Throws on hard errors; throws on transient errors so the caller can retry.
   */
  private async commitOnce(state: TeleFile[]): Promise<void> {
    const client = getClient();

    let peer: any;
    try {
      peer = await resolvePeerWithTimeout(client, this.channelId);
    } catch (err) {
      throw err; // Already classified upstream as transient or hard.
    }

    const chunks = chunkIndexBySize(state);

    // 1. Find the "current" existing index set — the messages we should edit
    //    or delete. This must use the SAME coherent-set selection logic as
    //    loadIndex, otherwise the queue will:
    //
    //      a) Edit OLDER index messages from a previous epoch while leaving
    //         the NEWER messages untouched, creating a Frankenstein channel
    //         where loadIndex on next restart has to pick between them
    //         (typically the older one wins if it's still pinned).
    //      b) Miss the current index entirely if it was unpinned (FLOOD_WAIT
    //         blocked the pin) but exists in the recent message stream,
    //         causing the queue to send a fresh duplicate set on top.
    //
    //    The fix: combine pinned + recent (BOTH, not either), then let
    //    pickCoherentIndexSet pick the same set loadIndex would pick.
    let allMsgs: any[] = [];
    try {
      const pinned = await withTimeout(
        client.getMessages(peer, {
          filter: new Api.InputMessagesFilterPinned(),
          limit: 100,
        }),
        FETCH_TIMEOUT_MS,
        "client.getMessages(pinned)"
      );
      allMsgs = allMsgs.concat(pinned);
    } catch (err) {
      // Fetch failed — treat as transient so we retry.
      throw err;
    }

    try {
      const recent = await withTimeout(
        client.getMessages(peer, { limit: 200 }),
        FETCH_TIMEOUT_MS,
        "client.getMessages(recent)"
      );
      allMsgs = allMsgs.concat(recent);
    } catch (err: any) {
      await invoke("log_vault_state", {
        state: `INDEX_FETCH_RECENT_FAIL reason=${err?.message ?? err}`,
      }).catch(() => {});
      // Non-fatal: we still have the pinned set above.
    }

    // Pick the coherent set of chunks that represents the current state of
    // the index.
    //
    // ATENÇÃO, pós-remoção do caminho de edição: `coherentSet` e `existing`
    // abaixo NÃO são mais o alvo de exclusão. O delete do passo 3 usa
    // `allMsgs` inteiro (qualquer chunk de índice que não seja recém-enviado).
    // `existing` sobrevive apenas para o log INDEX_EXISTING_FOUND/NONE, que é
    // o que faz um diagnóstico de "por que este commit reescreveu tudo"
    // distinguir "já existia epoch coerente" de "era a primeira gravação".
    const coherentSet: ParsedIndexChunk[] | null = pickCoherentIndexSet(allMsgs);

    // Map back from msgId → original Telegram message object, used only
    // for the diagnostics below.
    const existingById = new Map<number, any>();
    for (const m of allMsgs) {
      if (m?.id != null) existingById.set(Number(m.id), m);
    }
    const existing: any[] = coherentSet
      ? coherentSet
          .map((c) => existingById.get(c.msgId))
          .filter((m): m is any => Boolean(m))
      : [];

    if (existing.length > 0) {
      await invoke("log_vault_state", {
        state: `INDEX_EXISTING_FOUND count=${existing.length} msgIds=[${existing.map((m: any) => m.id).join(",")}]`,
      }).catch(() => {});
    } else {
      await invoke("log_vault_state", {
        state: `INDEX_EXISTING_NONE scannedMsgs=${allMsgs.length}`,
      }).catch(() => {});
    }

    // 2. SEND-FIRST, DELETE-LATER — esta é a decisão de atomicidade do
    //    índice inteiro, e ela inverte a ordem anterior (apagar-antes-de-
    //    enviar).
    //
    //    Por que a ordem antiga perdia dados: ela APAGAVA os chunks velhos
    //    e depois enviava os novos. Se o envio falhasse no chunk k de N
    //    (FLOOD_WAIT, timeout, processo morto), o canal ficava com uma
    //    epoch INCOMPLETA e nada mais. `pickCoherentIndexSet` não achava
    //    epoch coerente, `loadIndex` caía no merge best-effort — e
    //    `healAndSave` GRAVAVA esse set truncado de volta. Uma falha
    //    transitória virava perda permanente de ~40% dos arquivos.
    //
    //    Por que enviar-primeiro é seguro: `pickCoherentIndexSet` escolhe
    //    a epoch completa com a msgId MAIS ALTA, e msgId do Telegram é
    //    estritamente crescente. Logo:
    //
    //      - envio parcial → a epoch nova está INCOMPLETA → é ignorada →
    //        a epoch velha (completa) continua sendo a fonte da verdade.
    //        Nada se perde, e o retry reconstrói.
    //      - envio completo → a epoch nova tem msgIds maiores → vence.
    //        Só ENTÃO apagamos a velha.
    //      - falha no delete → epoch velha sobra como lixo, mas continua
    //        perdendo a comparação por msgId. Lixo, não corrupção.
    //
    //    Este mesmo raciocínio torna o antigo caminho de EDIÇÃO-in-place
    //    desnecessário (e foi removido). Ele editava os chunks no MESMO
    //    msgId: um edit que falhava no chunk 2 deixava chunks 0-1 com
    //    conteúdo novo e 2-3 com velho, todos com totalChunks/chunkIndex
    //    coerentes — e `findMostRecentCoherentEpoch` aceitava aquele
    //    Frankenstein como uma epoch completa e válida. Não há como
    //    "desfazer" um edit no Telegram, então aquele caminho não tinha
    //    como convergir sozinho.
    const newMsgIds: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const payload = {
        kumadrive_index: true,
        version: 1,
        chunkIndex: i,
        totalChunks: chunks.length,
        files: chunks[i],
      };
      const text = JSON.stringify(payload);

      let msgId: number;
      try {
        const result = await withTimeout(
          client.sendMessage(peer, { message: text }),
          EDIT_TIMEOUT_MS,
          `sendMessage(chunk ${i})`
        );
        msgId = Number((result as any).id);
        newMsgIds.push(msgId);
      } catch (err) {
        throw err;
      }

      // Pin is truly best-effort now. Pin failures NEVER cause a retry
      // because loadIndex picks by message id, not pin status. The pin
      // is only a fast-path hint to find the index quickly; if it's
      // missing, the scan-on-load path still finds the right messages.
      try {
        await withTimeout(
          client.invoke(
            new Api.messages.UpdatePinnedMessage({
              peer,
              id: msgId,
              unpin: false,
              silent: true,
            })
          ),
          PIN_TIMEOUT_MS,
          `UpdatePinnedMessage(chunk ${i})`
        );
      } catch (err: any) {
        await invoke("log_vault_state", {
          state: `INDEX_PIN_FAIL chunk=${i} reason=${err?.message ?? err}`,
        }).catch(() => {});
      }
    }

    await invoke("log_vault_state", {
      state: `INDEX_SEND_OK chunks=${chunks.length} files=${state.length} msgIds=[${newMsgIds.join(",")}]`,
    }).catch(() => {});

    // 3. TODA a epoch nova está no Telegram. Agora sim apagamos os chunks
    //    antigos — inclusive os de epochs velhas órfãs que um delete
    //    falhado deixou para trás. A correção aqui também limpa o lixo:
    //    apagamos QUALQUER mensagem de índice em `allMsgs` que não seja
    //    uma das que acabamos de enviar.
    //
    //    Filtro EXATO, não substring. `.text` de uma mensagem de mídia é
    //    o CAPTION (GramJS message.js: `get text() { return this.message }`),
    //    e o caption de arquivo é `kumadrive_file:{"folder":"..."}`.
    //    Com `includes("kumadrive_index")` — como escrevi nesta versão —
    //    um usuário que criasse uma pasta chamada "kumadrive_index" e
    //    subisse um arquivo nela teria o msgId DELE incluído em
    //    `staleIds` a cada commit, e o `deleteMessages(..., {revoke:true})`
    //    apagaria os BYTES do arquivo do Telegram. O índice continuaria
    //    referenciando aquele messageId: arquivo visível na UI, 404 no
    //    download, perda permanente.
    //
    //    Exigimos o prefixo EXATO do payload de índice. `JSON.stringify`
    //    produz `{"kumadrive_index":true,...` (chave numerada primeiro,
    //    sem espaços), então este prefixo só casa com chunks reais:
    //      - caption de arquivo  → `kumadrive_file:{...}`        não casa
    //      - pasta "kumadrive_index" com arquivo dentro → caption é
    //        `kumadrive_file:{"folder":"kumadrive_index"}`       não casa
    //    `parseIndexMessages` continua protegido pelo `JSON.parse`; o
    //    delete agora também tem garantia de identidade.
    const newIdSet = new Set(newMsgIds);
    const staleIds = allMsgs
      .filter(
        (m: any) =>
          m?.id != null && typeof m?.text === "string" && isIndexChunkText(m.text)
      )
      .map((m: any) => Number(m.id))
      .filter((id: number) => Number.isFinite(id) && !newIdSet.has(id));

    if (staleIds.length > 0) {
      let deleteOk = false;
      let lastDeleteErr: any = null;
      // Distingue o FLOOD_WAIT engolido do give-up de erro normal no log
      // final — sem isto o mesmo evento gerava DOIS logs
      // (INDEX_DELETE_OLD_FLOOD_WAIT swallowed + INDEX_DELETE_OLD_GIVE_UP),
      // deixando o diagnóstico ambíguo.
      let floodWaitSwallowed = false;
      for (let attempt = 1; attempt <= 3 && !deleteOk; attempt++) {
        try {
          await withTimeout(
            client.deleteMessages(peer, staleIds, { revoke: true }),
            DELETE_TIMEOUT_MS,
            `deleteMessages(stale attempt=${attempt})`
          );
          deleteOk = true;
        } catch (err: any) {
          lastDeleteErr = err;
          await invoke("log_vault_state", {
            state: `INDEX_DELETE_OLD_FAIL attempt=${attempt} reason=${err?.message ?? err}`,
          }).catch(() => {});
          // FLOOD_WAIT aqui NÃO pode lançar, e é o ponto sutil desta
          // versão. O envio da epoch nova JÁ terminou (o passo acima só
          // roda depois de `INDEX_SEND_OK`). Lançar faria o queue
          // reenviar a epoch INTEIRA por causa do LIXO — n×send + n×pin
          // ×5 tentativas, estourando o cap — e o `enqueueSave`
          // rejeitaria, fazendo o `applyOptimistic` DESFAZER na UI uma
          // ação que já está gravada no Telegram. Daí a próxima ação
          // gravaria o estado revertido: um "undo" fantasma.
          //
          // A correção do commit depende só de a epoch nova ter msgId
          // maior, o que o envio acima já garantiu. Lixo que sobra perde
          // a seleção por msgId — nunca corrupção. Então engolimos.
          if (parseFloodWaitSeconds(err) != null) {
            floodWaitSwallowed = true;
            await invoke("log_vault_state", {
              state: `INDEX_DELETE_OLD_FLOOD_WAIT swallowed count=${staleIds.length} err=${err?.message ?? err}`,
            }).catch(() => {});
            break;
          }
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
      await invoke("log_vault_state", {
        state: deleteOk
          ? `INDEX_DELETE_OLD_OK count=${staleIds.length}`
          : floodWaitSwallowed
          ? `INDEX_DELETE_OLD_PENDING count=${staleIds.length} reason=flood_wait lixo fica para o próximo commit`
          : `INDEX_DELETE_OLD_GIVE_UP count=${staleIds.length} err=${lastDeleteErr?.message ?? lastDeleteErr}`,
      }).catch(() => {});
    }
  }
}

/**
 * True quando o texto é EXATAMENTE um chunk de índice do KumaDrive.
 *
 * Guarda de segurança do `deleteMessages` do commit: impede apagar blobs
 * de arquivo ou captions que apenas CONTENHAM o literal "kumadrive_index"
 * (ex.: o nome de uma pasta). Ver o comentário do passo 3 em `commitOnce`.
 */
function isIndexChunkText(text: string): boolean {
  return text.startsWith('{"kumadrive_index":true');
}

async function resolvePeerWithTimeout(client: any, channelId: string): Promise<any> {
  // Mirrors resolveChannelInputPeer in metadataStore.ts but is local so the
  // queue is self-contained and doesn't depend on a circular import.
  try {
    return await client.getInputEntity(channelId);
  } catch (err) {
    return await withTimeout(
      client.getEntity(channelId),
      5000,
      "client.getEntity"
    );
  }
}

const queues: Map<string, ChannelQueue> = new Map();

/**
 * Returns the queue for the given channel, creating it on first use.
 */
export function getIndexQueue(channelId: string): ChannelQueue {
  let q = queues.get(channelId);
  if (!q) {
    q = new ChannelQueue(channelId);
    queues.set(channelId, q);
  }
  return q;
}

/**
 * Public API used by useFileActions and uploadManager.
 *
 * Resolves once the state has been durably written to Telegram.
 * Rejects with the original error if the write failed terminally (hard error).
 * For transient errors, the queue swallows the rejection and retries; the
 * returned promise stays pending until success or hard failure. This matches
 * the user's "hybrid rollback" choice — callers should roll back ONLY if this
 * promise rejects.
 */
export function enqueueSave(channelId: string, state: TeleFile[]): Promise<void> {
  return getIndexQueue(channelId).enqueue(state);
}

/** Flush all queues (used on logout). */
export async function flushAllQueues(): Promise<void> {
  await Promise.all(Array.from(queues.values()).map((q) => q.flush()));
  queues.clear();
}

/** Force an immediate retry on a currently-failed queue. */
export function retryQueue(channelId: string): void {
  const q = queues.get(channelId);
  if (!q) return;
  // enqueue with the current store state to force a retry attempt.
  const cur = useFileStore.getState().files;
  void q.enqueue(cur);
}