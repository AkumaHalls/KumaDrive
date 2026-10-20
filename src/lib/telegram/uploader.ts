import { Api } from "telegram";
import { getClient } from "./client";
// NOTE: we deliberately do NOT import @tauri-apps/plugin-fs here. Its
// `open()` is gated by capability scopes (`fs:allow-open` etc.) — those
// scopes are baked at build time and can't accept the user's arbitrary
// backup source folders. For file-path inputs we read chunks via a Rust
// command (`read_file_chunk`) which has full filesystem access because
// Tauri Rust commands are not subject to the JS plugin-fs scope.
import bigInt from "big-integer";
import { Buffer } from "buffer";
import { invoke } from "@tauri-apps/api/core";
import { withTimeout } from "../storage/metadataStore";
import {
  withTelegramRetry,
} from "./rateLimit";

/**
 * Tamanho do chunk enviado por `SaveFilePart`/`SaveBigFilePart`: 512KB.
 *
 * 512KB é o teto que o próprio GramJS usa (getAppropriatedPartSize,
 * Utils.js: 128KB <100MB, 256KB <750MB, 512KB acima) e o mesmo valor do
 * Teledrive original. Este fork chegou a usar 1MB aqui (commit 7085adc,
 * "o Telegram recomenda até 1MB" — falso), e TODOS os sintomas de campo
 * bateram com partes acima do teto:
 *
 *   - hipótese corroborada pela evidência (GramJS nunca envia >512KB; o
 *     upstream idem; arquivos <512KB subiam e os maiores nunca): o
 *     servidor não responde erro para uma parte inválida — apenas a
 *     ignora, produzindo o timeout de 30s por tentativa que o log
 *     mostrou em TODOS os arquivos grandes;
 *   - depois de algumas partes ignoradas, a conexão inteira para de ser
 *     respondida (arquivos pequenos válidos e até `getMessages` começam
 *     a dar timeout) — o sintoma parecia "sessão bloqueada", mas re-login
 *     não resolvia: o veneno era o payload;
 *   - arquivos <512KB (uma única parte válida) subiam: por isso o
 *     relato antigo "sobe 2 arquivos e falha" — os 2 pequenos passavam.
 *
 * NÃO subir isto de volta para 1MB: 512KB é o teto do Telegram por parte.
 * (Nota: um arquivo de 4 GiB gera 8192 partes de 512KB — o mesmo caminho
 * que os clientes oficiais usam para uploads Premium de 4 GB.)
 */
const CHUNK_SIZE = 512 * 1024; // 512KB — teto do Telegram por parte
// Timeout por chunk: 20s, o mesmo valor do Teledrive original. Com partes
// válidas de 512KB este é o teto comprovado em campo (o upstream usa-o
// há anos). Um chunk válido responde em fração de segundos.
const CHUNK_TIMEOUT_MS = 20_000;
const SENDFILE_TIMEOUT_MS = 30_000;

/**
 * Limite de arquivo de conta gratuita do Telegram: 2 GB.
 *
 * O limite é do PRÓPRIO Telegram (documento anexado a mensagem) — nenhum
 * app cliente pode contorná-lo. Em bytes usamos 2 GiB (2_147_483_648),
 * o valor conservador: só rejeitamos arquivos que certamente não passam.
 */
const TELEGRAM_FREE_FILE_LIMIT = 2 * 1024 * 1024 * 1024;
/**
 * Limite absoluto, inclusive contas Premium: 4 GB. Acima disto o Telegram
 * recusa o upload SEM responder ao `SaveBigFilePart` — e cada tentativa
 * custa 3×30s de timeout enquanto martela a sessão. Evidência de campo:
 * um arquivo de 9,4 GB (18.401 partes) foi tentado em todos os backups,
 * falhava em ~90s e somava pressão de escrita na sessão que já estava
 * penalizada. O Teledrive original não tem esta guarda — o KumaDrive sim.
 */
const TELEGRAM_PREMIUM_FILE_LIMIT = 4 * 1024 * 1024 * 1024;

/** Formato amigável de GB para as mensagens de erro. */
function gb(size: number): string {
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Memo (por instância de app) da flag Premium da conta logada.
 *
 * `getMe()` no GramJS é barato e cacheado após a primeira chamada, mas
 * evitamos repeti-lo por arquivo: um backup com centenas de arquivos não
 * precisa reconsultar. Se a consulta falhar, assumimos NÃO-Premium — o
 * lado seguro (recusa arquivos de 2-4 GB com mensagem clara em vez de
 * desperdiçar o upload inteiro para o Telegram recusar no final).
 */
let cachedAccountPremium: boolean | null = null;
async function accountHasPremium(client: any): Promise<boolean> {
  if (cachedAccountPremium !== null) return cachedAccountPremium;
  try {
    const me = await client.getMe();
    cachedAccountPremium = (me as any)?.premium === true;
  } catch {
    // Falha da consulta NÃO memoiza: a próxima chamada consulta de novo.
    // Assumir não-Premium APENAS agora é o lado seguro — recusa o arquivo
    // de 2-4 GB com mensagem clara em vez de condenar a sessão inteira a
    // recusar até um getMe futuro dar certo.
    return false;
  }
  return cachedAccountPremium;
}

/**
 * Zera o memo de Premium da conta. Chamado no logout/desconexão: o memo é
 * da CONTA logada, e trocar de conta (sair de uma Premium, entrar numa
 * gratuita, ou o contrário) sem zerar deixaria a flag stale — no pior
 * caso, liberando um arquivo de 3 GB numa conta gratuita (que gastaria o
 * upload inteiro para o Telegram recusar no final, o timeout que esta
 * guarda existe para evitar).
 */
export function resetAccountPremiumCache(): void {
  cachedAccountPremium = null;
}

interface UploadProgressCallback {
  (uploadedBytes: number, totalBytes: number): void;
}

/**
 * Optional callback fired when a chunk or the finalize step is about
 * to be retried. The backup runner wires this to the progress store
 * so the user sees "Retrying 3/5 — waiting 30s" in the overlay
 * instead of a frozen counter. Optional because the regular upload
 * path doesn't have a progress store equivalent.
 */
export type UploadRetryCallback = (event: {
  attempt: number;
  maxAttempts: number;
  waitMs: number;
  floodSeconds: number | null;
  label: string;
  error: any;
}) => void;

/**
 * Uploads a file (either from local native path or browser File object) to Telegram storage channel.
 * Returns the message object representing the uploaded file document.
 */
export async function uploadFileToTelegram(
  channelId: string,
  fileName: string,
  fileSize: number,
  filePathOrFile: string | File,
  folderPath: string = "/",
  onProgress?: UploadProgressCallback,
  onRetry?: UploadRetryCallback,
): Promise<any> {
  const client = getClient();

  // Arquivos de 0 bytes não podem ser enviados por este caminho: `inputFile.parts`
  // precisa ser >= 1 (`FILE_PARTS_INVALID` caso contrário) e uma parte vazia é
  // rejeitada com `FILE_PART_EMPTY`. Como `totalParts = ceil(0/512KB) = 0`,
  // enviar um arquivo vazio falhava com `400 FILE_PARTS_INVALID`. Falhamos com
  // uma mensagem clara em vez do 400 críptico; o walker do backup pula esses
  // arquivos antes de chegar aqui.
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error(
      `KumaDrive não pode enviar "${fileName}": o arquivo está vazio (0 bytes) e ` +
        `a API do Telegram não armazena arquivos de 0 byte.`,
    );
  }

  // Guarda de tamanho: recusa ANTES de qualquer RPC. Arquivos acima do
  // limite do Telegram nunca sobem — tentar só queima ~90s de timeouts
  // por arquivo em CADA backup e martela a sessão de escrita. Isto é uma
  // melhoria sobre o Teledrive original, que tenta e falha do jeito lento.
  if (fileSize > TELEGRAM_PREMIUM_FILE_LIMIT) {
    throw new Error(
      `KumaDrive não vai enviar "${fileName}" (${gb(fileSize)}): excede o limite ` +
        `máximo do Telegram (4 GB por arquivo, inclusive contas Premium). ` +
        `Divida o arquivo em partes menores ou compacte-o antes de tentar de novo.`,
    );
  }
  if (fileSize > TELEGRAM_FREE_FILE_LIMIT && !(await accountHasPremium(client))) {
    throw new Error(
      `KumaDrive não vai enviar "${fileName}" (${gb(fileSize)}): o Telegram limita ` +
        `arquivos a 2 GB em contas gratuitas (contas Premium chegam a 4 GB). ` +
        `Divida o arquivo em partes menores e tente de novo.`,
    );
  }

  // Setup file ID using bigInt which is required by GramJS API
  const fileId = bigInt(Math.floor(Math.random() * 1e15));
  
  const isBig = fileSize > 10 * 1024 * 1024; // > 10MB is considered big in MTProto
  const totalParts = Math.ceil(fileSize / CHUNK_SIZE);

  const isPathInput = typeof filePathOrFile === "string";

  try {
    // Upload chunks sequentially
    for (let partIndex = 0; partIndex < totalParts; partIndex++) {
      const start = partIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      const currentChunkSize = end - start;

      let chunkBytes: Uint8Array;

      if (isPathInput) {
        // Read the chunk via the Rust command. This bypasses the JS
        // plugin-fs scope restrictions (capability files) which would
        // otherwise reject arbitrary user-picked backup source folders.
        // The Rust side has full filesystem access; we just stream the
        // requested byte range back as a Vec<u8>. O Rust agora mantém um
        // pool de handles por caminho, então só pagamos `open` uma vez por
        // arquivo em vez de a cada chunk.
        const rawRes = await invoke<ArrayBuffer | Uint8Array | number[]>("read_file_chunk", {
          path: filePathOrFile as string,
          offset: start,
          length: currentChunkSize,
        });
        if (rawRes instanceof Uint8Array) {
          chunkBytes = rawRes;
        } else if (rawRes instanceof ArrayBuffer) {
          chunkBytes = new Uint8Array(rawRes);
        } else {
          chunkBytes = new Uint8Array(rawRes);
        }
      } else {
        // Read chunk from HTML File object (regular user upload path —
        // file is in the browser's File API, no Rust needed).
        const blobSlice = (filePathOrFile as File).slice(start, end);
        const arrayBuffer = await blobSlice.arrayBuffer();
        chunkBytes = new Uint8Array(arrayBuffer);
      }
      
      // Upload part through the shared retry helper. The chunk is re-read
      // from disk on each attempt via the closure — important because the
      // seek/read may have advanced the handle position mid-failure.
      //
      // Pacing ESPELHADO do Teledrive original: 5 tentativas por parte e
      // teto curto de FLOOD_WAIT (30s). Com partes válidas de 512KB este
      // é o comportamento comprovado em campo pelo upstream — e se um
      // rate-limit real aparecer, o arquivo falha rápido e o run segue,
      // em vez de pendurar o backup numa espera longa.
      const chunkLabel = `${isBig ? "SaveBigFilePart" : "SaveFilePart"}(${partIndex}/${totalParts})`;
      await withTelegramRetry(
        () =>
          withTimeout(
            isBig
              ? client.invoke(
                  new Api.upload.SaveBigFilePart({
                    fileId,
                    filePart: partIndex,
                    fileTotalParts: totalParts,
                    bytes: Buffer.from(chunkBytes),
                  })
                )
              : client.invoke(
                  new Api.upload.SaveFilePart({
                    fileId,
                    filePart: partIndex,
                    bytes: Buffer.from(chunkBytes),
                  })
                ),
            CHUNK_TIMEOUT_MS,
            chunkLabel
          ),
        chunkLabel,
        // 5 tentativas por parte — o mesmo valor do Teledrive original,
        // comprovado em campo. Com partes válidas de 512KB, 5×20s cobre
        // qualquer blip de rede sem exagero.
        5,
        onRetry
          ? (e) =>
              onRetry({
                ...e,
                label: chunkLabel,
              })
          : undefined,
      );
      
      // Update progress
      onProgress?.(end, fileSize);
    }
    
    // Finalize upload inside Telegram
    let inputFile: Api.TypeInputFile;
    if (isBig) {
      inputFile = new Api.InputFileBig({
        id: fileId,
        parts: totalParts,
        name: fileName,
      });
    } else {
      inputFile = new Api.InputFile({
        id: fileId,
        parts: totalParts,
        name: fileName,
        md5Checksum: "",
      });
    }
    
    // Send document to storage channel with folder path JSON metadata caption.
    // Finalize also goes through the retry helper — the file is already fully
    // uploaded to Telegram at this point, so the only failure modes here are
    // transient network/rate-limit issues.
    const caption = `kumadrive_file:${JSON.stringify({ folder: folderPath })}`;
    const finalizeLabel = "client.sendFile";
    const result = await withTelegramRetry(
      () =>
        withTimeout(
          client.sendFile(channelId, {
            file: inputFile,
            forceDocument: true,
            caption,
          }),
          SENDFILE_TIMEOUT_MS,
          finalizeLabel
        ),
      finalizeLabel,
      // Finalize cap: 3 attempts × teto curto — o mesmo pacing do Teledrive
      // original. Os chunks já estão no Telegram; se um rate-limit real
      // aparecer, falhar o arquivo rápido e retomar depois é o
      // comportamento comprovado do upstream (e não congela o overlay).
      3,
      onRetry
        ? (e) =>
            onRetry({
              ...e,
              label: finalizeLabel,
            })
        : undefined,
    );
    
    return result;
  } finally {
    // Libera o handle Rust em cache para o caminho enviado. Sem isto o
    // pool seguraria um descritor aberto por até CACHED_HANDLE_TTL depois
    // do arquivo terminar. Só se aplica a entradas por caminho (arquivos
    // do navegador não passam pelo Rust). Erros são engolidos: isto é
    // limpeza de recurso, não deve esconder o erro de upload original.
    if (isPathInput) {
      try {
        await invoke("release_file_handles", { paths: [filePathOrFile as string] });
      } catch {
        /* limpeza best-effort */
      }
    }
  }
}
