import { useEffect, useState } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useUIStore } from "@/stores/uiStore";
import {
  Check,
  Info,
  AlertTriangle,
  AlertCircle,
  Loader2,
} from "lucide-react";

/**
 * Resolve o tema efetivo (light | dark) a partir do uiStore.
 *
 * Antes usava `useTheme` do pacote `next-themes` (framework Next.js),
 * que não é inicializado neste app React+Vite — o destructure de
 * `theme`/`resolvedTheme` retornava undefined e quebrava em runtime.
 * Aqui lemos o store real e aplicamos o mesmo fallback de sistema
 * usado por src/hooks/useTheme.ts.
 */
function useResolvedTheme(): "light" | "dark" {
  const theme = useUIStore((state) => state.theme);
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) =>
      setSystemTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return systemTheme;
}

export const Toaster = ({ ...props }: ToasterProps) => {
  const activeTheme = useResolvedTheme();

  return (
    <Sonner
      theme={activeTheme}
      className="toaster group"
      position="bottom-right"
      richColors={false}
      closeButton
      gap={10}
      offset="20px"
      icons={{
        success: (
          <div className="flex items-center justify-center h-8 w-8 rounded-full bg-emerald-50 dark:bg-emerald-950/70 border border-emerald-200/80 dark:border-emerald-800/80 text-emerald-600 dark:text-emerald-400 shrink-0 shadow-xs">
            <Check className="h-4 w-4 stroke-[2.5]" />
          </div>
        ),
        info: (
          <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-50 dark:bg-blue-950/70 border border-blue-200/80 dark:border-blue-800/80 text-[#0b57d0] dark:text-[#a8c7fa] shrink-0 shadow-xs">
            <Info className="h-4 w-4 stroke-[2.5]" />
          </div>
        ),
        warning: (
          <div className="flex items-center justify-center h-8 w-8 rounded-full bg-amber-50 dark:bg-amber-950/70 border border-amber-200/80 dark:border-amber-800/80 text-amber-600 dark:text-amber-400 shrink-0 shadow-xs">
            <AlertTriangle className="h-4 w-4 stroke-[2.5]" />
          </div>
        ),
        error: (
          <div className="flex items-center justify-center h-8 w-8 rounded-full bg-rose-50 dark:bg-rose-950/70 border border-rose-200/80 dark:border-rose-800/80 text-rose-600 dark:text-rose-400 shrink-0 shadow-xs">
            <AlertCircle className="h-4 w-4 stroke-[2.5]" />
          </div>
        ),
        loading: (
          <div className="flex items-center justify-center h-8 w-8 rounded-full bg-blue-50 dark:bg-blue-950/70 border border-blue-200/80 dark:border-blue-800/80 text-[#0b57d0] dark:text-[#a8c7fa] shrink-0 shadow-xs">
            <Loader2 className="h-4 w-4 animate-spin stroke-[2.5]" />
          </div>
        ),
      }}
      toastOptions={{
        classNames: {
          toast: "kumadrive-toast",
          title: "kumadrive-toast-title",
          description: "kumadrive-toast-description",
          actionButton: "kumadrive-toast-action",
          cancelButton: "kumadrive-toast-cancel",
          closeButton: "kumadrive-toast-close",
        },
      }}
      {...props}
    />
  );
};
