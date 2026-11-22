// Auth, data and file routes that replace Supabase Auth, PostgREST and Storage.
import express from "express";
import rateLimit from "express-rate-limit";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getPool, runAsAdmin, runAsUser, rpcAsUser, withUser } from "./db.js";
import type { QuerySpec } from "../packages/shared/src/lib/queryBuilder.js";
import { signJwt, verifyJwt, type JwtClaims } from "./jwt.js";

const bearer = (req: express.Request): JwtClaims | null => {
  const h = req.headers.authorization;
  if (!h) return null;
  return verifyJwt(h.replace(/^Bearer\s+/i, ""));
};

const requireUser: express.RequestHandler = (req, res, next) => {
  const claims = bearer(req);
  if (!claims) {
    res.status(401).json({ error: { message: "Unauthorized", code: "401" } });
    return;
  }
  (req as any).claims = claims;
  next();
};

// ---------------------------------------------------------------------------
// Object storage (Neon, S3-compatible)
// ---------------------------------------------------------------------------
let s3: S3Client | null = null;
// Env values pasted into dashboards often carry stray spaces, newlines or quotes,
// which silently break the S3 signature.
const env = (name: string) => {
  const v = process.env[name];
  return v ? v.trim().replace(/^["']|["']$/g, "").trim() : undefined;
};
// Region must look like "eu-central-1"; otherwise take it from the endpoint host.
const storageRegion = (endpoint: string) => {
  const r = env("NEON_STORAGE_REGION");
  if (r && /^[a-z]{2}-[a-z]+-\d$/.test(r)) return r;
  return endpoint.match(/\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech/)?.[1] || "eu-central-1";
};
const getS3 = () => {
  if (!s3) {
    // Not AWS_*: Vercel reserves those names for its own runtime credentials,
    // which would silently replace ours and break the signature.
    const endpoint = env("NEON_STORAGE_ENDPOINT");
    const accessKeyId = env("NEON_STORAGE_ACCESS_KEY_ID");
    const secretAccessKey = env("NEON_STORAGE_SECRET_ACCESS_KEY");
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error("Object storage is not configured (NEON_STORAGE_ENDPOINT / NEON_STORAGE_ACCESS_KEY_ID / NEON_STORAGE_SECRET_ACCESS_KEY)");
    }
    s3 = new S3Client({
      region: storageRegion(endpoint),
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
      // Only send checksums when an operation requires them; the newer SDK default
      // (streaming CRC32 trailers) is not accepted by every S3-compatible service.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return s3;
};
const BUCKET = () => env("STORAGE_BUCKET") || "bokra";
const safeKey = (k: string) => {
  const key = k.replace(/^\/+/, "");
  if (!key || key.includes("..") || key.length > 512) throw new Error("Invalid file path");
  return key;
};

export function registerBokraRoutes(app: express.Express) {
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT || 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { message: "محاولات دخول كثيرة. حاول مرة أخرى بعد قليل.", code: "429" } },
  });
  const dataLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });

  // ---- Auth ---------------------------------------------------------------
  app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) {
      return res.status(400).json({ error: { message: "البريد الإلكتروني وكلمة المرور مطلوبان" } });
    }
    try {
      const r = await getPool().query(
        `UPDATE auth.users SET last_sign_in_at = now()
         WHERE lower(email) = $1 AND encrypted_password IS NOT NULL
           AND encrypted_password = extensions.crypt($2, encrypted_password)
         RETURNING id, email`,
        [email, password],
      );
      const user = r.rows[0];
      if (!user) {
        return res.status(400).json({ error: { message: "Invalid login credentials", code: "invalid_credentials" } });
      }
      const { token, claims } = signJwt({ sub: user.id, email: user.email });
      return res.json({
        session: {
          access_token: token,
          token_type: "bearer",
          expires_at: claims.exp,
          user: { id: user.id, email: user.email },
        },
      });
    } catch (e: any) {
      console.error("login error:", e);
      return res.status(500).json({ error: { message: "Login failed" } });
    }
  });

  app.get("/api/auth/user", requireUser, async (req, res) => {
    const claims = (req as any).claims as JwtClaims;
    const r = await getPool().query("SELECT id, email FROM auth.users WHERE id = $1", [claims.sub]);
    if (!r.rows[0]) return res.status(401).json({ error: { message: "User not found" } });
    res.json({ user: r.rows[0] });
  });

  // ---- Data (RLS enforced) --------------------------------------------------
  // Before login the app only needs the public branding from site_settings.
  const PUBLIC_SETTINGS = "id, app_name, logo_url, theme_color, currency, login_title, login_subtitle, support_email, is_finance_module_enabled, is_meetings_module_enabled, is_analytics_module_enabled, is_reports_module_enabled";
  app.post("/api/db", dataLimiter, async (req, res, next) => {
    const spec = req.body as QuerySpec;
    if (!bearer(req) && spec?.table === "site_settings" && spec.action === "select") {
      const result = await runAsAdmin({ table: "site_settings", action: "select", columns: PUBLIC_SETTINGS, single: spec.single ?? null });
      return res.json(result);
    }
    next();
  });

  app.post("/api/db", dataLimiter, requireUser, async (req, res) => {
    const claims = (req as any).claims as JwtClaims;
    const spec = req.body as QuerySpec;
    if (!spec || typeof spec.table !== "string" || typeof spec.action !== "string") {
      return res.status(400).json({ data: null, error: { message: "Invalid query" } });
    }
    const result = await runAsUser(claims, spec);

    // Salaries are visible only to the member themself and to roles allowed to see them.
    if (!result.error && spec.table === "team_members" && result.data) {
      const canSee = await withUser(claims, async (c) =>
        (await c.query("SELECT public.has_permission('view_all_salaries') OR public.is_admin() AS ok")).rows[0]?.ok,
      ).catch(() => false);
      if (!canSee) {
        const scrub = (row: any) =>
          row && row.auth_user_id !== claims.sub ? { ...row, salary: null, hourly_rate: null } : row;
        result.data = Array.isArray(result.data) ? result.data.map(scrub) : scrub(result.data);
      }
    }
    res.status(result.error && result.error.code === "401" ? 401 : 200).json(result);
  });

  app.post("/api/db/rpc", dataLimiter, requireUser, async (req, res) => {
    const claims = (req as any).claims as JwtClaims;
    const fn = String(req.body?.fn || "");
    res.json(await rpcAsUser(claims, fn, req.body?.args || {}));
  });

  // ---- Files ----------------------------------------------------------------
  app.post(
    "/api/storage/upload",
    dataLimiter,
    requireUser,
    express.raw({ type: () => true, limit: "10mb" }),
    async (req, res) => {
      try {
        const key = safeKey(String(req.query.path || ""));
        const contentType = String(req.query.contentType || req.headers["content-type"] || "application/octet-stream");
        // On Vercel the platform may already have read the body; accept Buffer / string forms.
        const raw = req.body as unknown;
        const body = Buffer.isBuffer(raw) ? raw : typeof raw === "string" ? Buffer.from(raw, "binary") : null;
        if (!body || body.length === 0) {
          return res.status(400).json({ data: null, error: { message: "الملف وصل فاضي للسيرفر" } });
        }
        // Upload through a presigned URL (UNSIGNED-PAYLOAD, only host + content-type signed):
        // the same signing path that works for downloads, and immune to body/checksum quirks.
        const url = await getSignedUrl(
          getS3(),
          new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType }),
          { expiresIn: 300 },
        );
        const put = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body });
        if (!put.ok) {
          const text = await put.text();
          const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1] || String(put.status);
          console.error("upload rejected:", put.status, code, "bytes:", body.length, "keyId:", (env("NEON_STORAGE_ACCESS_KEY_ID") || "").slice(0, 14));
          return res.status(502).json({ data: null, error: { message: `Storage rejected the upload (${code})` } });
        }
        res.json({ data: { path: key }, error: null });
      } catch (e: any) {
        console.error("upload error:", e?.name, e?.message, "keyId:", (env("NEON_STORAGE_ACCESS_KEY_ID") || "").slice(0, 14));
        res.status(500).json({ data: null, error: { message: e?.message || "Upload failed" } });
      }
    },
  );

  // Quick config check (no secrets): open /api/storage/health in the browser.
  app.get("/api/storage/health", async (_req, res) => {
    const keyId = env("NEON_STORAGE_ACCESS_KEY_ID") || "";
    const info: Record<string, unknown> = {
      endpoint: env("NEON_STORAGE_ENDPOINT") || null,
      region: env("NEON_STORAGE_ENDPOINT") ? storageRegion(env("NEON_STORAGE_ENDPOINT")!) : null,
      bucket: BUCKET(),
      keyIdPrefix: keyId.slice(0, 14) || null,
      secretLength: (env("NEON_STORAGE_SECRET_ACCESS_KEY") || "").length,
    };
    try {
      const url = await getSignedUrl(getS3(), new ListObjectsV2Command({ Bucket: BUCKET(), MaxKeys: 1 }), { expiresIn: 60 });
      const r = await fetch(url);
      const text = await r.text();
      info.listStatus = r.status;
      info.listCode = r.ok ? "OK" : text.match(/<Code>([^<]+)<\/Code>/)?.[1] || null;
    } catch (e: any) {
      info.error = e?.message;
    }
    res.json(info);
  });

  // Files are served through short-lived signed URLs so <img src> keeps working.
  app.get("/api/storage/object/*key", async (req, res) => {
    try {
      const raw = (req.params as any).key;
      const key = safeKey(Array.isArray(raw) ? raw.join("/") : String(raw || ""));
      const url = await getSignedUrl(getS3(), new GetObjectCommand({ Bucket: BUCKET(), Key: key }), { expiresIn: 3600 });
      res.set("Cache-Control", "private, max-age=3000");
      res.redirect(302, url);
    } catch (e: any) {
      res.status(404).json({ error: { message: e?.message || "Not found" } });
    }
  });

  app.post("/api/storage/remove", dataLimiter, requireUser, async (req, res) => {
    try {
      const paths: string[] = Array.isArray(req.body?.paths) ? req.body.paths : [];
      if (paths.length) {
        await getS3().send(
          new DeleteObjectsCommand({ Bucket: BUCKET(), Delete: { Objects: paths.map((p) => ({ Key: safeKey(p) })) } }),
        );
      }
      res.json({ data: paths.map((p) => ({ name: p })), error: null });
    } catch (e: any) {
      res.status(500).json({ data: null, error: { message: e?.message || "Remove failed" } });
    }
  });
}

/** Can this user manage the given project (task groups etc.)? Admins, manage_projects, the project creator, or a project Manager. */
export async function canManageProject(authHeader: string | undefined, projectId: string | null | undefined): Promise<boolean> {
  const claims = authHeader ? verifyJwt(authHeader.replace(/^Bearer\s+/i, "")) : null;
  if (!claims || !projectId) return false;
  return withUser(claims, async (c) => {
    const r = await c.query(
      `SELECT public.is_admin() OR public.has_permission('manage_projects') OR EXISTS (
         SELECT 1 FROM public.projects p
         WHERE p.id = $1 AND (
           p.creator_id = public.get_current_team_member_id()
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p.members, '[]'::jsonb)) m
                      WHERE (m->>'team_member_id')::int = public.get_current_team_member_id()
                        AND m->>'project_role' = 'Manager'))
       ) AS ok`,
      [projectId],
    );
    return !!r.rows[0]?.ok;
  }).catch(() => false);
}
