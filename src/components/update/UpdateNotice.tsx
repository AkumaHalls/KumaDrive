/**
 * UpdateNotice — aviso de nova versão exibido ao abrir o app.
 *
 * Fica na raiz (fora do `<Routes>`), empilhado com o `IndexQueuePill`, o
 * que faz o aviso aparecer em QUALQUER tela assim que a versão nova é
 * detectada. Antes o único aviso era o diálogo — que só abria quando o
 * `check()` do boot terminava e dependia de o usuário já estar numa tela
 * com UI montada, então em muitos casos a novidade passava batido.
 *
 * Não é um toast: não desaparece sozinho. O usuário escolhe entre abrir a
 * tela de atualização ("Ver detalhes") ou dispensar. Ele some
 * naturalmente na próxima abertura, porque a checagem roda a cada boot e
 * deixa de retornar versão nova depois de atualizar.
 */
import { Sparkles, ArrowRight, X } from "lucide-react";
import { useUpdateStore } from "@/stores/updateStore";

export function UpdateNotice() {
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const currentVersion = useUpdateStore((s) => s.currentVersion);
  const open = useUpdateStore((s) => s.open);
  const noticeDismissed = useUpdateStore((s) => s.noticeDismissed);
  const openScreen = useUpdateStore((s) => s.openScreen);
  const dismissNotice = useUpdateStore((s) => s.dismissNotice);

  // A tela cheia já mostra tudo; com ela aberta o aviso vira ruído.
  if (!availableVersion || open || noticeDismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto w-[min(34rem,calc(100vw-2rem))] rounded-2xl overflow-hidden bg-white/95 dark:bg-[#1e1f20]/95 backdrop-blur-md border border-amber-200/80 dark:border-amber-900/60 shadow-xl animate-slide-down select-none"
    >
      {/* Faixa de marca — laranja/âmbar Kuma. */}
      <div className="h-0.5 w-full bg-gradient-to-r from-amber-400 via-orange-500 to-amber-400" />

      <div className="flex items-center gap-3 p-3 pl-3.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 dark:bg-amber-950/60 border border-amber-200/80 dark:border-amber-800/80 text-amber-600 dark:text-amber-400">
          <Sparkles className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-tight text-[#1F1F1F] dark:text-[#E3E3E3]">
            Atualização disponível
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#444746] dark:text-[#C4C7C5]">
            <span className="tabular-nums">v{currentVersion || "?"}</span>
            <ArrowRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
            <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-400">
              v{availableVersion}
            </span>
          </p>
        </div>

        <button
          type="button"
          onClick={openScreen}
          className="hidden sm:inline-flex items-center gap-1.5 shrink-0 h-9 px-4 rounded-full bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#1e1f20]"
        >
          Ver detalhes
        </button>

        <button
          type="button"
          onClick={dismissNotice}
          aria-label="Dispensar aviso de atualização"
          className="shrink-0 rounded-full p-1.5 text-[#747775] dark:text-[#8E918F] hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* No mobile o botão cabe embaixo, em largura total. */}
      <button
        type="button"
        onClick={openScreen}
        className="sm:hidden w-full border-t border-amber-100 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/30 py-2.5 text-xs font-semibold text-amber-700 dark:text-amber-400 cursor-pointer"
      >
        Ver detalhes da atualização
      </button>
    </div>
  );
}
