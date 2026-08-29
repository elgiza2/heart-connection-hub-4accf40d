import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import { useLongRun } from "@/hooks/useLongRun";
import { clearActiveComputerRun, setActiveComputerRun } from "@/lib/computer/activeRun";
import { AgentToolTrace } from "./AgentToolTrace";



function formatElapsed(from?: string | null): string {
  if (!from) return "0m";
  const ms = Date.now() - Date.parse(from);
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Computer surface, split into clearly separate blocks:
 *   1. the live screen card (only while the task runs),
 *   2. the step / thinking trace (one live line, expandable to the full list),
 *   3. the final plain-text answer, rendered outside any card.
 */
export function ComputerPreview({
  runId,
  plan,
  onClose,
}: {
  runId: string;
  plan?: string[];
  onClose?: () => void;
}) {
  const { run, events, question, stop, softStop, answer, approvePlan, guide, steer } = useLongRun(runId);
  const [control, setControl] = useState(false);
  const [openSteps, setOpenSteps] = useState(true);
  const [full, setFull] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const summarizedRef = useRef(false);
  const [, force] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const active = run?.status === "running" || run?.status === "queued" || run?.status === "paused";
  const finished = !!run && !active;
  const failed = run?.status === "error" || run?.status === "canceled";

  useEffect(() => {
    if (active) setActiveComputerRun(runId);
    else if (finished) clearActiveComputerRun(runId);
  }, [active, finished, runId]);
  useEffect(() => () => clearActiveComputerRun(runId), [runId]);
  useEffect(() => {
    if (finished) setFull(false);
  }, [finished]);

  // The run keeps going server-side, so tell the user when it lands or blocks —
  // even if the tab was in the background the whole time.
  const notifiedRef = useRef<string | null>(null);
  useEffect(() => {
    const state = finished ? "finished" : question ? "needs_input" : null;
    if (!state || notifiedRef.current === state) return;
    notifiedRef.current = state;
    if (!("Notification" in window) || !document.hidden) return;
    const show = () => {
      try {
        new Notification(
          state === "needs_input" ? "الوكيل محتاج ردّك" : failed ? "المهمة فشلت" : "المهمة خلصت",
          { body: run?.goal?.slice(0, 120) || "" },
        );
      } catch {
        /* notifications blocked — the in-chat card is enough */
      }
    };
    if (Notification.permission === "granted") show();
    else if (Notification.permission === "default") void Notification.requestPermission().then((p) => {
      if (p === "granted") show();
    });
  }, [finished, question, failed, run?.goal]);

  const url = useMemo(() => {
    if (!run?.live_view_url || finished) return null;
    return control ? run.live_view_url : `${run.live_view_url}?view_only=true`;
  }, [run?.live_view_url, control, finished]);

  const rawOutput =
    (run?.result && (run.result.output as string | null)) ||
    (run?.status === "error" ? run?.error : null) ||
    null;

  // Model-written wrap-up, generated once when the run settles.
  useEffect(() => {
    if (!finished || summarizedRef.current || !run) return;
    summarizedRef.current = true;
    void (async () => {
      try {
        const { generateRunSummary } = await import("@/lib/computer/narration");
        const text = await generateRunSummary({
          task: run.goal || "",
          steps: events.map((e) => (e.detail ? `${e.title} — ${e.detail}` : e.title)),
          output: rawOutput,
          failed,
          conversationId: (run as { conversation_id?: string | null }).conversation_id ?? null,
        });
        if (text) setSummary(text);
      } catch {
        /* fall back to the raw output below */
      }
    })();
  }, [finished, run, events, rawOutput, failed]);

  const finalText =
    summary ||
    rawOutput ||
    (run?.status === "canceled" ? "Task stopped." : null);

  // The plan checklist stays visible during execution, with live check marks.
  const planText =
    events.find((e) => e.type === "plan")?.detail || (plan ?? []).join("\n") || "";
  const doneCount = run?.awaiting_plan_ack
    ? 0
    : events.filter((e) => e.type === "step" || e.type === "tool").length;

  const lastStep = events.length ? events[events.length - 1] : null;
  const headline = active
    ? run?.status_text || lastStep?.title || "Starting the computer…"
    : run?.status === "error"
      ? "Task failed"
      : run?.status === "canceled"
        ? "Stopped"
        : "Task completed";

  const traceLines: string[] = events.length
    ? events.map((e) => (e.detail ? `${e.title} — ${e.detail}` : e.title))
    : (plan ?? []);

  // Last screenshot captured by the agent — keeps the card meaningful after
  // the live view is torn down instead of collapsing it to a single line.
  const lastShot = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.screenshot_url) return events[i].screenshot_url as string;
    }
    return null;
  }, [events]);

  const resultFiles: { name?: string; url: string }[] = Array.isArray(run?.result?.files)
    ? (run!.result.files as { name?: string; url: string }[]).filter((f) => f && f.url)
    : [];

  return (
    <div className="flex flex-col gap-3">
      {/* the work continues server-side even with the tab closed */}
      {active && !question && (
        <p className="text-[11.5px] text-muted-foreground">
          شغال في الخلفية — تقدر تسيب الصفحة وهكمّل، وهبلّغك لما أخلّص.
          {typeof run?.step_count === "number" ? ` · ${run.step_count} خطوة` : ""}
          {` · ${formatElapsed(run?.created_at)}`}
        </p>
      )}

      {/* the plan — plain text in the chat, no card */}
      {planLines.length > 0 && !question && (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] font-medium text-foreground">الخطة</p>
          {planLines.map((step, i) => (
            <p key={i} className="text-[13px] leading-relaxed text-muted-foreground">
              {i < doneCount ? "✓ " : "• "}
              {step}
            </p>
          ))}
          {run?.awaiting_plan_ack && (
            <p className="text-[12.5px] text-muted-foreground">
              <button
                type="button"
                onClick={() => void approvePlan()}
                className="text-primary underline-offset-2 hover:underline"
              >
                متابعة
              </button>
              {secondsLeft !== null ? ` — هكمّل تلقائيًا بعد ${secondsLeft} ثانية` : " — مستني موافقتك"}
            </p>
          )}
        </div>
      )}

      {/* the agent needs a human answer — plain text + one line of input */}
      {question && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13.5px] leading-relaxed text-foreground">{question.question}</p>
          {question.reason && (
            <p className="text-[12.5px] text-muted-foreground">{question.reason}</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = reply.trim();
              if (!text) return;
              setReply("");
              void answer(text);
            }}
            className="flex items-center gap-2"
          >
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              type={question.sensitive ? "password" : "text"}
              placeholder="اكتب ردّك…"
              className="flex-1 border-0 border-b border-border/60 bg-transparent px-0 py-1 text-[13.5px] outline-none focus:border-primary"
            />
            <button type="submit" className="text-[12.5px] text-primary">
              إرسال
            </button>
          </form>
        </div>
      )}


      {/* 1 — computer card: live while running, kept (with the final frame) after */}
      <div
        className={
          full && !finished
            ? "fixed inset-0 z-50 flex flex-col bg-background"
            : "overflow-hidden rounded-2xl border border-border/50 bg-card/40"
        }
      >
        <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
          <span className="font-medium">Megsy Computer</span>
          <span className="text-muted-foreground">{formatElapsed(run?.created_at)}</span>
          {!active && (
            <span
              className={`inline-flex items-center gap-1 ${
                failed ? "text-destructive" : "text-emerald-500"
              }`}
            >
              {!failed && <Check className="h-3.5 w-3.5" />}
              {headline}
            </span>
          )}
          {active && (
            <>
              <button
                type="button"
                onClick={() => setControl((v) => !v)}
                className={`ms-auto rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  control
                    ? "bg-[var(--megsy-blue,#3b82f6)]/15 text-[var(--megsy-blue,#3b82f6)]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {control ? "View only" : "Take control"}
              </button>
              <button
                type="button"
                onClick={() => setFull((v) => !v)}
                aria-label={full ? "Exit full screen" : "Full screen"}
                className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              >
                {full ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void stop()}
                className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Stop
              </button>
            </>
          )}
        </div>

        {(!finished || lastShot) && (
          <div
            className={`relative w-full bg-black/80 ${
              full && !finished ? "flex-1" : "aspect-[16/10]"
            }`}
          >
            {url ? (
              <iframe
                key={url}
                src={url}
                title="Megsy Computer live view"
                className="absolute inset-0 h-full w-full border-0"
                allow="clipboard-read; clipboard-write"
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            ) : lastShot ? (
              <img
                src={lastShot}
                alt="Last computer screenshot"
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover object-top"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center px-6 text-center text-[12px] text-white/60">
                {run?.error || "Preparing the screen…"}
              </div>
            )}
            {!control && url && <div className="absolute inset-0" aria-hidden />}
          </div>
        )}

        {/* current step / final headline, inside the card */}
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
          {active ? (
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--megsy-blue,#3b82f6)]" />
          ) : failed ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          )}
          <span className={`truncate ${active ? "ai-shimmer motion-reduce:animate-none" : ""}`} aria-live="polite">
            {headline}
          </span>
          {traceLines.length > 0 && (
            <button
              type="button"
              onClick={() => setOpenSteps((v) => !v)}
              aria-expanded={openSteps}
              aria-label="Steps"
              className="ms-auto grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${openSteps ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>

        {openSteps && traceLines.length > 0 && (
          <div className="max-h-72 overflow-y-auto px-3 pb-3">
            <AgentToolTrace events={events} fallback={plan ?? []} />
          </div>
        )}

        {resultFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pb-3">
            {resultFiles.map((f) => (
              <a
                key={f.url}
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-foreground/[0.06] px-3 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {f.name || "File"}
              </a>
            ))}
          </div>
        )}
      </div>

      {/* steering as one line of text: type a note, or stop */}
      {active && !question && !run?.awaiting_plan_ack && (
        <div className="flex flex-col gap-1">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = note.trim();
              if (!text) return;
              setNote("");
              void steer(text);
            }}
            className="flex items-center gap-2"
          >
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="وجّهني وأنا شغال…"
              className="flex-1 border-0 border-b border-border/50 bg-transparent px-0 py-1 text-[13px] outline-none focus:border-primary"
            />
            <button type="submit" className="text-[12px] text-primary">
              إرسال
            </button>
            <button
              type="button"
              onClick={() => void softStop()}
              className="text-[12px] text-muted-foreground hover:text-foreground"
            >
              وقف بعد الخطوة
            </button>
          </form>
          {(run?.pending_steering ?? []).concat(run?.pending_guidance ?? []).length > 0 && (
            <p className="text-[11.5px] text-muted-foreground">
              في الطابور: {(run?.pending_steering ?? []).concat(run?.pending_guidance ?? []).join(" · ")}
            </p>
          )}
        </div>
      )}


      {/* 2 — final answer, plain text outside the card */}
      {finished && finalText && (
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
          {finalText}
        </p>
      )}

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="self-start text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Close
        </button>
      )}
    </div>
  );
}

export default ComputerPreview;
