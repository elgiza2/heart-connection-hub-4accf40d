/**
 * Long-run HTTP surface. All the intelligence lives in the shared agent kernel
 * (`_shared/agentkernel`) so the same loop runs from the browser and from cron.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { addEvent, answerRun, providerFetch, startRun, tickRun } from "../_shared/agentkernel/kernel.ts";
import { openQuestion } from "../_shared/agentkernel/questions.ts";

export interface LongRunPayload {
  action?: "start" | "keepalive" | "status" | "stop" | "answer";
  token?: string;
  goal?: string;
  answer?: string;
  budget_ms?: number;
  conversation_id?: string | null;
  run_id?: string;
}

function db() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Server misconfigured");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function getUser(supabase: SupabaseClient, token?: string) {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data.user ? null : data.user;
}

async function loadOwnedRun(supabase: SupabaseClient, userId: string, runId?: string) {
  if (!runId) return null;
  const { data } = await supabase
    .from("long_runs")
    .select("*")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

export async function handleLongRun(payload: LongRunPayload | null) {
  const supabase = db();
  const user = await getUser(supabase, payload?.token);
  if (!user) return { status: 401, body: { error: "Sign in required" } };

  if (payload?.action === "start") {
    return await startRun(supabase, user.id, {
      goal: payload.goal ?? "",
      conversationId: payload.conversation_id ?? null,
      budgetMs: payload.budget_ms,
    });
  }

  if (payload?.action === "keepalive" || payload?.action === "status") {
    const run = await loadOwnedRun(supabase, user.id, payload.run_id);
    if (!run) return { status: 404, body: { error: "Unknown run" } };
    const advanced = await tickRun(supabase, run);
    return {
      status: 200,
      body: { ok: true, run: advanced, question: await openQuestion(supabase, run.id) },
    };
  }

  if (payload?.action === "answer") {
    const run = await loadOwnedRun(supabase, user.id, payload.run_id);
    if (!run) return { status: 404, body: { error: "Unknown run" } };
    const answer = (payload.answer ?? "").trim();
    if (!answer) return { status: 400, body: { error: "Empty answer" } };
    return { status: 200, body: { ok: true, run: await answerRun(supabase, run, answer) } };
  }

  if (payload?.action === "stop") {
    const run = await loadOwnedRun(supabase, user.id, payload.run_id);
    if (!run) return { status: 404, body: { error: "Unknown run" } };
    if (run.external_run_id) {
      await providerFetch(supabase, `/tasks/${encodeURIComponent(run.external_run_id)}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "stop" }),
      }).catch(() => null);
    }
    const { data: updated } = await supabase
      .from("long_runs")
      .update({
        status: "canceled",
        needs_input: false,
        expires_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .select("*")
      .single();
    await supabase
      .from("agent_questions")
      .update({ status: "canceled", updated_at: new Date().toISOString() })
      .eq("run_id", run.id)
      .eq("status", "open");
    await addEvent(supabase, run.id, "Task stopped by user", "status");
    return { status: 200, body: { ok: true, run: updated ?? run } };
  }

  return { status: 400, body: { error: "Unknown action" } };
}
