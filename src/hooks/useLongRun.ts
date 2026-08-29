import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import * as localKernel from "@/lib/agentkernel/kernel";
import {
  KEEPALIVE_MS,
  type AgentQuestion,
  type LongRun,
  type LongRunEvent,
} from "@/lib/longrun/types";

/**
 * The kernel runs in the `long-run` edge function whenever it is reachable —
 * that version keeps working with the tab closed. If the function is missing or
 * erroring, we transparently fall back to the in-tab kernel, which drives the
 * same rows so the UI is identical (it just needs the tab open).
 */
let edgeAvailable = true;

async function call(action: string, body: Record<string, unknown> = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("سجّل الدخول أولاً لتشغيل مهام الكمبيوتر");
  const { data, error } = await supabase.functions.invoke<{
    run?: LongRun;
    question?: AgentQuestion | null;
  }>("long-run", {
    body: { action, ...body, token },
  });
  if (error) {
    edgeAvailable = false;
    throw error;
  }
  edgeAvailable = true;
  return data ?? {};
}

/** Runs the edge action, and on failure the equivalent in-tab kernel action. */
async function withFallback(
  action: string,
  body: Record<string, unknown>,
  local: () => Promise<LongRun | null>,
): Promise<LongRun | null> {
  if (edgeAvailable) {
    try {
      const res = await call(action, body);
      if (res.run) return res.run;
    } catch {
      /* fall through to the in-tab kernel */
    }
  }
  return local();
}

export async function startLongRun(
  goal: string,
  conversationId?: string | null,
  budgetMs?: number,
) {
  return withFallback(
    "start",
    {
      goal,
      conversation_id: conversationId ?? null,
      ...(budgetMs ? { budget_ms: budgetMs } : {}),
    },
    () => localKernel.startRun(goal, conversationId ?? null, budgetMs),
  );
}

export async function stopLongRun(runId: string) {
  await withFallback("stop", { run_id: runId }, () => localKernel.stop(runId));
}

export async function approveLongRunPlan(runId: string, planSteps?: string[]) {
  return withFallback(
    "approve_plan",
    { run_id: runId, ...(planSteps && planSteps.length ? { plan_steps: planSteps } : {}) },
    () => localKernel.approvePlan(runId, planSteps),
  );
}

export async function guideLongRun(runId: string, guidance: string) {
  return withFallback("guide", { run_id: runId, guidance }, () =>
    localKernel.guide(runId, guidance),
  );
}

export async function steerLongRun(runId: string, guidance: string) {
  return withFallback("steer", { run_id: runId, guidance }, () =>
    localKernel.steer(runId, guidance),
  );
}

export async function softStopLongRun(runId: string) {
  return withFallback("soft_stop", { run_id: runId }, () => localKernel.softStop(runId));
}

export async function answerLongRun(runId: string, answer: string) {
  return withFallback("answer", { run_id: runId, answer }, () =>
    localKernel.answer(runId, answer),
  );
}


  return { run, events, question, stop, softStop, answer, approvePlan, guide, steer };
}
