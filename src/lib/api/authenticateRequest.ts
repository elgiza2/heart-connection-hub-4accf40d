import { createClient, type User } from "@supabase/supabase-js";

export interface AuthenticatedRequest {
  user: User;
}

export async function authenticateRequest(request: Request): Promise<AuthenticatedRequest | null> {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!token || !url || !publishableKey) return null;

  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return { user: data.user };
}

export function apiHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowed = new Set(
    [process.env.APP_URL, process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null]
      .filter(Boolean)
      .map(String),
  );
  if (origin?.endsWith(".lovable.app")) allowed.add(origin);
  if (process.env.NODE_ENV !== "production" && origin?.startsWith("http://localhost:")) allowed.add(origin);

  return {
    ...(origin && allowed.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}