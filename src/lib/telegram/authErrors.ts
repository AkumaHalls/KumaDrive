/**
 * Detecção de erros de sessão do Telegram.
 *
 * Sem isso o app não distingue "sessão revogada" de "erro de rede": o
 * usuário tentava o backup novamente, recebia a mesma falha genérica e
 * não sabia que precisava deslogar e logar de novo. Pior, a fila de
 * backup retryava 5 vezes contra uma credencial morta, acumulando
 * FLOOD_WAIT (o log mostrava "A wait of 880 seconds is required").
 */

/** Códigos que significam que a sessão local não vale mais. */
const AUTH_ERROR_PATTERNS = [
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "SessionRevokedError",
  "AuthKeyUnregisteredError",
];

/**
 * Erros que valem reautenticação mesmo sem ser AUTH_KEY.
 * Mantidos como padrão porque o Telegram usa 401/UNAUTHORIZED em
 * algumas rotas quando o token de sessão ficou inválido.
 */
const SOFT_AUTH_PATTERNS = [
  "401",
  "UNAUTHORIZED",
  "PHONE_MIGRATE",
];

/**
 * Só considera sessão inválida em erro de soft-auth quando não há outro
 * sinal mais forte (FLOOD_WAIT, por exemplo, também pode vir com 401 em
 * gateway). Mantido separado de isAuthError para não mascarar erros
 * transitórios.
 */
export function isSoftAuthError(err: unknown): boolean {
  if (isAuthError(err)) return true;
  if (isFloodWaitError(err)) return false;
  const message = extractMessage(err);
  if (!message) return false;
  return SOFT_AUTH_PATTERNS.some((p) => message.includes(p));
}

export function isAuthError(err: unknown): boolean {
  const message = extractMessage(err);
  if (!message) return false;
  return AUTH_ERROR_PATTERNS.some((p) => message.includes(p));
}

/**
 * Flood wait / rate limit.
 *
 * Distinguir importa porque o limite de retry da fila só faz sentido
 * para erros transitórios: num flood wait o certo é esperar, mas numa
 * sessão morta esperar não resolve nada.
 */
export function isFloodWaitError(err: unknown): boolean {
  const message = extractMessage(err);
  if (!message) return false;
  return message.includes("FLOOD_WAIT") || /A wait of \d+ seconds/i.test(message);
}

/** Limite de mensagem — bug de chunking, não de sessão. */
export function isMessageTooLongError(err: unknown): boolean {
  const message = extractMessage(err);
  return message ? message.includes("MESSAGE_TOO_LONG") : false;
}

/** Extrai segundos de espera de um FLOOD_WAIT, quando presente. */
export function extractFloodWaitSeconds(err: unknown): number | null {
  const message = extractMessage(err);
  if (!message) return null;
  const match = message.match(/A wait of (\d+) seconds/i);
  return match ? Number(match[1]) : null;
}

/**
 * Humaniza o erro para mensagem de toast em pt-BR.
 *
 * O objetivo é que o usuário saiba exatamente o que fazer: em sessão
 * inválida, a instrução tem que ser "deslogue e logue novamente",
 * porque nenhuma quantidade de tentativas vai resolver.
 */
export function describeTelegramError(err: unknown): string {
  const raw = extractMessage(err) ?? "erro desconhecido";

  if (isAuthError(err)) {
    return "Sua sessão do Telegram expirou ou foi encerrada em outro dispositivo. Saia da conta e entre novamente para continuar.";
  }
  if (isMessageTooLongError(err)) {
    return "O índice de arquivos ficou grande demais para o Telegram. Tente reduzir a quantidade de arquivos ou reportar o problema.";
  }

  const floodSeconds = extractFloodWaitSeconds(err);
  if (floodSeconds !== null) {
    const min = Math.ceil(floodSeconds / 60);
    return `O Telegram pediu uma pausa por ${min} min por excesso de requisições. Aguarde e tente de novo.`;
  }
  if (isFloodWaitError(err)) {
    return "O Telegram limitou o número de requisições por um momento. Aguarde alguns instantes e tente novamente.";
  }

  return raw;
}

function extractMessage(err: unknown): string | null {
  if (err == null) return null;
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}