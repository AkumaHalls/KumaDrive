import { lazy, Suspense, useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import { useTheme } from "./hooks/useTheme";
import { Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
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
              const restored = await invoke("restore_session");
              if (restored) {
                await invoke("bootstrap_telegram", { phone: phoneNumber });
              }
            } catch (err) {
              console.error("Background session restoration/bootstrap failed:", err);
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
    </BrowserRouter>
  );
}

export default App;