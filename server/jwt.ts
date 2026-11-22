// Minimal HS256 JWT (no external dependency).
import crypto from "crypto";

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const fromB64url = (s: string) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const getSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET is missing or too short (min 32 chars)");
  }
  return secret;
};

export interface JwtClaims {
  sub: string;
  email: string;
  role: "authenticated";
  iat: number;
  exp: number;
}

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function signJwt(payload: { sub: string; email: string }): { token: string; claims: JwtClaims } {
  const now = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    sub: payload.sub,
    email: payload.email,
    role: "authenticated",
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac("sha256", getSecret()).update(`${header}.${body}`).digest());
  return { token: `${header}.${body}.${sig}`, claims };
}

export function verifyJwt(token: string): JwtClaims | null {
  try {
    const [header, body, sig] = token.split(".");
    if (!header || !body || !sig) return null;
    const expected = crypto.createHmac("sha256", getSecret()).update(`${header}.${body}`).digest();
    const given = fromB64url(sig);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(fromB64url(body).toString("utf8")) as JwtClaims;
    if (!claims.sub || claims.role !== "authenticated") return null;
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
