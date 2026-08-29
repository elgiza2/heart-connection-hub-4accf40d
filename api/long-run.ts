/** @doc Serverless endpoint powering long-running (20h+) computer sessions. */
import { handleLongRun, type LongRunPayload } from "../src/lib/longrun/core";
import { apiHeaders, authenticateRequest } from "../src/lib/api/authenticateRequest";

export const config = { runtime: "nodejs", maxDuration: 300 };

export default async function handler(req: Request): Promise<Response> {
  const headers = apiHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }
  if (!(await authenticateRequest(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }
  const payload = (await req.json().catch(() => null)) as LongRunPayload | null;
  try {
    const result = await handleLongRun(payload);
    return new Response(JSON.stringify(result.body), { status: result.status, headers });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "long run failed" }),
      { status: 500, headers },
    );
  }
}
