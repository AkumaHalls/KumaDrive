import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import { useTheme } from "./hooks/useTheme";
import { Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Toaster } from "./components/ui/sonner";
import { BackupProgressOverlay } from "./components/backup/BackupProgressOverlay";
import { UpdateDialog } from "./components/update/UpdateDialog";
import RemoteSyncOrchestrator from "./components/RemoteSyncOrchestrator";
import { IndexQueuePill } from "./components/IndexQueuePill";
import { useUpdateStore } from "./stores/updateStore";
import DriveBrowserPage from "./pages/DriveBrowserPage";
import RecentPage from "./pages/RecentPage";
import StarredPage from "./pages/StarredPage";
import TrashPage from "./pages/TrashPage";
import ArchivedPage from "./pages/ArchivedPage";
import SearchPage from "./pages/SearchPage";
import BackupsPage from "./pages/BackupsPage";
import BackupsFolderPage from "./pages/BackupsFolderPage";

// Lazy pages
const DriveLayout = lazy(() => import("./components/layout/DriveLayout"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const AuthPage = lazy(() => import("./pages/AuthPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));

// Full-screen spinner fallback
function LoadingFallback() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background select-none">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

// Splash Screen Loader
function SplashLoader({ status }: { status: string }) {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-background text-foreground gap-4 select-none">
      <div className="flex flex-col items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center">
          <svg className="w-8 h-8 text-on-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-1-1H5a2 2 0 00-2 2z" />
          </svg>
        </div>
        <div className="flex items-center gap-2.5 text-foreground/60 font-medium bg-muted px-5 py-2 rounded-full shadow-xs">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs">{status}</span>
        </div>
      </div>
    </div>
  );
}

// Protected Route Guard
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/auth" replace />;
}

// Guest/Auth Route Guard
function GuestRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  return !isAuthenticated ? <>{children}</> : <Navigate to="/drive/my-drive" replace />;
}

function App() {
  // Aplica a classe `light`/`dark` no <html> conforme a preferência do
  // usuário. Precisa rodar aqui (e não só no hook de Appearance) para que
  // o tema valha também nas telas de login, splash e settings — sem isso a
  // escolha de tema não tinha efeito em nenhuma página.
  useTheme();
  const [isRestoring, setIsRestoring] = useState(true);
  const [status] = useState("Conectando ao Telegram...");
  // Garante uma checagem de update por sessão, mesmo com StrictMode.
  const updateCheckedRef = useRef(false);

  useEffect(() => {
    let active = true;
    async function initSession() {
      try {
        const stored = await invoke<{ session: string | null; phone: string | null }>(
          "load_session"
        );
        const sessionString = stored?.session ?? null;
        const phoneNumber = stored?.phone ?? "";

        if (sessionString && active) {
          const { useAuthStore } = await import("./stores/authStore");
          useAuthStore.getState().setSession(sessionString, phoneNumber);

          const cached = localStorage.getItem("kumadrive_cached_files");
          let hasCachedFiles = false;
          if (cached) {
            try {
              const parsed = JSON.parse(cached);
              if (Array.isArray(parsed) && parsed.length > 0) {
                hasCachedFiles = true;
              }
            } catch (_) {}
          }

          if (hasCachedFiles) {
            setIsRestoring(false);
          }

          (async () => {
            const { useFileStore } = await import("./stores/fileStore");
            useFileStore.getState().setSyncing(true);
            try {
              // COMANDOS RUST QUE NÃO EXISTEM — este era o bug CRÍTICO da
              // auditoria round 4. Aqui havia `invoke("restore_session")`
              // e `invoke("bootstrap_telegram", ...)`: nenhum dos dois está
              // registrado no `generate_handler!` de lib.rs, então o await
              // rejeitava com "command not found", o catch fazia só
              // `console.error` e o cliente GramJS NUNCA era criado ao
              // reabrir o app. A sessão carregava (a UI parecia normal,
              // servindo o cache local), mas TUDO que tocava o Telegram
              // falhava: upload → toast de erro em inglês, pull-to-refresh
              // e download → engolidos em silêncio, sync loop → poluindo o
              // console para sempre.
              //
              // O caminho correto é o JS pronto que já existia para isso
              // (`restoreSession.ts` — antes órfão, nunca importado):
              // lê a sessão, resolve as credenciais do vault, chama
              // `initClient` e verifica `isUserAuthorized`. Se autorizado,
              // roda o mesmo `bootstrapKumaDrive` do login e do Drive.
              const { restoreSession } = await import("./lib/telegram/restoreSession");
              const restored = await restoreSession();
              if (restored && active) {
                const { bootstrapKumaDrive } = await import("./lib/telegram/bootstrap");
                await bootstrapKumaDrive(undefined, phoneNumber ?? "");
              }
            } catch (err) {
              // Falha visível: a rodada 4 mostrou que este caminho era 100%
              // silencioso (console.error só) e o app seguia "funcionando"
              // com cache, sem nunca dizer ao usuário que precisava
              // reconectar. O `log_vault_state` fica no catch externo, que
              // nunca era atingido — por isso logamos aqui também.
              console.error("Background session restoration/bootstrap failed:", err);
              await invoke("log_vault_state", {
                state: `RESTORE_BOOTSTRAP_ERR: ${err instanceof Error ? err.message : String(err)}`
              }).catch(() => {});
              toast.error(
                "Não foi possível reconectar ao Telegram.",
                { description: "Suas configurações estão salvas; tentaremos de novo. Se persistir, saia e entre novamente." }
              );
            } finally {
              if (active) {
                useFileStore.getState().setSyncing(false);
                setIsRestoring(false);
              }
            }
          })();
        } else {
          if (active) setIsRestoring(false);
        }
      } catch (err: any) {
        console.error("Failed to restore session on app launch:", err);
        await invoke("log_vault_state", {
          state: `BOOTSTRAP_ERR: ${err?.message || JSON.stringify(err)}\nStack: ${err?.stack || "no_stack"}`
        }).catch(() => {});
        if (active) setIsRestoring(false);
      }
    }
    initSession();
    return () => {
      active = false;
    };
  }, []);

  // Aviso de versão nova ao abrir.
  //
  // Fica ANTES do return condicional do splash por causa das Rules of
  // Hooks: um hook depois de um `return` antecipado quebra quando a
  // próxima renderização passa por um caminho diferente (o caso real aqui:
  // primeiro render mostra o splash, o segundo não).
  //
  // Espera `isRestoring` virar false porque enquanto o splash está
  // montado não existe UI onde o aviso pudesse aparecer. O guard por ref
  // evita a checagem dupla que o StrictMode provoca em dev.
  useEffect(() => {
    if (isRestoring) return;
    if (updateCheckedRef.current) return;
    updateCheckedRef.current = true;

    void useUpdateStore
      .getState()
      .loadCurrentVersion()
      .then(() => {
        // `silent` suprime os toasts de erro — ficar offline é normal e
        // não deve virar um aviso vermelho a cada abertura. Quando há
        // update, o diálogo abre em qualquer caso: é o aviso que o usuário
        // pediu para ver ao abrir o app.
        void useUpdateStore.getState().checkForUpdates({ silent: true });
      });
  }, [isRestoring]);

  if (isRestoring) {
    return <SplashLoader status={status} />;
  }

  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/drive/my-drive" replace />} />

          <Route
            path="/auth"
            element={
              <GuestRoute>
                <AuthPage />
              </GuestRoute>
            }
          />

          <Route
            path="/drive"
            element={
              <ProtectedRoute>
                <DriveLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="my-drive" replace />} />
            <Route path="my-drive" element={<DriveBrowserPage root />} />
            <Route path="recent" element={<RecentPage />} />
            <Route path="starred" element={<StarredPage />} />
            <Route path="trash" element={<TrashPage />} />
            <Route path="archived" element={<ArchivedPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="folder/*" element={<DriveBrowserPage />} />
            <Route path="backups" element={<BackupsPage />} />
            <Route path="backups/folder/*" element={<BackupsFolderPage />} />
          </Route>

          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>

      {/* Sobreposições globais — precisam ficar FORA do <Routes> para
          existirem em todas as telas.
          - Toaster: sem ele TODOS os toast.* do app são silenciosos
            (o componente existia em sonner.tsx mas nunca era montado).
          - BackupProgressOverlay: o botão "Fazer backup agora" vive em
            Configurações (/settings), que NÃO é filho do DriveLayout.
            Com o overlay preso ao DriveLayout, clicar no backup ali não
            produzia nenhuma feedback visível. */}
      <Toaster />
      <BackupProgressOverlay />
      <UpdateDialog />

      {/* Estado da fila de índice. Fica flutuante na raiz porque é o único
          aviso de "falha ao salvar" e o único botão de "Tentar novamente"
          — preso ao DriveLayout, não aparecia em /settings. */}
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[90] pointer-events-none">
        <div className="pointer-events-auto">
          <IndexQueuePill />
        </div>
      </div>

      {/* Orquestrador de sync multi-dispositivo + listener do backup
          agendado. NÃO pode ficar dentro de uma rota: ele é headless e
          precisa viver enquanto o usuário estiver autenticado, sem
          depender de estar numa tela específica. Sem este mount,
          `ensureTickListenerStarted()` nunca era chamado — o timer Rust
          disparava e ninguém ouvia, então o backup agendado nunca
          executava — e `startRemoteSync()` nunca era chamado, deixando
          `lib/sync/remoteSync.ts` inteiro inalcançável. */}
      <ProtectedRoute>
        <RemoteSyncOrchestrator />
      </ProtectedRoute>
    </BrowserRouter>
  );
}

export default App;