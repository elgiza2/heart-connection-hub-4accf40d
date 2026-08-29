/**
 * @doc Server-only bridge to the same Alibaba model the main chat uses.
 * The Dev Agent never talks to another provider — it calls the existing
 * `chat-alibaba` edge function and accumulates the SSE stream into one blob.
 */
import { DEFAULT_MODEL } from "../defaultModel";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

/** One completion from the chat model. Returns "" when the call fails. */
export async function askModel(
  token: string,
  system: string,
  messages: LlmMessage[],
  timeoutMs = 120_000,
): Promise<string> {
  const url = `${process.env.SUPABASE_URL}/functions/v1/chat-alibaba`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY || "",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages,
        model: DEFAULT_MODEL,
        chatMode: "normal",
        customSystem: system,
      }),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) return "";

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const j = JSON.parse(raw) as Record<string, any>;
          out += j?.choices?.[0]?.delta?.content ?? j?.delta ?? j?.content ?? "";
        } catch {
          /* keepalive frame */
        }
      }
    }
    return out;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Same call, but parses the first JSON object/array found in the reply. */
export async function askJson<T = Record<string, unknown>>(
  token: string,
  system: string,
  messages: LlmMessage[],
  timeoutMs = 120_000,
): Promise<T | null> {
  const text = await askModel(token, system, messages, timeoutMs);
  return extractJson<T>(text);
}

export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
