import { useCallback, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { AuthPage } from "@/pages/auth-page";
import { AppPage } from "@/pages/app-page";
import { OnboardingPage } from "@/pages/onboarding-page";
import { SettingsPage } from "@/pages/settings-page";
import { StatusPage } from "@/pages/status-page";

type Page = "app" | "settings" | "status" | "onboarding";

export function App() {
  const auth = useAuth();
  const [page, setPage] = useState<Page>("app");

  const handleNavigate = useCallback((target: Page | "settings" | "status" | "onboarding") => {
    setPage(target as Page);
  }, []);

  const handleBack = useCallback(() => setPage("app"), []);

  const handleOnboardingComplete = useCallback((_vpsId: string) => {
    setPage("app");
  }, []);

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

  switch (page) {
    case "onboarding":
      return (
        <OnboardingPage
          onBack={handleBack}
          onComplete={handleOnboardingComplete}
        />
      );
    case "settings":
      return (
        <SettingsPage
          userEmail={userEmail}
          onBack={handleBack}
          onLogout={auth.logout}
        />
      );
    case "status":
      return <StatusPage onBack={handleBack} />;
    default:
      return (
        <AppPage
          userEmail={userEmail}
          onLogout={auth.logout}
          onNavigate={handleNavigate}
        />
      );
  }
}
