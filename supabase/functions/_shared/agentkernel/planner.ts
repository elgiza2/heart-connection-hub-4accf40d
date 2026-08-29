/**
 * plan -> execute -> self-critique.
 *
 * The plan is written before the browser opens and stored in `agent_plans`.
 * When the provider says the task finished, the kernel reviews the trace and
 * the final output and decides: pass, retry (with a corrective task), or ask.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { askJson } from "./llm.ts";

export interface Plan {
  id: string;
  steps: string[];
  clarify?: string | null;
  tools?: string[];
}

export interface Critique {
  verdict: "pass" | "retry" | "ask";
  critique: string;
  fix_instruction?: string | null;
  question?: string | null;
}

const PLAN_SYSTEM = [
  "You plan a real browser-automation task before it runs, like a careful human assistant.",
  'Return JSON only: {"steps":["..."],"tools":["browser","web_search","write_file"],"clarify":"question or null","success_criteria":"one sentence"}',
  "3-8 steps, each a concrete observable action. Use the provided memories: never re-discover something already known.",
  'Set "clarify" ONLY when the goal cannot be attempted at all without an answer (missing target, missing account, ambiguous amount).',
  'List every tool the task genuinely needs in "tools" — you decide, not the user.',
].join("\n");

/** Creates and persists the plan for a run. */
export async function makePlan(
  supabase: SupabaseClient,
  run: { id: string; user_id: string; goal: string },
  memoryText: string,
): Promise<Plan & { clarify: string | null; success_criteria: string | null }> {
  const parsed = await askJson<{
    steps?: string[];
    tools?: string[];
    clarify?: string | null;
    success_criteria?: string | null;
  }>(supabase, PLAN_SYSTEM, [`Goal: ${run.goal}`, memoryText].filter(Boolean).join("\n\n"));

  const steps = (parsed?.steps ?? []).map((step) => String(step)).slice(0, 8);
  const tools = (parsed?.tools ?? ["browser"]).map((tool) => String(tool)).slice(0, 6);
  const clarify =
    parsed?.clarify && String(parsed.clarify).toLowerCase() !== "null"
      ? String(parsed.clarify)
      : null;

  const { data } = await supabase
    .from("agent_plans")
    .insert({
      run_id: run.id,
      user_id: run.user_id,
      goal: run.goal,
      steps: { steps, tools, success_criteria: parsed?.success_criteria ?? null },
    })
    .select("id")
    .single();

  return {
    id: (data as { id?: string } | null)?.id ?? "",
    steps,
    tools,
    clarify,
    success_criteria: parsed?.success_criteria ?? null,
  };
}

/** Reviews a finished run against its own plan. */
export async function critique(
  supabase: SupabaseClient,
  args: {
    goal: string;
    steps: string[];
    successCriteria?: string | null;
    trace: string[];
    output: string | null;
    round: number;
  },
): Promise<Critique> {
  const system = [
    "You are the reviewer of a browser-automation run that just reported success.",
    'Return JSON only: {"verdict":"pass|retry|ask","critique":"2 sentences max","fix_instruction":"what to do differently, or null","question":"question for the user, or null"}',
    'Answer honestly: was the goal ACTUALLY achieved? A run that only "looks" done (form not submitted, no confirmation, wrong item) is a retry.',
    'Use "ask" only when finishing needs information or permission the agent cannot get itself.',
  ].join("\n");
  const user = [
    `Goal: ${args.goal}`,
    args.successCriteria ? `Success criteria: ${args.successCriteria}` : "",
    `Plan: ${args.steps.join(" | ")}`,
    `Review round: ${args.round}`,
    "Trace:",
    args.trace.slice(-40).join("\n"),
    `Final output: ${args.output ?? "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const parsed = await askJson<Critique>(supabase, system, user);
  const verdict: Critique["verdict"] =
    parsed?.verdict === "retry" || parsed?.verdict === "ask" ? parsed.verdict : "pass";
  return {
    verdict,
    critique: parsed?.critique ? String(parsed.critique) : "No review available.",
    fix_instruction: parsed?.fix_instruction ? String(parsed.fix_instruction) : null,
    question: parsed?.question ? String(parsed.question) : null,
  };
}

/** Persists the review outcome on the plan row. */
export async function savePlanReview(
  supabase: SupabaseClient,
  planId: string,
  round: number,
  review: Critique,
): Promise<void> {
  if (!planId) return;
  await supabase
    .from("agent_plans")
    .update({
      review_round: round,
      critique: review.critique,
      verdict: review.verdict,
      updated_at: new Date().toISOString(),
    })
    .eq("id", planId);
}
