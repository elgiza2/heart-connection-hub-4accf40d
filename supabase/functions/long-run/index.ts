import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { handleLongRun, type LongRunPayload } from "./core.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const payload = (await request.json().catch(() => null)) as LongRunPayload | null;
  if (!payload) return json({ error: "Invalid JSON body" }, 400);
  const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? undefined;
  try {
    const result = await handleLongRun({ ...payload, token: payload.token ?? bearer });
    return json(result.body, result.status);
  } catch (error) {
    console.error("long-run", error);
    return json({ error: error instanceof Error ? error.message : "long_run_failed" }, 500);
  }
});