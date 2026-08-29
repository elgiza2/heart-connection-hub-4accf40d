/**
 * @doc Server-only Freestyle client used by the Dev Agent.
 * Covers everything the agent needs: VMs (exec / files / lifecycle), Git repos
 * (the project's real version history) and web deployments. Every call rotates
 * through the `freestyle_keys` pool with automatic failover, exactly like the
 * Manus key pool. Never import this from client code.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  availableFreestyleKeys,
  devAdminClient,
  markFreestyleFailure,
  markFreestyleSuccess,
  type FreestyleKeyRow,
} from "./keys";

const API_BASE = process.env.FREESTYLE_API_BASE || "https://api.freestyle.sh";

export class FreestyleError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FreestyleError";
    this.status = status;
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface VmInfo {
  id: string;
  domains: string[];
}

/** Statuses that are worth trying the next key for. */
function shouldRotate(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

export class FreestyleClient {
  private supabase: SupabaseClient;
  private keys: FreestyleKeyRow[] | null = null;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? devAdminClient();
  }

  private async keyPool(): Promise<FreestyleKeyRow[]> {
    if (!this.keys) this.keys = await availableFreestyleKeys(this.supabase);
    if (this.keys.length === 0) {
      throw new FreestyleError(500, "No active Freestyle key configured");
    }
    return this.keys;
  }

  /** One HTTP call against the Freestyle API, rotating keys on failure. */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = 300_000,
  ): Promise<T> {
    const keys = await this.keyPool();
    let lastStatus = 500;
    let lastMessage = "Freestyle request failed";

    for (const key of keys) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(`${API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${key.api_key}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await resp.text();
        const data = text ? safeJson(text) : {};

        if (resp.ok) {
          void markFreestyleSuccess(this.supabase, key);
          return data as T;
        }

        lastStatus = resp.status;
        lastMessage =
          (data as { message?: string; error?: string }).message ||
          (data as { error?: string }).error ||
          text.slice(0, 300) ||
          `HTTP ${resp.status}`;

        if (!shouldRotate(resp.status)) {
          throw new FreestyleError(lastStatus, lastMessage);
        }
        const retryAfter = Number(resp.headers.get("retry-after")) || undefined;
        await markFreestyleFailure(this.supabase, key, resp.status, lastMessage, retryAfter);
      } catch (err) {
        if (err instanceof FreestyleError) throw err;
        lastStatus = 599;
        lastMessage = err instanceof Error ? err.message : String(err);
        await markFreestyleFailure(this.supabase, key, lastStatus, lastMessage);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new FreestyleError(lastStatus, lastMessage);
  }

  // ---------------------------------------------------------------- VMs

  /**
   * Boots a VM. Port 3000 is exposed on 443 by default, so `domains[0]` is a
   * live preview URL as soon as a dev server listens on 3000.
   */
  async createVm(options: {
    idleTimeoutSeconds?: number | null;
    workdir?: string;
    snapshotId?: string;
    persistent?: boolean;
  } = {}): Promise<VmInfo> {
    const body: Record<string, unknown> = {
      waitForReadySignal: true,
      idleTimeoutSeconds: options.idleTimeoutSeconds ?? 900,
      workdir: options.workdir ?? "/app",
    };
    if (options.snapshotId) body.snapshotId = options.snapshotId;
    if (options.persistent) body.persistence = { strategy: "persistent" };

    const data = await this.request<{ id: string; domains?: string[] }>("POST", "/v1/vms", body);
    return { id: data.id, domains: data.domains ?? [] };
  }

  async getVm(vmId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/vms/${vmId}`);
  }

  async startVm(vmId: string): Promise<void> {
    await this.request("POST", `/v1/vms/${vmId}/start`, {});
  }

  async stopVm(vmId: string): Promise<void> {
    await this.request("POST", `/v1/vms/${vmId}/stop`, {});
  }

  async deleteVm(vmId: string): Promise<void> {
    await this.request("DELETE", `/v1/vms/${vmId}`);
  }

  /** Runs a shell command inside the VM and waits for it to finish. */
  async exec(vmId: string, command: string, timeoutMs = 240_000): Promise<ExecResult> {
    const data = await this.request<{
      stdout?: string | null;
      stderr?: string | null;
      statusCode?: number | null;
    }>("POST", `/v1/vms/${vmId}/exec-await`, { command, timeoutMs }, timeoutMs + 15_000);
    return {
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      exitCode: data.statusCode ?? 0,
    };
  }

  async writeFile(vmId: string, filepath: string, content: string): Promise<void> {
    await this.request("PUT", `/v1/vms/${vmId}/files/${encodePath(filepath)}`, {
      content,
      encoding: "utf8",
    });
  }

  async readFile(vmId: string, filepath: string): Promise<string> {
    const data = await this.request<{ content?: string; files?: unknown[] }>(
      "GET",
      `/v1/vms/${vmId}/files/${encodePath(filepath)}`,
    );
    if (typeof data.content !== "string") throw new FreestyleError(400, "Path is not a file");
    return data.content;
  }

  async listDir(vmId: string, dirpath: string): Promise<{ name: string; kind: string }[]> {
    const data = await this.request<{ files?: { name: string; kind: string }[] }>(
      "GET",
      `/v1/vms/${vmId}/files/${encodePath(dirpath)}`,
    );
    return data.files ?? [];
  }

  // ---------------------------------------------------------------- Git

  /** Creates a repo, optionally forking/importing from a public Git URL. */
  async createRepo(options: {
    name?: string;
    source?: { url: string; revision?: string; depth?: number };
    defaultBranch?: string;
  } = {}): Promise<string> {
    const body: Record<string, unknown> = {
      name: options.name ?? `dev-agent-${Date.now()}`,
      public: false,
      defaultBranch: options.defaultBranch ?? "main",
    };
    if (options.source) body.source = options.source;
    const data = await this.request<{ repoId: string }>("POST", "/git/v1/repo", body);
    return data.repoId;
  }

  async deleteRepo(repoId: string): Promise<void> {
    await this.request("DELETE", `/git/v1/repo/${repoId}`);
  }

  async listCommits(repoId: string, limit = 10): Promise<{ hash: string; message?: string }[]> {
    const data = await this.request<{ commits?: { hash: string; message?: string }[] }>(
      "GET",
      `/git/v1/repo/${repoId}/git/commits?limit=${limit}`,
    );
    return data.commits ?? [];
  }

  /** Git URL usable inside a VM (token is injected via an identity token). */
  gitUrl(repoId: string): string {
    return `https://git.freestyle.sh/${repoId}`;
  }

  /** Short-lived identity + token so the VM can push to the repo. */
  async createRepoToken(repoId: string): Promise<{ identityId: string; token: string }> {
    const identity = await this.request<{ id: string }>("POST", "/identity/v1/identities", {});
    const identityId = identity.id;
    await this.request("POST", `/identity/v1/identities/${identityId}/permissions/git`, {
      repoId,
      permission: "write",
    });
    const tokenResp = await this.request<{ token: string; id?: string }>(
      "POST",
      `/identity/v1/identities/${identityId}/tokens`,
      {},
    );
    return { identityId, token: tokenResp.token };
  }

  // ------------------------------------------------------------- Deploy

  /** Deploys a repo (or a directory inside it) to a live HTTPS domain. */
  async deployFromGit(options: {
    gitUrl: string;
    branch?: string;
    dir?: string;
    domains?: string[];
    build?: boolean | { command: string; outDir?: string };
    envVars?: Record<string, string>;
  }): Promise<{ deploymentId: string; domains: string[] }> {
    const data = await this.request<{ deploymentId: string; domains?: string[] | null }>(
      "POST",
      "/web/v1/deploy",
      {
        source: {
          kind: "git",
          url: options.gitUrl,
          branch: options.branch ?? "main",
          dir: options.dir ?? null,
        },
        config: {
          domains: options.domains ?? null,
          build: options.build ?? true,
          envVars: options.envVars ?? null,
          await: true,
        },
      },
      600_000,
    );
    return { deploymentId: data.deploymentId, domains: data.domains ?? options.domains ?? [] };
  }

  /** Deploys a plain map of files (used for tiny static outputs). */
  async deployFiles(
    files: Record<string, { content: string; encoding?: string }>,
    config: Record<string, unknown> = {},
  ): Promise<{ deploymentId: string; domains: string[] }> {
    const data = await this.request<{ deploymentId: string; domains?: string[] | null }>(
      "POST",
      "/web/v1/deploy",
      { source: { kind: "files", files }, config: { await: true, ...config } },
      600_000,
    );
    return { deploymentId: data.deploymentId, domains: data.domains ?? [] };
  }
}

function encodePath(p: string): string {
  return p.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
