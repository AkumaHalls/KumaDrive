/**
 * UpdateScreen — tela de atualização do KumaDrive.
 *
 * Substitui o antigo `UpdateDialog`: em vez de um modal pequeno, abre uma
 * tela em tela cheia com o par de versões, as novidades e o progresso do
 * download — o usuário atualiza dali mesmo, sem procurar em Configurações.
 *
 * Por que Radix (e não um overlay caseiro):
 * - `DialogPrimitive` já resolve focus trap, `aria-modal`, bloqueio de
 *   scroll e restauração de foco ao fechar — exatamente o que a auditoria
 *   de UX pede para modais. O overlay anterior fazia isso à mão.
 * - Usamos os primitivos `radix-ui` direto (e não o `DialogContent` do
 *   projeto) porque precisamos do `z-index` acima das sobreposições
 *   globais (aviso do topo, pill da fila de índice, toasts).
 *
 * Contrato de vida útil:
 * - `open`/dados vêm de `useUpdateStore`, então o aviso do topo e o botão
 *   de Configurações → Sobre abrem esta MESMA tela.
 * - Fechar sem instalar libera o handle Rust do plugin
 *   (`releasePendingUpdate`) — sem isso o `Update` segura um recurso
 *   reservado a cada abertura.
 */
import { useEffect, useRef } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Sparkles, Download, Loader2, X } from "lucide-react";
import { useUpdateStore, releasePendingUpdate } from "@/stores/updateStore";
import { Button } from "@/components/ui/button";

export function UpdateScreen() {
  const open = useUpdateStore((s) => s.open);
  const closeScreen = useUpdateStore((s) => s.closeScreen);
  const currentVersion = useUpdateStore((s) => s.currentVersion);
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const notes = useUpdateStore((s) => s.notes);
  const installing = useUpdateStore((s) => s.installing);
  const progress = useUpdateStore((s) => s.progress);
  const install = useUpdateStore((s) => s.install);

  const primaryRef = useRef<HTMLButtonElement>(null);

  // Libera o handle do plugin quando a tela fecha sem instalar. É
  // idempotente, então rodar após um `install` bem-sucedido (que já
  // limpou o slot) não faz nada.
  useEffect(() => {
    if (!open && !useUpdateStore.getState().installing) {
      releasePendingUpdate();
    }
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (next) return;
    // Nunca fecha no meio do download: interromper deixaria o handle e o
    // instalador do Windows em estado indefinido.
    if (installing) return;
    closeScreen();
  }

  const hasUpdate = Boolean(availableVersion);

  return (
    <DialogPrimitive.Root open={open && hasUpdate} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // Radix foca o primeiro elemento focável (o botão de fechar);
          // queremos o foco na ação principal.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            primaryRef.current?.focus();
          }}
          onPointerDownOutside={(e) => {
            if (installing) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (installing) e.preventDefault();
          }}
          onMouseDown={(e) => {
            // Clique fora fecha — mas nunca no meio de um download.
            if (e.target === e.currentTarget && !installing) closeScreen();
          }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 outline-none"
        >
          <div className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-2xl select-none dark:border-slate-800 dark:bg-[#1e1f20]">
            {/* Faixa de marca */}
            <div className="h-1.5 w-full shrink-0 bg-gradient-to-r from-amber-400 via-orange-500 to-amber-400" />

            {/* Cabeçalho */}
            <div className="flex items-start gap-4 p-6 pb-4 shrink-0">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-amber-200/80 bg-amber-50 text-amber-600 dark:border-amber-800/80 dark:bg-amber-950/60 dark:text-amber-400">
                <Sparkles className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="text-lg font-semibold text-[#1F1F1F] dark:text-[#E3E3E3]">
                  Nova versão disponível
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-sm text-[#444746] dark:text-[#C4C7C5]">
                  Uma versão mais recente do KumaDrive foi publicada. Atualize para receber as
                  novidades e correções.
                </DialogPrimitive.Description>
              </div>
              {!installing && (
                <button
                  type="button"
                  onClick={closeScreen}
                  aria-label="Fechar"
                  className="shrink-0 rounded-full p-1.5 text-[#747775] transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 dark:text-[#8E918F] dark:hover:bg-slate-800"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Corpo (rolável quando as notas são longas) */}
            <div className="flex-1 space-y-4 overflow-y-auto px-6 pb-2">
              {/* Par de versões */}
              <div className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-slate-50 px-4 py-3 dark:border-slate-700/70 dark:bg-slate-800/50">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-[#747775] dark:text-[#8E918F]">
                    Instalada
                  </p>
                  <p className="text-sm font-semibold tabular-nums text-[#444746] dark:text-[#C4C7C5]">
                    v{currentVersion || "?"}
                  </p>
                </div>
                <span aria-hidden="true" className="shrink-0 text-lg text-[#B0B3B1] dark:text-[#5F6361]">
                  &rarr;
                </span>
                <div className="min-w-0 flex-1 text-right">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    Disponível
                  </p>
                  <p className="text-sm font-semibold tabular-nums text-[#1F1F1F] dark:text-[#E3E3E3]">
                    v{availableVersion}
                  </p>
                </div>
              </div>

              {/* Novidades */}
              <div className="rounded-2xl border border-slate-200/80 bg-slate-50 px-4 py-3 dark:border-slate-700/70 dark:bg-slate-800/50">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[#747775] dark:text-[#8E918F]">
                  Novidades desta versão
                </p>
                {notes ? (
                  <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-[#444746] dark:text-[#C4C7C5]">
                    {notes}
                  </pre>
                ) : (
                  // Sem notas úteis (release sem changelog, ou corpo só com
                  // instruções de instalação). Dizemos isso em vez de omitir
                  // o bloco, para a tela não parecer incompleta.
                  <p className="text-xs leading-relaxed text-[#747775] dark:text-[#8E918F]">
                    Esta versão traz melhorias e correções internas. Detalhes no{" "}
                    <a
                      href="https://github.com/AkumaHalls/KumaDrive/blob/main/CHANGELOG.md"
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-amber-600 underline-offset-2 hover:underline dark:text-amber-400"
                    >
                      changelog
                    </a>
                    .
                  </p>
                )}
              </div>

              {/* Progresso */}
              {installing && (
                <div
                  role="status"
                  aria-live="polite"
                  className="rounded-2xl border border-amber-200/70 bg-amber-50/60 px-4 py-4 dark:border-amber-900/50 dark:bg-amber-950/30"
                >
                  <div className="mb-2 flex items-center justify-between text-xs text-[#444746] dark:text-[#C4C7C5]">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                      Baixando e instalando…
                    </span>
                    <span className="tabular-nums font-semibold text-amber-700 dark:text-amber-400">
                      {progress}%
                    </span>
                  </div>
                  <div
                    className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                  >
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500 transition-[width] duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Rodapé */}
            <div className="flex shrink-0 items-center justify-end gap-2 px-6 py-5">
              {!installing ? (
                <>
                  <Button
                    variant="outline"
                    onClick={closeScreen}
                    className="h-9 rounded-full border-slate-300 px-4 text-xs font-medium hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
                  >
                    Agora não
                  </Button>
                  <Button
                    ref={primaryRef}
                    onClick={install}
                    className="h-9 rounded-full bg-amber-500 px-4 text-xs font-medium text-white hover:bg-amber-600 focus-visible:ring-2 focus-visible:ring-amber-500/60 focus-visible:ring-offset-2"
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    Atualizar para v{availableVersion}
                  </Button>
                </>
              ) : (
                <span className="text-[11px] text-[#747775] dark:text-[#8E918F]">
                  Não feche o KumaDrive — a instalação vai reiniciar o app automaticamente.
                </span>
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
