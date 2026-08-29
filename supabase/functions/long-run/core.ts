import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface LongRunPayload {
  action?: "start" | "keepalive" | "status" | "stop";
  token?: string;
  goal?: string;
  conversation_id?: string | null;
  run_id?: string;
}

const BU_BASE = Deno.env.get("BROWSER_USE_API_BASE") || "https://api.browser-use.com/api/v2";

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

async function browserUseKey(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from("provider_api_keys")
    .select("api_key")
    .eq("provider", "c")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Computer key lookup failed");
  const key = (data as { api_key?: string } | null)?.api_key?.trim() || Deno.env.get("BROWSER_USE_API_KEY");
  if (!key) throw new Error("Computer provider is not configured yet");
  return key;
}

async function providerFetch(supabase: SupabaseClient, path: string, init: RequestInit = {}) {
  return fetch(`${BU_BASE}${path}`, {
    ...init,
    headers: {
      "X-Browser-Use-API-Key": await browserUseKey(supabase),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

interface ProviderStep {
  number?: number;
  nextGoal?: string | null;
  evaluationPreviousGoal?: string | null;
  url?: string | null;
}

interface ProviderTask {
  id: string;
  sessionId?: string | null;
  status?: string;
  liveUrl?: string | null;
  output?: string | null;
  error?: string | null;
  steps?: ProviderStep[];
}

function mapStatus(status?: string) {
  if (status === "created") return "queued";
  if (status === "paused") return "paused";
  if (status === "finished") return "done";
  if (status === "stopped") return "canceled";
  if (status === "failed") return "error";
  return "running";
}

async function getTask(supabase: SupabaseClient, taskId: string): Promise<ProviderTask | null> {
  const response = await providerFetch(supabase, `/tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) return null;
  const task = (await response.json().catch(() => null)) as ProviderTask | null;
  if (!task) return null;
  if (task.sessionId) {
    const sessionResponse = await providerFetch(
      supabase,
      `/sessions/${encodeURIComponent(task.sessionId)}`,
    ).catch(() => null);
    if (sessionResponse?.ok) {
      const session = (await sessionResponse.json().catch(() => null)) as { liveUrl?: string | null } | null;
      task.liveUrl = session?.liveUrl ?? null;
    }
  }
  return task;
}

async function addEvent(
  supabase: SupabaseClient,
  runId: string,
  title: string,
  type = "log",
  detail?: string | null,
) {
  await supabase.from("long_run_events").insert({ run_id: runId, type, title, detail: detail ?? null });
}

async function syncRun(supabase: SupabaseClient, run: Record<string, unknown>) {
  const externalId = typeof run.external_run_id === "string" ? run.external_run_id : "";
  const currentStatus = typeof run.status === "string" ? run.status : "queued";
  if (!externalId || ["done", "error", "canceled"].includes(currentStatus)) return run;
  const task = await getTask(supabase, externalId);
  if (!task) return run;

  const status = mapStatus(task.status);
  const patch: Record<string, unknown> = {
    status,
    live_view_url: task.liveUrl ?? run.live_view_url ?? null,
    last_heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (status === "running") patch.phase = "working";
  if (status === "done") {
    patch.phase = "finished";
    patch.result = { output: task.output ?? null };
    patch.expires_at = new Date().toISOString();
  }
  if (status === "error") patch.error = task.error || "Task failed";
  await supabase.from("long_runs").update(patch).eq("id", run.id);

  const steps = Array.isArray(task.steps) ? task.steps : [];
  if (steps.length) {
    const { count } = await supabase
      .from("long_run_events")
      .select("id", { count: "exact", head: true })
      .eq("run_id", run.id)
      .eq("type", "thought");
    const already = count ?? 0;
    const fresh = steps.slice(already);
    if (fresh.length) {
      await supabase.from("long_run_events").insert(
        fresh.map((step, index) => ({
          run_id: run.id,
          type: "thought",
          title: step.nextGoal || step.evaluationPreviousGoal || `Step ${already + index + 1}`,
          detail: [step.evaluationPreviousGoal, step.url].filter(Boolean).join(" · ") || null,
        })),
      );
    }
  }
  if (status !== currentStatus) {
    const title = status === "done" ? "Task finished" : status === "error" ? "Task failed" : "Computer is working";
    await addEvent(supabase, String(run.id), title, "status", task.output ?? null);
  }
  return { ...run, ...patch };
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
    const goal = (payload.goal ?? "").trim();
    if (!goal) return { status: 400, body: { error: "Empty goal" } };
    const { data: run, error } = await supabase
      .from("long_runs")
      .insert({
        user_id: user.id,
        conversation_id: payload.conversation_id ?? null,
        goal,
        status: "queued",
        provider: "browser-use",
        status_text: "Starting the computer",
      })
      .select("*")
      .single();
    if (error || !run) return { status: 500, body: { error: error?.message || "Run creation failed" } };

    try {
      const response = await providerFetch(supabase, "/tasks", {
        method: "POST",
        body: JSON.stringify({ task: goal }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const taskId = typeof data.id === "string" ? data.id : "";
      if (!response.ok || !taskId) {
        throw new Error(String(data.detail || data.error || `Provider HTTP ${response.status}`));
      }
      const task = (await getTask(supabase, taskId)) ?? { id: taskId };
      const { data: updated } = await supabase
        .from("long_runs")
        .update({
          status: mapStatus(task.status),
          phase: "working",
          external_run_id: taskId,
          live_view_url: task.liveUrl ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id)
        .select("*")
        .single();
      await addEvent(supabase, run.id, "Computer session started", "status");
      return { status: 200, body: { ok: true, run: updated ?? run } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start task";
      await supabase.from("long_runs").update({ status: "error", error: message }).eq("id", run.id);
      await addEvent(supabase, run.id, "Failed to start", "error", message);
      return { status: 502, body: { error: message } };
    }
  }

  if (payload?.action === "keepalive" || payload?.action === "status") {
    const run = await loadOwnedRun(supabase, user.id, payload.run_id);
    if (!run) return { status: 404, body: { error: "Unknown run" } };
    return { status: 200, body: { ok: true, run: await syncRun(supabase, run) } };
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
      .update({ status: "canceled", expires_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", run.id)
      .select("*")
      .single();
    await addEvent(supabase, run.id, "Task stopped by user", "status");
    return { status: 200, body: { ok: true, run: updated ?? run } };
  }

  return { status: 400, body: { error: "Unknown action" } };
}