// Auth, data and file routes that replace Supabase Auth, PostgREST and Storage.
import express from "express";
import rateLimit from "express-rate-limit";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getPool, runAsUser, rpcAsUser, withUser } from "./db";
import type { QuerySpec } from "../packages/shared/src/lib/queryBuilder";
import { signJwt, verifyJwt, type JwtClaims } from "./jwt";

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
const getS3 = () => {
  if (!s3) {
    const { AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION } = process.env;
    if (!AWS_ENDPOINT_URL_S3 || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
      throw new Error("Object storage is not configured (AWS_ENDPOINT_URL_S3 / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)");
    }
    s3 = new S3Client({
      region: AWS_REGION || "us-east-1",
      endpoint: AWS_ENDPOINT_URL_S3,
      credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
      forcePathStyle: true,
    });
  }
  return s3;
};
const BUCKET = () => process.env.STORAGE_BUCKET || "bokra";
const safeKey = (k: string) => {
  const key = k.replace(/^\/+/, "");
  if (!key || key.includes("..") || key.length > 512) throw new Error("Invalid file path");
  return key;
};

export function registerBokraRoutes(app: express.Express) {
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
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
        await getS3().send(
          new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: req.body as Buffer, ContentType: contentType }),
        );
        res.json({ data: { path: key }, error: null });
      } catch (e: any) {
        console.error("upload error:", e);
        res.status(500).json({ data: null, error: { message: e?.message || "Upload failed" } });
      }
    },
  );

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
