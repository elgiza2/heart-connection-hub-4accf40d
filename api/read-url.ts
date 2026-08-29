/** @doc Serverless endpoint that returns the readable text of web pages for the Deep Research agent. */
import { readUrls } from "../src/lib/search/readUrlCore";
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
    | { urls?: string[]; maxChars?: number }
    | null;

  try {
    const pages = await readUrls(
      Array.isArray(body?.urls) ? body!.urls!.map(String) : [],
      Number(body?.maxChars ?? 9000),
    );
    return new Response(JSON.stringify({ pages }), { status: 200, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ pages: [], error: err instanceof Error ? err.message : "read failed" }),
      { status: 200, headers },
    );
  }
}
