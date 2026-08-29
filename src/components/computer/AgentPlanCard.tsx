import { useEffect, useState } from "react";
import { ListChecks, Play } from "lucide-react";

/**
 * The agent shows its plan as plain text and waits for "Continue".
 * If the user does nothing, the countdown runs out and the agent proceeds on its
 * own (the same 60s deadline is enforced server-side, so it also fires with the
 * tab closed).
 */
export function AgentPlanCard({
  planText,
  autoContinueAt,
  onContinue,
}: {
  planText: string;
  autoContinueAt: string | null;
  onContinue: () => Promise<void> | void;
}) {
  const [left, setLeft] = useState(() => remaining(autoContinueAt));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLeft(remaining(autoContinueAt));
    const id = window.setInterval(() => setLeft(remaining(autoContinueAt)), 500);
    return () => window.clearInterval(id);
  }, [autoContinueAt]);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onContinue();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
      <div className="flex items-start gap-2">
        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-[var(--megsy-blue,#3b82f6)]" />
        <div className="flex-1">
          <p className="text-[13px] font-medium">دي الخطة اللي هأمشي عليها</p>
          <pre className="mt-1 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-muted-foreground">
            {planText}
          </pre>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void go()}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--megsy-blue,#3b82f6)] px-4 text-[13px] font-medium text-white transition-opacity disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              متابعة{left > 0 ? ` (${left})` : ""}
            </button>
            <span className="text-[11px] text-muted-foreground">
              {left > 0 ? "هكمّل تلقائي لو مضغطتش" : "بكمّل دلوقتي…"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function remaining(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.parse(iso) - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}
