import { useState } from "react";
import { CornerDownLeft, Send, Square } from "lucide-react";

/**
 * Mid-run controls: steer the agent without restarting it, or stop it.
 * Queued notes stay visible until the agent picks them up on its next step.
 */
export function AgentSteerBar({
  queued = [],
  onGuide,
  onStop,
}: {
  queued?: string[];
  onGuide: (text: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const note = text.trim();
    if (!note || busy) return;
    setBusy(true);
    try {
      await onGuide(note);
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border/50 bg-card/40 p-2">
      {queued.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {queued.map((q, i) => (
            <span
              key={`${i}-${q.slice(0, 16)}`}
              className="max-w-full truncate rounded-full bg-foreground/[0.06] px-2.5 py-1 text-[11.5px] text-muted-foreground"
              title={q}
            >
              في الطابور: {q}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          dir="auto"
          placeholder="وجّهه وهو شغال… (Enter للإرسال)"
          className="max-h-24 min-h-9 flex-1 resize-none rounded-xl bg-transparent px-2 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !text.trim()}
          aria-label="إرسال توجيه"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--megsy-blue,#3b82f6)] text-white transition-opacity disabled:opacity-40"
        >
          {busy ? <CornerDownLeft className="h-4 w-4" /> : <Send className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => void onStop()}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] text-muted-foreground transition-colors hover:text-destructive"
        >
          <Square className="h-3 w-3" />
          إيقاف
        </button>
      </div>
    </div>
  );
}

export default AgentSteerBar;
