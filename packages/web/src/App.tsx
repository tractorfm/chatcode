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
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleNavigate = useCallback((target: "settings" | "status" | "onboarding") => {
    setOverlay(target);
  }, []);

  const handleCloseOverlay = useCallback(() => setOverlay(null), []);

  const handleOnboardingComplete = useCallback((_vpsId: string) => {
    setOverlay(null);
  }, []);

  useEffect(() => {
    if (!overlay) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    overlayRef.current?.focus();
  }, [overlay]);

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
            />
          )}
          {overlay === "settings" && (
            <SettingsPage
              userEmail={userEmail}
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
