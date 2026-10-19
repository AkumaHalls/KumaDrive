/**
 * UpdateDialog — aviso de nova versão.
 *
 * Montado na raiz do App (fora do `<Routes>`), então aparece em qualquer
 * tela: o usuário não precisa estar em Configurações → Sobre para ser
 * avisado. É esse requisito que o `check()` isolado no AboutSection não
 * atendia — ele só rodava quando a tela já estava aberta.
 *
 * Contrato de vida útil
 * ---------------------
 * - `open` e os dados vêm de `useUpdateStore`, então qualquer chamador
 *   (startup ou o botão "Verificar atualizações") abre o mesmo diálogo.
 * - Fechar sem instalar libera o handle do plugin via `releasePendingUpdate()`.
 *   Sem isso o `Update` segura um recurso Rust reservado a cada boot.
 */
import { useEffect, useRef } from "react";
import { Sparkles, Download, Loader2, X } from "lucide-react";
import {
  useUpdateStore,
  releasePendingUpdate,
} from "@/stores/updateStore";
import { Button } from "@/components/ui/button";

export function UpdateDialog() {
  const open = useUpdateStore((s) => s.open);
  const setOpen = useUpdateStore((s) => s.setOpen);
  const currentVersion = useUpdateStore((s) => s.currentVersion);
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const notes = useUpdateStore((s) => s.notes);
  const installing = useUpdateStore((s) => s.installing);
  const progress = useUpdateStore((s) => s.progress);
  const install = useUpdateStore((s) => s.install);

  const dialogRef = useRef<HTMLDivElement>(null);

  // Segurança contra vazamento: se o diálogo sair da árvore sem o
  // usuário ter clicado em nada (troca de rota, hot reload), o handle
  // Rust do `Update` ficaria reservado indefinidamente. `releasePendingUpdate`
  // é idempotente, então rodar depois de um `install` bem-sucedido (que
  // já limpou o slot) não faz nada.
  useEffect(() => {
    return () => {
      if (!useUpdateStore.getState().installing) {
        releasePendingUpdate();
      }
    };
  }, []);

  // Fechar por Escape enquanto não estiver instalando.
  useEffect(() => {
    if (!open || installing) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleDismiss();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, installing]);

  function handleDismiss() {
    if (installing) return;
    releasePendingUpdate();
    setOpen(false);
  }

  if (!open || !availableVersion) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4 select-none"
      onMouseDown={(e) => {
        // Clique fora fecha, mas nunca no meio de um download.
        if (e.target === e.currentTarget) handleDismiss();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kumadrive-update-title"
        className="w-full max-w-md rounded-3xl bg-white dark:bg-[#1e1f20] border border-slate-200/80 dark:border-slate-800 shadow-2xl overflow-hidden"
      >
        {/* Faixa de destaque */}
        <div className="h-1 w-full bg-gradient-to-r from-amber-400 via-amber-500 to-orange-500" />

        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 rounded-2xl bg-amber-50 dark:bg-amber-950/60 border border-amber-200/80 dark:border-amber-800/80 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h2
                id="kumadrive-update-title"
                className="text-base font-semibold text-[#1F1F1F] dark:text-[#E3E3E3]"
              >
                Nova versão disponível
              </h2>
              <p className="text-sm text-[#444746] dark:text-[#C4C7C5] mt-1">
                Uma versão mais recente do KumaDrive foi publicada no GitHub.
              </p>
            </div>
            {!installing && (
              <button
                onClick={handleDismiss}
                aria-label="Fechar"
                className="rounded-full p-1 text-[#747775] dark:text-[#8E918F] hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Par de versões — a informação que faltava */}
          <div className="mt-5 flex items-center gap-3 rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/70 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium text-[#747775] dark:text-[#8E918F] uppercase tracking-wide">
                Instalada
              </p>
              <p className="text-sm font-semibold text-[#444746] dark:text-[#C4C7C5] tabular-nums">
                v{currentVersion || "?"}
              </p>
            </div>
            <span className="text-[#B0B3B1] dark:text-[#5F6361] text-lg shrink-0">&rarr;</span>
            <div className="flex-1 min-w-0 text-right">
              <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wide">
                Disponível
              </p>
              <p className="text-sm font-semibold text-[#1F1F1F] dark:text-[#E3E3E3] tabular-nums">
                v{availableVersion}
              </p>
            </div>
          </div>

          {notes && (
            <div className="mt-4 max-h-40 overflow-y-auto rounded-2xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200/80 dark:border-slate-700/70 px-4 py-3">
              <p className="text-[11px] font-medium text-[#747775] dark:text-[#8E918F] uppercase tracking-wide mb-1.5">
                Novidades
              </p>
              <pre className="text-xs text-[#444746] dark:text-[#C4C7C5] whitespace-pre-wrap break-words font-sans leading-relaxed">
                {notes.slice(0, 800)}
              </pre>
            </div>
          )}

          {installing && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-[#444746] dark:text-[#C4C7C5] mb-1.5">
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                  Baixando e instalando…
                </span>
                <span className="tabular-nums">{progress}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500 transition-[width] duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 pb-6">
          {!installing ? (
            <>
              <Button
                variant="outline"
                onClick={handleDismiss}
                className="rounded-full text-xs font-medium h-9 px-4 border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Agora não
              </Button>
              <Button
                onClick={install}
                className="rounded-full text-xs font-medium h-9 px-4 bg-amber-500 hover:bg-amber-600 text-white"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Atualizar para v{availableVersion}
              </Button>
            </>
          ) : (
            <span className="text-[11px] text-[#747775] dark:text-[#8E918F]">
              Não feche o KumaDrive — a instalação vai reiniciar o app.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}