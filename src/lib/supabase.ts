import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_PROJECT_ID = 'rpxxzxtorksliubzkhcc';
export const DEFAULT_SUPABASE_URL = `https://${SUPABASE_PROJECT_ID}.supabase.co`;

const rawSupabaseUrl = (import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL).trim();
const rawSupabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const SUPABASE_URL: string = rawSupabaseUrl;
export const SUPABASE_ANON_KEY: string = rawSupabaseAnonKey;
export const IS_SUPABASE_CONFIGURED: boolean = Boolean(rawSupabaseUrl && rawSupabaseAnonKey);

export const ACTIVE_PROJECT_LABEL: string = (() => {
  if (!rawSupabaseUrl) return SUPABASE_PROJECT_ID;
  try {
    return new URL(rawSupabaseUrl).hostname.split('.')[0] || SUPABASE_PROJECT_ID;
  } catch {
    return SUPABASE_PROJECT_ID;
  }
})();

export const BOOTSTRAP_ADMIN_EMAILS = [
  'malilanghaikal3697@gmail.com',
  'muhammadhaikalmalilang@gmail.com',
] as const;

export const BOOTSTRAP_ADMIN_EMAIL = BOOTSTRAP_ADMIN_EMAILS[0];

export function isBootstrapAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return BOOTSTRAP_ADMIN_EMAILS.some((adminEmail) => adminEmail.toLowerCase() === normalized);
}

const sessionStorageAdapter =
  typeof window !== 'undefined' && window.sessionStorage
    ? {
        getItem: (key: string) => window.sessionStorage.getItem(key),
        setItem: (key: string, value: string) => {
          window.sessionStorage.setItem(key, value);
        },
        removeItem: (key: string) => {
          window.sessionStorage.removeItem(key);
        },
      }
    : undefined;

export const supabase: SupabaseClient | null = IS_SUPABASE_CONFIGURED
  ? createClient(rawSupabaseUrl, rawSupabaseAnonKey, {
      auth: {
        storage: sessionStorageAdapter,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    })
  : null;

let currentAuthUser: { uid: string; email: string | null } | null = null;

if (supabase) {
  void supabase.auth.getSession().then(({ data }) => {
    const u = data.session?.user;
    currentAuthUser = u ? { uid: u.id, email: u.email ?? null } : null;
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    const u = session?.user;
    currentAuthUser = u ? { uid: u.id, email: u.email ?? null } : null;
  });
}

export const authCompat = {
  get currentUser() {
    return currentAuthUser;
  },
};

export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      'Konfigurasi Supabase (VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY) belum diisi pada environment variables.'
    );
  }
  return supabase;
}

/**
 * Secondary non-persistent Supabase client for Administrator account provisioning
 * so signing up a staff account never replaces the active Admin session.
 */
export function createEphemeralSupabaseClient(): SupabaseClient {
  if (!IS_SUPABASE_CONFIGURED) {
    throw new Error(
      'Konfigurasi Supabase (VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY) belum diisi.'
    );
  }
  return createClient(rawSupabaseUrl, rawSupabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
