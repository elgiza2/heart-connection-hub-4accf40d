/**
 * @doc Chat turn handler for the Dev Agent (@dev).
 *
 * The agent builds real React 18 + Vite projects inside a cloud VM. The chat
 * shows a short live progress log while it works, then the final summary.
 * A deployment is only performed when the user explicitly asked for it, and
 * in that case the reply ends with the live URL and a screenshot.
 */
import { toast } from "sonner";
import type { Message } from "../chatConstants";
import { driveDevRun, startDevRun, type DevState } from "@/lib/devagent/client";

export interface RunDevArgs {
  text: string;
  userMsg: Message;
  localTurnId: string;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setInput: (v: string) => void;
  setAttachedFiles: (v: any[]) => void;
  createOrUpdateConversation: (title: string) => Promise<string | null>;
  saveMessage: (
    cid: string,
    role: string,
    content: string,
    modelId?: any,
    meta?: any,
  ) => Promise<string | undefined>;
  ownInsertedIdsRef: React.MutableRefObject<Set<string>>;
}

export function stripDevMention(text: string): string {
  return text.replace(/@dev\b/gi, "").trim();
}

function render(state: DevState): string {
  const lines: string[] = [];
  const tasks = state.tasks ?? [];
  if (tasks.length) {
    lines.push(
      ...tasks.map((t) => {
        const mark = t.status === "done" ? "✅" : t.status === "running" ? "⏳" : t.status === "failed" ? "❌" : "•";
        return `${mark} ${t.title}`;
      }),
    );
  }
  const lastTool = [...(state.events ?? [])].reverse().find((e) => e.type === "tool");
  if (lastTool && !state.finished) lines.push("", `\`${lastTool.title}\``);

  const summary = state.run?.summary as string | undefined;
  if (state.finished && summary) {
    lines.push("", summary);
  }
  const deployed = state.events?.find((e) => e.type === "deployed");
  const url = (deployed?.payload?.url as string) || state.project?.deploy_url;
  const shot = (deployed?.payload?.screenshot as string) || state.project?.screenshot_url;
  if (state.finished && url) {
    lines.push("", `🔗 ${url}`);
    if (shot) lines.push("", `![preview](${shot})`);
  }
  return lines.join("\n").trim();
}

export async function runDevTurn({
  text,
  userMsg,
  localTurnId,
  setMessages,
  setInput,
  setAttachedFiles,
  createOrUpdateConversation,
  saveMessage,
  ownInsertedIdsRef,
}: RunDevArgs) {
  const prompt = stripDevMention(text);
  const assistantClientId = `assistant-${localTurnId}`;

  setMessages((prev) => [
    ...prev,
    userMsg,
    { role: "assistant", content: "جاري تجهيز بيئة التطوير…", clientId: assistantClientId },
  ]);
  setInput("");
  setAttachedFiles([]);

  const update = (content: string) =>
    setMessages((prev) =>
      prev.map((m) => (m.clientId === assistantClientId ? { ...m, content } : m)),
    );

  try {
    const cid = await createOrUpdateConversation(prompt.slice(0, 60) || "Dev task");
    if (cid) {
      const userMessageId = await saveMessage(cid, "user", userMsg.content);
      if (userMessageId) ownInsertedIdsRef.current.add(userMessageId);
    }

    const started = await startDevRun(prompt, cid);
    let latest = "";
    const final = await driveDevRun(started.run.id, (state) => {
      const body = render(state);
      latest = body || latest;
      update(latest || "جاري العمل…");
    });

    const content = final ? render(final) || "تم." : latest || "تم.";
    update(content);

    if (cid) {
      const assistantId = await saveMessage(cid, "assistant", content, undefined, {
        kind: "devRun",
        devRunId: started.run.id,
      });
      if (assistantId) ownInsertedIdsRef.current.add(assistantId);
    }
    window.dispatchEvent(new CustomEvent("megsy:conversations-changed"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "فشل تشغيل وكيل البرمجة";
    update(msg);
    toast.error(msg);
  }
}
