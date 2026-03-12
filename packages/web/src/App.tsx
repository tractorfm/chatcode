import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { getUserSettings } from "@/lib/api";
import { cachePreferences, DEFAULT_PREFERENCES, type UserPreferences } from "@/lib/preferences";

const AuthPage = lazy(() => import("@/pages/auth-page").then((m) => ({ default: m.AuthPage })));
const AppPage = lazy(() => import("@/pages/app-page").then((m) => ({ default: m.AppPage })));
const OnboardingPage = lazy(() =>
  import("@/pages/onboarding-page").then((m) => ({ default: m.OnboardingPage })),
);
const SettingsPage = lazy(() =>
  import("@/pages/settings-page").then((m) => ({ default: m.SettingsPage })),
);
const StatusPage = lazy(() => import("@/pages/status-page").then((m) => ({ default: m.StatusPage })));

type Overlay = "settings" | "status" | "onboarding" | null;

export function App() {
  const auth = useAuth();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [sidebarRefreshSignal, setSidebarRefreshSignal] = useState(0);
  const [selectedVpsIdHint, setSelectedVpsIdHint] = useState<string | null>(null);
  const [onboardingManualVpsId, setOnboardingManualVpsId] = useState<string | null>(null);
  const [linkedProviders, setLinkedProviders] = useState<string[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleNavigate = useCallback((target: "settings" | "status" | "onboarding", opts?: { manualVpsId?: string | null }) => {
    setOnboardingManualVpsId(target === "onboarding" ? opts?.manualVpsId ?? null : null);
    setOverlay(target);
  }, []);

  const handleCloseOverlay = useCallback(() => {
    setOnboardingManualVpsId(null);
    setOverlay(null);
  }, []);

  const handleOnboardingComplete = useCallback((vpsId: string) => {
    setSelectedVpsIdHint(vpsId);
    setSidebarRefreshSignal((value) => value + 1);
    setOnboardingManualVpsId(null);
    setOverlay(null);
    window.setTimeout(() => setSelectedVpsIdHint(null), 0);
  }, []);

  useEffect(() => {
    if (!overlay) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    overlayRef.current?.focus();
  }, [overlay]);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    setLinkedProviders(auth.user.providers ?? []);
  }, [auth.status]);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    let cancelled = false;
    void getUserSettings()
      .then(({ preferences }) => {
        if (cancelled) return;
        setPreferences(preferences);
        cachePreferences(preferences);
      })
      .catch(() => {
        if (cancelled) return;
        setPreferences(DEFAULT_PREFERENCES);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.status]);

  if (auth.status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (auth.status === "unauthenticated") {
    return (
      <Suspense fallback={<PageLoading />}>
        <AuthPage />
      </Suspense>
    );
  }

  const userEmail = auth.user.email;

  return (
    <Suspense fallback={<PageLoading />}>
      <>
        <AppPage
          userEmail={userEmail}
          onLogout={auth.logout}
          onNavigate={handleNavigate}
          overlayOpen={overlay !== null}
          externalRefreshSignal={sidebarRefreshSignal}
          selectedVpsIdHint={selectedVpsIdHint}
        />
        {overlay && (
          <div
            ref={overlayRef}
            className="fixed inset-0 z-50 bg-background overflow-y-auto"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
          >
            {overlay === "onboarding" && (
              <OnboardingPage
                onBack={handleCloseOverlay}
                onComplete={handleOnboardingComplete}
                manualVpsId={onboardingManualVpsId}
              />
            )}
            {overlay === "settings" && (
              <SettingsPage
                userEmail={userEmail}
                linkedProviders={linkedProviders}
                onProvidersChanged={setLinkedProviders}
                preferences={preferences}
                onPreferencesChanged={(next) => {
                  setPreferences(next);
                  cachePreferences(next);
                }}
                onBack={handleCloseOverlay}
                onLogout={auth.logout}
              />
            )}
            {overlay === "status" && (
              <StatusPage onBack={handleCloseOverlay} />
            )}
          </div>
        )}
      </>
    </Suspense>
  );
}

function PageLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">Loading...</div>
    </div>
  );
}
