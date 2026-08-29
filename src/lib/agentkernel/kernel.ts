/**
 * @doc In-tab fallback for the agent kernel.
 *
 * The real kernel lives in the `long-run` edge function and keeps running with
 * the tab closed. When that function can't be reached, this module drives the
 * exact same rows (`long_runs`, `long_run_events`, `agent_questions`,
 * `agent_memory`) from the browser, so the UI, plan gate, questions, trace and
 * artifacts all behave identically — the only difference is that progress
 * happens while the tab is open, and resumes from the database when it reopens.
 */
import { supabase } from "@/integrations/supabase/client";
import type { LongRun } from "@/lib/longrun/types";
import { loginIdentityFor } from "./credentials";
import { listMail } from "@/lib/mail/mailClient";
import { askJson, askModel } from "./llm";
import {
  fetchUrl,
  filesToArtifacts,
  readFile,
  runCode,
  writeFile,
  type ToolContext,
} from "./tools";


const AUTO_CONTINUE_MS = 60_000;
const MAX_ACTIONS_PER_TICK = 6;
const TICK_DEADLINE_MS = 40_000;
const MAX_STEPS = 600;
const MAX_REVIEW_ROUNDS = 3;
const DEFAULT_BUDGET_MS = 6 * 60 * 60 * 1000;

/** Tools whose arguments must never be echoed into the public trace. */
const REDACTED_TOOLS = new Set(["remember"]);

const ticking = new Set<string>();
const fileCache = new Map<string, ToolContext>();

type RunRow = LongRun & { result: any };

function ctxFor(run: RunRow): ToolContext {
  let ctx = fileCache.get(run.id);
  if (!ctx) {
    ctx = { files: new Map<string, string>() };
    const saved = Array.isArray(run.result?.files) ? run.result.files : [];
    for (const f of saved) {
      if (f && typeof f.path === "string" && typeof f.content === "string") {
        ctx.files.set(f.path, f.content);
      }
    }
    fileCache.set(run.id, ctx);
  }
  return ctx;
}

async function loadRun(runId: string): Promise<RunRow | null> {
  const { data } = await supabase.from("long_runs").select("*").eq("id", runId).maybeSingle();
  return (data as unknown as RunRow) ?? null;
}

async function patch(runId: string, fields: Record<string, unknown>): Promise<RunRow | null> {
  const { data } = await supabase
    .from("long_runs")
    .update({ ...fields, last_heartbeat_at: new Date().toISOString() })
    .eq("id", runId)
    .select("*")
    .maybeSingle();
  return (data as unknown as RunRow) ?? null;
}

async function event(runId: string, type: string, title: string, detail?: string) {
  await supabase
    .from("long_run_events")
    .insert({ run_id: runId, type, title, detail: detail ?? null } as never);
}

async function recallMemory(userId: string): Promise<string> {
  const { data } = await supabase
    .from("agent_memory")
    .select("content")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(20);
  const lines = (data ?? [])
    .map((r) => (r as { content?: string }).content)
    .filter((c): c is string => !!c);
  return lines.length ? `Things you already learned:\n- ${lines.join("\n- ")}` : "";
}

async function remember(userId: string, content: string) {
  await supabase
    .from("agent_memory")
    .insert({ user_id: userId, kind: "user_fact", content } as never);
}

/* ------------------------------------------------------------------ planning */

interface Plan {
  steps: string[];
  risk: "low" | "medium" | "high";
}

const PLAN_SYSTEM = `You plan a task an autonomous agent will execute in the user's browser.
Available tools: run_code (sandboxed JS), fetch_url (read a public page as text),
write_file / read_file (task workspace), remember (save a durable fact),
ask_user (pause and ask), finish (deliver the result).
Reply with JSON only: {"steps":["...", "..."],"risk":"low|medium|high"}
3 to 8 short imperative steps, in the same language the user used.
risk is "high" when the task involves payments, deletions, sending messages on the
user's behalf, or credentials; "medium" when it changes data the user owns; else "low".`;

async function makePlan(goal: string, memory: string): Promise<Plan> {
  const parsed = await askJson<{ steps?: unknown; risk?: unknown }>(PLAN_SYSTEM, [
    { role: "user", content: memory ? `${memory}\n\nTask: ${goal}` : `Task: ${goal}` },
  ]);
  const steps = Array.isArray(parsed?.steps)
    ? parsed!.steps.map((s) => String(s)).filter(Boolean).slice(0, 8)
    : [];
  const risk =
    parsed?.risk === "high" || parsed?.risk === "medium" ? parsed.risk : ("low" as const);
  return {
    steps: steps.length ? steps : ["افهم المطلوب", "نفّذ المهمة خطوة بخطوة", "راجع النتيجة وسلّمها"],
    risk,
  };
}

/** Deterministic risk floor — the model can raise risk but never lower it. */
function riskFloor(goal: string): "low" | "high" {
  const sensitive =
    /(payment|pay\b|checkout|purchase|شراء|ادفع|الدفع|delete|حذف|امسح|password|كلمة السر|otp|verification code|كود التحقق|transfer|تحويل|send email|ابعت|invoice)/i;
  return sensitive.test(goal) ? "high" : "low";
}

/* ------------------------------------------------------------------ executing */

const EXEC_SYSTEM = `You are an autonomous agent executing a task end to end, like a senior human operator.
Pick exactly ONE next action and reply with JSON only:
{"thought":"one short sentence","tool":"run_code|fetch_url|login_identity|check_mail|write_file|read_file|remember|ask_user|finish","args":{...}}
Args by tool:
- run_code: {"code":"async JS; console.log results"}
- fetch_url: {"url":"https://..."}
- login_identity: {"site":"example.com","url":"https://example.com/signup"}
  -> returns the user's own Megsy email plus a clean strong password, already saved
     in Settings > Passwords. ALWAYS use this to sign up or sign in to any site.
- check_mail: {"query":"verification"} -> reads the newest messages in that Megsy
  mailbox, so you can pull confirmation links and verification codes yourself.
- write_file: {"path":"report.md","content":"..."}
- read_file: {"path":"report.md"}
- remember: {"content":"durable fact about the user or the task"}
- ask_user: {"question":"...","reason":"...","sensitive":true|false}
- finish: {"summary":"what you delivered, in the user's language"}

How you behave:
- NEVER ask the user for an email or a password: call login_identity and use it.
- When something blocks you (error page, dead selector, rate limit, missing data),
  do NOT stop the task. Think it through in "thought": name the obstacle, then take a
  DIFFERENT action towards the same goal — another URL, another source, another method.
- Only ask_user for things no software can do for you: a CAPTCHA you cannot pass, a
  2FA code that never lands in the mailbox, a payment, or an irreversible action.
- Deliver real artifacts with write_file when the task produces a document or code.
- Call finish only when the task is genuinely complete, with evidence in the log.`;

interface Action {
  thought?: string;
  tool?: string;
  args?: Record<string, any>;
}

async function nextAction(run: RunRow, memory: string): Promise<Action | null> {
  const plan: string[] = Array.isArray(run.result?.plan) ? run.result.plan : [];
  const transcript: string[] = Array.isArray(run.result?.transcript) ? run.result.transcript : [];
  const guidance = [...(run.pending_steering ?? []), ...(run.pending_guidance ?? [])];
  const directive: string | null = run.result?.supervisor ?? null;
  const context = [
    memory,
    `Task: ${run.goal}`,
    plan.length ? `Plan:\n- ${plan.join("\n- ")}` : "",
    directive ? `Supervisor directive (follow it):\n${directive}` : "",
    guidance.length ? `New instructions from the user:\n- ${guidance.join("\n- ")}` : "",
    transcript.length ? `Progress so far:\n${transcript.slice(-16).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return askJson<Action>(EXEC_SYSTEM, [{ role: "user", content: context }]);
}

/* ----------------------------------------------------------------- supervisor */

const SUPERVISOR_SYSTEM = `You are the supervising agent of a worker agent running a long task.
You never execute anything yourself; you keep the worker moving for hours without stalling.
Read the task and the recent log, then reply with JSON only:
{"keep_going":true|false,"directive":"one or two concrete sentences telling the worker exactly what to do next, in the user's language"}
keep_going=false ONLY when the task is verifiably complete or a human decision is truly required.
If the worker is repeating itself, stuck on an obstacle, or drifting, order a concrete different approach.`;

/** Asks the supervisor for a directive; injected into the worker's next prompt. */
async function superviseRun(run: RunRow): Promise<{ keep_going: boolean; directive: string } | null> {
  const transcript: string[] = Array.isArray(run.result?.transcript) ? run.result.transcript : [];
  const parsed = await askJson<{ keep_going?: boolean; directive?: unknown }>(SUPERVISOR_SYSTEM, [
    {
      role: "user",
      content: [
        `Task: ${run.goal}`,
        `Steps so far: ${run.step_count ?? 0}`,
        `Recent log:\n${transcript.slice(-20).join("\n") || "(nothing yet)"}`,
      ].join("\n\n"),
    },
  ]);
  if (!parsed) return null;
  const directive = String(parsed.directive ?? "").slice(0, 500);
  return { keep_going: parsed.keep_going !== false, directive };
}

/** Blockers a human really has to handle — everything else the agent solves itself. */
function needsHuman(text: string): boolean {
  return /(captcha|كابتشا|recaptcha|2fa|two-factor|otp|كود التحقق|verification code|payment|credit card|بطاقة|ادفع|الدفع|refund|delete account|حذف الحساب)/i.test(
    text,
  );
}


/* -------------------------------------------------------------------- public */

export async function startRun(
  goal: string,
  conversationId: string | null,
  budgetMs?: number,
): Promise<RunRow | null> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("سجّل الدخول أولاً لتشغيل المهام");

  const { data: inserted, error } = await supabase
    .from("long_runs")
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      kind: "agentic",
      goal,
      status: "paused",
      phase: "plan_review",
      status_text: "بأجهّز الخطة…",
      provider: "in_tab",
      budget_ms: budgetMs ?? DEFAULT_BUDGET_MS,
      step_count: 0,
      review_round: 0,
    } as never)
    .select("*")
    .maybeSingle();
  if (error || !inserted) throw new Error(error?.message ?? "مش قادر أبدأ المهمة");
  const run = inserted as unknown as RunRow;

  const memory = await recallMemory(userId);
  const plan = await makePlan(goal, memory);
  const risk = riskFloor(goal) === "high" ? "high" : plan.risk;
  const autoAllowed = risk === "low";

  await event(run.id, "plan", "الخطة", plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
  return patch(run.id, {
    status: "paused",
    phase: "plan_review",
    status_text: autoAllowed ? "الخطة جاهزة — هكمل تلقائيًا" : "الخطة جاهزة — محتاج موافقتك",
    awaiting_plan_ack: true,
    auto_continue_allowed: autoAllowed,
    auto_continue_at: autoAllowed
      ? new Date(Date.now() + AUTO_CONTINUE_MS).toISOString()
      : null,
    risk_level: risk,
    result: { ...(run.result ?? {}), plan: plan.steps, transcript: [] },
  });
}

export async function approvePlan(runId: string, planSteps?: string[]): Promise<RunRow | null> {
  const run = await loadRun(runId);
  if (!run) return null;
  const steps = planSteps?.length ? planSteps : run.result?.plan ?? [];
  await event(runId, "step", "بدأت التنفيذ");
  return patch(runId, {
    status: "running",
    phase: "executing",
    status_text: "بنفّذ…",
    awaiting_plan_ack: false,
    auto_continue_at: null,
    result: { ...(run.result ?? {}), plan: steps },
  });
}

export async function answer(runId: string, text: string): Promise<RunRow | null> {
  const run = await loadRun(runId);
  if (!run) return null;
  const { data: open } = await supabase
    .from("agent_questions")
    .select("id, sensitive, question")
    .eq("run_id", runId)
    .eq("status", "open")
    .order("asked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const q = open as { id?: string; sensitive?: boolean; question?: string } | null;
  if (q?.id) {
    await supabase
      .from("agent_questions")
      .update({ answer: text, status: "answered" } as never)
      .eq("id", q.id);
  }
  const transcript: string[] = Array.isArray(run.result?.transcript) ? run.result.transcript : [];
  transcript.push(
    `USER answered${q?.question ? ` "${q.question}"` : ""}: ${q?.sensitive ? "[provided privately]" : text}`,
  );
  return patch(runId, {
    status: "running",
    phase: "executing",
    status_text: "كمّلت بعد ردك",
    needs_input: false,
    result: { ...(run.result ?? {}), transcript },
  });
}

export async function guide(runId: string, text: string): Promise<RunRow | null> {
  const run = await loadRun(runId);
  if (!run) return null;
  const queue = [...(run.pending_guidance ?? []), text];
  return patch(runId, { pending_guidance: queue });
}

export async function steer(runId: string, text: string): Promise<RunRow | null> {
  const run = await loadRun(runId);
  if (!run) return null;
  const queue = [...(run.pending_steering ?? []), text];
  return patch(runId, { pending_steering: queue });
}

export async function softStop(runId: string): Promise<RunRow | null> {
  await event(runId, "step", "طلب إيقاف بعد الخطوة الحالية");
  return patch(runId, { stop_requested: true, status_text: "بأنهي الخطوة الحالية وأوقف…" });
}

export async function stop(runId: string): Promise<RunRow | null> {
  fileCache.delete(runId);
  await event(runId, "step", "المهمة أُوقفت");
  return patch(runId, { status: "canceled", phase: "stopped", status_text: "أوقفتها" });
}

/**
 * Advances the run. Safe to call repeatedly (the UI polls it); overlapping calls
 * for the same run are dropped, and every step is persisted before returning so
 * closing the tab loses at most the step in flight.
 */
export async function tick(runId: string): Promise<RunRow | null> {
  if (ticking.has(runId)) return loadRun(runId);
  ticking.add(runId);
  try {
    let run = await loadRun(runId);
    if (!run) return null;

    if (run.status === "done" || run.status === "error" || run.status === "canceled") return run;

    if (run.stop_requested) return stop(runId);

    // Plan gate: low-risk plans continue by themselves once the timer elapses.
    if (run.awaiting_plan_ack) {
      const due = run.auto_continue_at ? Date.parse(run.auto_continue_at) : NaN;
      if (run.auto_continue_allowed && Number.isFinite(due) && Date.now() >= due) {
        run = (await approvePlan(runId)) ?? run;
      } else {
        return run;
      }
    }

    if (run.needs_input) return run;

    const started = Date.parse(run.created_at);
    const budget = run.budget_ms ?? DEFAULT_BUDGET_MS;
    if (Number.isFinite(started) && Date.now() - started > budget) {
      return fail(runId, "خلصت الميزانية الزمنية للمهمة قبل ما تكمل");
    }
    if ((run.step_count ?? 0) >= MAX_STEPS) {
      return fail(runId, "وصلت للحد الأقصى للخطوات");
    }

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return run;
    const memory = await recallMemory(userId);
    const ctx = ctxFor(run);
    const deadline = Date.now() + TICK_DEADLINE_MS;

    for (let i = 0; i < MAX_ACTIONS_PER_TICK && Date.now() < deadline; i++) {
      run = (await loadRun(runId)) ?? run;
      if (run.stop_requested) return stop(runId);
      if (run.needs_input || run.status === "done" || run.status === "canceled") return run;

      const transcript: string[] = Array.isArray(run.result?.transcript)
        ? [...run.result.transcript]
        : [];

      // Consume queued guidance so the model sees it exactly once.
      const guidance = [...(run.pending_steering ?? []), ...(run.pending_guidance ?? [])];
      if (guidance.length) {
        for (const g of guidance) transcript.push(`USER guidance: ${g}`);
        await event(runId, "step", "توجيه من المستخدم", guidance.join("\n"));
      }

      const action = await nextAction(run, memory);
      if (!action?.tool) {
        transcript.push("MODEL returned no usable action");
        run =
          (await patch(runId, {
            pending_guidance: [],
            pending_steering: [],
            loop_strikes: (run.loop_strikes ?? 0) + 1,
            result: { ...(run.result ?? {}), transcript },
          })) ?? run;
        if ((run.loop_strikes ?? 0) >= 3) {
          return fail(runId, "مش قادر أكمل — النموذج مش بيرجّع خطوة صالحة");
        }
        continue;
      }

      const tool = action.tool;
      const args = action.args ?? {};
      const signature = `${tool}:${JSON.stringify(args).slice(0, 200)}`;
      const repeats = transcript.filter((t) => t.includes(signature)).length;
      const loopHint =
        repeats >= 2 ? " (نفس الخطوة تكررت — لازم أغيّر الطريقة)" : "";

      if (tool === "finish") {
        const summary = String(args.summary ?? "خلصت المهمة");
        return finish(runId, run, summary, ctx);
      }

      if (tool === "ask_user") {
        const question = String(args.question ?? "محتاج توضيح");
        const sensitive = !!args.sensitive;
        await supabase.from("agent_questions").insert({
          run_id: runId,
          user_id: userId,
          question,
          reason: args.reason ? String(args.reason) : null,
          options: [],
          sensitive,
          status: "open",
        } as never);
        await event(runId, "question", "وقفت وسألت", question);
        return patch(runId, {
          status: "paused",
          phase: "awaiting_user",
          status_text: "مستني ردك",
          needs_input: true,
          pending_guidance: [],
          pending_steering: [],
          result: {
            ...(run.result ?? {}),
            transcript: [...transcript, `AGENT asked: ${question}`],
          },
        });
      }

      let output = "";
      let ok = true;
      if (tool === "run_code") {
        const res = await runCode(String(args.code ?? ""));
        ok = res.ok;
        output = res.output;
      } else if (tool === "fetch_url") {
        const res = await fetchUrl(String(args.url ?? ""));
        ok = res.ok;
        output = res.output;
      } else if (tool === "write_file") {
        const res = writeFile(ctx, String(args.path ?? ""), String(args.content ?? ""));
        ok = res.ok;
        output = res.output;
      } else if (tool === "read_file") {
        const res = readFile(ctx, String(args.path ?? ""));
        ok = res.ok;
        output = res.output;
      } else if (tool === "remember") {
        const content = String(args.content ?? "").trim();
        if (content) await remember(userId, content);
        output = content ? "تم الحفظ في الذاكرة" : "مفيش حاجة تُحفظ";
      } else {
        ok = false;
        output = `أداة غير معروفة: ${tool}`;
      }

      const detail = REDACTED_TOOLS.has(tool) ? "[محجوب]" : output;
      await event(runId, "tool", `${tool}${loopHint}`, detail.slice(0, 2000));
      transcript.push(
        `AGENT ${signature}${loopHint}\nRESULT(${ok ? "ok" : "fail"}): ${
          REDACTED_TOOLS.has(tool) ? "[redacted]" : output.slice(0, 1500)
        }`,
      );

      run =
        (await patch(runId, {
          status: "running",
          phase: "executing",
          status_text: action.thought ? String(action.thought).slice(0, 200) : "بنفّذ…",
          step_count: (run.step_count ?? 0) + 1,
          loop_strikes: repeats >= 2 ? (run.loop_strikes ?? 0) + 1 : 0,
          pending_guidance: [],
          pending_steering: [],
          result: {
            ...(run.result ?? {}),
            transcript: transcript.slice(-60),
            files: filesToArtifacts(ctx),
          },
        })) ?? run;
    }

    return run;
  } finally {
    ticking.delete(runId);
  }
}

/* ---------------------------------------------------------------- finishing */

const CRITIQUE_SYSTEM = `You review an agent's own work. Reply with JSON only:
{"done":true|false,"gap":"what is still missing, in the user's language"}
done=true only when the task in "Task" is genuinely satisfied by the work shown.`;

async function finish(
  runId: string,
  run: RunRow,
  summary: string,
  ctx: ToolContext,
): Promise<RunRow | null> {
  const round = (run.review_round ?? 0) + 1;
  await event(runId, "step", "دلوقتي بأراجع اللي عملته");

  const transcript: string[] = Array.isArray(run.result?.transcript) ? run.result.transcript : [];
  const verdict = await askJson<{ done?: boolean; gap?: string }>(CRITIQUE_SYSTEM, [
    {
      role: "user",
      content: [
        `Task: ${run.goal}`,
        `Agent summary: ${summary}`,
        `Files produced: ${[...ctx.files.keys()].join(", ") || "none"}`,
        `Work log:\n${transcript.slice(-20).join("\n")}`,
      ].join("\n\n"),
    },
  ]);

  if (verdict?.done === false && round <= MAX_REVIEW_ROUNDS) {
    const gap = String(verdict.gap ?? "فيه حاجة ناقصة");
    await event(runId, "step", "المراجعة لقت نقص — بكمّل", gap);
    return patch(runId, {
      status: "running",
      phase: "executing",
      status_text: "بأستكمل النقص اللي لقيته في المراجعة",
      review_round: round,
      result: {
        ...(run.result ?? {}),
        transcript: [...transcript, `SELF-REVIEW: not done yet — ${gap}`],
        files: filesToArtifacts(ctx),
      },
    });
  }

  await event(runId, "result", "خلصت", summary);
  const updated = await patch(runId, {
    status: "done",
    phase: "finished",
    status_text: "خلصت",
    needs_input: false,
    review_round: round,
    result: {
      ...(run.result ?? {}),
      summary,
      transcript,
      files: filesToArtifacts(ctx),
    },
  });
  fileCache.delete(runId);
  return updated;
}

async function fail(runId: string, message: string): Promise<RunRow | null> {
  await event(runId, "error", "المهمة وقفت", message);
  fileCache.delete(runId);
  return patch(runId, {
    status: "error",
    phase: "failed",
    status_text: message,
    error: message,
  });
}
