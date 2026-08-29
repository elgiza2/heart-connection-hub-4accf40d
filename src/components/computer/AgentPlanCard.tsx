import { useEffect, useMemo, useState } from "react";
import { Check, ListChecks, Pencil, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The plan gate.
 *
 * The agent writes its plan as a checklist and waits for "Continue". If the user
 * does nothing, a 60s countdown runs out and the agent proceeds on its own (the
 * same deadline is enforced server-side, so it fires with the tab closed too).
 * Editing the plan cancels the countdown — an edited plan always needs an
 * explicit Continue.
 */
export function AgentPlanCard({
  planText,
  autoContinueAt,
  doneCount = 0,
  onContinue,
}: {
  planText: string;
  autoContinueAt: string | null;
  /** How many leading steps are already finished (live check marks). */
  doneCount?: number;
  onContinue: (planSteps?: string[]) => Promise<void> | void;
}) {
  const steps = useMemo(() => splitSteps(planText), [planText]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => steps.join("\n"));
  const [left, setLeft] = useState(() => remaining(autoContinueAt));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(steps.join("\n"));
  }, [steps, editing]);

  useEffect(() => {
    if (editing) return;
    setLeft(remaining(autoContinueAt));
    const id = window.setInterval(() => setLeft(remaining(autoContinueAt)), 500);
    return () => window.clearInterval(id);
  }, [autoContinueAt, editing]);

  const go = async (edited?: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = edited ? splitSteps(draft) : undefined;
      await onContinue(next && next.length ? next : undefined);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
      <div className="flex items-start gap-2">
        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-[var(--megsy-blue,#3b82f6)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-medium">دي الخطة اللي هأمشي عليها</p>
            {!editing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                className="ms-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
                تعديل الخطة
              </Button>
            )}
          </div>

          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(12, Math.max(4, draft.split("\n").length + 1))}
              dir="auto"
              className="mt-2 w-full resize-y rounded-xl border border-border/60 bg-background/60 p-2 text-[13px] leading-relaxed outline-none focus:border-[var(--megsy-blue,#3b82f6)]/60"
              placeholder="خطوة في كل سطر…"
            />
          ) : (
            <ol className="mt-2 flex flex-col gap-1.5">
              {steps.map((step, i) => {
                const done = i < doneCount;
                const current = i === doneCount;
                return (
                  <li key={`${i}-${step.slice(0, 20)}`} className="flex items-start gap-2">
                    <span
                      className={`mt-[3px] grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] ${
                        done
                          ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-500"
                          : current
                            ? "border-[var(--megsy-blue,#3b82f6)]/60 bg-[var(--megsy-blue,#3b82f6)]/10"
                            : "border-border/60"
                      }`}
                    >
                      {done ? <Check className="h-2.5 w-2.5" /> : null}
                    </span>
                    <span
                      className={`text-[13px] leading-relaxed ${
                        done
                          ? "text-muted-foreground line-through decoration-border"
                          : current
                            ? "text-foreground"
                            : "text-muted-foreground"
                      }`}
                    >
                      {step}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void go(editing)}
              disabled={busy}
              className="rounded-full"
            >
              <Play className="h-3.5 w-3.5" />
              {editing ? "متابعة بالخطة المعدّلة" : `متابعة${left > 0 ? ` (${left})` : ""}`}
            </Button>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setDraft(steps.join("\n"));
                }}
                className="h-9 rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                إلغاء التعديل
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                {left > 0 ? "هكمّل تلقائي لو مضغطتش" : "بكمّل دلوقتي…"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One step per line, tolerating "1." / "-" / "•" prefixes from the model. */
function splitSteps(text: string): string[] {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[).:-]|[-*•])\s*/, "").trim())
    .filter((line) => line.length > 0);
}

function remaining(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.parse(iso) - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}
