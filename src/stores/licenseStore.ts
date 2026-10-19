/**
 * licenseStore — stub replacement.
 *
 * KumaDrive is now a fully free application. All plan/Pro gating, backend
 * JWT authentication, and device-management features have been removed.
 *
 * This stub keeps the same export surface so any remaining imports compile
 * without changes. All backend actions are no-ops. `backupFolders` is now
 * persisted in localStorage directly by this store.
 */
import { create } from 'zustand';
import { toast } from 'sonner';

export type Plan = 'FREE' | 'PRO';

export interface BackupFoldersPayload {
  paths: string[];
  excludes: string[];
}

/** Kept for source compatibility with files that import Device type */
export interface Device {
  id: string;
  deviceName: string;
  os: string;
  lastSeenAt: string | null;
  createdAt: string;
}

/** Kept for source compatibility */
export interface License {
  id: string;
  plan: Plan;
  purchasedAt: string | null;
  expiresAt: string | null;
  scheduledBackupIntervalMinutes: number | null;
}

/** Kept for source compatibility */
export type LicenseResponse = License;

interface LicenseState {
  plan: Plan;
  backupFolders: BackupFoldersPayload;
  backendReachable: boolean;
  /** Kept for source compatibility — always null. */
  jwt: null;
  license: License | null;
  activeDevices: Device[];
  deviceLimit: number;
  canActivateDevice: boolean;
  inFlightVerify: null;

  // No-op actions kept for import compatibility
  loginToBackend: (_params: unknown) => Promise<void>;
  reconnectToBackend: (_params: unknown) => Promise<void>;
  verifyBackendSession: () => Promise<void>;
  refreshBackendState: () => Promise<void>;
  logoutFromBackend: () => Promise<void>;
  revokeDeviceById: (_deviceId: string) => Promise<void>;
  setProSchedule: (intervalMinutes: number | null) => Promise<void>;
  setProBackupFolders: (folders: BackupFoldersPayload) => Promise<void>;
}

const BACKUP_FOLDERS_KEY = 'kumadrive_backup_folders';
const BACKUP_SCHEDULE_KEY = 'kumadrive_backup_schedule';

function loadBackupFolders(): BackupFoldersPayload {
  try {
    const raw = localStorage.getItem(BACKUP_FOLDERS_KEY);
    if (raw) return JSON.parse(raw) as BackupFoldersPayload;
  } catch { /* ignore */ }
  return { paths: [], excludes: [] };
}

/**
 * Grava as pastas de origem. Retorna `false` se a escrita falhou.
 *
 * Antes o erro era engolido e o state era atualizado mesmo assim: a
 * pasta aparecia na lista durante a sessão e sumia no próximo boot.
 * O sintoma era o backup falhar depois com "selecione pelo menos uma
 * pasta", sem o usuário ter mexido em nada. O chamador agora avisa.
 */
function saveBackupFolders(folders: BackupFoldersPayload): boolean {
  try {
    localStorage.setItem(BACKUP_FOLDERS_KEY, JSON.stringify(folders));
    return true;
  } catch (err) {
    console.warn("[licenseStore] failed to persist backupFolders:", err);
    return false;
  }
}

function loadBackupSchedule(): number | null {
  try {
    const raw = localStorage.getItem(BACKUP_SCHEDULE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

/** Grava o intervalo. Retorna `false` se a escrita falhou (ex.: quota). */
function saveBackupSchedule(intervalMinutes: number | null): boolean {
  try {
    localStorage.setItem(BACKUP_SCHEDULE_KEY, JSON.stringify(intervalMinutes));
    return true;
  } catch (err) {
    console.warn("[licenseStore] failed to persist backup schedule:", err);
    return false;
  }
}

export const useLicenseStore = create<LicenseState>((set, _get) => ({
  plan: 'PRO',
  backupFolders: loadBackupFolders(),
  backendReachable: false,
  jwt: null,
  license: {
    id: 'local',
    plan: 'PRO',
    purchasedAt: null,
    expiresAt: null,
    scheduledBackupIntervalMinutes: loadBackupSchedule(),
  },
  activeDevices: [],
  deviceLimit: Infinity,
  canActivateDevice: true,
  inFlightVerify: null,

  loginToBackend: async () => { /* no-op: backend removed */ },
  reconnectToBackend: async () => { /* no-op: backend removed */ },
  verifyBackendSession: async () => { /* no-op: backend removed */ },
  refreshBackendState: async () => { /* no-op: backend removed */ },
  logoutFromBackend: async () => { /* no-op: backend removed */ },
  revokeDeviceById: async () => { /* no-op: backend removed */ },

  setProSchedule: async (intervalMinutes) => {
    const persisted = saveBackupSchedule(intervalMinutes);
    // Update local license projection so the UI stays in sync
    set((prev) => ({
      license: prev.license
        ? { ...prev.license, scheduledBackupIntervalMinutes: intervalMinutes }
        : { id: 'local', plan: 'PRO', purchasedAt: null, expiresAt: null, scheduledBackupIntervalMinutes: intervalMinutes },
    }));

    // Mesmo motivo do `setProBackupFolders`: o badge "Ativo" vem do state
    // em memória, então sem este aviso o usuário escolhia "A cada 24
    // horas", viaia o badge ligado — e no próximo boot o agendamento
    // simplesmente não existia mais, sem nenhum sinal.
    if (!persisted) {
      toast.warning("O agendamento de backup não pôde ser salvo", {
        description:
          "Vale para esta sessão, mas não foi gravado no dispositivo (armazenamento cheio ou bloqueado). O backup agendado será perdido ao fechar o KumaDrive.",
      });
    }
  },

  setProBackupFolders: async (folders) => {
    if (!Array.isArray(folders.paths) || !Array.isArray(folders.excludes)) return;
    const next: BackupFoldersPayload = {
      paths: folders.paths.filter((p) => typeof p === 'string' && p.length > 0).slice(0, 10),
      excludes: folders.excludes.filter((p) => typeof p === 'string' && p.length > 0).slice(0, 30),
    };
    const persisted = saveBackupFolders(next);
    set({ backupFolders: next });

    // O state reflete a sessão atual, mas sem a escrita no localStorage a
    // configuração morre no próximo boot — e o backup passa a falhar com
    // "selecione pelo menos uma pasta" sem o usuário ter mudado nada.
    if (!persisted) {
      toast.warning("A configuração de backup não pôde ser salva", {
        description:
          "A pasta foi adicionada para esta sessão, mas não pôde ser gravada no dispositivo (armazenamento cheio ou bloqueado). Ela será perdida ao fechar o KumaDrive.",
      });
    }
  },
}));

/** Test-only escape hatch */
export function __resetLicenseStoreForTests(): void {
  useLicenseStore.setState({
    plan: 'FREE',
    backupFolders: { paths: [], excludes: [] },
    backendReachable: false,
    jwt: null,
    license: null,
    activeDevices: [],
    deviceLimit: Infinity,
    canActivateDevice: true,
    inFlightVerify: null,
  });
}
