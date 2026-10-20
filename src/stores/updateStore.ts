/**
 * updateStore - estado do ciclo de atualização do app.
 *
 * Por que um store e não um CustomEvent: o aviso de "versão nova" precisa
 * aparecer assim que o app termina de abrir, quando nenhum componente
 * específico (como AboutSection) ainda está montado. Um `CustomEvent`
 * exigiria um listener registrado antes do disparo — e perderia o
 * evento. Um store Zustand guarda o estado mesmo com zero assinantes,
 * que é exatamente o caso do `backupProgressStore`.
 *
 * Segue o mesmo padrão: `create` sem `persist`. A checagem é refeita a
 * cada abertura de propósito — se persistíssemos, o app reavisaria de uma
 * atualização já instalada em vez de buscar a mais nova.
 */
import { create } from "zustand";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "sonner";

/**
 * Limpa o corpo da release do GitHub antes de mostrá-lo como "Novidades
 * desta versão".
 *
 * Duas razões:
 *  1. O corpo pode ser só o boilerplate de instalação (releases antigas,
 *     ou uma release criada à mão fora do workflow que extrai o
 *     CHANGELOG). Mostrar "Instaladores para Windows" como "Novidades"
 *     é pior que não mostrar nada — o usuário acha que o app atualizou
 *     sem trazer mudança.
 *  2. O Tauri preenche `body` com o texto cru do release; removemos o
 *     rodapé de instaladores e o separador para a tela ficar limpa.
 *
 * Retorna `null` quando, depois da limpeza, não sobra conteúdo útil —
 * a tela simplesmente omite o bloco de novidades.
 */
export function sanitizeReleaseNotes(raw: string | null): string | null {
  if (!raw) return null;
  let text = raw;

  // Corta o bloco de instaladores. Casamos apenas as linhas de RODAPÉ —
  // `**Instaladores para Windows**` (formato novo) ou uma linha isolada
  // `Instalador para Windows.` (formato antigo) — sempre ancoradas na
  // linha inteira (`^...$` com `m`). Assim não cortamos uma nota legítima
  // que apenas MENCIONE o instalador no meio de uma frase.
  const installIdx = text.search(
    /^\s*(?:\*\*Instaladores para Windows\*\*|Instalador para Windows\.?)\s*$/im,
  );
  if (installIdx >= 0) text = text.slice(0, installIdx);

  // Remove o cabeçalho "## KumaDrive vX" (redundante: a tela já mostra o par).
  text = text.replace(/^##\s*KumaDrive\s*v?[\d.]+\s*$/im, "");

  // Remove a sub-rubrica "### Novidades desta versão" (redundante com o título).
  text = text.replace(/^#+\s*Novidades desta versão\s*$/im, "");

  // Remove separadores soltos e linhas vazias nas pontas.
  text = text.replace(/^\s*-{3,}\s*$/gm, "").trim();

  return text.length > 0 ? text : null;
}

export interface UpdateState {
  /** Versão em execução (vem do manifesto do Tauri, não do frontend). */
  currentVersion: string;
  /** Versão mais recente publicada, quando existir. */
  availableVersion: string | null;
  /** Release notes, quando o mantenedor escreveu. */
  notes: string | null;
  /** Tela de atualização em tela cheia visível. */
  open: boolean;
  /** Aviso flutuante do topo dispensado nesta sessão. */
  noticeDismissed: boolean;
  /** Checagem em andamento (botão "Verificar atualizações"). */
  checking: boolean;
  /** Download/instalação em andamento. */
  installing: boolean;
  /** Progresso 0-100 do download. */
  progress: number;
  setOpen: (open: boolean) => void;
  /** Abre a tela de atualização (usada pelo aviso do topo e por Sobre). */
  openScreen: () => void;
  /** Fecha a tela e dispensa o aviso — o usuário já viu a novidade. */
  closeScreen: () => void;
  /** Dispensa apenas o aviso do topo, sem abrir a tela. */
  dismissNotice: () => void;
  setChecking: (checking: boolean) => void;
  /** Busca a versão atual, sem tocar na rede. */
  loadCurrentVersion: () => Promise<void>;
  /**
   * Consulta o endpoint de updates. Notifica via toast quando o chamador
   * não pediu UI explícita (checagem de fundo no startup).
   */
  checkForUpdates: (opts?: {
    silent?: boolean;
    /** Abre a tela cheia ao encontrar versão nova (padrão: !silent). */
    openOnFound?: boolean;
  }) => Promise<boolean>;
  /** Baixa, instala e reinicia. */
  install: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  currentVersion: "",
  availableVersion: null,
  notes: null,
  open: false,
  noticeDismissed: false,
  checking: false,
  installing: false,
  progress: 0,

  setOpen: (open) => set({ open }),
  openScreen: () => set({ open: true }),
  closeScreen: () => set({ open: false, noticeDismissed: true }),
  dismissNotice: () => set({ noticeDismissed: true }),
  setChecking: (checking) => set({ checking }),

  loadCurrentVersion: async () => {
    try {
      const v = await getVersion();
      set({ currentVersion: v });
    } catch (err) {
      console.warn("[update] falha ao ler a versão do app:", err);
    }
  },

  checkForUpdates: async (opts) => {
    const silent = opts?.silent ?? false;
    // Chamadas explícitas (botão em Configurações → Sobre) abrem a tela
    // quando acham versão nova. No boot (`silent`) o resultado só alimenta
    // o aviso do topo — abrir uma tela cheia por cima do splash seria
    // intrusivo, e o usuário pode não estar pronto para reiniciar o app.
    const openOnFound = opts?.openOnFound ?? !silent;
    set({ checking: true });
    try {
      const update = await check();

      if (!update) {
        // Sem update: nada a fazer. Só o chamador explícito (botão em
        // Configurações → Sobre) recebe confirmação — no boot, silêncio.
        //
        // Limpamos `availableVersion`/`notes` de propósito. Sem isso, o
        // usuário via o diálogo, clicava "Agora não", e o badge em
        // Configurações → Sobre continuava mostrando "→ v1.4.0"
        // enquanto o `check()` desta vez retornava null e o toast dizia
        // "você está atualizado" — a mesma tela com as duas informações
        // contraditórias.
        const current = get().currentVersion;
        // Zeramos `noticeDismissed`: numa próxima abertura o aviso volta a
        // ter permissão de aparecer caso surja uma versão nova.
        set({ availableVersion: null, notes: null, noticeDismissed: false });
        if (!silent) {
          toast.success("Você está atualizado!", {
            description: current
              ? `O KumaDrive v${current} é a versão mais recente.`
              : undefined,
          });
        }
        return false;
      }

      // `currentVersion` vem do mesmo manifesto do endpoint, então é mais
      // consistente que getVersion() (que vem do bundle do frontend).
      const current = update.currentVersion || get().currentVersion;
      set({
        currentVersion: current,
        availableVersion: update.version,
        notes: sanitizeReleaseNotes(update.body ?? null),
        open: openOnFound,
        // Versão recém-descoberta reexibe o aviso do topo, mesmo que o
        // usuário tenha dispensado um aviso anterior nesta sessão.
        noticeDismissed: false,
      });

      // Mantemos o `update` vivo para o botão "Atualizar agora" — quem
      // fecha a tela sem instalar precisa liberar o handle via
      // releasePendingUpdate (feito em UpdateScreen). Nada de toast aqui:
      // o aviso do topo + a tela já comunicam a mesma coisa, e um toast
      // junto triplicaria a informação na mesma tela.
      getPendingUpdate(update);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Offline é o caso comum no startup — não pode virar toast de erro.
      if (!silent) {
        toast.error("Não foi possível verificar atualizações", {
          description: message,
        });
      }
      return false;
    } finally {
      set({ checking: false });
    }
  },

  install: async () => {
    if (get().installing) return;
    let update = takePendingUpdate();
    if (!update) {
      // O handle pode ter sido descartado (ex.: uma tentativa anterior falhou).
      // Reconsulta para obter um handle novo em vez de mostrar "não está mais
      // disponível" enquanto o diálogo ainda exibe uma versão disponível.
      try {
        const fresh = await check();
        if (fresh) {
          getPendingUpdate(fresh);
          update = fresh;
        }
      } catch {
        // Sem rede — cai na mensagem de erro abaixo.
      }
    }
    if (!update) {
      toast.error("A atualização não está mais disponível.", {
        description: "Verifique as atualizações novamente.",
      });
      return;
    }

    set({ installing: true, progress: 0 });
    let downloaded = 0;
    let total = 0;

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data?.contentLength ?? 0;
          downloaded = 0;
          set({ progress: 0 });
        } else if (event.event === "Progress") {
          downloaded += event.data?.chunkLength ?? 0;
          set({ progress: total > 0 ? Math.round((downloaded / total) * 100) : 0 });
        }
      });

      set({ installing: false, open: false, availableVersion: null });
      toast.success("Atualização instalada!", {
        description: "O KumaDrive será reiniciado para aplicar a atualização.",
      });
      setTimeout(async () => {
        await relaunch();
      }, 1500);
    } catch (err) {
      set({ installing: false });
      toast.error("Falha ao instalar a atualização", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));

/**
 * Handle do `Update` fora do React.
 *
 * O objetoreturned por `check()` mantém um recurso reservado no lado Rust
 * e só é liberado por `close()`. Guardá-lo num `useRef` do componente de
 * diálogo seria suficiente — mas a checagem de fundo acontece em App.tsx,
 * longe de qualquer componente. Um slot de módulo resolve os dois casos
 * sem criar um store só para isso.
 */
let pending: Awaited<ReturnType<typeof check>> = null;

function getPendingUpdate(update: NonNullable<Awaited<ReturnType<typeof check>>>) {
  // Um check novo descarta o handle antigo — sem isso vazamos um por boot.
  pending?.close();
  pending = update;
}

/**
 * Retorna o handle e limpa o slot.
 *
 * O nome original (`takePendingUpdate`) prometia isso mas não zerava o
 * `pending` — o handle continuava vivo e um segundo `install()` após uma
 * falha de download chamava `downloadAndInstall` no MESMO handle, que já
 * tinha um download parcial. O plugin recomeça do zero sem limpar o estado
 * interno do Rust. O handle só era liberado se o usuário clicasse "Agora
 * não".
 */
function takePendingUpdate() {
  const u = pending;
  pending = null;
  return u;
}

/** Libera o handle quando o usuário adia a atualização. */
export function releasePendingUpdate() {
  pending?.close();
  pending = null;
}