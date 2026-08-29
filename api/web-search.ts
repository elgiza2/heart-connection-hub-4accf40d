/** @doc Serverless endpoint powering Deep Research web lookups (keys live in Supabase, never in the client). */
import { webSearch } from "../src/lib/search/webSearchCore";
import { apiHeaders, authenticateRequest } from "../src/lib/api/authenticateRequest";

export const config = { runtime: "nodejs" };

export default async function handler(req: Request): Promise<Response> {
  const headers = apiHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }
  if (!(await authenticateRequest(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  const body = (await req.json().catch(() => null)) as
    | { query?: string; count?: number; offset?: number }
    | null;

  try {
    const data = await webSearch(String(body?.query ?? ""), Number(body?.count ?? 8), Number(body?.offset ?? 0));
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ results: [], error: err instanceof Error ? err.message : "search failed" }),
      { status: 200, headers },
    );
  }
}
