import { Toaster } from "@/components/ui/toaster";
import { ToastAction } from "@/components/ui/toast";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, useRef, lazy, Suspense } from "react";
import { toast } from "@/hooks/use-toast";
import { useAuthStore } from "./stores/authStore";
import { migrateLegacyCredentials } from "./lib/secureStorage";
import Loading from "./components/Loading";
import AlertNotification from "./components/AlertNotification";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useAuthCallbacks } from "./hooks/useAuthCallbacks";

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
  const { updateAvailable, version, checkForUpdates, install } = useAppUpdate();
  const updateToastShown = useRef(false);

  useAuthCallbacks();

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
      toast({
        title: "Update available",
        description: `Version ${version} is ready to install`,
        duration: Infinity,
        action: (
          <ToastAction altText="Install the update" onClick={() => void install()}>
            Update
          </ToastAction>
        ),
      });
    }
  }, [updateAvailable, version, install]);

  return (
    <>
      <Toaster />
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
    </>
  );
};

export default App;
