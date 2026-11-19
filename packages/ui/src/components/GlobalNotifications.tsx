import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useGatewayClientContext } from "../contexts/GatewayClientContext";

// ── Toast data ───────────────────────────────────────────────
interface ToastData {
  id: string;
  message: string;
  taskName: string;
  timestamp: number;
  /** Where "Open" goes (a session, same origin), in a tab of its own. */
  url?: string | null;
  /** Stays until dismissed: someone is waiting on the user. */
  sticky?: boolean;
}

/**
 * One tab per link, so opening it twice brings the same tab back. A session's tab has the name
 * the /today board's session pills use, so both land in the same tab.
 */
function tabName(url: string): string {
  const session = url.match(/\/chat\/[^/]+\/([^/?#]+)/)?.[1];
  return session ? `anima-session-${session}` : `anima-${url.replace(/[^a-z0-9]+/gi, "-")}`;
}

// ── Toast component ──────────────────────────────────────────
function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.sticky) return;
    const timer = setTimeout(onDismiss, 15_000);
    return () => clearTimeout(timer);
  }, [onDismiss, toast.sticky]);

  return (
    <div className="animate-in slide-in-from-top-2 fade-in duration-300 pointer-events-auto">
      <div className="bg-violet-200/90 backdrop-blur-xl border border-violet-300 rounded-xl px-5 py-4 shadow-2xl shadow-violet-400/20 max-w-md">
        <div className="flex items-start gap-3">
          <div className="shrink-0 size-8 rounded-full bg-violet-300/60 flex items-center justify-center text-sm">
            ✨
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-violet-700 font-semibold mb-1">{toast.taskName}</div>
            <p className="text-sm text-violet-900 leading-relaxed">{toast.message}</p>
            {toast.url && (
              <a
                href={toast.url}
                target={tabName(toast.url)}
                rel="noopener"
                onClick={onDismiss}
                className="mt-2 inline-block text-xs font-semibold text-violet-700 hover:text-violet-900"
              >
                Open →
              </a>
            )}
          </div>
          <button
            onClick={onDismiss}
            className="shrink-0 text-violet-400 hover:text-violet-600 transition-colors text-xs mt-0.5"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Global notifications provider ────────────────────────────
export function GlobalNotifications({ children }: { children: ReactNode }) {
  const ctx = useGatewayClientContext();
  const client = ctx?.client ?? null;
  const isConnected = ctx?.isConnected ?? false;
  const notificationPermissionRef = useRef(false);
  const [toasts, setToasts] = useState<ToastData[]>([]);

  // Request browser notification permission on mount
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then((perm) => {
        notificationPermissionRef.current = perm === "granted";
      });
    } else if ("Notification" in window) {
      notificationPermissionRef.current = Notification.permission === "granted";
    }
  }, []);

  // Subscribe to scheduler notifications globally
  useEffect(() => {
    if (!client || !isConnected) return;

    const events = ["scheduler.notification", "today.needs_you"];
    client.subscribe(events);

    const show = (toast: ToastData) => {
      setToasts((prev) => [...prev, toast]);
      if (!notificationPermissionRef.current) return;
      const notification = new Notification(`✨ ${toast.taskName}`, {
        body: toast.message,
        icon: "/favicon.ico",
      });
      const { url } = toast;
      if (url) {
        notification.onclick = () => {
          window.open(url, tabName(url));
          notification.close();
        };
      }
    };

    const offScheduler = client.on("scheduler.notification", (_event, raw) => {
      const payload = raw as { taskId?: string; taskName?: string; message?: string };
      show({
        id: crypto.randomUUID(),
        message: payload.message ?? "Task completed",
        taskName: payload.taskName ?? "Anima",
        timestamp: Date.now(),
      });
    });

    // A session working a Today item needs the user (a question, an approval).
    const offToday = client.on("today.needs_you", (_event, raw) => {
      const payload = raw as { title?: string; message?: string; url?: string | null };
      show({
        id: crypto.randomUUID(),
        message: payload.message ?? "Needs your answer.",
        taskName: payload.title ?? "Needs your answer",
        timestamp: Date.now(),
        url: payload.url ?? null,
        sticky: true,
      });
    });

    return () => {
      offScheduler();
      offToday();
    };
  }, [client, isConnected]);

  const dismissToast = useCallback((toastId: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);

  return (
    <>
      {children}
      {/* Toast overlay — fixed top-right, always on top */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-3 pointer-events-none">
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
          ))}
        </div>
      )}
    </>
  );
}
