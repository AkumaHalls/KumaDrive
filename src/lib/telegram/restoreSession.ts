import { initClient, getClient } from "./client";
import { useAuthStore } from "../../stores/authStore";
import {
  getSecret,
  VAULT_KEY_API_ID,
  VAULT_KEY_API_HASH,
} from "../secure/vault";
import { DEFAULT_API_ID, DEFAULT_API_HASH } from "./config";
import { isAuthError, isSoftAuthError } from "./authErrors";
import { invoke } from "@tauri-apps/api/core";

/**
 * Attempts to restore a previously saved Telegram session.
 *
 * Session token is stored via a dedicated Rust command (save_session) which
 * writes a simple JSON file in the app data dir. This is reliable and survives
 * dev-server restarts without any Stronghold overhead.
 *
 * Credentials (API ID / API Hash) are still read from the Stronghold vault so
 * users who configure custom credentials retain that preference.
 */
export async function restoreSession(): Promise<boolean> {
  console.log("restoreSession: Starting session restoration...");
  try {
    // ── 1. Load the session token from the file-backed store ──────────────────
    let sessionString: string | null = null;
    let phoneNumber: string = "";

    try {
      const stored = await invoke<{ session: string | null; phone: string | null }>(
        "load_session"
      );
      sessionString = stored?.session ?? null;
      phoneNumber   = stored?.phone   ?? "";
      const maskedPhone = phoneNumber ? phoneNumber.slice(0, 4) + "****" + phoneNumber.slice(-4) : "empty";
      await invoke("log_vault_state", {
        state: `RESTORE_LAUNCH: hasSession=${!!sessionString} sessionLen=${sessionString?.length ?? 0} phone=${maskedPhone}`,
      });
    } catch (loadErr: any) {
      await invoke("log_vault_state", {
        state: `RESTORE_LOAD_ERR: ${loadErr?.message ?? JSON.stringify(loadErr)}`,
      });
      // If we can't load, fall through and return false
      return false;
    }

    if (!sessionString) {
      await invoke("log_vault_state", { state: "RESTORE_DONE: No session stored." });
      return false;
    }

    // ── 2. Resolve API credentials (vault or built-in defaults) ───────────────
    let apiId   = DEFAULT_API_ID;
    let apiHash = DEFAULT_API_HASH;
    try {
      const storedApiIdStr  = await getSecret(VAULT_KEY_API_ID);
      const storedApiHash   = await getSecret(VAULT_KEY_API_HASH);
      if (storedApiIdStr) {
        const parsed = parseInt(storedApiIdStr, 10);
        if (!isNaN(parsed)) apiId = parsed;
      }
      if (storedApiHash) apiHash = storedApiHash;
    } catch {
      // Vault unavailable — built-in defaults already set above
    }

    // Set credentials in Zustand store
    useAuthStore.getState().setCredentials(apiId, apiHash);

    // ── 3. Re-initialise the Telegram client and verify the session ───────────
    await initClient(apiId, apiHash, sessionString);
    const client = getClient();

    const isAuthorized = await client.isUserAuthorized();
    await invoke("log_vault_state", {
      state: `RESTORE_AUTH_CHECK: isAuthorized=${isAuthorized}`,
    });

    if (isAuthorized) {
      useAuthStore.getState().setSession(sessionString, phoneNumber);
      await invoke("log_vault_state", { state: "RESTORE_SUCCESS: Session restored successfully." });
      return true;
    } else {
      // Session is stale — clear it so the user is not stuck
      await invoke("clear_session").catch(() => {});
      useAuthStore.getState().logout();
      await invoke("log_vault_state", { state: "RESTORE_FAIL: Session not authorized. Cleared." });
      return false;
    }
  } catch (error: any) {
    const errorStr = `RESTORE_EXC: ${error?.message ?? "no_msg"}\nStack: ${error?.stack ?? "no_stack"}`;
    await invoke("log_vault_state", { state: errorStr }).catch(() => {});

    // Só apaga a sessão quando o Telegram realmente indicou que ela não vale
    // mais. Antes, qualquer erro que não "parecesse rede" (500 interno,
    // RPC_CALL_FAIL, FLOOD_WAIT) deslogava o usuário no boot.
    if (isAuthError(error) || isSoftAuthError(error)) {
      console.warn("restoreSession: sessão inválida ou expirada, limpando...", error);
      await invoke("clear_session").catch(() => {});
      useAuthStore.getState().logout();
    } else {
      console.warn("restoreSession: falha transitória ao restaurar a sessão (mantendo sessão ativa):", error);
    }
    return false;
  }
}
