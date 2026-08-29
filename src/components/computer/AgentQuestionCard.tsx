import { useState } from "react";
import { HelpCircle, Send } from "lucide-react";
import type { AgentQuestion } from "@/lib/longrun/types";

/**
 * The agent stopped and asked. Shown inside the computer surface so the user can
 * unblock a paused run (CAPTCHA solved, OTP code, confirm a payment, pick a path).
 */
export function AgentQuestionCard({
  question,
  onAnswer,
}: {
  question: AgentQuestion;
  onAnswer: (text: string) => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (value: string) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await onAnswer(value.trim());
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[var(--megsy-blue,#3b82f6)]/40 bg-[var(--megsy-blue,#3b82f6)]/5 p-3">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--megsy-blue,#3b82f6)]" />
        <div className="flex-1">
          <p className="text-[13px] leading-relaxed">{question.question}</p>
          {question.sensitive && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Sent straight to the task and never stored.
            </p>
          )}

          {question.options.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {question.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={busy}
                  onClick={() => void send(option)}
                  className="rounded-full border border-border/60 px-3 py-1 text-[12px] transition-colors hover:bg-muted/60 disabled:opacity-50"
                >
                  {option}
                </button>
              ))}
            </div>
          )}

          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              type={question.sensitive ? "password" : "text"}
              autoComplete="off"
              placeholder="Your answer…"
              className="h-9 flex-1 rounded-full border border-border/60 bg-background px-3 text-[13px] outline-none focus:border-[var(--megsy-blue,#3b82f6)]"
            />
            <button
              type="submit"
              disabled={busy || !text.trim()}
              aria-label="Send answer"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--megsy-blue,#3b82f6)] text-white transition-opacity disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
