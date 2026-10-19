import { create } from "zustand";
import { useLicenseStore } from "./licenseStore";

interface AuthState {
  isAuthenticated: boolean;
  phoneNumber: string | null;
  sessionString: string | null;
  apiId: number | null;
  apiHash: string | null;
  setCredentials: (apiId: number, apiHash: string) => void;
  setSession: (sessionString: string, phoneNumber: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  phoneNumber: null,
  sessionString: null,
  apiId: null,
  apiHash: null,
  setCredentials: (apiId, apiHash) => set({ apiId, apiHash }),
  setSession: (sessionString, phoneNumber) =>
    set({ sessionString, phoneNumber, isAuthenticated: true }),
  logout: () => {
    try {
      localStorage.removeItem("kumadrive_cached_files");
    } catch (err) {
      console.warn("[authStore] Failed to clear cached files on logout:", err);
    }
    try {
      // As pastas de origem e o intervalo de backup são por conta. Sem
      // esta limpeza, quem logasse depois no mesmo Windows herdaria a
      // configuração de backup da conta anterior — e o próximo "Fazer
      // backup agora" espelharia a pasta errada no canal novo.
      localStorage.removeItem("kumadrive_backup_folders");
      localStorage.removeItem("kumadrive_backup_schedule");
    } catch (err) {
      console.warn("[authStore] Failed to clear backup config on logout:", err);
    }
    try {
      // O gate de bootstrap precisa cair junto: o índice do canal
      // anterior não descreve o canal novo.
      sessionStorage.removeItem("kumadrive_bootstrap_done");
    } catch (err) {
      console.warn("[authStore] Failed to clear bootstrap flag on logout:", err);
    }
    // Limpar o localStorage não basta: o `licenseStore` guarda as pastas
    // e o intervalo EM MEMÓRIA, e nada no logout o zerava. Quem logasse
    // de novo no mesmo processo herdava as pastas da conta anterior — e o
    // `RemoteSyncOrchestrator`, agora montado, lia o intervalo em memória
    // e disparava `start_backup_scheduler`, fazendo a conta B espelhar as
    // pastas da conta A no canal da conta B.
    //
    // Zeramos `scheduledBackupIntervalMinutes` mantendo o objeto `license`
    // com a MESMA forma do initializer. Coloquei `license: null` primeiro e
    // isso quebrava a invariante de que a store sempre tem um objeto
    // license: após logout+login o shape divergia de um boot limpo até que
    // alguém chamasse `setProSchedule`, que por acaso recriava o objeto.
    try {
      useLicenseStore.setState({
        backupFolders: { paths: [], excludes: [] },
        license: {
          id: "local",
          plan: "PRO",
          purchasedAt: null,
          expiresAt: null,
          scheduledBackupIntervalMinutes: null,
        },
      });
    } catch (err) {
      console.warn("[authStore] Failed to clear license store on logout:", err);
    }
    set({
      sessionString: null,
      phoneNumber: null,
      isAuthenticated: false,
      apiId: null,
      apiHash: null,
    });
  },
}));
