import { useCallback, useEffect, useRef, useState } from "react";
import type { UserProfile } from "@simpleim/contracts";
import { HttpAuthClient } from "../api/http-client.ts";

export type AuthNoticeKey =
  | "auth.notice.crossTabLogout"
  | "auth.notice.reauthRequired";

export interface UseAuthSessionOptions {
  readonly onBeforeSessionReset?: () => Promise<void>;
}

export interface AuthSessionController {
  readonly authClient: HttpAuthClient;
  readonly bootstrapping: boolean;
  readonly user: UserProfile | null;
  readonly authNoticeKey: AuthNoticeKey | null;
  readonly login: (params: { username: string; password: string }) => Promise<void>;
  readonly register: (params: {
    username: string;
    password: string;
    displayName?: string;
  }) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly expireToReauth: () => void;
}

export function useAuthSession(
  options?: UseAuthSessionOptions,
): AuthSessionController {
  const authClientRef = useRef<HttpAuthClient | null>(null);
  if (!authClientRef.current) {
    authClientRef.current = new HttpAuthClient();
  }
  const authClient = authClientRef.current;

  const beforeResetRef = useRef(options?.onBeforeSessionReset);
  beforeResetRef.current = options?.onBeforeSessionReset;

  const [bootstrapping, setBootstrapping] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authNoticeKey, setAuthNoticeKey] = useState<AuthNoticeKey | null>(null);

  useEffect(() => {
    let cancelled = false;

    const unsubscribeCrossTab = authClient.onCrossTabSessionReset((nextUser) => {
      const resetPromise = beforeResetRef.current
        ? beforeResetRef.current()
        : Promise.resolve();
      void resetPromise.then(() => {
        if (cancelled) return;
        setUser(nextUser);
        if (nextUser === null) {
          setAuthNoticeKey("auth.notice.crossTabLogout");
        } else {
          setAuthNoticeKey(null);
        }
      });
    });

    void authClient
      .getMe()
      .then((restoredUser) => {
        if (!cancelled) {
          setUser(restoredUser);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBootstrapping(false);
        }
      });

    return () => {
      cancelled = true;
      unsubscribeCrossTab();
    };
  }, [authClient]);

  const login = useCallback(
    async (params: { username: string; password: string }): Promise<void> => {
      if (beforeResetRef.current) {
        await beforeResetRef.current();
      }
      const loggedIn = await authClient.login(params);
      setAuthNoticeKey(null);
      setUser(loggedIn);
    },
    [authClient],
  );

  const register = useCallback(
    async (params: {
      username: string;
      password: string;
      displayName?: string;
    }): Promise<void> => {
      if (beforeResetRef.current) {
        await beforeResetRef.current();
      }
      const registered = await authClient.register(params);
      setAuthNoticeKey(null);
      setUser(registered);
    },
    [authClient],
  );

  const signOut = useCallback(async (): Promise<void> => {
    if (beforeResetRef.current) {
      await beforeResetRef.current();
    }
    try {
      await authClient.logout();
    } finally {
      setUser(null);
      setAuthNoticeKey(null);
    }
  }, [authClient]);

  const expireToReauth = useCallback((): void => {
    setUser(null);
    setAuthNoticeKey("auth.notice.reauthRequired");
  }, []);

  return {
    authClient,
    bootstrapping,
    user,
    authNoticeKey,
    login,
    register,
    signOut,
    expireToReauth,
  };
}
