import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useRef, lazy, Suspense } from "react";
import { listen } from "@tauri-apps/api/event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuthStore } from "./stores/authStore";
import { migrateLegacyCredentials } from "./lib/secureStorage";
import Loading from "./components/Loading";
import { AlertService } from "./services/alertsService";
import AlertNotification from "./components/AlertNotification";
import { useAppUpdate } from "./hooks/useAppUpdate";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

// Lazy load page components to improve startup time
const Index = lazy(() => import("./pages/Index"));
const Login = lazy(() => import("./pages/Login"));
const NotFound = lazy(() => import("./pages/NotFound"));

// Protected route component that redirects to login if not authenticated.
// Auth state comes from the OS keychain and is hydrated asynchronously, so
// routing waits for `hydrated` before deciding.
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const isTwitchAuthed = useAuthStore(s => s.isTwitchAuthed);
  const isYoutubeAuthed = useAuthStore(s => s.isYoutubeAuthed);
  const hydrated = useAuthStore(s => s.hydrated);

  if (!hydrated) {
    return <Loading message="Loading StreamTTS..." />;
  }

  if (!isTwitchAuthed && !isYoutubeAuthed) {
    return <Navigate to="/login" replace />;
  }

  return <Suspense fallback={<Loading message="Loading application..." />}>{children}</Suspense>;
};

const App = () => {
  const { updateAvailable, version, checkForUpdates, install, dismiss } = useAppUpdate();
  const updateToastShown = useRef(false);

  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  // Move credentials from plaintext localStorage into the OS keychain, then
  // hydrate auth state from the keychain before any routing decision.
  useEffect(() => {
    void (async () => {
      try {
        await migrateLegacyCredentials();
      } catch (error) {
        console.error('Failed to migrate legacy credentials:', error);
      }
      await useAuthStore.getState().hydrate();
    })();
  }, []);

  useEffect(() => {
    if (updateAvailable && !updateToastShown.current) {
      updateToastShown.current = true;
      toast("Update available", {
        description: `Version ${version} is ready to install`,
        action: {
          label: "Update",
          onClick: () => {
            install();
            toast.dismiss();
          },
        },
        cancel: {
          label: "Later",
          onClick: () => {
            dismiss();
            toast.dismiss();
          },
        },
        duration: Infinity,
      });
    }
  }, [updateAvailable, version, install, dismiss]);

  useEffect(() => {
    try {
      const alertService = AlertService.getInstance();
      alertService.initialize();
      return () => alertService.cleanup();
    } catch (error) {
      console.error('Failed to initialize alert service:', error);
    }
  }, []);

  // The Rust loopback OAuth server runs asynchronously; if it fails to bind
  // (e.g. port 3000 is taken), login will silently fail without this signal.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('oauth-server-error', (event) => {
      toast.error("Login server failed to start", {
        description: String(event.payload),
        duration: 10000,
      });
    })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <AlertNotification />
        <Suspense fallback={<Loading isStartup={true} message="Loading StreamTTS..." />}>
          <HashRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route 
                path="/" 
                element={
                  <ProtectedRoute>
                    <Index />
                  </ProtectedRoute>
                } 
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </HashRouter>
        </Suspense>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
