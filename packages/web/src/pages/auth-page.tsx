import { useCallback, useState } from "react";
import { Mail, Github, ArrowRight } from "lucide-react";
import { startEmailLogin, getOAuthURL } from "@/lib/api";

export function AuthPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleEmailSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!email.trim() || loading) return;
      setLoading(true);
      setError("");
      try {
        await startEmailLogin(email.trim());
        setSent(true);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Failed to send login link";
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [email, loading],
  );

  const handleOAuth = useCallback(
    (provider: "google" | "github") => {
      window.location.href = getOAuthURL(provider);
    },
    [],
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            Chatcode
          </h1>
          <p className="text-sm text-muted-foreground">
            Vibe-code on your own cloud server
          </p>
        </div>

        {sent ? (
          /* Email sent confirmation */
          <div className="bg-card rounded-lg border border-border p-6 text-center space-y-3">
            <Mail className="h-8 w-8 mx-auto text-primary" />
            <h2 className="text-base font-medium text-foreground">
              Check your inbox
            </h2>
            <p className="text-sm text-muted-foreground">
              We sent a sign-in link to{" "}
              <span className="font-medium text-foreground">{email}</span>
            </p>
            <button
              onClick={() => setSent(false)}
              className="text-sm text-primary hover:underline"
            >
              Use a different email
            </button>
          </div>
        ) : (
          /* Sign in form */
          <div className="bg-card rounded-lg border border-border p-6 space-y-5">
            <form onSubmit={handleEmailSubmit} className="space-y-3">
              <label
                htmlFor="email"
                className="block text-sm font-medium text-foreground"
              >
                Email
              </label>
              <div className="flex gap-2">
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="submit"
                  disabled={loading || !email.trim()}
                  className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {loading ? (
                    "..."
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                </button>
              </div>
              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}
            </form>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-card px-2 text-muted-foreground">or</span>
              </div>
            </div>

            <div className="space-y-2">
              <button
                onClick={() => handleOAuth("google")}
                className="w-full flex items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
              >
                <GoogleIcon />
                Continue with Google
              </button>
              <button
                onClick={() => handleOAuth("github")}
                className="w-full flex items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
              >
                <Github className="h-4 w-4" />
                Continue with GitHub
              </button>
            </div>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground">
          Your code runs on your own VPS, not ours.
        </p>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}
