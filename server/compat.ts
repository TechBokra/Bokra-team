// Drop-in replacement for the parts of `@supabase/supabase-js` that server.ts uses,
// backed by Neon Postgres. Admin clients bypass RLS (like the old service-role key);
// clients created with a user's Authorization header run under RLS as that user.
import { QueryBuilder } from "../packages/shared/src/lib/queryBuilder.js";
import { getPool, runAsAdmin, runAsUser, rpcAsUser } from "./db.js";
import { verifyJwt, type JwtClaims } from "./jwt.js";

type AuthUser = { id: string; email: string; user_metadata?: Record<string, unknown> };

const err = (message: string, code?: string) => ({ message, code });

async function findUserById(id: string): Promise<AuthUser | null> {
  const r = await getPool().query(
    "SELECT id, email, raw_user_meta_data FROM auth.users WHERE id = $1",
    [id],
  );
  const u = r.rows[0];
  return u ? { id: u.id, email: u.email, user_metadata: u.raw_user_meta_data } : null;
}

const adminAuth = {
  async createUser(attrs: { email: string; password?: string; email_confirm?: boolean; user_metadata?: Record<string, unknown> }) {
    try {
      const r = await getPool().query(
        `INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data)
         VALUES (lower($1), CASE WHEN $2::text IS NULL THEN NULL ELSE extensions.crypt($2::text, extensions.gen_salt('bf', 10)) END, $3::jsonb)
         RETURNING id, email, raw_user_meta_data`,
        [attrs.email, attrs.password ?? null, JSON.stringify(attrs.user_metadata || {})],
      );
      const u = r.rows[0];
      return { data: { user: { id: u.id, email: u.email, user_metadata: u.raw_user_meta_data } }, error: null };
    } catch (e: any) {
      const msg = e?.code === "23505" ? "A user with this email address has already been registered" : e?.message;
      return { data: { user: null }, error: err(msg, e?.code === "23505" ? "email_exists" : e?.code) };
    }
  },

  async updateUserById(id: string, attrs: { email?: string; password?: string; email_confirm?: boolean; user_metadata?: Record<string, unknown> }) {
    try {
      const sets: string[] = ["updated_at = now()"];
      const params: unknown[] = [];
      if (attrs.email) { params.push(attrs.email); sets.push(`email = lower($${params.length})`); }
      if (attrs.password) { params.push(attrs.password); sets.push(`encrypted_password = extensions.crypt($${params.length}::text, extensions.gen_salt('bf', 10))`); }
      if (attrs.user_metadata) { params.push(JSON.stringify(attrs.user_metadata)); sets.push(`raw_user_meta_data = raw_user_meta_data || $${params.length}::jsonb`); }
      params.push(id);
      const r = await getPool().query(
        `UPDATE auth.users SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id, email, raw_user_meta_data`,
        params,
      );
      if (!r.rows[0]) return { data: { user: null }, error: err("User not found", "user_not_found") };
      const u = r.rows[0];
      return { data: { user: { id: u.id, email: u.email, user_metadata: u.raw_user_meta_data } }, error: null };
    } catch (e: any) {
      return { data: { user: null }, error: err(e?.message, e?.code) };
    }
  },

  async listUsers(_opts?: { page?: number; perPage?: number }) {
    try {
      const r = await getPool().query("SELECT id, email, raw_user_meta_data FROM auth.users ORDER BY created_at");
      return {
        data: { users: r.rows.map((u) => ({ id: u.id, email: u.email, user_metadata: u.raw_user_meta_data })) },
        error: null,
      };
    } catch (e: any) {
      return { data: { users: [] }, error: err(e?.message, e?.code) };
    }
  },

  async getUserById(id: string) {
    const user = await findUserById(id);
    return user ? { data: { user }, error: null } : { data: { user: null }, error: err("User not found", "user_not_found") };
  },

  async deleteUser(id: string) {
    try {
      await getPool().query("DELETE FROM auth.users WHERE id = $1", [id]);
      return { data: {}, error: null };
    } catch (e: any) {
      return { data: null, error: err(e?.message, e?.code) };
    }
  },
};

export function createClient(_url?: string, _key?: string, opts?: { global?: { headers?: Record<string, string> }; auth?: unknown }) {
  const authHeader = opts?.global?.headers?.Authorization || opts?.global?.headers?.authorization;
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "") : null;
  const claims: JwtClaims | null = token ? verifyJwt(token) : null;
  const userScoped = authHeader !== undefined;

  const exec = userScoped
    ? (spec: any) => (claims ? runAsUser(claims, spec) : Promise.resolve({ data: null, error: err("Invalid or expired session", "401") }))
    : runAsAdmin;

  return {
    from: (table: string) => new QueryBuilder(exec, table),

    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (!claims) return { data: null, error: err("rpc requires a user session", "401") };
      return rpcAsUser(claims, fn, args);
    },

    auth: {
      async getUser(jwt?: string) {
        const c = jwt ? verifyJwt(jwt) : claims;
        if (!c) return { data: { user: null }, error: err("Invalid or expired token", "401") };
        const user = await findUserById(c.sub);
        if (!user) return { data: { user: null }, error: err("User not found", "user_not_found") };
        return { data: { user }, error: null };
      },
      admin: adminAuth,
    },
  };
}

export type CompatClient = ReturnType<typeof createClient>;
