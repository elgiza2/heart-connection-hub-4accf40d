/**
 * @doc Server-only Dev Agent loop: Router → Planner → Coder → Verifier.
 *
 * Every invocation advances one bounded slice so it always fits inside a
 * serverless request; the client keeps calling `step` until the run is done.
 * State lives entirely in `dev_runs` / `dev_tasks` / `dev_events`, so a slice
 * can resume on a completely different worker.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { FreestyleClient } from "./freestyle";
import { DevWorkspace, runTool, screenshotUrl, type ToolCall } from "./tools";
import { askJson, askModel } from "./llm";

const SLICE_MS = 50_000;
const MAX_TOOLS_PER_SLICE = 6;
const MAX_BUILD_FIXES = 3;

export type Intent = "create" | "edit" | "question" | "deploy";

const ROUTER_SYSTEM = `You classify a user's request to a coding agent. Reply with JSON only:
{"intent":"create|edit|question|deploy","title":"<short project title>","github_url":"<url or null>"}
- "create": a brand new app/project.
- "edit": change, add to, or fix an existing project.
- "deploy": the user explicitly asks to publish / deploy / go live.
- "question": they only ask something, no code change needed.
Set github_url when the user asks to import an existing GitHub repository.`;

const PLANNER_SYSTEM = `You are the planner of an autonomous full-stack coding agent working in a real Linux VM
with a React 18 + Vite + TypeScript + Tailwind project.
Break the user's request into 2-8 concrete engineering tasks. Reply with JSON only:
{"tasks":["...","..."]}
Each task must be independently verifiable and touch real files. No task about deploying.`;

const CODER_SYSTEM = `You are the coder of an autonomous agent working inside a real Linux VM on a
React 18 + Vite + TypeScript + Tailwind project at /app. You output ONE tool call as JSON, nothing else:

{"thought":"<one short sentence>","tool":"write_file","path":"src/App.tsx","content":"<full file content>"}
{"thought":"...","tool":"read_file","path":"src/App.tsx"}
{"thought":"...","tool":"list_dir","path":"src"}
{"thought":"...","tool":"delete_file","path":"src/old.tsx"}
{"thought":"...","tool":"bash","command":"npm install zustand"}
{"thought":"...","tool":"build"}
{"thought":"...","tool":"done","summary":"<what you changed>"}

Rules:
- write_file always contains the COMPLETE final file, never a diff or placeholder.
- Build real, production-quality React components — multiple files, typed props, Tailwind styling.
- Never write index.html-only apps. Never use CDN React.
- Install any package you import, with bash, before using it.
- Do not repeat a failed action unchanged; change approach.
- Finish the current task with "done" as soon as it is complete.
- JSON only, no markdown fences.`;

interface RunRow {
  id: string;
  user_id: string;
  project_id: string | null;
  prompt: string;
  intent: string | null;
  status: string;
  step: number | null;
  allow_deploy: boolean | null;
  vm_id: string | null;
}

interface ProjectRow {
  id: string;
  vm_id: string | null;
  repo_id: string | null;
  preview_url: string | null;
  deploy_url: string | null;
  title: string | null;
  status: string | null;
}

async function event(
  db: SupabaseClient,
  run: RunRow,
  type: string,
  title: string,
  payload?: unknown,
) {
  await db.from("dev_events").insert({
    run_id: run.id,
    user_id: run.user_id,
    type,
    title: title.slice(0, 300),
    payload: payload ? (payload as Record<string, unknown>) : null,
  });
}

async function patchRun(db: SupabaseClient, run: RunRow, patch: Record<string, unknown>) {
  await db
    .from("dev_runs")
    .update({ ...patch, last_heartbeat_at: new Date().toISOString() })
    .eq("id", run.id);
}

/** Explicit deploy intent — deploying costs money, so we never guess. */
export function wantsDeploy(text: string): boolean {
  return /\b(deploy|publish|go\s*live|ship it)\b/i.test(text) ||
    /(انشر|أنشر|نشر|ارفع|إرفع|رفع الموقع|على الهوا|علي الهوا|لايف)/.test(text);
}

export async function classify(token: string, prompt: string) {
  const res = await askJson<{ intent?: Intent; title?: string; github_url?: string | null }>(
    token,
    ROUTER_SYSTEM,
    [{ role: "user", content: prompt }],
    45_000,
  );
  return {
    intent: (res?.intent ?? "edit") as Intent,
    title: res?.title?.slice(0, 80) || "Project",
    githubUrl: res?.github_url && /^https?:\/\//.test(res.github_url) ? res.github_url : null,
  };
}

async function plan(token: string, prompt: string, tree: string): Promise<string[]> {
  const res = await askJson<{ tasks?: string[] }>(token, PLANNER_SYSTEM, [
    {
      role: "user",
      content: `REQUEST:\n${prompt}\n\nCURRENT PROJECT FILES:\n${tree || "(empty project)"}`,
    },
  ]);
  const tasks = (res?.tasks ?? []).filter((t) => typeof t === "string" && t.trim()).slice(0, 8);
  return tasks.length ? tasks : [prompt];
}

/** Runs one bounded slice. Returns true when the whole run is finished. */
export async function advanceDevRun(
  db: SupabaseClient,
  run: RunRow,
  token: string,
): Promise<boolean> {
  const started = Date.now();
  const client = new FreestyleClient(db);

  // ---------------------------------------------------------------- project
  let project: ProjectRow | null = null;
  if (run.project_id) {
    const { data } = await db.from("dev_projects").select("*").eq("id", run.project_id).maybeSingle();
    project = (data as ProjectRow | null) ?? null;
  }
  if (!project) {
    await patchRun(db, run, { status: "error", error: "Project not found" });
    return true;
  }

  // ---------------------------------------------------------------- VM boot
  const boot = await DevWorkspace.boot(client, project.vm_id);
  const ws = boot.ws;
  if (boot.vmId !== project.vm_id || !project.preview_url) {
    await db
      .from("dev_projects")
      .update({ vm_id: boot.vmId, preview_url: boot.previewUrl, updated_at: new Date().toISOString() })
      .eq("id", project.id);
    project.vm_id = boot.vmId;
    project.preview_url = boot.previewUrl;
  }
  if (!run.vm_id) await patchRun(db, run, { vm_id: boot.vmId });

  // ---------------------------------------------------------------- repo
  if (!project.repo_id) {
    const repoId = await client.createRepo({ name: `proj-${project.id.slice(0, 8)}` });
    await db.from("dev_projects").update({ repo_id: repoId }).eq("id", project.id);
    project.repo_id = repoId;
  }

  // ---------------------------------------------------------------- scaffold
  if (!(await ws.hasProject())) {
    await event(db, run, "status", "تجهيز المشروع (React 18 + Vite + Tailwind)");
    const meta = (run as unknown as { metadata?: { github_url?: string } }).metadata;
    const githubUrl = meta?.github_url;
    const res = githubUrl ? await ws.importGithub(githubUrl) : await ws.scaffold();
    if (res.exitCode !== 0 && !(await ws.hasProject())) {
      await event(db, run, "error", "فشل تجهيز المشروع", { output: res.stderr.slice(0, 2000) });
      await patchRun(db, run, { status: "error", error: "Scaffold failed" });
      return true;
    }
    await ws.startDevServer();
    await event(db, run, "status", "المشروع جاهز والمعاينة شغالة", { preview: project.preview_url });
  }

  // ---------------------------------------------------------------- tasks
  const { data: taskRows } = await db
    .from("dev_tasks")
    .select("id,position,title,status")
    .eq("run_id", run.id)
    .order("position", { ascending: true });
  let tasks = (taskRows ?? []) as { id: string; position: number; title: string; status: string }[];

  if (tasks.length === 0) {
    const list = await plan(token, run.prompt, await ws.tree());
    const rows = list.map((title, i) => ({
      run_id: run.id,
      user_id: run.user_id,
      position: i,
      title,
      status: "pending",
    }));
    const { data: inserted } = await db.from("dev_tasks").insert(rows).select("id,position,title,status");
    tasks = (inserted ?? []) as typeof tasks;
    await event(db, run, "plan", `خطة من ${tasks.length} خطوات`, { tasks: list });
  }

  // ---------------------------------------------------------------- coding
  while (Date.now() - started < SLICE_MS) {
    const task = tasks.find((t) => t.status !== "done" && t.status !== "failed");
    if (!task) break;

    if (task.status === "pending") {
      await db.from("dev_tasks").update({ status: "running" }).eq("id", task.id);
      task.status = "running";
      await event(db, run, "task", task.title);
    }

    const { data: priorEvents } = await db
      .from("dev_events")
      .select("type,title,payload")
      .eq("run_id", run.id)
      .order("created_at", { ascending: true })
      .limit(120);
    const log = (priorEvents ?? [])
      .filter((e) => e.type === "tool")
      .slice(-14)
      .map((e) => {
        const p = (e.payload ?? {}) as { output?: string };
        return `- ${e.title}${p.output ? ` → ${String(p.output).slice(0, 500)}` : ""}`;
      });

    const reply = await askJson<ToolCall & { thought?: string; summary?: string }>(
      token,
      CODER_SYSTEM,
      [
        {
          role: "user",
          content: [
            `USER REQUEST: ${run.prompt}`,
            `CURRENT TASK: ${task.title}`,
            `PROJECT FILES:\n${await ws.tree()}`,
            log.length ? `RECENT ACTIONS:\n${log.join("\n")}` : "RECENT ACTIONS: (none yet)",
            "Reply with the next tool call as JSON only.",
          ].join("\n\n"),
        },
      ],
    );

    if (!reply?.tool) {
      await db.from("dev_tasks").update({ status: "failed", result: "no tool call" }).eq("id", task.id);
      task.status = "failed";
      continue;
    }

    if (reply.tool === "done") {
      await db
        .from("dev_tasks")
        .update({ status: "done", result: (reply.summary ?? "").slice(0, 1000) })
        .eq("id", task.id);
      task.status = "done";
      await event(db, run, "task_done", task.title, { summary: reply.summary ?? null });
      continue;
    }

    const result = await runTool(ws, reply);
    await event(
      db,
      run,
      "tool",
      `${reply.tool}${reply.path ? ` ${reply.path}` : reply.command ? ` ${String(reply.command).slice(0, 80)}` : ""}`,
      { ok: result.ok, output: result.output.slice(0, 3000), thought: reply.thought ?? null },
    );
    await patchRun(db, run, { step: (run.step ?? 0) + 1 });
    run.step = (run.step ?? 0) + 1;

    if (run.step > MAX_TOOLS_PER_SLICE * 20) break; // hard safety stop
  }

  const remaining = tasks.some((t) => t.status !== "done" && t.status !== "failed");
  if (remaining) {
    await patchRun(db, run, { status: "running" });
    return false;
  }

  // ---------------------------------------------------------------- verify
  await event(db, run, "status", "التحقق من البناء");
  let build = await ws.build();
  for (let i = 0; build.exitCode !== 0 && i < MAX_BUILD_FIXES; i++) {
    const fix = await askJson<ToolCall & { thought?: string }>(token, CODER_SYSTEM, [
      {
        role: "user",
        content: `The build failed. Fix it with ONE tool call.\n\nBUILD OUTPUT:\n${build.stdout.slice(-4000)}\n${build.stderr.slice(-2000)}\n\nPROJECT FILES:\n${await ws.tree()}`,
      },
    ]);
    if (!fix?.tool || fix.tool === "done") break;
    const r = await runTool(ws, fix);
    await event(db, run, "tool", `fix ${fix.tool} ${fix.path ?? ""}`.trim(), {
      ok: r.ok,
      output: r.output.slice(0, 2000),
    });
    build = await ws.build();
  }
  const buildOk = build.exitCode === 0;
  await event(db, run, buildOk ? "build_ok" : "build_failed", buildOk ? "البناء ناجح" : "البناء فشل", {
    output: build.stdout.slice(-2000),
  });

  // ---------------------------------------------------------------- commit
  await ws.startDevServer();
  let commit: string | null = null;
  if (project.repo_id) commit = await ws.commit(project.repo_id, run.prompt.slice(0, 120) || "update");
  if (commit) {
    await db
      .from("dev_projects")
      .update({ last_commit: commit, updated_at: new Date().toISOString() })
      .eq("id", project.id);
  }

  // ---------------------------------------------------------------- deploy
  let deployUrl: string | null = null;
  let shot: string | null = null;
  if (run.allow_deploy && buildOk && project.repo_id) {
    if (project.deploy_url && commit && commit === (project as { last_deployed_commit?: string }).last_deployed_commit) {
      deployUrl = project.deploy_url;
    } else {
      await event(db, run, "status", "جاري النشر");
      try {
        const dep = await client.deployFromGit({
          gitUrl: client.gitUrl(project.repo_id),
          branch: "main",
          build: { command: "npm install && npm run build", outDir: "dist" },
        });
        deployUrl = dep.domains[0] ? `https://${dep.domains[0]}` : null;
        shot = deployUrl ? screenshotUrl(deployUrl) : null;
        await db.from("dev_deploys").insert({
          user_id: run.user_id,
          project_id: project.id,
          run_id: run.id,
          commit,
          deployment_id: dep.deploymentId,
          url: deployUrl,
          screenshot_url: shot,
          status: "success",
        });
        await db
          .from("dev_projects")
          .update({
            deploy_url: deployUrl,
            screenshot_url: shot,
            last_deployed_commit: commit,
            updated_at: new Date().toISOString(),
          })
          .eq("id", project.id);
        await event(db, run, "deployed", "تم النشر", { url: deployUrl, screenshot: shot });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.from("dev_deploys").insert({
          user_id: run.user_id,
          project_id: project.id,
          run_id: run.id,
          commit,
          status: "failed",
          error: msg.slice(0, 500),
        });
        await event(db, run, "error", "فشل النشر", { error: msg.slice(0, 500) });
      }
    }
  }

  // ---------------------------------------------------------------- summary
  const summary = await askModel(
    token,
    "You summarize a coding agent's work for the user in the same language as the request. 2-4 short sentences, concrete, no fluff, no markdown headers.",
    [
      {
        role: "user",
        content: `REQUEST: ${run.prompt}\nTASKS: ${tasks.map((t) => `${t.title} [${t.status}]`).join("; ")}\nBUILD: ${buildOk ? "passed" : "failed"}\nPREVIEW: ${project.preview_url ?? "none"}\nDEPLOYED: ${deployUrl ?? "not deployed"}`,
      },
    ],
    60_000,
  );

  await patchRun(db, run, {
    status: buildOk ? "done" : "error",
    summary: (summary || "تم تنفيذ المطلوب.").slice(0, 4000),
    error: buildOk ? null : "Build failed",
    finished_at: new Date().toISOString(),
  });
  return true;
}
