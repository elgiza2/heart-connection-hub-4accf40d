/**
 * @doc Server-only tool layer for the Dev Agent.
 *
 * Everything the agent can physically do lives here: booting a VM, scaffolding
 * a real React 18 + Vite + TypeScript + Tailwind project, editing files,
 * running shell commands, building, committing to the project's Git repo,
 * importing a GitHub repo, wiring Supabase env vars and deploying.
 *
 * The agent loop only chooses which of these to call — it never talks to the
 * Freestyle API directly.
 */
import { FreestyleClient, type ExecResult } from "./freestyle";

const WORKDIR = "/app";

export interface ToolCall {
  tool: string;
  path?: string;
  content?: string;
  command?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

function clip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated, ${text.length - max} more chars)`;
}

/** A live project checkout inside one Freestyle VM. */
export class DevWorkspace {
  readonly client: FreestyleClient;
  readonly vmId: string;

  constructor(client: FreestyleClient, vmId: string) {
    this.client = client;
    this.vmId = vmId;
  }

  static async boot(
    client: FreestyleClient,
    existingVmId?: string | null,
  ): Promise<{ ws: DevWorkspace; vmId: string; previewUrl: string | null; reused: boolean }> {
    if (existingVmId) {
      try {
        await client.startVm(existingVmId);
        const info = (await client.getVm(existingVmId)) as { domains?: string[] };
        return {
          ws: new DevWorkspace(client, existingVmId),
          vmId: existingVmId,
          previewUrl: info.domains?.[0] ? `https://${info.domains[0]}` : null,
          reused: true,
        };
      } catch {
        /* VM was reaped — fall through and create a fresh one */
      }
    }
    const vm = await client.createVm({ workdir: WORKDIR, idleTimeoutSeconds: 1800 });
    return {
      ws: new DevWorkspace(client, vm.id),
      vmId: vm.id,
      previewUrl: vm.domains[0] ? `https://${vm.domains[0]}` : null,
      reused: false,
    };
  }

  bash(command: string, timeoutMs = 240_000): Promise<ExecResult> {
    return this.client.exec(this.vmId, `cd ${WORKDIR} && ${command}`, timeoutMs);
  }

  /** True when the workdir already holds a project. */
  async hasProject(): Promise<boolean> {
    const res = await this.bash("test -f package.json && echo yes || echo no", 30_000);
    return res.stdout.includes("yes");
  }

  /**
   * Scaffolds a real Vite + React 18 + TS + Tailwind + router app — not an
   * HTML page. Everything is installed inside the VM, so the agent works with
   * a genuine node_modules and a genuine build.
   */
  async scaffold(): Promise<ExecResult> {
    const script = [
      "npm create vite@latest . -- --template react-ts --yes",
      "npm pkg set dependencies.react=^18.3.1 dependencies.react-dom=^18.3.1",
      "npm install",
      "npm install react-router-dom lucide-react clsx",
      "npm install -D tailwindcss@^3.4.17 postcss autoprefixer",
      "npx tailwindcss init -p",
      `printf '%s\\n' "/** @type {import('tailwindcss').Config} */" "export default { content: ['./index.html','./src/**/*.{js,ts,jsx,tsx}'], theme: { extend: {} }, plugins: [] }" > tailwind.config.js`,
      `printf '%s\\n' "@tailwind base;" "@tailwind components;" "@tailwind utilities;" > src/index.css`,
    ].join(" && ");
    return this.bash(script, 420_000);
  }

  /** Imports a public GitHub repository into the workdir. */
  async importGithub(repoUrl: string, branch?: string): Promise<ExecResult> {
    const b = branch ? `-b ${branch}` : "";
    return this.bash(
      `rm -rf ./* ./.[!.]* 2>/dev/null; git clone --depth 1 ${b} ${repoUrl} . && (npm install || true)`,
      480_000,
    );
  }

  /** Starts the Vite dev server on port 3000 (the VM's public preview port). */
  async startDevServer(): Promise<void> {
    await this.bash(
      "pkill -f 'vite' || true; nohup npx vite --host 0.0.0.0 --port 3000 > /tmp/dev.log 2>&1 & sleep 4; true",
      60_000,
    );
  }

  async writeFile(path: string, content: string): Promise<void> {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) await this.bash(`mkdir -p ${JSON.stringify(dir)}`, 20_000);
    await this.client.writeFile(this.vmId, `${WORKDIR}/${path.replace(/^\/+/, "")}`, content);
  }

  async readFile(path: string): Promise<string> {
    return this.client.readFile(this.vmId, `${WORKDIR}/${path.replace(/^\/+/, "")}`);
  }

  /** Compact file tree the model can reason about, ignoring noise. */
  async tree(depth = 3): Promise<string> {
    const res = await this.bash(
      `find . -maxdepth ${depth} -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -160`,
      45_000,
    );
    return res.stdout.trim();
  }

  /** Type-checks + builds. This is the verifier's ground truth. */
  async build(): Promise<ExecResult> {
    return this.bash("npm run build 2>&1 | tail -60", 480_000);
  }

  /** Writes Supabase credentials the generated app can use. */
  async writeSupabaseEnv(url: string, anonKey: string): Promise<void> {
    await this.writeFile(".env", `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anonKey}\n`);
  }

  /** Commits everything and pushes to the project's Freestyle Git repo. */
  async commit(repoId: string, message: string): Promise<string | null> {
    const { token } = await this.client.createRepoToken(repoId);
    const remote = `https://x-access-token:${token}@git.freestyle.sh/${repoId}`;
    const script = [
      "git init -q 2>/dev/null || true",
      "git config user.email agent@megsy.dev",
      "git config user.name 'Dev Agent'",
      `printf '%s\\n' node_modules dist .env > .gitignore`,
      "git add -A",
      `git commit -q -m ${JSON.stringify(message)} || true`,
      "git branch -M main",
      `git remote remove origin 2>/dev/null; git remote add origin ${JSON.stringify(remote)}`,
      "git push -q -u origin main --force",
      "git rev-parse HEAD",
    ].join(" && ");
    const res = await this.bash(script, 240_000);
    const hash = res.stdout.trim().split("\n").pop() ?? "";
    return /^[0-9a-f]{7,40}$/.test(hash) ? hash : null;
  }
}

/** Executes one model-chosen tool call against the workspace. */
export async function runTool(ws: DevWorkspace, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case "write_file": {
        if (!call.path) return { ok: false, output: "write_file needs a path" };
        await ws.writeFile(call.path, call.content ?? "");
        return { ok: true, output: `wrote ${call.path} (${(call.content ?? "").length} chars)` };
      }
      case "read_file": {
        if (!call.path) return { ok: false, output: "read_file needs a path" };
        return { ok: true, output: clip(await ws.readFile(call.path), 6000) };
      }
      case "delete_file": {
        if (!call.path) return { ok: false, output: "delete_file needs a path" };
        await ws.bash(`rm -rf ${JSON.stringify(call.path)}`, 30_000);
        return { ok: true, output: `deleted ${call.path}` };
      }
      case "list_dir": {
        const res = await ws.bash(
          `ls -1 ${JSON.stringify(call.path || ".")} | head -100`,
          30_000,
        );
        return { ok: res.exitCode === 0, output: clip(res.stdout || res.stderr) };
      }
      case "bash": {
        if (!call.command) return { ok: false, output: "bash needs a command" };
        const res = await ws.bash(call.command);
        return {
          ok: res.exitCode === 0,
          output: clip(`exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`.trim()),
        };
      }
      case "build": {
        const res = await ws.build();
        return {
          ok: res.exitCode === 0,
          output: clip(`exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`.trim()),
        };
      }
      default:
        return { ok: false, output: `Unknown tool: ${call.tool}` };
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/** Free screenshot service — no key needed, used for the deploy card. */
export function screenshotUrl(siteUrl: string): string {
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(siteUrl)}?w=1200&h=800`;
}
