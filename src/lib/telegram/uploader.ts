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
  FLOOD_WAIT_MAX_CAP_SECONDS,
} from "./rateLimit";

/**
 * Tamanho do chunk enviado por `SaveFilePart`/`SaveBigFilePart`.
 *
 * O Telegram recomenda de 512KB a 1MB. Usar 1MB (o teto recomendado)
 * METADE dos chunks de um arquivo — e, com isso, metade das leituras de
 * disco, metade das conversões `Uint8Array → Buffer` e metade dos
 * round-trips de IPC (`read_file_chunk`) e de rede. Num arquivo de 1GB
 * isso significa ~1024 chunks em vez de ~2048.
 *
 * Cuidado: `parts` (o número de partes do arquivo) é derivado daqui e
 * precisa caber no `int` do MTProto, então não subimos além de 1MB.
 */
const CHUNK_SIZE = 1024 * 1024; // 1MB (teto recomendado pelo Telegram)
// Timeout por chunk. Com chunks de 1MB dobramos o volume por round-trip,
// então subimos o teto de 20s para 30s — uma pausa de rede não deve
// abortar um chunk que ainda está progredindo.
const CHUNK_TIMEOUT_MS = 30_000;
const SENDFILE_TIMEOUT_MS = 30_000;

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
      // FLOOD_WAIT aqui usa o TETO LONGO (900s), não o curto de 30s. Motivo
      // (evidência de campo): o Telegram pediu esperas de 125s→600s→884s e
      // o app, com teto de 30s, esperava 30s e reenviava o chunk — o que
      // RENOVA e AGRAVA o flood em vez de resolvê-lo. O resultado era o
      // backup falhar com "falha na conexão" após subir 2 arquivos. Com o
      // teto longo esperamos o prazo que o Telegram exigiu e o upload
      // converge em vez de escalar.
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
        // Menos tentativas que antes (5) de propósito: como cada espera de
        // FLOOD_WAIT agora respeita o prazo real, uma tentativa longa já
        // resolve; insistir 5× só multiplicaria a espera total. 3 tentativas
        // cobrem blips de rede sem transformar um rate-limit persistente
        // numa espera de horas.
        3,
        onRetry
          ? (e) =>
              onRetry({
                ...e,
                label: chunkLabel,
              })
          : undefined,
        // Teto de FLOOD_WAIT longo: esperar o prazo pedido, não retentar a
        // cada 30s (que agrava o flood).
        FLOOD_WAIT_MAX_CAP_SECONDS,
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
      // Finalize cap: 3 attempts. Se um FLOOD_WAIT vier aqui, esperamos o
      // prazo real (teto longo) — os chunks já estão no Telegram, então
      // convergir vale mais que desistir rápido e reenviar tudo depois.
      3,
      onRetry
        ? (e) =>
            onRetry({
              ...e,
              label: finalizeLabel,
            })
        : undefined,
      FLOOD_WAIT_MAX_CAP_SECONDS,
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
