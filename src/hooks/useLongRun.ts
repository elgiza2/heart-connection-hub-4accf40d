import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  KEEPALIVE_MS,
  type AgentQuestion,
  type LongRun,
  type LongRunEvent,
} from "@/lib/longrun/types";

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
  if (error) throw new Error("خدمة الكمبيوتر مش متاحة دلوقتي. جرّب تاني بعد لحظة.");
  return data ?? {};
}

export async function startLongRun(
  goal: string,
  conversationId?: string | null,
  budgetMs?: number,
) {
  const res = await call("start", {
    goal,
    conversation_id: conversationId ?? null,
    ...(budgetMs ? { budget_ms: budgetMs } : {}),
  });
  return res.run ?? null;
}

export async function stopLongRun(runId: string) {
  await call("stop", { run_id: runId });
}

export async function approveLongRunPlan(runId: string, planSteps?: string[]) {
  const res = await call("approve_plan", {
    run_id: runId,
    ...(planSteps && planSteps.length ? { plan_steps: planSteps } : {}),
  });
  return res.run ?? null;
}

export async function answerLongRun(runId: string, answer: string) {
  const res = await call("answer", { run_id: runId, answer });
  return res.run ?? null;
}

/**
 * Live view of a long run.
 *
 * The run itself is advanced server-side by the `agent-tick` cron, so it keeps
 * going with the tab closed. This hook only mirrors state (realtime + a light
 * poll while visible) and surfaces the agent's open question so the user can
 * unblock it.
 */
export function useLongRun(runId: string | null) {
  const [run, setRun] = useState<LongRun | null>(null);
  const [events, setEvents] = useState<LongRunEvent[]>([]);
  const [question, setQuestion] = useState<AgentQuestion | null>(null);
  const beating = useRef(false);

  const loadQuestion = useCallback(async (id: string) => {
    const { data } = await supabase
      .from("agent_questions")
      .select("*")
      .eq("run_id", id)
      .eq("status", "open")
      .order("asked_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setQuestion((data as unknown as AgentQuestion) ?? null);
  }, []);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setEvents([]);
      setQuestion(null);
      return;
    }
    let cancelled = false;

    void (async () => {
      const [{ data: r }, { data: ev }] = await Promise.all([
        supabase.from("long_runs").select("*").eq("id", runId).maybeSingle(),
        supabase
          .from("long_run_events")
          .select("*")
          .eq("run_id", runId)
          .order("created_at", { ascending: true }),
      ]);
      if (cancelled) return;
      if (r) setRun(r as unknown as LongRun);
      setEvents((ev ?? []) as unknown as LongRunEvent[]);
      await loadQuestion(runId);
    })();

    const channel = supabase
      .channel(`long-run-${runId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "long_runs", filter: `id=eq.${runId}` },
        (p) => setRun(p.new as unknown as LongRun),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "long_run_events", filter: `run_id=eq.${runId}` },
        (p) => setEvents((prev) => [...prev, p.new as unknown as LongRunEvent]),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_questions", filter: `run_id=eq.${runId}` },
        () => void loadQuestion(runId),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [runId, loadQuestion]);

  // While the tab is open, poll the kernel so steps stream in quickly. The cron
  // tick does the same work server-side, so stopping this changes nothing but
  // the refresh rate.
  useEffect(() => {
    if (!runId) return;
    const active = run?.status === "running" || run?.status === "paused" || run?.status === "queued";
    if (!active || run?.needs_input) return;
    // NB: awaiting_plan_ack runs stay polled — the tick auto-continues them.
    const ping = async () => {
      if (beating.current || document.hidden) return;
      beating.current = true;
      try {
        const res = await call("keepalive", { run_id: runId });
        if (res.run) setRun(res.run);
        if (res.question !== undefined) setQuestion(res.question ?? null);
      } catch {
        /* the server-side tick keeps the run moving anyway */
      } finally {
        beating.current = false;
      }
    };
    void ping();
    const id = window.setInterval(ping, Math.min(8_000, KEEPALIVE_MS));
    return () => window.clearInterval(id);
  }, [runId, run?.status, run?.needs_input]);

  const approvePlan = useCallback(
    async (planSteps?: string[]) => {
      if (!runId) return;
      const updated = await approveLongRunPlan(runId, planSteps);
      if (updated) setRun(updated);
    },
    [runId],
  );

  const stop = useCallback(async () => {
    if (runId) await stopLongRun(runId);
  }, [runId]);

  const answer = useCallback(
    async (text: string) => {
      if (!runId || !text.trim()) return;
      const updated = await answerLongRun(runId, text.trim());
      if (updated) setRun(updated);
      setQuestion(null);
    },
    [runId],
  );

  return { run, events, question, stop, answer, approvePlan };
}
