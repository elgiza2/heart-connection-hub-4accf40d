/**
 * @doc Browser-side driver for the Dev Agent.
 * Starts a run then keeps calling `step` until it finishes; each slice runs
 * server-side inside one serverless request, so long tasks survive.
 */
export interface DevTask {
  position: number;
  title: string;
  status: string;
}

export interface DevEvent {
  type: string;
  title: string;
  payload?: Record<string, any> | null;
}

export interface DevProject {
  id: string;
  title: string | null;
  preview_url: string | null;
  deploy_url: string | null;
  screenshot_url: string | null;
}

export interface DevState {
  run: Record<string, any>;
  tasks: DevTask[];
  events: DevEvent[];
  project: DevProject | null;
  finished: boolean;
}

const ENDPOINT = "/api/dev-agent";

async function call<T = Record<string, any>>(body: Record<string, unknown>): Promise<T> {
  const { supabase } = await import("@/integrations/supabase/client");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in to use the developer agent");
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, token }),
  });
  const json = (await resp.json().catch(() => ({}))) as Record<string, any>;
  if (!resp.ok) throw new Error((json.error as string) || `HTTP ${resp.status}`);
  return json as T;
}

export async function startDevRun(
  prompt: string,
  conversationId?: string | null,
): Promise<{ run: { id: string }; intent: string; allow_deploy: boolean }> {
  return call({ action: "start", prompt, conversation_id: conversationId ?? null });
}

export async function stopDevRun(runId: string): Promise<void> {
  await call({ action: "stop", run_id: runId });
}

/** Drives the run to completion, reporting each new state. */
export async function driveDevRun(
  runId: string,
  onState: (state: DevState) => void,
  opts: { maxSlices?: number; signal?: AbortSignal } = {},
): Promise<DevState | null> {
  const maxSlices = opts.maxSlices ?? 40;
  let last: DevState | null = null;
  for (let i = 0; i < maxSlices; i++) {
    if (opts.signal?.aborted) break;
    const state = (await call<DevState>({ action: "step", run_id: runId })) as DevState;
    last = state;
    onState(state);
    if (state.finished) break;
  }
  return last;
}
