/** @doc Vercel serverless proxy for the Anything.com API. */
import { proxyAnythingRequest } from "../src/lib/anything/proxy-core";
import { apiHeaders, authenticateRequest } from "../src/lib/api/authenticateRequest";

export const config = { runtime: "nodejs" };

export default async function handler(req: Request): Promise<Response> {
  const cors = apiHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });
  }
  if (!(await authenticateRequest(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });
  }
  const payload = await req.json().catch(() => null);
  const result = await proxyAnythingRequest(payload, process.env.ANYTHING_API_KEY);
  return new Response(JSON.stringify(result.body), { status: result.status, headers: cors });
}
