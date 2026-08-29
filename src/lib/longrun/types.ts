/** Shared (client-safe) types for long-running computer/agent runs. */

export type LongRunStatus = "queued" | "running" | "paused" | "done" | "error" | "canceled";

export interface LongRun {
  id: string;
  user_id: string;
  conversation_id: string | null;
  kind: string;
  goal: string;
  status: LongRunStatus;
  phase: string | null;
  status_text: string | null;
  provider: string | null;
  external_run_id: string | null;
  sandbox_id: string | null;
  live_view_url: string | null;
  expires_at: string | null;
  last_heartbeat_at: string;
  result: any;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface LongRunEvent {
  id: string;
  run_id: string;
  type: string;
  title: string;
  detail: string | null;
  screenshot_url: string | null;
  created_at: string;
}

/** How long a single sandbox lease lasts before the keep-alive extends it. */
export const LEASE_SECONDS = 15 * 60;
/** Client/watchdog keep-alive cadence — comfortably inside the lease. */
export const KEEPALIVE_MS = 4 * 60_000;
/** Hard ceiling for a single run (24h) so a runaway task always ends. */
export const MAX_RUN_MS = 24 * 60 * 60 * 1000;
