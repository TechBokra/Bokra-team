// Browser client for the Bokra API (Neon backend).
// It keeps the same surface the app used from supabase-js — from(), auth, storage,
// rpc — so the rest of the code didn't need to change.
import { QueryBuilder, type DbResult, type QuerySpec } from "./queryBuilder";

const SESSION_KEY = "bokra.session.v1";

export interface BokraUser {
  id: string;
  email: string;
}
export interface BokraSession {
  access_token: string;
  token_type: "bearer";
  expires_at: number; // unix seconds
  user: BokraUser;
}
type AuthEvent = "SIGNED_IN" | "SIGNED_OUT" | "INITIAL_SESSION";
type AuthListener = (event: AuthEvent, session: BokraSession | null) => void;

const listeners = new Set<AuthListener>();

const readSession = (): BokraSession | null => {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as BokraSession;
    if (!s?.access_token || !s.expires_at || s.expires_at * 1000 < Date.now()) {
      window.localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
};

const writeSession = (s: BokraSession | null) => {
  try {
    if (s) window.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
};

const emit = (event: AuthEvent, session: BokraSession | null) => {
  listeners.forEach((l) => {
    try {
      l(event, session);
    } catch (e) {
      console.error(e);
    }
  });
};

const handleUnauthorized = () => {
  if (readSession()) {
    writeSession(null);
    emit("SIGNED_OUT", null);
  }
};

export const getAccessToken = () => readSession()?.access_token ?? null;

const authHeaders = (): Record<string, string> => {
  const t = getAccessToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

async function postJson<T = any>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (resp.status === 401) handleUnauthorized();
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { data: null, error: { message: `Unexpected server response (${resp.status})` } } as any;
  }
}

const executeOverHttp = (spec: QuerySpec): Promise<DbResult> =>
  postJson<DbResult>("/api/db", spec).catch((e) => ({ data: null, error: { message: e?.message || "Network error" } }));

export function createBokraClient() {
  return {
    from: (table: string) => new QueryBuilder(executeOverHttp, table),

    rpc: (fn: string, args: Record<string, unknown> = {}) => postJson<DbResult>("/api/db/rpc", { fn, args }),

    auth: {
      async getSession() {
        return { data: { session: readSession() }, error: null };
      },
      async getUser() {
        const s = readSession();
        return { data: { user: s?.user ?? null }, error: null };
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const r = await postJson<{ session?: BokraSession; error?: { message: string } }>("/api/auth/login", {
          email,
          password,
        });
        if (!r.session) {
          return { data: { session: null, user: null }, error: { message: r.error?.message || "Login failed" } };
        }
        writeSession(r.session);
        emit("SIGNED_IN", r.session);
        return { data: { session: r.session, user: r.session.user }, error: null };
      },
      async signOut() {
        writeSession(null);
        emit("SIGNED_OUT", null);
        return { error: null };
      },
      onAuthStateChange(cb: AuthListener) {
        listeners.add(cb);
        return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
      },
    },

    storage: {
      from(bucket: string) {
        const fullKey = (path: string) => `${bucket}/${path.replace(/^\/+/, "")}`;
        return {
          async upload(path: string, file: Blob, opts?: { contentType?: string; upsert?: boolean; cacheControl?: string }) {
            const contentType = opts?.contentType || (file as any)?.type || "application/octet-stream";
            const resp = await fetch(
              `/api/storage/upload?path=${encodeURIComponent(fullKey(path))}&contentType=${encodeURIComponent(contentType)}`,
              { method: "POST", headers: { "Content-Type": contentType, ...authHeaders() }, body: file },
            );
            if (resp.status === 401) handleUnauthorized();
            const json = await resp.json().catch(() => null);
            if (!resp.ok || !json || json.error) {
              return { data: null, error: { message: json?.error?.message || `Upload failed (${resp.status})` } };
            }
            return { data: { path }, error: null };
          },
          getPublicUrl(path: string) {
            const encoded = fullKey(path).split("/").map(encodeURIComponent).join("/");
            return { data: { publicUrl: `${window.location.origin}/api/storage/object/${encoded}` } };
          },
          async remove(paths: string[]) {
            return postJson("/api/storage/remove", { paths: paths.map(fullKey) });
          },
        };
      },
    },

    // Realtime is not used (RealtimeContext is a no-op); kept so old calls don't crash.
    channel: () => ({ on: function () { return this; }, subscribe: () => ({}) }),
    removeChannel: () => Promise.resolve("ok"),
  };
}

export type BokraClient = ReturnType<typeof createBokraClient>;
