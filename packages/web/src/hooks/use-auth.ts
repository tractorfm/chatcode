import { useCallback, useEffect, useState } from "react";
import { getMe, logout as apiLogout, type User } from "@/lib/api";

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: User };

export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  const checkAuth = useCallback(async () => {
    try {
      const user = await getMe();
      setState({ status: "authenticated", user });
    } catch {
      setState({ status: "unauthenticated" });
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      /* ignore */
    }
    setState({ status: "unauthenticated" });
  }, []);

  return { ...state, checkAuth, logout };
}
