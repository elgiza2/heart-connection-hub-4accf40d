/**
 * Edge function powering the in-chat Computer Agent (Megsy Computer).
 * Mirrors api/computer-agent.ts so the feature works on Lovable hosting,
 * where Vercel-style serverless functions under api/ are not executed.
 */
import { handleComputerAgent, type ComputerPayload } from "./agentCore.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const payload = (await req.json().catch(() => null)) as ComputerPayload | null;
  if (!payload) return json({ error: "Invalid JSON body" }, 400);

  // The caller's Supabase access token authenticates the request; agentCore
  // verifies it against auth.users before touching any data.
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? undefined;
  const token = payload.token ?? bearer;

  try {
    const result = await handleComputerAgent({ ...payload, token });
    return json(result.body, result.status);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "server_error";
    return json({ error: message }, 500);
  }
});
