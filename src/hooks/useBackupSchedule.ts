/**
 * useBackupSchedule — manages the device backup schedule.
 *
 * All users can use backup scheduling — no Pro gate.
 * Backup interval is stored locally via the licenseStore stub.
 */
import { useCallback, useMemo } from "react";
import { useLicenseStore } from "@/stores/licenseStore";
import { useFileStore } from "@/stores/fileStore";
import { useBackupProgressStore } from "@/stores/backupProgressStore";
import { applyIntervalChange } from "@/lib/backup/scheduler";

export type BackupIntervalMinutes = number | null;

export interface UseBackupSchedule {
  /** Current schedule. null = disabled. 1440 = daily, 10080 = weekly. */
  intervalMinutes: BackupIntervalMinutes;
  /** Always true — backup scheduling is available to all users. */
  isPro: boolean;
  /** Last successful or failed backup timestamp (ms), null = never. */
  lastBackupAt: number | null;
  /** True iff a snapshot is currently in flight. */
  isRunning: boolean;
  /** Update the schedule interval and restart the Rust timer accordingly. */
  setIntervalMinutes: (minutes: BackupIntervalMinutes) => Promise<void>;
}

export function useBackupSchedule(): UseBackupSchedule {
  const license = useLicenseStore((s) => s.license);
  const lastBackupAt = useFileStore((s) => s.lastBackupAt);
  const setProSchedule = useLicenseStore((s) => s.setProSchedule);
  // A fonte da verdade para "um backup está em voo" é `active` da store de
  // progresso — setado por `start()` e limpo só por `finish`/`fail`/
  // `cancel`, independentemente de quem iniciou o run.
  //
  // O campo antigo era `indexQueueState === "backup-running"`, escrito pelo
  // scheduler no início do tick. Mas o IndexQueue é o DONO daquele campo e
  // o sobrescreve para "saving"/"idle" já no primeiro `enqueueSave` do
  // próprio backup — então, durante quase todo um backup AGENDADO, o botão
  // "Fazer backup agora" ficava liberado e um clique partia um run manual
  // por cima (resetando o overlay e sequestrando o botão Cancelar).
  const backupActive = useBackupProgressStore((s) => s.active);

  const intervalMinutes = useMemo<BackupIntervalMinutes>(() => {
    const v = license?.scheduledBackupIntervalMinutes;
    return typeof v === "number" && v > 0 ? v : null;
  }, [license?.scheduledBackupIntervalMinutes]);

  const setIntervalMinutes = useCallback(
    async (minutes: BackupIntervalMinutes) => {
      await setProSchedule(minutes);
      // Restart the Rust timer with the new value (or stop it).
      await applyIntervalChange(minutes);
    },
    [setProSchedule],
  );

  return {
    intervalMinutes,
    isPro: true, // All users have full backup access
    lastBackupAt,
    isRunning: backupActive,
    setIntervalMinutes,
  };
}
