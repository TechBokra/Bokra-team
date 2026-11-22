// Vercel serverless entry: every /api/* request is handled by the Express app.
import { buildApp } from "../server";

const appPromise = buildApp("serverless");

export default async function handler(req: any, res: any) {
  const app = await appPromise;
  return app(req, res);
}
