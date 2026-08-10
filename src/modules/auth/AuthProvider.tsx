import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "@/lib/firebase";
import { isPlatformAdminRole, PERMISSIONS, type Permission } from "@spp/shared";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  permissions: Permission[];
  rolePrimary: string | null;
  sessionId: string | null;
  companyId: string | null;
  isPlatformAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshClaims: () => Promise<void>;
  rehydrateFromToken: () => Promise<void>;
  hasPermission: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function readClaims(user: User) {
  const token = await user.getIdTokenResult(true);
  return {
    permissions: (token.claims.permissions as Permission[]) || [],
    rolePrimary: (token.claims.rolePrimary as string) || null,
    sessionId: (token.claims.sessionId as string) || null,
    companyId: (token.claims.companyId as string | null) || null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [rolePrimary, setRolePrimary] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);

  const hydrate = useCallback(async (next: User | null) => {
    if (!next) {
      setUser(null);
      setPermissions([]);
      setRolePrimary(null);
      setSessionId(null);
      setCompanyId(null);
      return;
    }
    setUser(next);
    const claims = await readClaims(next);
    setPermissions(claims.permissions);
    setRolePrimary(claims.rolePrimary);
    setSessionId(claims.sessionId);
    setCompanyId(claims.companyId);
  }, []);

  useEffect(() => {
    return onAuthStateChanged(auth, async (next) => {
      try {
        await hydrate(next);
      } finally {
        setLoading(false);
      }
    });
  }, [hydrate]);

  const refreshClaims = useCallback(async () => {
    if (!auth.currentUser) return;
    const sync = httpsCallable(functions, "syncClaims");
    await sync({});
    await auth.currentUser.getIdToken(true);
    await hydrate(auth.currentUser);
  }, [hydrate]);

  /** Re-read ID token claims without staff syncClaims (safe for clients). */
  const rehydrateFromToken = useCallback(async () => {
    if (!auth.currentUser) return;
    await auth.currentUser.getIdToken(true);
    await hydrate(auth.currentUser);
  }, [hydrate]);

  const signIn = useCallback(async (email: string, password: string) => {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    try {
      const sync = httpsCallable(functions, "syncClaims");
      await sync({});
      await cred.user.getIdToken(true);
    } catch {
      // First-time users may need bootstrap before claims exist.
    }
    await hydrate(cred.user);
  }, [hydrate]);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
    await hydrate(null);
  }, [hydrate]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      permissions,
      rolePrimary,
      sessionId,
      companyId,
      isPlatformAdmin:
        isPlatformAdminRole(rolePrimary) ||
        permissions.includes(PERMISSIONS.ADMIN_ACCESS) ||
        permissions.includes(PERMISSIONS.COMPANIES_MANAGE),
      signIn,
      signOut,
      refreshClaims,
      rehydrateFromToken,
      hasPermission: (permission) => permissions.includes(permission),
    }),
    [
      user,
      loading,
      permissions,
      rolePrimary,
      sessionId,
      companyId,
      signIn,
      signOut,
      refreshClaims,
      rehydrateFromToken,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
