import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { AuthPage } from "@/pages/auth-page";
import { AppPage } from "@/pages/app-page";
import { OnboardingPage } from "@/pages/onboarding-page";
import { SettingsPage } from "@/pages/settings-page";
import { StatusPage } from "@/pages/status-page";

type Overlay = "settings" | "status" | "onboarding" | null;

export function App() {
  const auth = useAuth();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [sidebarRefreshSignal, setSidebarRefreshSignal] = useState(0);
  const [selectedVpsIdHint, setSelectedVpsIdHint] = useState<string | null>(null);
  const [onboardingManualVpsId, setOnboardingManualVpsId] = useState<string | null>(null);
  const [linkedProviders, setLinkedProviders] = useState<string[]>([]);
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
  }, [auth]);

  if (auth.status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (auth.status === "unauthenticated") {
    return <AuthPage />;
  }

  const userEmail = auth.user.email;

  return (
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
  );
}
