import { Brain, Coins, Cpu, Sparkles } from "lucide-react";
import { estimateCostUsd, formatCostUsd } from "@/lib/modelCosts";

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface TimingInfo {
  durationMs?: number;
  ttftMs?: number;
}

interface MessageInsightsProps {
  metadata?: Record<string, any> | null;
}

/**
 * Trust & Transparency: shows model, tokens, cost, latency and memory usage
 * for an assistant message. Renders nothing if metadata is empty.
 */
export function MessageInsights({ metadata }: MessageInsightsProps) {
  if (!metadata) return null;
  const model: string | undefined = metadata.modelActual || metadata.modelLabel;
  const usage: Usage | undefined = metadata.usage;
  const timing: TimingInfo | undefined = metadata.timing;
  const usedMemory: boolean = metadata.usedMemory === true;
  const memoryCount: number = Number(metadata.memoryCount || 0);

  const chips: React.ReactNode[] = [];

  if (model) {
    chips.push(
      <span key="model" className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
        <Cpu className="h-3 w-3" /> {model}
      </span>,
    );
  }

  if (usage && (usage.total_tokens || usage.prompt_tokens || usage.completion_tokens)) {
    const total = usage.total_tokens || (Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0));
    chips.push(
      <span key="tokens" className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground" title={`in ${usage.prompt_tokens ?? 0} / out ${usage.completion_tokens ?? 0}`}>
        <Sparkles className="h-3 w-3" /> {total.toLocaleString()} tok
      </span>,
    );
    const cost = estimateCostUsd(model, usage);
    if (cost !== null) {
      chips.push(
        <span key="cost" className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
          <Coins className="h-3 w-3" /> {formatCostUsd(cost)}
        </span>,
      );
    }
  }


  if (usedMemory) {
    chips.push(
      <span key="mem" className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary" title="Your memory was used in this reply">
        <Brain className="h-3 w-3" /> Memory{memoryCount ? ` (${memoryCount})` : ""}
      </span>,
    );
  }

  if (chips.length === 0) return null;
  return <div className="mt-1 flex flex-wrap items-center gap-1.5">{chips}</div>;
}
