import { memo, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import MegsyStar from "@/components/branding/MegsyStar";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { t as uiT, useUserLang } from "@/lib/authI18n";

export interface ThinkingTraceProps {
  /** Rotating / live status line shown while the model is still working. */
  status?: string;
  /** Ordered narration steps (deep research, tools, slides, media…). */
  steps?: string[];
  /** Raw reasoning tokens from the model. */
  text?: string;
  /** True while the turn is still running. */
  active?: boolean;
  /** Start expanded (rarely needed — collapsed is the default look). */
  defaultOpen?: boolean;
  className?: string;
}

const RTL_LANGS = new Set(["ar", "ar-eg", "fa", "he"]);

/**
 * The single "AI thinking" surface used across chat, deep research, slides,
 * media and tool turns. Borderless, quiet grey, collapsible — the Megsy star
 * stays as the marker of the row.
 */
const ThinkingTrace = ({
  status,
  steps,
  text,
  active,
  defaultOpen,
  className = "",
}: ThinkingTraceProps) => {
  const lang = useUserLang();
  const [open, setOpen] = useState(!!defaultOpen);
  const rtl = RTL_LANGS.has(lang);

  const lines = useMemo(() => {
    const out: string[] = [];
    for (const s of steps || []) {
      const v = String(s || "").trim();
      if (v && out[out.length - 1] !== v) out.push(v);
    }
    if (text?.trim()) {
      for (const p of text.trim().split(/\n{2,}|\n/)) {
        const v = p.trim();
        if (v && out[out.length - 1] !== v) out.push(v);
      }
    }
    return out;
  }, [steps, text]);

  const hasBody = lines.length > 0;
  const label = active ? uiT("thinking", lang) : uiT("thoughts", lang);
  const headline = active && status?.trim() ? status.trim() : label;

  // Nothing to show at all.
  if (!hasBody && !active) return null;


  return (
    <div className={`mb-3 ${className}`} dir={rtl ? "rtl" : undefined}>
      <div className="flex w-full items-center gap-2 py-0.5">
        {active ? (
          <MegsyStar className="h-3.5 w-3.5 text-[var(--megsy-blue)]" />
        ) : (
          <BrandLogo className="h-3.5 w-3.5" />
        )}
        <span
          className={`truncate text-[13px] ${
            active
              ? "ai-shimmer font-medium motion-reduce:animate-none"
              : "text-muted-foreground"
          }`}
          aria-live="polite"
        >
          {headline}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={label}
          className="ms-auto grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {open && (
        <div className="mt-1.5 max-h-80 overflow-y-auto">
          <div className="border-s border-border/40 ps-3 flex flex-col gap-2">
            {hasBody ? (
              lines.map((line, i) => (
                <div
                  key={`${i}-${line.slice(0, 24)}`}
                  className="text-[12.5px] leading-relaxed text-muted-foreground whitespace-pre-wrap"
                >
                  {line}
                </div>
              ))
            ) : (
              <div className="text-[12.5px] text-muted-foreground">…</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(ThinkingTrace);
