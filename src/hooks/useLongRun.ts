import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { KEEPALIVE_MS, type LongRun, type LongRunEvent } from "@/lib/longrun/types";

async function call(action: string, body: Record<string, unknown> = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("سجّل الدخول أولاً لتشغيل مهام الكمبيوتر");
  const { data, error } = await supabase.functions.invoke<{ run?: LongRun }>("long-run", {
    body: { action, ...body, token },
  });
  if (error) throw new Error("خدمة الكمبيوتر مش متاحة دلوقتي. جرّب تاني بعد لحظة.");
  return data ?? {};
}


export async function startLongRun(goal: string, conversationId?: string | null) {
  const res = await call("start", { goal, conversation_id: conversationId ?? null });
  return res.run ?? null;
}

export async function stopLongRun(runId: string) {
  await call("stop", { run_id: runId });
}

/**
 * Live view of a long run: realtime row/event updates plus a keep-alive ping
 * that keeps the sandbox lease extended so the run survives many hours.
 */
export function useLongRun(runId: string | null) {
  const [run, setRun] = useState<LongRun | null>(null);
  const [events, setEvents] = useState<LongRunEvent[]>([]);
  const beating = useRef(false);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setEvents([]);
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
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [runId]);

  // Keep-alive: extends the computer lease while the run is active.
  useEffect(() => {
    if (!runId) return;
    const active = run?.status === "running" || run?.status === "paused" || run?.status === "queued";
    if (!active) return;
    const ping = async () => {
      if (beating.current) return;
      beating.current = true;
      try {
        const res = await call("keepalive", { run_id: runId });
        if (res.run) setRun(res.run);
      } catch {
        /* watchdog will retry on the next tick */
      } finally {
        beating.current = false;
      }
    };
    void ping();
    // Poll fast enough to notice the task finishing (and to stream its steps),
    // which also doubles as the sandbox keep-alive.
    const id = window.setInterval(ping, Math.min(8_000, KEEPALIVE_MS));
    return () => window.clearInterval(id);
  }, [runId, run?.status]);

  const stop = useCallback(async () => {
    if (runId) await stopLongRun(runId);
  }, [runId]);

  return { run, events, stop };
}
