/** @doc Vercel serverless endpoint powering the in-chat Computer Agent. */
import { handleComputerAgent, type ComputerPayload } from "../src/lib/manus/agentCore";
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
  const payload = (await req.json().catch(() => null)) as ComputerPayload | null;
  const result = await handleComputerAgent(payload);
  return new Response(JSON.stringify(result.body), { status: result.status, headers });
}
