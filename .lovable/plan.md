# Making the agent behave like a human operator

## What exists today (after reviewing the code)

- Three separate agent systems, none unified:
  - **Computer Agent** (`src/lib/manus/agentCore.ts`) — thin proxy to an upstream provider: create / poll / stop. Has a single conversation summary in `computer_memory`.
  - **Long Run** (`src/lib/longrun/core.ts` + `supabase/functions/long-run`) — proxy to a cloud browser provider, streams steps into `long_run_events` over Supabase realtime. Sandbox lease 15 min, kept alive **by the open browser tab**.
  - **Dev Agent** (`src/lib/devagent/agentLoop.ts`) — the only real in-house loop (Router → Planner → Coder → Verifier), advanced in 50s slices, driven by **client polling**.
- Missing everywhere: durable cross-task memory, pause-and-ask, self-critique, loop detection, server-side continuation, parallel tools.

## What will be built

A shared orchestration layer (`src/lib/agentkernel/`) used by Long Run and the Computer Agent, plus the DB and UI pieces around it.

### 1. Real memory
New tables: `agent_memory` (facts scoped by user + optional `domain`, e.g. `booking.com` → "asks for OTP", `payment` → "prefers Vodafone Cash"), with `kind` (`site_fact` | `user_pref` | `credential_hint` | `failure_lesson`), `confidence`, `hits`, `last_used_at`.
- **Before** each run: relevant memories are selected by goal keywords + detected domains and injected into the prompt as a "What you already know" block.
- **After** each run (and on every pause/failure): a summarizer extracts new durable facts and upserts them, deduped by `(user_id, domain, key)`.

### 2. Stop and ask
- New `agent_questions` table (`run_id`, `question`, `options`, `answer`, `status`, `asked_at`, `answered_at`).
- The run enters `status = 'needs_input'` and stops burning provider time. Triggers: CAPTCHA / OTP / login wall detected, money above a per-user threshold, destructive action (delete, send, publish), or the model itself calling an `ask_user` tool.
- Chat UI renders an inline question card (quick-reply chips + free text). Answering writes the answer, resumes the run, and the answer is also stored as memory so the same question isn't asked twice.

### 3. Plan → execute → self-critique
- Phase `planning`: the model writes a numbered plan (stored in `agent_plans`, shown live in the UI) before any browser action.
- Phase `verifying`: after execution, the last screenshot + goal + plan go back to the model with a strict rubric ("was every step actually done? evidence?"). Verdict `pass` / `retry` / `ask`. `retry` re-enters execution with the critique appended (max 3 review rounds), `ask` goes to #2.

### 4. No repeated mistakes
- `agentkernel/loopGuard.ts` fingerprints each step (action + target + URL + screenshot hash). 2 identical fingerprints ⇒ inject a "change strategy" directive; 3 ⇒ escalate strategy (keyboard instead of click, direct URL instead of navigation, search instead of menu); 4 ⇒ pause and ask the user.
- Every escalation is written to memory as a `failure_lesson` so future runs skip the dead end.

### 5. Runs continue with the tab closed
- Server-side driver: a new public route `api/public/agent-tick` (with the cron auth helper) plus a Supabase `pg_cron` schedule every minute. It picks up runs whose heartbeat is stale, extends the sandbox lease, syncs provider state, and advances slices — no browser required.
- The client keeps its realtime subscription for live view, but is no longer load-bearing.
- On finish / failure / question: a notification row (existing notifications system) + optional web push, so the user gets pinged.

### 6. Multiple tools in one task
- Tool registry in `agentkernel/tools.ts` exposing `browser`, `web_search`, `write_file`, `read_file`, `run_code`, `ask_user`, `remember`. The model may return an **array** of tool calls; independent ones run with `Promise.all`, dependent ones sequentially, and each result is fed back into the loop. Tool choice is the model's, not the user's.

### 7. Two-hour-plus tasks
- Slice-based execution with checkpointing after every step, so any slice can die and be resumed.
- Lease auto-renewal from the server tick; `MAX_RUN_MS` raised to a configurable ceiling (default 6h) with a per-run budget in steps and provider minutes.
- Resume-after-provider-timeout: if the sandbox is reaped, a fresh sandbox is booted and the run continues from the checkpoint + memory instead of starting over.

## Technical notes

- One migration adds `agent_memory`, `agent_questions`, `agent_plans`, `agent_checkpoints`, plus columns on `long_runs` (`plan_id`, `review_round`, `budget_ms`, `needs_input`, `loop_strikes`). Every new public table gets explicit GRANTs and owner-only RLS via `auth.uid()`.
- Kernel code is server-only (`src/lib/agentkernel/*`), reused by both the Vercel `api/*` functions and the Supabase edge functions so dev and prod behave the same.
- Existing chat surfaces (`useLongRun`, `ServiceProgress`, `runDevTurn`) are extended, not replaced — no visual redesign.
- Verified end-to-end with the demo account you gave.

## Suggested order

1. Migration + memory read/write wired into Long Run (points 1, 4-lessons).
2. Pause-and-ask + inline question card (point 2).
3. Plan + self-critique phases and the loop guard (points 3, 4).
4. Server tick, cron, notifications, long-budget resume (points 5, 7).
5. Multi-tool registry (point 6).
