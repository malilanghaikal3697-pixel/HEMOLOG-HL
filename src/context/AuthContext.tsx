import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Session, User as SupabaseUser } from '@supabase/supabase-js';
import {
  BOOTSTRAP_ADMIN_EMAILS,
  IS_SUPABASE_CONFIGURED,
  createEphemeralSupabaseClient,
  isBootstrapAdminEmail,
  requireSupabase,
  supabase,
} from '../lib/supabase';
import {
  OperationType,
  db,
  doc,
  formatDbError,
  getDoc,
  handleDbError,
  isPermissionDeniedError,
  isTransientDbError,
  onDbReconnect,
  onSnapshot,
  reconnectDb,
  serverTimestamp,
  setDoc,
  updateDoc,
} from '../lib/supabaseDb';
import { clampString } from '../lib/formatters';
import { clearLastActivity, stampLastActivity } from '../hooks/useIdleTimeout';
import type { UserProfile, UserRole } from '../types';

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  providerData: { providerId: string; email?: string | null }[];
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
}

function mapSupabaseUser(user: SupabaseUser, session: Session | null): AuthUser {
  const providersRaw = Array.isArray(user.app_metadata?.providers)
    ? (user.app_metadata.providers as string[])
    : [String(user.app_metadata?.provider || 'email')];

  const providerData = providersRaw.map((p) => ({
    providerId: p === 'email' ? 'password' : p === 'google' ? 'google.com' : p,
    email: user.email || null,
  }));

  return {
    uid: user.id,
    email: user.email || null,
    displayName:
      (user.user_metadata?.full_name as string | undefined) ||
      (user.user_metadata?.name as string | undefined) ||
      null,
    emailVerified: Boolean(user.email_confirmed_at || user.confirmed_at),
    providerData,
    getIdToken: async (forceRefresh = false) => {
      const client = requireSupabase();
      if (forceRefresh) {
        const { data } = await client.auth.refreshSession();
        if (data.session?.access_token) return data.session.access_token;
      }
      const { data } = await client.auth.getSession();
      return data.session?.access_token || session?.access_token || '';
    },
  };
}

interface AuthContextValue {
  authUser: AuthUser | null;
  userProfile: UserProfile | null;
  authReady: boolean;
  profileLoading: boolean;
  isSupabaseConfigured: boolean;
  blockedMessage: string | null;
  idleLogoutMessage: string | null;
  clearIdleLogoutMessage: () => void;
  loginWithEmail: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  registerWithEmail: (params: {
    email: string;
    password: string;
    fullName: string;
    nip: string;
  }) => Promise<{ requiresEmailConfirmation: boolean }>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  logoutDueToIdle: () => Promise<void>;
  updateOwnProfile: (data: {
    fullName: string;
    nip: string;
    phone: string;
    specialization: string;
  }) => Promise<void>;
  changeUserPassword: (currentPassword: string, newPassword: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  adminCreateAccount: (params: {
    email: string;
    password: string;
    fullName: string;
    nip: string;
    role: UserRole;
    phone?: string;
    specialization?: string;
  }) => Promise<void>;
  adminBulkCreateAccounts: (
    accounts: {
      rowIndex: number;
      fullName: string;
      nip: string;
      email: string;
      password: string;
      role: UserRole;
      phone?: string;
      specialization?: string;
    }[]
  ) => Promise<{
    ok: boolean;
    createdCount: number;
    failedCount: number;
    results: {
      rowIndex: number;
      email: string;
      fullName: string;
      ok: boolean;
      uid?: string;
      error?: string;
    }[];
  }>;
  adminDeleteAccount: (targetUid: string) => Promise<{ authDeleted: boolean }>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

async function parseApiJsonResponse<T extends { ok?: boolean; error?: string; message?: string }>(
  res: Response,
  fallbackMessage: string
): Promise<T> {
  const rawText = await res.text();
  let parsed: T | null = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as T;
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    const trimmed = rawText.trim();
    const looksLikeSpaHtml =
      trimmed.startsWith('<!doctype html') ||
      trimmed.startsWith('<!DOCTYPE html') ||
      trimmed.includes('<div id="root">');
    const err = new Error(
      looksLikeSpaHtml
        ? `Endpoint server /api tidak merespons JSON (HTTP ${res.status}). Pastikan Serverless Function Vercel (/api/index.mjs) ter-deploy dengan benar.`
        : `${fallbackMessage} (HTTP ${res.status}${trimmed ? `: ${trimmed.slice(0, 140)}` : ''})`
    ) as Error & { code?: string };
    err.code = looksLikeSpaHtml ? 'API_UNREACHABLE' : `HTTP_${res.status}`;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(parsed.message || `${fallbackMessage} (HTTP ${res.status})`) as Error & {
      code?: string;
    };
    err.code = parsed.error || `HTTP_${res.status}`;
    throw err;
  }

  return parsed;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [authReady, setAuthReady] = useState(!IS_SUPABASE_CONFIGURED);
  const [profileLoading, setProfileLoading] = useState(IS_SUPABASE_CONFIGURED);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [idleLogoutMessage, setIdleLogoutMessage] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_SUPABASE_CONFIGURED || !supabase) {
      setAuthReady(true);
      setProfileLoading(false);
      return;
    }

    let cancelled = false;
    let authEventSeq = 0;
    let unsubscribeProfile: (() => void) | null = null;
    let retryTimer: number | null = null;
    let activeUid: string | null = null;
    let bootstrappingUid: string | null = null;

    const bootstrapMissingProfile = async (user: AuthUser, seq: number) => {
      if (bootstrappingUid === user.uid) return;
      bootstrappingUid = user.uid;
      try {
        const isBootstrap = isBootstrapAdminEmail(user.email);
        const initialRole: UserRole = isBootstrap ? 'Administrator' : 'Perawat Pelaksana';
        const fallbackName =
          clampString(user.displayName || user.email?.split('@')[0] || 'Perawat HD', 120) ||
          'Perawat HD';
        const initialNip = isBootstrap ? 'ADM-001' : `HD-${user.uid.slice(0, 6).toUpperCase()}`;

        const profilePayload = {
          uid: user.uid,
          email: clampString(user.email || 'staff@hemolog.local', 200),
          fullName: fallbackName,
          nip: initialNip,
          role: initialRole,
          isActive: true,
          phone: '',
          specialization: isBootstrap ? 'System Administrator' : 'Perawat Hemodialisa',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };

        await Promise.all([
          setDoc(doc(db, 'users', user.uid), profilePayload),
          setDoc(doc(db, 'staff_directory', user.uid), {
            uid: user.uid,
            fullName: fallbackName,
            role: initialRole,
            isActive: true,
            updatedAt: serverTimestamp(),
          }),
        ]);
      } catch (error) {
        if (cancelled || seq !== authEventSeq) return;
        bootstrappingUid = null;
        if (isTransientDbError(error)) {
          console.warn('Inisialisasi profil tertunda sementara, mencoba sinkronisasi ulang:', error);
          void reconnectDb({ force: true, resubscribe: true, reason: 'error' });
        } else {
          const msg = error instanceof Error ? error.message : String(error);
          console.error('Error initializing user profile:', error);
          setBlockedMessage(
            `Autentikasi berhasil, tetapi gagal menyiapkan profil di Supabase (${msg}). Pastikan file supabase/schema.sql sudah dijalankan di SQL Editor Supabase.`
          );
          setUserProfile(null);
          setAuthReady(true);
          setProfileLoading(false);
        }
      }
    };

    const attachProfileListener = (user: AuthUser, seq: number) => {
      if (cancelled || seq !== authEventSeq) return;
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }

      const userRef = doc(db, 'users', user.uid);
      unsubscribeProfile = onSnapshot<UserProfile>(
        userRef,
        (docSnap) => {
          if (cancelled || seq !== authEventSeq) return;
          if (docSnap.exists()) {
            const data = docSnap.data() as UserProfile;
            if (!data.isActive) {
              setBlockedMessage(
                'Akun Anda sedang dinonaktifkan oleh Administrator. Hubungi Admin Unit Hemodialisa untuk aktivasi kembali.'
              );
              setUserProfile(null);
              void supabase?.auth.signOut().catch(() => undefined);
            } else {
              const fallbackName =
                clampString(
                  data.fullName || user.displayName || user.email?.split('@')[0] || 'Staf HD',
                  120
                ) || 'Staf HD';
              setUserProfile({
                ...data,
                uid: user.uid,
                email: data.email || user.email || '',
                fullName: fallbackName,
              });
            }
            setAuthReady(true);
            setProfileLoading(false);
          } else {
            void bootstrapMissingProfile(user, seq);
          }
        },
        (error) => {
          if (cancelled || seq !== authEventSeq) return;
          if (isTransientDbError(error)) {
            console.warn('Koneksi profil Supabase terputus sementara, menyambungkan ulang...');
            if (retryTimer !== null) window.clearTimeout(retryTimer);
            retryTimer = window.setTimeout(() => {
              if (!cancelled && seq === authEventSeq && activeUid === user.uid) {
                attachProfileListener(user, seq);
              }
            }, 3000);
            return;
          }
          if (isPermissionDeniedError(error)) {
            setBlockedMessage(
              'Akses tabel profil ditolak oleh kebijakan RLS Supabase. Pastikan skrip supabase/schema.sql sudah dijalankan di SQL Editor Supabase.'
            );
            setUserProfile(null);
            setAuthReady(true);
            setProfileLoading(false);
            return;
          }
          setFatalError(formatDbError(error, OperationType.GET, `users/${user.uid}`));
        }
      );
    };

    const handleSessionChange = (session: Session | null) => {
      const currentSeq = ++authEventSeq;
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (cancelled) return;

      const supaUser = session?.user ?? null;
      if (!supaUser) {
        activeUid = null;
        bootstrappingUid = null;
        setAuthUser(null);
        setUserProfile(null);
        setFatalError(null);
        setAuthReady(true);
        setProfileLoading(false);
        return;
      }

      const mappedUser = mapSupabaseUser(supaUser, session);
      activeUid = mappedUser.uid;
      bootstrappingUid = null;
      setAuthUser(mappedUser);
      setFatalError(null);
      setBlockedMessage(null);
      setIdleLogoutMessage(null);
      setProfileLoading(true);
      attachProfileListener(mappedUser, currentSeq);
    };

    const unsubReconnect = onDbReconnect(() => {
      if (!cancelled && activeUid && authUser && authUser.uid === activeUid) {
        attachProfileListener(authUser, authEventSeq);
      }
    });

    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) {
        handleSessionChange(data.session);
      }
    });

    const { data: authSub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) {
        handleSessionChange(session);
      }
    });

    return () => {
      cancelled = true;
      authSub.subscription.unsubscribe();
      unsubReconnect();
      if (unsubscribeProfile) unsubscribeProfile();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, []);

  if (fatalError) {
    throw new Error(fatalError);
  }

  const loginWithEmail = async (email: string, password: string, _rememberMe = true) => {
    const client = requireSupabase();
    setBlockedMessage(null);
    setIdleLogoutMessage(null);
    stampLastActivity();
    const { error } = await client.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error) throw error;
    stampLastActivity();
  };

  const resetPassword = async (email: string) => {
    const client = requireSupabase();
    const { error } = await client.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
    });
    if (error) throw error;
  };

  const registerWithEmail = async (params: {
    email: string;
    password: string;
    fullName: string;
    nip: string;
  }) => {
    const client = requireSupabase();
    setBlockedMessage(null);
    setIdleLogoutMessage(null);
    stampLastActivity();

    const cleanEmail = clampString(params.email.trim().toLowerCase(), 200);
    const cleanName = clampString(params.fullName, 120);
    const cleanNip = clampString(params.nip, 40);

    const { data, error } = await client.auth.signUp({
      email: cleanEmail,
      password: params.password,
      options: {
        data: {
          full_name: cleanName,
          nip: cleanNip,
        },
        emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    });
    if (error) throw error;
    stampLastActivity();

    const supaUser = data.user;
    const hasSession = Boolean(data.session);

    if (supaUser && hasSession) {
      const isBootstrap = isBootstrapAdminEmail(cleanEmail);
      const role: UserRole = isBootstrap ? 'Administrator' : 'Perawat Pelaksana';
      try {
        await Promise.all([
          setDoc(doc(db, 'users', supaUser.id), {
            uid: supaUser.id,
            email: cleanEmail,
            fullName: cleanName,
            nip: cleanNip,
            role,
            isActive: true,
            phone: '',
            specialization: isBootstrap ? 'System Administrator' : 'Perawat Hemodialisa',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }),
          setDoc(doc(db, 'staff_directory', supaUser.id), {
            uid: supaUser.id,
            fullName: cleanName,
            role,
            isActive: true,
            updatedAt: serverTimestamp(),
          }),
        ]);
      } catch (err) {
        handleDbError(err, OperationType.CREATE, `users/${supaUser.id}`);
      }
    }

    return { requiresEmailConfirmation: !hasSession };
  };

  const loginWithGoogle = async () => {
    const client = requireSupabase();
    setBlockedMessage(null);
    setIdleLogoutMessage(null);
    stampLastActivity();
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    });
    if (error) throw error;
  };

  const clearIdleLogoutMessage = () => {
    setIdleLogoutMessage(null);
  };

  const logout = async () => {
    clearLastActivity();
    setIdleLogoutMessage(null);
    if (supabase) {
      await supabase.auth.signOut();
    }
  };

  const logoutDueToIdle = async () => {
    clearLastActivity();
    setIdleLogoutMessage(
      'Sesi Anda telah otomatis logout karena tidak ada aktivitas pada aplikasi lebih dari 15 menit. Silakan masuk kembali.'
    );
    if (supabase) {
      await supabase.auth.signOut();
    }
  };

  const updateOwnProfile = async (data: {
    fullName: string;
    nip: string;
    phone: string;
    specialization: string;
  }) => {
    if (!authUser || !userProfile) throw new Error('Pengguna belum terautentikasi.');
    const cleanName = clampString(data.fullName, 120);
    const cleanNip = clampString(data.nip, 40);
    const cleanPhone = clampString(data.phone, 30);
    const cleanSpec = clampString(data.specialization, 100);

    try {
      await Promise.all([
        updateDoc(doc(db, 'users', authUser.uid), {
          fullName: cleanName,
          nip: cleanNip,
          phone: cleanPhone,
          specialization: cleanSpec,
          updatedAt: serverTimestamp(),
        }),
        updateDoc(doc(db, 'staff_directory', authUser.uid), {
          fullName: cleanName,
          updatedAt: serverTimestamp(),
        }),
      ]);
    } catch (error) {
      handleDbError(error, OperationType.UPDATE, `users/${authUser.uid}`);
    }
  };

  const changeUserPassword = async (currentPassword: string, newPassword: string) => {
    const client = requireSupabase();
    if (!authUser || !authUser.email) {
      throw new Error('Akun tidak terautentikasi.');
    }
    const { error: verifyErr } = await client.auth.signInWithPassword({
      email: authUser.email,
      password: currentPassword,
    });
    if (verifyErr) {
      const err = new Error('Password saat ini salah.') as Error & { code?: string };
      err.code = 'auth/wrong-password';
      throw err;
    }
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) throw error;
  };

  const resendVerificationEmail = async () => {
    const client = requireSupabase();
    if (!authUser?.email) throw new Error('Akun tidak terautentikasi.');
    const { error } = await client.auth.resend({
      type: 'signup',
      email: authUser.email,
    });
    if (error) throw error;
  };

  const adminCreateAccount = async (params: {
    email: string;
    password: string;
    fullName: string;
    nip: string;
    role: UserRole;
    phone?: string;
    specialization?: string;
  }) => {
    if (!authUser || userProfile?.role !== 'Administrator') {
      throw new Error('Hanya Administrator yang dapat membuat akun baru.');
    }

    const cleanEmail = clampString(params.email.trim().toLowerCase(), 200);
    const cleanName = clampString(params.fullName, 120);
    const cleanNip = clampString(params.nip, 40);
    const cleanPhone = clampString(params.phone || '', 30);
    const cleanSpec = clampString(params.specialization || 'Perawat Hemodialisa', 100);

    // Prefer backend /api/admin/users/bulk (auto-confirms email via Supabase Service Role)
    const idToken = await authUser.getIdToken();
    try {
      const res = await fetch('/api/admin/users/bulk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          accounts: [
            {
              rowIndex: 0,
              fullName: cleanName,
              nip: cleanNip,
              email: cleanEmail,
              password: params.password,
              role: params.role,
              phone: cleanPhone,
              specialization: cleanSpec,
            },
          ],
        }),
      });

      if (res.status !== 503 && res.status !== 404) {
        const parsed = await parseApiJsonResponse<{
          ok?: boolean;
          results?: { ok: boolean; error?: string }[];
          message?: string;
        }>(res, 'Gagal membuat akun staf.');
        const first = parsed.results?.[0];
        if (first && !first.ok) {
          throw new Error(first.error || 'Gagal membuat akun staf.');
        }
        return;
      }
    } catch (apiErr) {
      const code = (apiErr as { code?: string })?.code;
      if (
        code !== 'SUPABASE_ADMIN_NOT_CONFIGURED' &&
        code !== 'API_UNREACHABLE' &&
        code !== 'API_ROUTE_NOT_FOUND' &&
        code !== 'HTTP_503' &&
        code !== 'HTTP_404'
      ) {
        throw apiErr;
      }
    }

    // Fallback: create via non-persistent Supabase client (works if "Confirm email" is off in Supabase Auth)
    const secClient = createEphemeralSupabaseClient();
    const { data, error } = await secClient.auth.signUp({
      email: cleanEmail,
      password: params.password,
      options: {
        data: {
          full_name: cleanName,
          nip: cleanNip,
        },
      },
    });
    if (error) throw error;
    const newUid = data.user?.id;
    if (!newUid) {
      throw new Error('Gagal mendapatkan UID akun baru dari Supabase Auth.');
    }

    try {
      await Promise.all([
        setDoc(doc(db, 'users', newUid), {
          uid: newUid,
          email: cleanEmail,
          fullName: cleanName,
          nip: cleanNip,
          role: params.role,
          isActive: true,
          phone: cleanPhone,
          specialization: cleanSpec,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
        setDoc(doc(db, 'staff_directory', newUid), {
          uid: newUid,
          fullName: cleanName,
          role: params.role,
          isActive: true,
          updatedAt: serverTimestamp(),
        }),
      ]);
    } catch (err) {
      handleDbError(err, OperationType.CREATE, `users/${newUid}`);
    }
  };

  const adminDeleteAccount = async (targetUid: string) => {
    if (!authUser || userProfile?.role !== 'Administrator') {
      throw new Error('Hanya Administrator yang dapat menghapus akun pengguna.');
    }
    if (targetUid === authUser.uid) {
      throw new Error('Anda tidak dapat menghapus akun Anda sendiri yang sedang aktif.');
    }

    const idToken = await authUser.getIdToken();
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetUid)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    const data = await parseApiJsonResponse<{
      ok?: boolean;
      authDeleted?: boolean;
      error?: string;
      message?: string;
    }>(res, 'Gagal menghapus akun pengguna.');

    if (!data.ok) {
      const err = new Error(data.message || 'Gagal menghapus akun pengguna.') as Error & {
        code?: string;
      };
      err.code = data.error || 'DELETE_USER_FAILED';
      throw err;
    }

    return { authDeleted: Boolean(data.authDeleted) };
  };

  const adminBulkCreateAccounts = async (
    accounts: {
      rowIndex: number;
      fullName: string;
      nip: string;
      email: string;
      password: string;
      role: UserRole;
      phone?: string;
      specialization?: string;
    }[]
  ) => {
    if (!authUser || userProfile?.role !== 'Administrator') {
      throw new Error('Hanya Administrator yang dapat membuat akun massal.');
    }

    const idToken = await authUser.getIdToken();
    const res = await fetch('/api/admin/users/bulk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ accounts }),
    });

    const data = await parseApiJsonResponse<{
      ok?: boolean;
      createdCount?: number;
      failedCount?: number;
      results?: {
        rowIndex: number;
        email: string;
        fullName: string;
        ok: boolean;
        uid?: string;
        error?: string;
      }[];
      error?: string;
      message?: string;
    }>(res, 'Gagal membuat banyak akun staf.');

    return {
      ok: Boolean(data.ok),
      createdCount: data.createdCount || 0,
      failedCount: data.failedCount || 0,
      results: data.results || [],
    };
  };

  // Ensure existing callers like getDoc(doc(db, ...)) never complain unused
  void BOOTSTRAP_ADMIN_EMAILS;
  void getDoc;

  return (
    <AuthContext.Provider
      value={{
        authUser,
        userProfile,
        authReady,
        profileLoading,
        isSupabaseConfigured: IS_SUPABASE_CONFIGURED,
        blockedMessage,
        idleLogoutMessage,
        clearIdleLogoutMessage,
        loginWithEmail,
        resetPassword,
        registerWithEmail,
        loginWithGoogle,
        logout,
        logoutDueToIdle,
        updateOwnProfile,
        changeUserPassword,
        resendVerificationEmail,
        adminCreateAccount,
        adminBulkCreateAccounts,
        adminDeleteAccount,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
