import { useState } from "react";
import { CornerDownLeft, ListEnd, Send, ShieldOff, Square } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Mid-run controls: steer the agent without restarting it, or stop it.
 * Queued notes stay visible until the agent picks them up on its next step.
 */
export function AgentSteerBar({
  queued = [],
  steering = [],
  onGuide,
  onSteer,
  onSoftStop,
  onStop,
}: {
  queued?: string[];
  steering?: string[];
  onGuide: (text: string) => Promise<void> | void;
  onSteer: (text: string) => Promise<void> | void;
  onSoftStop: () => Promise<void> | void;
  onStop: () => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"steer" | "queue">("steer");

  const send = async () => {
    const note = text.trim();
    if (!note || busy) return;
    setBusy(true);
    try {
      await (mode === "steer" ? onSteer(note) : onGuide(note));
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border/50 bg-card/40 p-2">
      {(queued.length > 0 || steering.length > 0) && (
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
          {steering.map((q, i) => (
            <span key={`steer-${i}-${q.slice(0, 16)}`} className="max-w-full truncate rounded-full bg-primary/10 px-2.5 py-1 text-[11.5px] text-primary" title={q}>
              توجيه قريب: {q}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <div className="flex shrink-0 rounded-md border border-border/50 p-0.5" aria-label="نوع التوجيه">
          <Button type="button" size="icon-sm" variant={mode === "steer" ? "secondary" : "ghost"} onClick={() => setMode("steer")} title="توجيه عند أقرب نقطة آمنة">
            <CornerDownLeft className="h-4 w-4" />
          </Button>
          <Button type="button" size="icon-sm" variant={mode === "queue" ? "secondary" : "ghost"} onClick={() => setMode("queue")} title="إضافة للدورة التالية">
            <ListEnd className="h-4 w-4" />
          </Button>
        </div>
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
          placeholder={mode === "steer" ? "غيّر المسار عند أقرب نقطة آمنة…" : "أضف توجيهًا للدورة التالية…"}
          className="max-h-24 min-h-9 flex-1 resize-none rounded-xl bg-transparent px-2 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        <Button
          type="button"
          onClick={() => void send()}
          disabled={busy || !text.trim()}
          aria-label="إرسال توجيه"
          size="icon-sm"
          className="shrink-0 rounded-full"
        >
          {busy ? <CornerDownLeft className="h-4 w-4" /> : <Send className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void onSoftStop()}
          title="يتوقف عند أقرب نقطة آمنة ويحفظ التقدم"
        >
          <ShieldOff className="h-3 w-3" />
          إيقاف آمن
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => void onStop()} title="إيقاف فوري" className="text-muted-foreground hover:text-destructive">
          <Square className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

export default AgentSteerBar;
