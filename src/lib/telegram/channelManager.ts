import { Api } from "telegram";
import { getClient } from "./client";
import { getSecret, saveSecret, VAULT_KEY_CHANNEL_ID, channelIdKey } from "../secure/vault";

/**
 * Títulos de canal reconhecidos como canal de armazenamento.
 *
 * IMPORTANTE — compatibilidade com instalações existentes:
 * o app original (TeleDrive) criava o canal privado com o título
 * "TeleDrive Storage". Se procurássemos apenas "KumaDrive Storage",
 * contas que já têm arquivosuplOADED ficariam sem canal e o app
 * criaria um canal vazio novo, parecendo perda de dados.
 * Por isso o título legado continua sendo aceito na busca.
 */
const STORAGE_CHANNEL_TITLES = ["KumaDrive Storage", "TeleDrive Storage"] as const;

function isStorageChannelTitle(title: string): boolean {
  return (STORAGE_CHANNEL_TITLES as readonly string[]).includes(title.trim());
}

/**
 * O erro significa "esta entidade/channel não existe" — diferente de
 * "não consegui falar com o Telegram agora".
 *
 * A distinção é crítica em `ensureStorageChannel`: tratar uma falha de
 * rede — ou uma sessão revogada — como "canal sumiu" levava o fluxo a
 * CRIAR um canal novo e sobrescrever o id guardado no vault, apontando
 * o drive para um canal vazio enquanto o original (com todos os
 * arquivos) continuava intocado e sem referência. Perda aparente de
 * tudo, sem nenhum aviso.
 *
 * Só entram erros que PROVAM que a ENTIDADE não existe mais: o canal
 * foi apagado, o id guardado está errado, ou a conta perdeu acesso a
 * ele.
 *
 * `AUTH_KEY_UNREGISTERED` NÃO entra, apesar do código 401: ele significa
 * "esta conta foi removida deste dispositivo", não "o canal sumiu". O
 * canal continua lá com todos os arquivos. Classifier como entidade
 * morta faria o app criar um canal novo em CADA sessão revogada —
 * exatamente a perda de dados que este helper existe para evitar.
 * Ele propaga para cima, e o chamador mostra "reconecte sua conta".
 */
function isMissingEntityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");

  // Auth primeiro, com Return antecipado: precisa vencer qualquer outro
  // padrão da mensagem antes de qualquer outra checagem.
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED/i.test(msg)) {
    return false;
  }

  // Só trata como "entidade morta" o que nomeia o PEER. Um 400/403
  // genérico (ex.: flood limit) sem menção ao canal não prova nada.
  const namesPeer =
    /CHANNEL_INVALID|PEER_ID_INVALID|CHANNEL_PRIVATE|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|NOCHAT|CHAT_ID_INVALID/i.test(
      msg,
    );
  if (namesPeer) return true;

  // Código RPC sem nome de peer: conservadoramente NÃO é entidade morta.
  // Preferimos falhar e pedir novo login a criar um canal e perder o
  // acesso aos dados do usuário.
  return false;
}

/**
 * Ensures the KumaDrive Storage channel exists for the given phone number.
 *
 * Multi-account design:
 *   Each Telegram account stores its channel ID under a phone-specific vault key:
 *   e.g. "telegram_channel_id_+918653420095"
 *
 *   This means logging in with Account A and Account B never interferes — each
 *   account finds its own channel and its own uploaded files.
 *
 * Lookup order:
 *   1. Phone-specific vault key  (fast path, normal case)
 *   2. Legacy generic key        (migration: single-account installs before this change)
 *   3. Dialog search             (recovery: vault cleared / first run on new device)
 *   4. Create new channel        (first-ever login for this account)
 */
export async function ensureStorageChannel(phone: string): Promise<string> {
  const client = getClient();
  const phoneKey = channelIdKey(phone);

  // —— 1. Phone-specific vault key (fast path) ——————————————————————————————
  let channelId = await getSecret(phoneKey);

  if (channelId) {
    try {
      const peer = await client.getEntity(channelId);
      if (peer) return channelId;
    } catch (err) {
      // Distingue "o canal não existe mais" de "não consegui falar com o
      // Telegram agora". Antes, TODO erro zerava o channelId e caía até
      // o passo 4, que CRIAVA um canal novo e sobrescrevia a chave do
      // vault com o id novo. Duas falhas de rede seguidas no login
      // faziam o drive aparecer vazio e o id do canal original sumir —
      // sem nenhum aviso ao usuário.
      if (!isMissingEntityError(err)) {
        throw err;
      }
      console.warn(`[channelManager] Channel ${channelId} no longer exists, searching dialogs…`);
      channelId = null;
    }
  }

  // —— 2. Legacy generic key (migration path for existing installs) —————————
  if (!channelId) {
    const legacyId = await getSecret(VAULT_KEY_CHANNEL_ID);
    if (legacyId) {
      try {
        const peer = await client.getEntity(legacyId);
        if (peer) {
          // Migrate: write under the phone-specific key so future lookups are fast
          await saveSecret(phoneKey, legacyId);
          console.info(`[channelManager] Migrated legacy channel ID ${legacyId} → ${phoneKey}`);
          return legacyId;
        }
      } catch (err) {
        if (!isMissingEntityError(err)) throw err;
        console.warn(`[channelManager] Legacy channel ${legacyId} no longer exists, searching dialogs…`);
      }
    }
  }

  // —— 3. Search dialogs for "KumaDrive Storage" ————————————————————————————
  try {
    const dialogs = await client.getDialogs({});
    for (const dialog of dialogs) {
      if (
        isStorageChannelTitle(dialog.title ?? "") &&
        (dialog.isChannel || dialog.entity?.className === "Channel") &&
        dialog.id
      ) {
        // dialog.id from GramJS is BigInt; normalise to a plain string
        // Use the absolute value with -100 prefix which is how Telegram identifies supergroups/channels
        const rawId = String(dialog.id);
        await saveSecret(phoneKey, rawId);
        console.info(`[channelManager] Found channel via dialog search: ${rawId}`);
        return rawId;
      }
    }
  } catch (err) {
    // Rede falhou de novo. Criar um canal agora seria_data-loss puro:
    // o canal original continua existindo com todos os arquivos, e nós
    // trocaríamos o id guardado,_pointando o drive para um canal vazio.
    if (!isMissingEntityError(err)) throw err;
    console.warn("[channelManager] Dialog search failed:", err);
  }

  // —— 4. Create a new private channel (first-ever login for this account) —
  //
  // Só chega aqui se o vault não tinha id, ou se o id guardado realmente
  // não existe mais (confirmado por `isMissingEntityError` acima). Nunca
  // por falha de rede.
  try {
    const result = await client.invoke(
      new Api.channels.CreateChannel({
        title: "KumaDrive Storage",
        about: "Private storage channel managed by KumaDrive. Do not delete or modify pinned messages.",
        broadcast: true,
      })
    );

    const chats = (result as any).chats || [];
    const channel = chats[0];
    if (!channel) {
      throw new Error("Failed to create storage channel: channel info missing in updates");
    }

    const idStr = String(channel.id);
    await saveSecret(phoneKey, idStr);
    console.info(`[channelManager] Created new channel: ${idStr} for ${phoneKey}`);
    return idStr;
  } catch (err) {
    console.error("[channelManager] Failed to create storage channel:", err);
    throw err;
  }
}

/**
 * Look up the storage channel id WITHOUT contacting Telegram.
 *
 * Used by the multi-device sync orchestrator and the backup scheduler,
 * both of which need to know the channel id WITHOUT triggering a full
 * `ensureStorageChannel` (which would do dialog searches and potentially
 * create a new channel — too heavy for a background tick).
 *
 * Returns the phone-keyed id if present, else the legacy generic key.
 * Returns null if neither is set yet (i.e. user hasn't completed first
 * login). The caller should treat null as "wait for bootstrap" and
 * retry shortly.
 *
 * @param phone  The authenticated phone number, e.g. "+918653420095".
 *               Falls back to the legacy generic key if empty.
 */
export async function getStorageChannelId(phone?: string | null): Promise<string | undefined> {
  const phoneStr = phone ?? "";
  try {
    if (phoneStr) {
      const phoneKey = channelIdKey(phoneStr);
      const id = await getSecret(phoneKey);
      if (id) return id;
    }
    const legacy = await getSecret(VAULT_KEY_CHANNEL_ID);
    return legacy ?? undefined;
  } catch {
    return undefined;
  }
}

