/**
 * @doc Single server-side auth + rate-limit boundary shared by BOTH the Vercel
 * handlers in `api/` and the Vite dev/preview middlewares in `vite.config.ts`.
 *
 * Production and preview must never diverge again: every protected endpoint —
 * whichever runtime serves it — goes through `guardApiRequest`.
 */
import { authenticateRequest } from "./authenticateRequest";

export interface GuardResult {
  ok: boolean;
  status: number;
  error?: string;
  userId?: string;
  retryAfter?: number;
}

/** Requests per window, per user, per endpoint. */
const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  "deep-research": { limit: 6, windowMs: 60 * 60 * 1000 },
  "web-search": { limit: 120, windowMs: 5 * 60 * 1000 },
  "read-url": { limit: 60, windowMs: 5 * 60 * 1000 },
  "computer-agent": { limit: 30, windowMs: 5 * 60 * 1000 },
  "long-run": { limit: 30, windowMs: 5 * 60 * 1000 },
  "dev-agent": { limit: 60, windowMs: 5 * 60 * 1000 },
  mcp: { limit: 240, windowMs: 5 * 60 * 1000 },
  transcribe: { limit: 60, windowMs: 5 * 60 * 1000 },
  "render-pdf": { limit: 30, windowMs: 5 * 60 * 1000 },
  default: { limit: 180, windowMs: 5 * 60 * 1000 },
};

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function rateLimit(endpoint: string, key: string): { ok: boolean; retryAfter: number } {
  const rule = RATE_LIMITS[endpoint] ?? RATE_LIMITS.default;
  const now = Date.now();
  const id = `${endpoint}:${key}`;
  const bucket = buckets.get(id);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(id, { count: 1, resetAt: now + rule.windowMs });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return { ok: true, retryAfter: 0 };
  }
  bucket.count += 1;
  if (bucket.count > rule.limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Authenticates the caller and applies the endpoint's rate limit.
 * Callers MUST return early when `ok` is false — before any provider call.
 */
export async function guardApiRequest(request: Request, endpoint: string): Promise<GuardResult> {
  const auth = await authenticateRequest(request);
  if (!auth) return { ok: false, status: 401, error: "Unauthorized" };

  const limited = rateLimit(endpoint, auth.user.id || clientIp(request.headers));
  if (!limited.ok) {
    return {
      ok: false,
      status: 429,
      error: "Too many requests. Please slow down and try again shortly.",
      retryAfter: limited.retryAfter,
    };
  }
  return { ok: true, status: 200, userId: auth.user.id };
}

/** JSON error response for a failed guard, including `Retry-After` on 429. */
export function guardResponse(result: GuardResult, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: result.error ?? "Unauthorized" }), {
    status: result.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {}),
      ...headers,
    },
  });
}

/**
 * Node/Connect adapter used by the Vite dev+preview middlewares so they run the
 * exact same guard as the Vercel handlers.
 */
export async function guardNodeRequest(
  req: { headers: Record<string, string | string[] | undefined> },
  endpoint: string,
): Promise<GuardResult> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(","));
  }
  return guardApiRequest(new Request("http://localhost/api", { headers }), endpoint);
}
