import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import Docker from "dockerode";
import { v4 as uuidv4 } from "uuid";
import { getDockerConfig, getProjectsRoot } from "../config/docker";
import { TemplateEngine, CreateEnvironmentInput } from "./TemplateEngine";

const execFileAsync = promisify(execFile);

export type EnvironmentStatus = "running" | "stopped" | "error" | "provisioning";

export interface EnvironmentMeta {
  id: string;
  name: string;
  domain: string;
  webserver: string;
  runtime: string;
  database: string;
  status: EnvironmentStatus;
  createdAt: string;
  updatedAt: string;
  projectPath: string;
  publicUrl: string;
  errorMessage?: string;
}

export interface EnvironmentLogs {
  id: string;
  logs: string;
}

interface StoredRegistry {
  environments: EnvironmentMeta[];
}

export class DockerService {
  private readonly docker: Docker;
  private readonly templateEngine: TemplateEngine;
  private readonly projectsRoot: string;
  private readonly registryPath: string;
  private readonly proxyNetwork: string;

  constructor(templateEngine?: TemplateEngine) {
    const cfg = getDockerConfig();
    this.docker = new Docker(cfg.dockerodeOptions);
    this.templateEngine = templateEngine ?? new TemplateEngine();
    this.projectsRoot = getProjectsRoot();
    this.registryPath = path.join(this.projectsRoot, "registry.json");
    this.proxyNetwork = cfg.proxyNetwork;
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.projectsRoot, { recursive: true });
    await this.ensureProxyNetwork();
    await this.ensureRegistry();
  }

  async createEnvironment(input: CreateEnvironmentInput): Promise<EnvironmentMeta> {
    await this.ensureReady();

    const projectId = this.buildProjectId(input.name);
    const projectPath = path.join(this.projectsRoot, projectId);

    const meta: EnvironmentMeta = {
      id: projectId,
      name: input.name,
      domain: input.domain,
      webserver: input.webserver,
      runtime: input.runtime,
      database: input.database,
      status: "provisioning",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectPath,
      publicUrl: `http://${input.domain}`,
    };

    await this.upsertMeta(meta);

    try {
      await fs.mkdir(path.join(projectPath, "app"), { recursive: true });

      const rendered = await this.templateEngine.renderCompose({
        ...input,
        projectId,
        proxyNetwork: this.proxyNetwork,
      });

      await fs.writeFile(path.join(projectPath, "docker-compose.yml"), rendered.compose, "utf8");

      if (rendered.nginxConf) {
        await fs.writeFile(path.join(projectPath, "nginx.conf"), rendered.nginxConf, "utf8");
      }

      await fs.writeFile(
        path.join(projectPath, "app", "index.html"),
        this.bootstrapIndexHtml(input.name, input.domain, input.runtime),
        "utf8"
      );

      await fs.writeFile(
        path.join(projectPath, "meta.json"),
        JSON.stringify(meta, null, 2),
        "utf8"
      );

      await this.composeUp(projectPath);

      meta.status = "running";
      meta.updatedAt = new Date().toISOString();
      delete meta.errorMessage;
      await this.upsertMeta(meta);
      await fs.writeFile(path.join(projectPath, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

      return meta;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      meta.status = "error";
      meta.errorMessage = message;
      meta.updatedAt = new Date().toISOString();
      await this.upsertMeta(meta);
      throw error;
    }
  }

  async listEnvironments(): Promise<EnvironmentMeta[]> {
    await this.ensureReady();
    const registry = await this.readRegistry();
    const refreshed = await Promise.all(
      registry.environments.map(async (env) => {
        const live = await this.resolveLiveStatus(env);
        return live;
      })
    );

    await this.writeRegistry({ environments: refreshed });
    return refreshed;
  }

  async getEnvironment(id: string): Promise<EnvironmentMeta | null> {
    const all = await this.listEnvironments();
    return all.find((e) => e.id === id) ?? null;
  }

  async startEnvironment(id: string): Promise<EnvironmentMeta> {
    const env = await this.requireEnvironment(id);
    await this.composeUp(env.projectPath);
    env.status = "running";
    env.updatedAt = new Date().toISOString();
    delete env.errorMessage;
    await this.upsertMeta(env);
    return env;
  }

  async stopEnvironment(id: string): Promise<EnvironmentMeta> {
    const env = await this.requireEnvironment(id);
    await this.composeDown(env.projectPath);
    env.status = "stopped";
    env.updatedAt = new Date().toISOString();
    await this.upsertMeta(env);
    return env;
  }

  async getLogs(id: string, tail = 200): Promise<EnvironmentLogs> {
    const env = await this.requireEnvironment(id);
    try {
      const { stdout, stderr } = await execFileAsync(
        "docker",
        ["compose", "-f", path.join(env.projectPath, "docker-compose.yml"), "logs", "--no-color", "--tail", String(tail)],
        { cwd: env.projectPath, maxBuffer: 10 * 1024 * 1024 }
      );
      return { id, logs: `${stdout}${stderr}`.trim() || "(sem logs)" };
    } catch (error) {
      // Fallback: collect logs from containers labeled with this project
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`docktopus.project.id=${id}`] },
      });

      if (!containers.length) {
        const message = error instanceof Error ? error.message : String(error);
        return { id, logs: `Não foi possível obter logs: ${message}` };
      }

      const chunks: string[] = [];
      for (const summary of containers) {
        const container = this.docker.getContainer(summary.Id);
        const buffer = (await container.logs({
          stdout: true,
          stderr: true,
          tail,
          timestamps: true,
        })) as Buffer;
        chunks.push(`=== ${summary.Names?.[0] ?? summary.Id.slice(0, 12)} ===\n${this.demuxDockerLogs(buffer)}`);
      }

      return { id, logs: chunks.join("\n\n") };
    }
  }

  /** Stream container logs via dockerode (used by SSE endpoint). */
  async streamLogs(
    id: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    await this.requireEnvironment(id);

    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`docktopus.project.id=${id}`] },
    });

    if (!containers.length) {
      onChunk("Nenhum container encontrado para este ambiente.\n");
      return;
    }

    const streams: NodeJS.ReadableStream[] = [];

    for (const summary of containers) {
      const container = this.docker.getContainer(summary.Id);
      const stream = (await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 50,
        timestamps: true,
      })) as NodeJS.ReadableStream;

      streams.push(stream);
      stream.on("data", (buf: Buffer) => {
        onChunk(`[${summary.Names?.[0] ?? "container"}] ${this.demuxDockerLogs(buf)}`);
      });
    }

    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        streams.forEach((s) => (s as { destroy?: () => void }).destroy?.());
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => {
        streams.forEach((s) => (s as { destroy?: () => void }).destroy?.());
        resolve();
      });
    });
  }

  private async composeUp(projectPath: string): Promise<void> {
    await execFileAsync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "up", "-d", "--remove-orphans"],
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    );
  }

  private async composeDown(projectPath: string): Promise<void> {
    await execFileAsync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "stop"],
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    );
  }

  private async resolveLiveStatus(env: EnvironmentMeta): Promise<EnvironmentMeta> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`docktopus.project.id=${env.id}`] },
      });

      if (!containers.length) {
        if (env.status === "provisioning") return env;
        return { ...env, status: "stopped", updatedAt: new Date().toISOString() };
      }

      const running = containers.some((c) => c.State === "running");
      const hasError = containers.some((c) => c.State === "exited" && (c.Status ?? "").includes("Error"));

      let status: EnvironmentStatus = "stopped";
      if (running) status = "running";
      else if (hasError) status = "error";

      return { ...env, status, updatedAt: new Date().toISOString() };
    } catch {
      return { ...env, status: "error", errorMessage: "Falha ao consultar Docker Engine" };
    }
  }

  private async ensureProxyNetwork(): Promise<void> {
    const networks = await this.docker.listNetworks({
      filters: { name: [this.proxyNetwork] },
    });

    const exists = networks.some((n) => n.Name === this.proxyNetwork);
    if (!exists) {
      await this.docker.createNetwork({
        Name: this.proxyNetwork,
        Driver: "bridge",
        Labels: { "docktopus.managed": "true" },
      });
    }
  }

  private buildProjectId(name: string): string {
    const slug = name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    return `${slug || "proj"}-${uuidv4().slice(0, 8)}`;
  }

  private bootstrapIndexHtml(name: string, domain: string, runtime: string): string {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background:#0b1220; color:#e2e8f0; display:grid; place-items:center; min-height:100vh; margin:0; }
    .card { max-width:480px; padding:2rem; border:1px solid #1e293b; border-radius:16px; background:#111827; }
    h1 { margin:0 0 .5rem; font-size:1.5rem; }
    p { margin:.35rem 0; color:#94a3b8; }
    code { color:#38bdf8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${name}</h1>
    <p>Ambiente provisionado pelo <strong>Docktopus</strong>.</p>
    <p>Domínio: <code>${domain}</code></p>
    <p>Runtime: <code>${runtime}</code></p>
  </div>
</body>
</html>`;
  }

  private demuxDockerLogs(buffer: Buffer): string {
    // dockerode multiplexed stream: 8-byte header + payload
    if (buffer.length < 8) return buffer.toString("utf8");

    const parts: string[] = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset + 4);
      const start = offset + 8;
      const end = start + size;
      if (end > buffer.length) {
        parts.push(buffer.slice(offset).toString("utf8"));
        break;
      }
      parts.push(buffer.slice(start, end).toString("utf8"));
      offset = end;
    }
    return parts.join("");
  }

  private async requireEnvironment(id: string): Promise<EnvironmentMeta> {
    const registry = await this.readRegistry();
    const env = registry.environments.find((e) => e.id === id);
    if (!env) {
      throw Object.assign(new Error(`Ambiente '${id}' não encontrado`), { statusCode: 404 });
    }
    return env;
  }

  private async ensureRegistry(): Promise<void> {
    try {
      await fs.access(this.registryPath);
    } catch {
      await this.writeRegistry({ environments: [] });
    }
  }

  private async readRegistry(): Promise<StoredRegistry> {
    try {
      const raw = await fs.readFile(this.registryPath, "utf8");
      return JSON.parse(raw) as StoredRegistry;
    } catch {
      return { environments: [] };
    }
  }

  private async writeRegistry(data: StoredRegistry): Promise<void> {
    await fs.writeFile(this.registryPath, JSON.stringify(data, null, 2), "utf8");
  }

  private async upsertMeta(meta: EnvironmentMeta): Promise<void> {
    const registry = await this.readRegistry();
    const idx = registry.environments.findIndex((e) => e.id === meta.id);
    if (idx >= 0) registry.environments[idx] = meta;
    else registry.environments.unshift(meta);
    await this.writeRegistry(registry);
  }
}
