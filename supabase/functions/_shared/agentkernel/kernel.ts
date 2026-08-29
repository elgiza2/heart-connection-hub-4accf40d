/**
 * The agent kernel: one loop that behaves like a careful human worker.
 *
 *   recall memory -> plan -> (parallel tools) -> execute -> watch
 *   -> loop detection -> pause & ask when unclear -> self-critique -> learn
 *
 * Every phase is persisted, so the loop is driven server-side by the
 * `agent-tick` cron and survives the user closing the tab. Long runs (hours)
 * checkpoint after every step and are resumed from the last checkpoint when the
 * provider sandbox dies.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { memoryBlock, recallMemory, learnFromRun, remember } from "./memory.ts";
import { fingerprint, loopInstruction, verdictFor } from "./loopGuard.ts";
import { askUser, detectBlock, detectLargeAmount, openQuestion, resolveQuestion } from "./questions.ts";
import { critique, makePlan, savePlanReview } from "./planner.ts";
import { webSearch } from "./tools.ts";
import { type AgentAction, decideNextAction, runTool } from "./executor.ts";

const BU_BASE = Deno.env.get("BROWSER_USE_API_BASE") || "https://api.browser-use.com/api/v2";
const MAX_REVIEW_ROUNDS = 3;
const DEFAULT_BUDGET_MS = 6 * 60 * 60 * 1000;
const MAX_STEPS = 600;
/** How long the user gets to press "Continue" before the agent proceeds itself. */
const PLAN_ACK_MS = 60_000;
/** Tool calls executed per tick, and the wall-clock ceiling for one tick. */
const STEPS_PER_TICK = 6;
const TICK_DEADLINE_MS = 50_000;
/** Announced out loud before the agent grades its own work. */
const REVIEW_TEXT = "دلوقتي بأراجع اللي عملته";


export type RunRow = Record<string, any> & {
  id: string;
  user_id: string;
  goal: string;
};

/* ------------------------------------------------------------------ provider */

export async function browserUseKey(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from("provider_api_keys")
    .select("api_key")
    .eq("provider", "c")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Computer key lookup failed");
  const key =
    (data as { api_key?: string } | null)?.api_key?.trim() || Deno.env.get("BROWSER_USE_API_KEY");
  if (!key) throw new Error("Computer provider is not configured yet");
  return key;
}

export async function providerFetch(
  supabase: SupabaseClient,
  path: string,
  init: RequestInit = {},
) {
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
  screenshotUrl?: string | null;
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

export function mapStatus(status?: string) {
  if (status === "created") return "queued";
  if (status === "paused") return "paused";
  if (status === "finished") return "done";
  if (status === "stopped") return "canceled";
  if (status === "failed") return "error";
  return "running";
}

export async function getTask(
  supabase: SupabaseClient,
  taskId: string,
): Promise<ProviderTask | null> {
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
      const session = (await sessionResponse.json().catch(() => null)) as
        | { liveUrl?: string | null }
        | null;
      task.liveUrl = session?.liveUrl ?? null;
    }
  }
  return task;
}

/* --------------------------------------------------------------- primitives */

export async function addEvent(
  supabase: SupabaseClient,
  runId: string,
  title: string,
  type = "log",
  detail?: string | null,
) {
  await supabase
    .from("long_run_events")
    .insert({ run_id: runId, type, title, detail: detail ?? null });
}

async function notify(
  supabase: SupabaseClient,
  run: RunRow,
  title: string,
  body: string,
): Promise<void> {
  if (run.notified_at) return;
  await supabase.from("notifications").insert({
    user_id: run.user_id,
    title,
    body,
    type: "agent",
    data: { run_id: run.id, goal: run.goal },
  });
  await supabase
    .from("long_runs")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", run.id);
}

async function traceOf(supabase: SupabaseClient, runId: string): Promise<string[]> {
  const { data } = await supabase
    .from("long_run_events")
    .select("title,detail,type")
    .eq("run_id", runId)
    .order("created_at", { ascending: true })
    .limit(300);
  return (data ?? []).map((event: any) =>
    event.detail ? `${event.title} — ${event.detail}` : String(event.title),
  );
}

async function checkpoint(
  supabase: SupabaseClient,
  run: RunRow,
  stepNumber: number,
  print: string,
  lastAction: string,
  state: Record<string, unknown>,
): Promise<void> {
  await supabase.from("agent_checkpoints").insert({
    run_id: run.id,
    user_id: run.user_id,
    step_number: stepNumber,
    fingerprint: print,
    last_action: lastAction.slice(0, 500),
    state,
  });
}

async function lastCheckpoint(supabase: SupabaseClient, runId: string) {
  const { data } = await supabase
    .from("agent_checkpoints")
    .select("*")
    .eq("run_id", runId)
    .order("step_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function planOf(supabase: SupabaseClient, planId?: string | null) {
  if (!planId) return null;
  const { data } = await supabase.from("agent_plans").select("*").eq("id", planId).maybeSingle();
  return data;
}

/* ----------------------------------------------------------- prompt building */

function buildInstruction(args: {
  goal: string;
  memory: string;
  plan: string[];
  research: string;
  extra?: string | null;
  resumeFrom?: string | null;
}): string {
  return [
    args.goal,
    args.plan.length ? `Plan you already agreed on:\n${args.plan.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "",
    args.memory,
    args.research ? `Research gathered before you started:\n${args.research}` : "",
    args.resumeFrom ? `You are resuming an interrupted session. Last known state: ${args.resumeFrom}` : "",
    args.extra ?? "",
    [
      "Rules:",
      "- Never repeat an action that already failed; change method instead.",
      "- If you hit a CAPTCHA, an OTP/2FA prompt, a login wall, a payment confirmation or an irreversible action, STOP and say exactly what you need. Do not guess.",
      "- State clearly at the end whether the goal was achieved, with the evidence you saw.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function createTask(
  supabase: SupabaseClient,
  instruction: string,
  sessionId?: string | null,
): Promise<ProviderTask> {
  const response = await providerFetch(supabase, "/tasks", {
    method: "POST",
    body: JSON.stringify(sessionId ? { task: instruction, sessionId } : { task: instruction }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const taskId = typeof data.id === "string" ? data.id : "";
  if (!response.ok || !taskId) {
    throw new Error(String(data.detail || data.error || `Provider HTTP ${response.status}`));
  }
  return (await getTask(supabase, taskId)) ?? { id: taskId };
}

/* -------------------------------------------------------------------- start */

export async function startRun(
  supabase: SupabaseClient,
  userId: string,
  args: { goal: string; conversationId?: string | null; budgetMs?: number },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const goal = args.goal.trim();
  if (!goal) return { status: 400, body: { error: "Empty goal" } };

  const { data: run, error } = await supabase
    .from("long_runs")
    .insert({
      user_id: userId,
      conversation_id: args.conversationId ?? null,
      goal,
      status: "queued",
      provider: "browser-use",
      phase: "planning",
      status_text: "Thinking about how to do this",
      budget_ms: args.budgetMs ?? DEFAULT_BUDGET_MS,
    })
    .select("*")
    .single();
  if (error || !run) {
    return { status: 500, body: { error: error?.message || "Run creation failed" } };
  }

  try {
    // 1 — memory first, exactly like a human recalling the site.
    const memories = await recallMemory(supabase, userId, goal);
    const memory = memoryBlock(memories);
    if (memories.length) {
      await addEvent(
        supabase,
        run.id,
        `Recalled ${memories.length} thing(s) from previous tasks`,
        "memory",
        memories.slice(0, 6).map((m) => `${m.key}: ${m.value}`).join("\n"),
      );
    }

    // 2 — plan.
    const plan = await makePlan(supabase, run, memory);
    const planText = [
      ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
      plan.success_criteria ? `\nمعيار النجاح: ${plan.success_criteria}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // 3 — blocking ambiguity? ask before burning provider minutes.
    if (plan.clarify) {
      await supabase.from("long_runs").update({ plan_id: plan.id }).eq("id", run.id);
      if (plan.steps.length) await addEvent(supabase, run.id, "الخطة", "plan", planText);
      await askUser(supabase, run, {
        question: plan.clarify,
        reason: "ambiguous_goal",
        sensitive: false,
      });
      const { data: parked } = await supabase
        .from("long_runs")
        .select("*")
        .eq("id", run.id)
        .single();
      return { status: 200, body: { ok: true, run: parked ?? run } };
    }

    // 4 — show the plan and wait for "Continue" — for 60s only, then go ahead.
    await addEvent(
      supabase,
      run.id,
      "دي الخطة اللي هأمشي عليها",
      "plan",
      planText || String(run.goal ?? ""),
    );
    const { data: pending } = await supabase
      .from("long_runs")
      .update({
        plan_id: plan.id,
        kind: plan.kind === "browser" ? "browser" : "agentic",
        status: "paused",
        phase: "plan_review",
        awaiting_plan_ack: true,
        auto_continue_at: new Date(Date.now() + PLAN_ACK_MS).toISOString(),
        status_text: "مستني موافقتك على الخطة (هكمّل تلقائي بعد 60 ثانية)",
        last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .select("*")
      .single();
    return { status: 200, body: { ok: true, run: pending ?? run } };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : "Failed to start task";
    await supabase.from("long_runs").update({ status: "error", error: message }).eq("id", run.id);
    await addEvent(supabase, run.id, "Failed to start", "error", message);
    return { status: 502, body: { error: message } };
  }
}

/* ------------------------------------------------------ plan ack / execution */

/** The user pressed Continue (or the 60s timer expired) — start doing the work. */
export async function beginExecution(
  supabase: SupabaseClient,
  run: RunRow,
  auto = false,
  revisedSteps?: string[],
): Promise<RunRow> {
  const goal = String(run.goal ?? "");
  const plan = await planOf(supabase, run.plan_id);
  let planSteps: string[] = Array.isArray(plan?.steps?.steps) ? plan!.steps.steps : [];
  const planTools: string[] = Array.isArray(plan?.steps?.tools) ? plan!.steps.tools : [];

  // The user edited the checklist before continuing — that wins over the model's.
  if (revisedSteps && revisedSteps.length) {
    planSteps = revisedSteps.slice(0, 20).map((s) => String(s).slice(0, 400));
    if (run.plan_id) {
      await supabase
        .from("agent_plans")
        .update({ steps: { ...(plan?.steps ?? {}), steps: planSteps, edited_by_user: true } })
        .eq("id", run.plan_id);
    }
    await addEvent(supabase, run.id, "عدّلت الخطة", "plan", planSteps.join("\n"));
  }

  const memory = memoryBlock(await recallMemory(supabase, run.user_id, goal));


  await supabase
    .from("long_runs")
    .update({
      awaiting_plan_ack: false,
      auto_continue_at: null,
      status: "running",
      phase: "working",
      status_text: planSteps[0] ?? "بدأت الشغل",
      last_heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id);
  await addEvent(
    supabase,
    run.id,
    auto ? "كمّلت تلقائيًا بعد انتهاء المهلة" : "تمت الموافقة على الخطة — بدأت التنفيذ",
    "status",
  );

  // Independent pre-work the agent asked for in its own plan.
  if (planTools.includes("web_search")) {
    const research = await webSearch(supabase, goal);
    if (research) {
      await addEvent(supabase, run.id, "بحثت قبل البدء", "tool", research.slice(0, 1200));
    }
  }

  const fresh = { ...run, awaiting_plan_ack: false, status: "running", phase: "working" } as RunRow;

  // Coding / integrations / MCP / mixed work runs in the agentic executor.
  if (String(run.kind ?? "agentic") !== "browser") {
    return await tickAgentic(supabase, fresh);
  }

  try {
    const task = await createTask(
      supabase,
      buildInstruction({ goal, memory, plan: planSteps, research: "" }),
    );
    await supabase
      .from("long_runs")
      .update({
        status: mapStatus(task.status),
        external_run_id: task.id,
        live_view_url: task.liveUrl ?? null,
        last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    await addEvent(supabase, run.id, "Computer session started", "status");
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : "Failed to start task";
    await supabase.from("long_runs").update({ status: "error", error: message }).eq("id", run.id);
    await addEvent(supabase, run.id, "Failed to start", "error", message);
  }
  const { data } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
  return (data as RunRow) ?? fresh;
}


/* --------------------------------------------------------------------- tick */

/**
 * One kernel iteration for a single run. Safe to call from the client (status
 * polling) and from cron — it is idempotent and does the same work either way.
 */
export async function tickRun(supabase: SupabaseClient, run: RunRow): Promise<RunRow> {
  const status = typeof run.status === "string" ? run.status : "queued";
  if (["done", "error", "canceled"].includes(status)) return run;
  if (run.needs_input) return run;

  const now = Date.now();
  const startedAt = Date.parse(run.created_at ?? new Date().toISOString());
  const budget = Number(run.budget_ms ?? DEFAULT_BUDGET_MS);
  if (now - startedAt > budget) {
    await finish(supabase, run, "error", "Time budget exhausted");
    return { ...run, status: "error", error: "Time budget exhausted" };
  }

  // Waiting for "Continue": auto-proceed once the 60s window is over. This runs
  // from cron too, so the timer holds even with the tab closed.
  if (run.awaiting_plan_ack) {
    const due = Date.parse(run.auto_continue_at ?? new Date(0).toISOString());
    if (!Number.isFinite(due) || now >= due) return await beginExecution(supabase, run, true);
    return run;
  }

  if (String(run.kind ?? "agentic") !== "browser" && run.phase !== "browser_sub") {
    return await tickAgentic(supabase, run);
  }

  const externalId = typeof run.external_run_id === "string" ? run.external_run_id : "";
  if (!externalId) return run;


  const task = await getTask(supabase, externalId);
  if (!task) {
    // Sandbox is gone — resume from the last checkpoint in a fresh session.
    return await resumeAfterSandboxLoss(supabase, run);
  }

  const mapped = mapStatus(task.status);
  const steps = Array.isArray(task.steps) ? task.steps : [];

  // --- new steps become events + checkpoints -------------------------------
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
        screenshot_url: step.screenshotUrl ?? null,
      })),
    );
  }

  const patch: Record<string, unknown> = {
    status: mapped,
    live_view_url: task.liveUrl ?? run.live_view_url ?? null,
    step_count: steps.length,
    last_heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (mapped === "running") patch.phase = "working";

  const latest = steps[steps.length - 1];
  const latestText = [latest?.nextGoal, latest?.evaluationPreviousGoal, latest?.url]
    .filter(Boolean)
    .join(" · ");
  if (latestText) patch.status_text = (latest?.nextGoal || latestText).slice(0, 240);

  // --- loop detection ------------------------------------------------------
  if (latest && fresh.length) {
    const print = fingerprint([latest.nextGoal, latest.url]);
    const strikes = print && print === run.last_fingerprint ? Number(run.loop_strikes ?? 0) + 1 : 0;
    patch.last_fingerprint = print;
    patch.loop_strikes = strikes;
    await checkpoint(supabase, run, steps.length, print, latestText, {
      url: latest.url ?? null,
      goal: latest.nextGoal ?? null,
      status: mapped,
    });

    const verdict = verdictFor(strikes);
    if (verdict !== "ok") {
      await addEvent(
        supabase,
        run.id,
        `Repeated action detected (${strikes}x) — changing approach`,
        "loop",
        latestText,
      );
      if (verdict === "ask_user") {
        await supabase.from("long_runs").update(patch).eq("id", run.id);
        await remember(supabase, run.user_id, {
          kind: "lesson",
          key: `stuck:${(latest.nextGoal ?? "step").slice(0, 60)}`,
          value: `Got stuck repeating "${latestText}" — needs another route.`,
          source_run_id: run.id,
        });
        await askUser(supabase, run, {
          question: `I'm stuck: "${latest.nextGoal ?? latestText}" keeps failing. How should I proceed?`,
          reason: "loop",
          sensitive: false,
        });
        const { data: parked } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
        return parked ?? { ...run, ...patch };
      }
      await providerFetch(supabase, `/tasks/${encodeURIComponent(externalId)}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "add_follow_up_task", task: loopInstruction(verdict, latestText) }),
      }).catch(() => null);
    }
  }

  // --- pause & ask ---------------------------------------------------------
  const blockText = [latestText, task.output, task.error].filter(Boolean).join(" \n ");
  const block = detectBlock(blockText) ?? detectLargeAmount(blockText);
  if (block) {
    await supabase.from("long_runs").update(patch).eq("id", run.id);
    await providerFetch(supabase, `/tasks/${encodeURIComponent(externalId)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "pause" }),
    }).catch(() => null);
    await askUser(supabase, { id: run.id, user_id: run.user_id }, block);
    await notify(supabase, run, "Your task needs you", block.question);
    const { data: parked } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
    return parked ?? { ...run, ...patch };
  }

  if (steps.length > MAX_STEPS) {
    await supabase.from("long_runs").update(patch).eq("id", run.id);
    await finish(supabase, run, "error", "Step budget exhausted");
    return { ...run, status: "error" };
  }

  // --- provider says finished -> self-critique ----------------------------
  if (mapped === "done" || mapped === "error") {
    // A browser sub-task owned by the agentic loop: hand the result back.
    if (run.phase === "browser_sub") {
      await supabase
        .from("long_runs")
        .update({ ...patch, status: "running", phase: "working", external_run_id: null })
        .eq("id", run.id);
      await addEvent(
        supabase,
        run.id,
        "نتيجة مهمة المتصفح",
        "observation",
        (task.output || task.error || "no output").slice(0, 4000),
      );
      const { data: back } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
      return await tickAgentic(supabase, (back as RunRow) ?? { ...run, ...patch });
    }
    if (mapped === "done") {
      await supabase.from("long_runs").update(patch).eq("id", run.id);
      return await reviewFinished(supabase, { ...run, ...patch }, task);
    }
    patch.error = task.error || "Task failed";
    await supabase.from("long_runs").update(patch).eq("id", run.id);
    await finish(supabase, { ...run, ...patch }, "error", String(patch.error));
    return { ...run, ...patch };
  }


  await supabase.from("long_runs").update(patch).eq("id", run.id);
  if (mapped !== run.status) {
    await addEvent(supabase, run.id, "Computer is working", "status");
  }
  return { ...run, ...patch };
}

/* ----------------------------------------------------------- agentic executor */

const AGENTIC_EVENT_TYPES = ["act", "observation", "tool", "review", "answer"];

async function agenticTranscript(supabase: SupabaseClient, runId: string): Promise<string[]> {
  const { data } = await supabase
    .from("long_run_events")
    .select("type,title,detail,created_at")
    .eq("run_id", runId)
    .in("type", AGENTIC_EVENT_TYPES)
    .order("created_at", { ascending: true })
    .limit(200);
  return (data ?? []).map((event: any) =>
    event.detail ? `[${event.type}] ${event.title} :: ${event.detail}` : `[${event.type}] ${event.title}`,
  );
}

/** Pops the user's queued steering notes (if any) and logs them in the trace. */
async function drainGuidance(supabase: SupabaseClient, run: RunRow): Promise<string> {
  const { data } = await supabase
    .from("long_runs")
    .select("pending_guidance")
    .eq("id", run.id)
    .maybeSingle();
  const queued: string[] = Array.isArray((data as any)?.pending_guidance)
    ? ((data as any).pending_guidance as string[])
    : [];
  if (!queued.length) return "";
  await supabase.from("long_runs").update({ pending_guidance: [] }).eq("id", run.id);
  const text = queued.join("\n");
  await addEvent(supabase, run.id, "استلمت توجيه منك وهمشي عليه", "log", text.slice(0, 800));
  return text;
}


/**
 * One bounded slice of the ReAct loop: think, use a tool, record the
 * observation. Repeats a few times per tick and resumes on the next tick, so a
 * task can run for hours server-side.
 */
export async function tickAgentic(supabase: SupabaseClient, run: RunRow): Promise<RunRow> {
  const deadline = Date.now() + TICK_DEADLINE_MS;
  const goal = String(run.goal ?? "");
  const plan = await planOf(supabase, run.plan_id);
  const planSteps: string[] = Array.isArray(plan?.steps?.steps) ? plan!.steps.steps : [];
  const memory = memoryBlock(await recallMemory(supabase, run.user_id, goal));
  let current: RunRow = run;
  let strikes = Number(run.loop_strikes ?? 0);
  let stepCount = Number(run.step_count ?? 0);

  for (let i = 0; i < STEPS_PER_TICK && Date.now() < deadline; i += 1) {
    if (stepCount > MAX_STEPS) {
      await finish(supabase, current, "error", "Step budget exhausted");
      return { ...current, status: "error" };
    }

    // Mid-run steering: whatever the user queued while we were working gets
    // folded into the very next decision, then cleared.
    const guidance = await drainGuidance(supabase, current);

    const transcript = await agenticTranscript(supabase, current.id);
    const action: AgentAction | null = await decideNextAction(supabase, {
      goal,
      memory,
      plan: planSteps,
      transcript,
      extra:
        [
          guidance ? `The user just steered you mid-run: ${guidance}\nFollow it now.` : null,
          strikes >= 1
            ? "Your last action produced nothing new. Change your approach — different tool, different input."
            : null,
        ]
          .filter(Boolean)
          .join("\n") || null,
    });

    if (!action) {
      await addEvent(supabase, current.id, "مش قدرت أحدد الخطوة الجاية — هجرّب تاني", "log");
      break;
    }

    stepCount += 1;
    await addEvent(
      supabase,
      current.id,
      action.say || action.thought || action.tool,
      "act",
      `${action.tool} ${JSON.stringify(action.input).slice(0, 800)}`,
    );
    await supabase
      .from("long_runs")
      .update({
        status: "running",
        phase: "working",
        step_count: stepCount,
        status_text: (action.say || action.thought || action.tool).slice(0, 240),
        last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", current.id);

    // --- loop detection --------------------------------------------------
    const print = fingerprint([action.tool, JSON.stringify(action.input)]);
    strikes = print && print === current.last_fingerprint ? strikes + 1 : 0;
    await supabase
      .from("long_runs")
      .update({ last_fingerprint: print, loop_strikes: strikes })
      .eq("id", current.id);
    current = { ...current, last_fingerprint: print, loop_strikes: strikes, step_count: stepCount };
    await checkpoint(supabase, current, stepCount, print, `${action.tool}`, {
      tool: action.tool,
      input: action.input,
    });
    if (verdictFor(strikes) === "ask_user") {
      await addEvent(supabase, current.id, `تكرار متكرر (${strikes}x) — محتاج توجيه`, "loop");
      await askUser(supabase, { id: current.id, user_id: current.user_id }, {
        question: `أنا عالق: "${action.tool}" مش بيوصلني لحاجة جديدة. أعمل إيه؟`,
        reason: "loop",
        sensitive: false,
      });
      await notify(supabase, current, "المهمة محتاجاك", "الوكيل عالق ومحتاج توجيه");
      const { data } = await supabase.from("long_runs").select("*").eq("id", current.id).single();
      return (data as RunRow) ?? current;
    }

    // --- control-flow tools ----------------------------------------------
    if (action.tool === "ask_user") {
      await askUser(supabase, { id: current.id, user_id: current.user_id }, {
        question: String(action.input.question ?? "محتاج معلومة منك لأكمل"),
        reason: "agent_request",
        sensitive: Boolean(action.input.sensitive),
      });
      await notify(supabase, current, "المهمة محتاجاك", String(action.input.question ?? ""));
      const { data } = await supabase.from("long_runs").select("*").eq("id", current.id).single();
      return (data as RunRow) ?? current;
    }

    if (action.tool === "remember") {
      await remember(supabase, current.user_id, {
        kind: "user_fact",
        key: String(action.input.key ?? "note").slice(0, 120),
        value: String(action.input.value ?? "").slice(0, 800),
        source_run_id: current.id,
      }).catch(() => null);
      await addEvent(supabase, current.id, "حفظت المعلومة دي للمستقبل", "observation", String(action.input.key ?? ""));
      continue;
    }

    if (action.tool === "browser_task") {
      try {
        const task = await createTask(
          supabase,
          buildInstruction({
            goal: String(action.input.task ?? goal),
            memory,
            plan: [],
            research: "",
            extra: `This is a sub-task of a larger job: ${goal}`,
          }),
        );
        await supabase
          .from("long_runs")
          .update({
            status: mapStatus(task.status),
            phase: "browser_sub",
            external_run_id: task.id,
            live_view_url: task.liveUrl ?? null,
            status_text: "بشغّل المتصفح للجزء ده",
            last_heartbeat_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", current.id);
        await addEvent(supabase, current.id, "سلّمت الجزء ده للمتصفح", "tool", String(action.input.task ?? ""));
      } catch (error) {
        await addEvent(
          supabase,
          current.id,
          "المتصفح مش متاح",
          "observation",
          error instanceof Error ? error.message : null,
        );
        continue;
      }
      const { data } = await supabase.from("long_runs").select("*").eq("id", current.id).single();
      return (data as RunRow) ?? current;
    }

    if (action.tool === "finish") {
      return await reviewAgentic(supabase, current, String(action.input.summary ?? ""));
    }

    // --- real tools -------------------------------------------------------
    const outcome = await runTool(
      supabase,
      { runId: current.id, userId: current.user_id },
      action,
    );
    await addEvent(
      supabase,
      current.id,
      outcome.artifact ? `أنتجت ${outcome.artifact.name}` : `نتيجة ${action.tool}`,
      "observation",
      outcome.observation.slice(0, 4000),
    );
    // Deliverables are collected on the run so the chat can offer them for download.
    if (outcome.artifact) {
      const { data: row } = await supabase
        .from("long_runs")
        .select("result")
        .eq("id", current.id)
        .maybeSingle();
      const result = ((row as any)?.result ?? {}) as Record<string, unknown>;
      const files = Array.isArray(result.files)
        ? (result.files as { name?: string; url: string }[])
        : [];
      if (!files.some((f) => f.url === outcome.artifact!.url)) files.push(outcome.artifact);
      await supabase
        .from("long_runs")
        .update({ result: { ...result, files }, updated_at: new Date().toISOString() })
        .eq("id", current.id);
    }
  }


  const { data } = await supabase.from("long_runs").select("*").eq("id", current.id).single();
  return (data as RunRow) ?? current;
}

/** The announced self-review of an agentic run. */
async function reviewAgentic(
  supabase: SupabaseClient,
  run: RunRow,
  summary: string,
): Promise<RunRow> {
  const round = Number(run.review_round ?? 0) + 1;
  await supabase
    .from("long_runs")
    .update({ phase: "reviewing", status_text: REVIEW_TEXT, updated_at: new Date().toISOString() })
    .eq("id", run.id);
  await addEvent(supabase, run.id, REVIEW_TEXT, "status", summary || null);

  const plan = await planOf(supabase, run.plan_id);
  const planSteps: string[] = Array.isArray(plan?.steps?.steps) ? plan!.steps.steps : [];
  const review = await critique(supabase, {
    goal: String(run.goal ?? ""),
    steps: planSteps,
    successCriteria: plan?.steps?.success_criteria ?? null,
    trace: await agenticTranscript(supabase, run.id),
    output: summary || null,
    round,
  });
  await savePlanReview(supabase, String(run.plan_id ?? ""), round, review);
  await addEvent(supabase, run.id, `مراجعة ذاتية: ${review.verdict}`, "review", review.critique);
  await supabase.from("long_runs").update({ review_round: round }).eq("id", run.id);

  if (review.verdict === "ask" && review.question) {
    await askUser(supabase, { id: run.id, user_id: run.user_id }, {
      question: review.question,
      reason: "review",
      sensitive: false,
    });
    await notify(supabase, run, "المهمة محتاجاك", review.question);
    const { data } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
    return (data as RunRow) ?? run;
  }

  if (review.verdict === "retry" && round <= MAX_REVIEW_ROUNDS) {
    await addEvent(
      supabase,
      run.id,
      "المراجعة كشفت نقص — برجع أكمّل صح",
      "answer",
      [review.critique, review.fix_instruction].filter(Boolean).join("\n"),
    );
    await supabase
      .from("long_runs")
      .update({
        status: "running",
        phase: "working",
        status_text: "بصلّح اللي ناقص",
        loop_strikes: 0,
        last_fingerprint: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    const { data } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
    return (data as RunRow) ?? { ...run, review_round: round };
  }

  await finish(supabase, { ...run, review_round: round }, "done", null, summary, review.critique);
  const { data } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
  return (data as RunRow) ?? run;
}



/* --------------------------------------------------------- review / finish */

async function reviewFinished(
  supabase: SupabaseClient,
  run: RunRow,
  task: ProviderTask,
): Promise<RunRow> {
  const plan = await planOf(supabase, run.plan_id);
  const planSteps: string[] = Array.isArray(plan?.steps?.steps) ? plan!.steps.steps : [];
  const round = Number(run.review_round ?? 0) + 1;
  const trace = await traceOf(supabase, run.id);
  const output = task.output ?? null;

  // Say it out loud before grading itself.
  await supabase
    .from("long_runs")
    .update({ phase: "reviewing", status_text: REVIEW_TEXT, updated_at: new Date().toISOString() })
    .eq("id", run.id);
  await addEvent(supabase, run.id, REVIEW_TEXT, "status", output);



  const review = await critique(supabase, {
    goal: String(run.goal ?? ""),
    steps: planSteps,
    successCriteria: plan?.steps?.success_criteria ?? null,
    trace,
    output,
    round,
  });
  await savePlanReview(supabase, String(run.plan_id ?? ""), round, review);
  await addEvent(supabase, run.id, `Self-review: ${review.verdict}`, "review", review.critique);

  if (review.verdict === "ask" && review.question) {
    await supabase.from("long_runs").update({ review_round: round }).eq("id", run.id);
    await askUser(supabase, { id: run.id, user_id: run.user_id }, {
      question: review.question,
      reason: "review",
      sensitive: false,
    });
    await notify(supabase, run, "Your task needs you", review.question);
    const { data: parked } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
    return parked ?? run;
  }

  if (review.verdict === "retry" && round <= MAX_REVIEW_ROUNDS) {
    const memory = memoryBlock(await recallMemory(supabase, run.user_id, String(run.goal ?? "")));
    const instruction = buildInstruction({
      goal: String(run.goal ?? ""),
      memory,
      plan: planSteps,
      research: "",
      extra: [
        "Your previous attempt did NOT actually achieve the goal.",
        `Review: ${review.critique}`,
        review.fix_instruction ? `Do this differently: ${review.fix_instruction}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    try {
      const next = await createTask(supabase, instruction);
      await supabase
        .from("long_runs")
        .update({
          status: mapStatus(next.status),
          phase: "working",
          review_round: round,
          external_run_id: next.id,
          live_view_url: next.liveUrl ?? null,
          status_text: "Fixing what was missed",
          loop_strikes: 0,
          last_fingerprint: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      await addEvent(supabase, run.id, "Retrying to finish the job properly", "status", review.critique);
      const { data: retried } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
      return retried ?? run;
    } catch {
      /* fall through to accepting the result */
    }
  }

  await finish(supabase, { ...run, review_round: round }, "done", null, output, review.critique);
  const { data: finished } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
  return finished ?? run;
}

async function finish(
  supabase: SupabaseClient,
  run: RunRow,
  status: "done" | "error",
  error: string | null,
  output?: string | null,
  reviewNote?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  // Keep any artifacts produced during the run attached to the final result.
  const { data: latest } = await supabase
    .from("long_runs")
    .select("result")
    .eq("id", run.id)
    .maybeSingle();
  const previous = (((latest as any)?.result ?? run.result) ?? {}) as Record<string, unknown>;
  const files = Array.isArray(previous.files) ? previous.files : [];
  await supabase
    .from("long_runs")
    .update({
      status,
      phase: "finished",
      review_round: run.review_round ?? 0,
      result:
        status === "done"
          ? { output: output ?? null, review: reviewNote ?? null, files }
          : files.length
            ? { ...previous, files }
            : run.result ?? null,

      error,
      status_text: status === "done" ? "Task completed" : "Task failed",
      expires_at: now,
      updated_at: now,
    })
    .eq("id", run.id);
  await addEvent(
    supabase,
    run.id,
    status === "done" ? "Task finished" : "Task failed",
    status === "done" ? "status" : "error",
    error ?? output ?? null,
  );
  await notify(
    supabase,
    run,
    status === "done" ? "Task finished" : "Task failed",
    String(run.goal ?? "").slice(0, 160),
  );
  // Learn from the run whichever way it went.
  const trace = await traceOf(supabase, run.id);
  await learnFromRun(
    supabase,
    run.user_id,
    run.id,
    String(run.goal ?? ""),
    trace,
    status === "done" ? `success: ${output ?? ""}` : `failure: ${error ?? ""}`,
  ).catch(() => null);
}

/* ------------------------------------------------------- sandbox resilience */

async function resumeAfterSandboxLoss(supabase: SupabaseClient, run: RunRow): Promise<RunRow> {
  const generation = Number(run.sandbox_generation ?? 0) + 1;
  if (generation > 12) {
    await finish(supabase, run, "error", "Lost the browser session too many times");
    return { ...run, status: "error" };
  }
  const point = await lastCheckpoint(supabase, run.id);
  const memory = memoryBlock(await recallMemory(supabase, run.user_id, String(run.goal ?? "")));
  const plan = await planOf(supabase, run.plan_id);
  const planSteps: string[] = Array.isArray(plan?.steps?.steps) ? plan!.steps.steps : [];
  try {
    const task = await createTask(
      supabase,
      buildInstruction({
        goal: String(run.goal ?? ""),
        memory,
        plan: planSteps,
        research: "",
        resumeFrom: point
          ? `step ${point.step_number} — ${point.last_action ?? ""} (url: ${(point.state as any)?.url ?? "unknown"})`
          : null,
      }),
    );
    await supabase
      .from("long_runs")
      .update({
        status: mapStatus(task.status),
        external_run_id: task.id,
        live_view_url: task.liveUrl ?? null,
        sandbox_generation: generation,
        status_text: "Resuming after the browser restarted",
        loop_strikes: 0,
        last_fingerprint: null,
        last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    await addEvent(supabase, run.id, "Browser session restarted — resuming from last checkpoint", "status");
    const { data } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
    return data ?? run;
  } catch (error) {
    await addEvent(
      supabase,
      run.id,
      "Could not restart the browser session",
      "error",
      error instanceof Error ? error.message : null,
    );
    return run;
  }
}

/* -------------------------------------------------------------- answer flow */

/** The user answered the open question — feed it back and continue. */
export async function answerRun(
  supabase: SupabaseClient,
  run: RunRow,
  answer: string,
): Promise<RunRow> {
  const question = await openQuestion(supabase, run.id);
  if (!question) return run;
  await resolveQuestion(supabase, question.id, run.id, answer);
  await addEvent(supabase, run.id, "You answered", "answer", answer.slice(0, 400));

  if (!question.sensitive) {
    await remember(supabase, run.user_id, {
      kind: "preference",
      key: `answer:${String(question.reason ?? "general").slice(0, 40)}`,
      value: `When asked "${String(question.question).slice(0, 120)}" the user said: ${answer.slice(0, 200)}`,
      source_run_id: run.id,
    }).catch(() => null);
  }

  // Agentic runs continue inside their own loop with the answer in the transcript.
  if (String(run.kind ?? "agentic") !== "browser" && run.phase !== "browser_sub") {
    await supabase
      .from("long_runs")
      .update({
        status: "running",
        phase: run.awaiting_plan_ack ? "plan_review" : "working",
        status_text: "بكمّل بعد ردّك",
        loop_strikes: 0,
        last_fingerprint: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    const { data: resumedRun } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
    const next = (resumedRun as RunRow) ?? run;
    return next.awaiting_plan_ack
      ? await beginExecution(supabase, next)
      : await tickAgentic(supabase, next);
  }

  const externalId = typeof run.external_run_id === "string" ? run.external_run_id : "";
  const followUp = `The user answered your question: ${answer}\nContinue the task from where you stopped.`;



  if (externalId) {
    const resumed = await providerFetch(supabase, `/tasks/${encodeURIComponent(externalId)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "resume" }),
    }).catch(() => null);
    await providerFetch(supabase, `/tasks/${encodeURIComponent(externalId)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "add_follow_up_task", task: followUp }),
    }).catch(() => null);
    if (resumed?.ok) {
      await supabase
        .from("long_runs")
        .update({ status: "running", status_text: "Continuing", updated_at: new Date().toISOString() })
        .eq("id", run.id);
      const { data } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
      return data ?? run;
    }
  }

  // No live session (e.g. clarification asked before execution) — start now.
  const plan = await planOf(supabase, run.plan_id);
  const planSteps: string[] = Array.isArray(plan?.steps?.steps) ? plan!.steps.steps : [];
  const memory = memoryBlock(await recallMemory(supabase, run.user_id, String(run.goal ?? "")));
  try {
    const task = await createTask(
      supabase,
      buildInstruction({
        goal: String(run.goal ?? ""),
        memory,
        plan: planSteps,
        research: "",
        extra: `The user clarified: ${answer}`,
      }),
    );
    await supabase
      .from("long_runs")
      .update({
        status: mapStatus(task.status),
        phase: "working",
        external_run_id: task.id,
        live_view_url: task.liveUrl ?? null,
        status_text: planSteps[0] ?? "Working",
        last_heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id);
  } catch (error) {
    await addEvent(
      supabase,
      run.id,
      "Could not continue after your answer",
      "error",
      error instanceof Error ? error.message : null,
    );
  }
  const { data } = await supabase.from("long_runs").select("*").eq("id", run.id).single();
  return data ?? run;
}

/** Cron entry point: advance every live run, oldest heartbeat first. */
export async function tickAllRuns(supabase: SupabaseClient, limit = 25): Promise<number> {
  const { data } = await supabase
    .from("long_runs")
    .select("*")
    .in("status", ["queued", "running", "paused"])
    .eq("needs_input", false)
    .order("last_heartbeat_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  const runs = (data ?? []) as RunRow[];
  for (const run of runs) {
    try {
      await tickRun(supabase, run);
    } catch (error) {
      console.error(`tick failed for run ${run.id}`, error);
    }
  }
  return runs.length;
}
