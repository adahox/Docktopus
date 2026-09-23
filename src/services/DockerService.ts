import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import Docker from "dockerode";
import { v4 as uuidv4 } from "uuid";
import { getDockerConfig, getProjectsRoot, buildPublicUrl } from "../config/docker";
import { publishEnvironment, RealtimePhase } from "./RealtimeHub";
import {
  TemplateEngine,
  CreateEnvironmentInput,
  ApplicationSpec,
  ApplicationSshInfo,
  WebserverSpec,
  DatabaseSpec,
  DatabaseConnectionInfo,
  EnvVar,
  RuntimeChoice,
  databaseFamily,
  normalizeCreateInput,
  linkedDatabaseIds,
  renderFail2banJail,
  renderFail2banFilter,
  canvasNetworkName,
  type Fail2banSpec,
} from "./TemplateEngine";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);

export type EnvironmentStatus = "running" | "stopped" | "error" | "provisioning";

export interface EnvironmentConfig {
  webservers: WebserverSpec[];
  applications: ApplicationSpec[];
  databases: DatabaseSpec[];
  databaseConnections: DatabaseConnectionInfo[];
  sshConnections: ApplicationSshInfo[];
  /** Legacy mirrors (1º banco / env compartilhado). */
  dbName: string | null;
  dbUser: string | null;
  dbPassword: string | null;
  dbRootPassword: string | null;
  envVars: EnvVar[];
  databaseConnection: DatabaseConnectionInfo | null;
  links?: import("./TemplateEngine").ServiceLink[];
  networks?: import("./TemplateEngine").CanvasNetwork[];
  positions?: Record<string, import("./TemplateEngine").CanvasPoint>;
  fail2ban?: import("./TemplateEngine").Fail2banSpec;
}

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
  config?: EnvironmentConfig;
  webservers?: WebserverSpec[];
  applications?: ApplicationSpec[];
  databases?: DatabaseSpec[];
}

export interface EnvironmentContainerInfo {
  id: string;
  name: string;
  state: string;
  status: string;
  image: string;
}

export interface EnvironmentDetails extends EnvironmentMeta {
  containers: EnvironmentContainerInfo[];
  runtimePort: number;
  backendHost: string;
  publicUrls: Array<{
    appId?: string;
    webId?: string;
    name: string;
    url: string;
    subdomain: string;
    via: "webserver" | "application";
  }>;
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
  private readonly traefikHttpPort: number;
  private readonly publicScheme: "http" | "https";
  private readonly traefikDynamicDir: string;

  constructor(templateEngine?: TemplateEngine) {
    const cfg = getDockerConfig();
    this.docker = new Docker(cfg.dockerodeOptions);
    this.templateEngine = templateEngine ?? new TemplateEngine();
    this.projectsRoot = getProjectsRoot();
    this.registryPath = path.join(this.projectsRoot, "registry.json");
    this.proxyNetwork = cfg.proxyNetwork;
    this.traefikHttpPort = cfg.traefikHttpPort;
    this.publicScheme = cfg.publicScheme;
    this.traefikDynamicDir =
      process.env.TRAEFIK_DYNAMIC_DIR ||
      path.resolve(process.cwd(), "infra/traefik/dynamic");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.projectsRoot, { recursive: true });
    await fs.mkdir(this.traefikDynamicDir, { recursive: true });
    await this.ensureProxyNetwork();
    await this.ensureRegistry();
    await this.migrateLegacyEnvironments();
    await this.syncTraefikRoutes();
    await this.healMissingDbPortMappings();
  }

  private async migrateLegacyEnvironments(): Promise<void> {
    const registry = await this.readRegistry();
    let changed = false;

    for (const env of registry.environments) {
      const composePath = path.join(env.projectPath, "docker-compose.yml");
      let compose = "";
      try {
        compose = await fs.readFile(composePath, "utf8");
      } catch {
        compose = "";
      }

      const hasNewShape = Boolean(env.config?.applications?.length);
      const composeIsModern = compose.includes("./apps/");
      const hasWebserversArray = Array.isArray(env.config?.webservers);
      const hasSsh =
        Array.isArray(env.config?.sshConnections) &&
        env.config.sshConnections.length === (env.config.applications?.length || 0);
      const hasEmbeddedWeb =
        env.config?.applications?.some(
          (a) => a.webserver && a.webserver !== "none"
        ) ?? false;
      const composeHasOrphanWeb =
        /(^|\n)\s+[a-z0-9-]+:\s*\n(?:.*\n)*?\s+image:\s*nginx:/m.test(compose) &&
        !compose.includes("docktopus.role=webserver");

      if (
        hasNewShape &&
        composeIsModern &&
        hasWebserversArray &&
        hasSsh &&
        !hasEmbeddedWeb &&
        !composeHasOrphanWeb
      ) {
        continue;
      }

      const input = normalizeCreateInput({
        name: env.name,
        domain: env.domain,
        webserver: env.webserver,
        runtime: env.runtime,
        database: env.database,
        dbName: env.config?.dbName,
        dbUser: env.config?.dbUser,
        dbPassword: env.config?.dbPassword,
        dbRootPassword: env.config?.dbRootPassword,
        envVars: env.config?.envVars,
        webservers: env.config?.webservers,
        applications: env.config?.applications,
        databases:
          env.config?.databases?.length
            ? env.config.databases
            : env.database && env.database !== "none"
              ? [
                  {
                    id: "db",
                    name: "db",
                    engine: env.database,
                    dbName: env.config?.dbName,
                    dbUser: env.config?.dbUser,
                    dbPassword: env.config?.dbPassword,
                    dbRootPassword: env.config?.dbRootPassword,
                    hostPort: env.config?.databaseConnection?.hostPort,
                  },
                ]
              : [],
      });

      // Preserve published port from legacy connection when id becomes db
      if (
        input.databases[0] &&
        !input.databases[0].hostPort &&
        env.config?.databaseConnection?.hostPort
      ) {
        input.databases[0].hostPort = env.config.databaseConnection.hostPort;
      }

      try {
        const { config } = await this.writeStackFiles(
          env.id,
          env.projectPath,
          input,
          env.config?.databases,
          env.config?.sshConnections
        );
        env.config = config;
        env.webservers = input.webservers;
        env.applications = input.applications;
        env.databases = config.databases;
        this.mirrorLegacyFields(env, input.webservers, input.applications, config.databases);
        await this.composeRecreate(env.projectPath);
        await this.writeTraefikRoutes(env.id, input.webservers, input.applications);
        changed = true;
      } catch (error) {
        console.error(`[docktopus] falha ao migrar stack ${env.id}:`, error);
      }
    }

    if (changed) await this.writeRegistry({ environments: registry.environments });
  }

  private buildConfig(
    webservers: WebserverSpec[],
    applications: ApplicationSpec[],
    databases: DatabaseSpec[],
    connections: DatabaseConnectionInfo[],
    envVars: EnvVar[],
    sshConnections: ApplicationSshInfo[] = [],
    links?: import("./TemplateEngine").ServiceLink[],
    networks?: import("./TemplateEngine").CanvasNetwork[],
    positions?: Record<string, import("./TemplateEngine").CanvasPoint>,
    fail2ban?: import("./TemplateEngine").Fail2banSpec
  ): EnvironmentConfig {
    const first = connections[0] ?? null;
    const firstSql = connections.find(
      (c) => databaseFamily(c.engine) === "mysql" || databaseFamily(c.engine) === "postgres"
    );
    return {
      webservers: webservers || [],
      applications,
      databases,
      databaseConnections: connections,
      sshConnections,
      dbName: firstSql?.name ?? null,
      dbUser: firstSql?.user ?? null,
      dbPassword: firstSql?.password ?? first?.password ?? null,
      dbRootPassword: firstSql?.rootPassword ?? null,
      envVars,
      databaseConnection: first,
      links,
      networks,
      positions,
      fail2ban,
    };
  }

  private mirrorLegacyFields(
    env: EnvironmentMeta,
    webservers: WebserverSpec[],
    applications: ApplicationSpec[],
    databases: DatabaseSpec[]
  ): void {
    const app = applications[0];
    const db = databases[0];
    const hosts = TemplateEngine.collectPublicHosts(webservers, applications);
    if (app) {
      env.webserver = webservers[0]?.engine || "none";
      env.runtime = app.runtime;
      env.domain = hosts[0] || app.subdomain || env.domain;
    } else {
      env.webserver = webservers[0]?.engine || "none";
    }
    env.database = db?.engine ?? "none";
    env.webservers = webservers;
    env.applications = applications;
    env.databases = databases;
  }

  private async healMissingDbPortMappings(): Promise<void> {
    const registry = await this.readRegistry();
    let changed = false;

    for (const env of registry.environments) {
      const config = env.config;
      if (!config?.databases?.length) continue;

      const composePath = path.join(env.projectPath, "docker-compose.yml");
      let compose = "";
      try {
        compose = await fs.readFile(composePath, "utf8");
      } catch {
        continue;
      }

      const needsHeal = config.databases.some((db) => {
        if (!db.hostPort) return true;
        return !(
          compose.includes(`"${db.hostPort}:`) ||
          compose.includes(`'${db.hostPort}:`) ||
          new RegExp(`\\b${db.hostPort}:\\d+`).test(compose)
        );
      });

      if (!needsHeal) continue;

      try {
        const input = this.toCreateInput(env, config);
        await this.writeStackFiles(
          env.id,
          env.projectPath,
          input,
          config.databases,
          config.sshConnections
        );
        for (const db of config.databases) {
          await this.composeUpService(env.projectPath, db.id);
        }
        changed = true;
      } catch (error) {
        console.error(`[docktopus] falha ao publicar portas DB em ${env.id}:`, error);
      }
    }

    if (changed) await this.writeRegistry({ environments: registry.environments });
  }

  private toCreateInput(env: EnvironmentMeta, config: EnvironmentConfig): CreateEnvironmentInput {
    return {
      name: env.name,
      domain: env.domain,
      webservers: config.webservers || [],
      applications: config.applications?.length
        ? config.applications
        : [
            {
              id: "app",
              name: "app",
              subdomain: env.domain,
              runtime: (env.runtime === "go" ? "go122" : env.runtime) as RuntimeChoice,
            },
          ],
      databases: config.databases || [],
      envVars: config.envVars,
      links: config.links,
      networks: config.networks,
      positions: config.positions,
      fail2ban: config.fail2ban,
    };
  }

  private assertComposePublishesDbPorts(compose: string, databases: DatabaseSpec[]): void {
    for (const db of databases) {
      if (!db.hostPort) {
        throw new Error(`Porta externa do banco '${db.id}' não foi alocada no cadastro.`);
      }
      const mapped =
        compose.includes(`"${db.hostPort}:`) ||
        compose.includes(`'${db.hostPort}:`) ||
        new RegExp(`ports:[\\s\\S]*?\\b${db.hostPort}:\\d+`).test(compose);
      if (!mapped) {
        throw new Error(
          `Compose sem mapeamento de porta do banco ${db.id} (${db.hostPort}).`
        );
      }
    }
  }

  private async writeStackFiles(
    projectId: string,
    projectPath: string,
    input: CreateEnvironmentInput,
    previousDatabases?: DatabaseSpec[],
    previousSsh?: ApplicationSshInfo[]
  ): Promise<{ config: EnvironmentConfig; renderedCompose: string }> {
    const reserved = await this.collectUsedHostPorts(projectId);
    for (const ssh of previousSsh || []) {
      if (ssh.hostPort) reserved.add(ssh.hostPort);
    }
    for (const app of input.applications) {
      if (!app.hostPort) continue;
      if (reserved.has(app.hostPort)) {
        throw Object.assign(
          new Error(`Porta externa ${app.hostPort} da aplicação '${app.name || app.id}' já está em uso`),
          { statusCode: 409 }
        );
      }
      reserved.add(app.hostPort);
    }
    const databases = TemplateEngine.withAllocatedPorts(
      projectId,
      input.databases,
      previousDatabases,
      reserved
    );
    for (const db of databases) {
      if (db.hostPort) reserved.add(db.hostPort);
    }

    const keyPairs: Record<string, { publicKey: string; privateKey: string }> = {};
    const prevSshByApp = new Map((previousSsh || []).map((s) => [s.appId, s]));
    for (const app of input.applications) {
      const prev = prevSshByApp.get(app.id);
      if (prev?.publicKey && prev?.privateKey) continue;
      keyPairs[app.id] = await this.generateSshKeyPair(app.id);
    }

    const sshConnections = TemplateEngine.withAllocatedSsh(
      projectId,
      input.applications,
      previousSsh,
      reserved,
      keyPairs
    );

    const connections = databases.map((d) =>
      TemplateEngine.buildDatabaseConnection(d, { projectId, hostPort: d.hostPort })
    );
    const sharedEnv = TemplateEngine.buildAppEnvVars(databases, connections, input.envVars);
    const appEnvVars: Record<string, EnvVar[]> = {};
    for (const app of input.applications) {
      if (!input.links) {
        appEnvVars[app.id] = sharedEnv;
        continue;
      }
      const allowed = new Set(linkedDatabaseIds(app.id, input.links));
      appEnvVars[app.id] = TemplateEngine.buildAppEnvVars(
        databases.filter((db) => allowed.has(db.id)),
        connections.filter((db) => allowed.has(db.id)),
        input.envVars
      );
    }

    const webservers = input.webservers || [];
    const networks = await this.preferLiveSubnets(projectId, input.networks || []);
    const existingNetworks = await this.existingNetworkKeys(projectId);
    const rendered = await this.templateEngine.renderCompose({
      ...input,
      networks,
      existingNetworks,
      webservers,
      databases,
      projectId,
      proxyNetwork: this.proxyNetwork,
      appEnvVars,
      sshConnections,
    });

    this.assertComposePublishesDbPorts(rendered.compose, databases);
    await fs.writeFile(path.join(projectPath, "docker-compose.yml"), rendered.compose, "utf8");

    try {
      const files = await fs.readdir(projectPath);
      await Promise.all(
        files
          .filter(
            (f) =>
              (f.startsWith("nginx-") || f.startsWith("apache-")) && f.endsWith(".conf")
          )
          .map((f) => fs.unlink(path.join(projectPath, f)).catch(() => undefined))
      );
      await fs.unlink(path.join(projectPath, "nginx.conf")).catch(() => undefined);
    } catch {
      // ok
    }

    for (const conf of rendered.nginxConfs) {
      await fs.writeFile(path.join(projectPath, conf.filename), conf.content, "utf8");
    }

    for (const app of input.applications) {
      const appDir = path.join(projectPath, "apps", app.id);
      await fs.mkdir(appDir, { recursive: true });
      if (app.source === "project") {
        await this.ensureProjectDocker(appDir, app.composeFile || "docker-compose.yml", app.composeService || "app", app.containerPort || 80);
        continue;
      }
      if (app.framework === "laravel" && app.runtime.startsWith("php")) {
        await this.writeLaravelFiles(appDir, app.runtime);
        continue;
      }
      if ((app.framework === "next" || app.framework === "adonis") && app.runtime.startsWith("node")) {
        await this.writeNodeFrameworkFiles(appDir, app.runtime, app.framework);
        continue;
      }
      if (app.framework === "django" && app.runtime.startsWith("python")) {
        await this.writeDjangoFiles(appDir, app.runtime);
        continue;
      }
      const indexPath = path.join(appDir, "index.html");
      try {
        await fs.access(indexPath);
      } catch {
        await fs.writeFile(
          indexPath,
          this.bootstrapIndexHtml(
            app.name || input.name,
            app.subdomain || input.domain,
            app.runtime
          ),
          "utf8"
        );
      }
    }

    for (const ssh of sshConnections) {
      const sshDir = path.join(projectPath, "ssh", ssh.appId);
      await fs.mkdir(sshDir, { recursive: true });
      await fs.writeFile(path.join(sshDir, "authorized_keys"), `${ssh.publicKey.trim()}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });
      await fs.writeFile(path.join(sshDir, "id_ed25519"), ssh.privateKey, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.writeFile(path.join(sshDir, "id_ed25519.pub"), `${ssh.publicKey.trim()}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });
      await fs.writeFile(
        path.join(sshDir, "connection.txt"),
        [
          `host: 127.0.0.1`,
          `port: ${ssh.hostPort}`,
          `user: ${ssh.user}`,
          `password: ${ssh.password}`,
          `command: ${ssh.command}`,
          `workspace: /config/workspace`,
          "",
          `# chave privada: ssh/${ssh.appId}/id_ed25519`,
          `# ${ssh.command} -i ssh/${ssh.appId}/id_ed25519`,
          "",
        ].join("\n"),
        "utf8"
      );
    }

    // Migrate legacy ./app -> apps/app if present
    const legacyApp = path.join(projectPath, "app");
    const primaryApp = input.applications[0];
    if (primaryApp) {
      try {
        await fs.access(legacyApp);
        const target = path.join(projectPath, "apps", primaryApp.id);
        await fs.mkdir(target, { recursive: true });
        const entries = await fs.readdir(legacyApp);
        for (const entry of entries) {
          await fs
            .rename(path.join(legacyApp, entry), path.join(target, entry))
            .catch(async () => {
              await fs.cp(path.join(legacyApp, entry), path.join(target, entry), {
                recursive: true,
                force: false,
              });
            });
        }
      } catch {
        // no legacy folder
      }
    }

    const config = this.buildConfig(
      webservers,
      input.applications,
      databases,
      connections,
      sharedEnv,
      sshConnections,
      input.links,
      networks,
      input.positions,
      input.fail2ban
    );
    if (input.fail2ban?.enabled) {
      await this.writeFail2banFiles(projectPath, projectId, input.fail2ban);
    }
    await fs.writeFile(
      path.join(projectPath, "config.json"),
      JSON.stringify({ input: { ...input, webservers, databases }, config }, null, 2),
      "utf8"
    );

    return { config, renderedCompose: rendered.compose };
  }

  private async generateSshKeyPair(
    comment: string
  ): Promise<{ publicKey: string; privateKey: string }> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "docktopus-ssh-"));
    const keyPath = path.join(dir, "id_ed25519");
    try {
      await execFileAsync(
        "ssh-keygen",
        ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", `docktopus-${comment}`],
        { maxBuffer: 1024 * 1024 }
      );
      const privateKey = await fs.readFile(keyPath, "utf8");
      const publicKey = (await fs.readFile(`${keyPath}.pub`, "utf8")).trim();
      return { privateKey, publicKey };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async createEnvironment(input: CreateEnvironmentInput): Promise<EnvironmentMeta> {
    await this.ensureReady();
    await this.assertSubdomainsAvailable(input.webservers || [], input.applications);

    const projectId = this.buildProjectId(input.name);
    const projectPath = path.join(this.projectsRoot, projectId);
    const hosts = TemplateEngine.collectPublicHosts(input.webservers || [], input.applications);
    const primaryHost = hosts[0] || input.domain;

    const meta: EnvironmentMeta = {
      id: projectId,
      name: input.name,
      domain: primaryHost,
      webserver: input.webservers?.[0]?.engine || "none",
      runtime: input.applications[0]?.runtime || "php82",
      database: input.databases[0]?.engine || "none",
      status: "provisioning",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectPath,
      publicUrl: buildPublicUrl(primaryHost, {
        traefikHttpPort: this.traefikHttpPort,
        publicScheme: this.publicScheme,
      }),
      webservers: input.webservers || [],
      applications: input.applications,
      databases: input.databases,
    };

    await this.upsertMeta(meta);
    this.emit(projectId, "provisioning", `Preparando o ambiente ${input.name}`, input.name);
    void this.provisionEnvironment(meta, input);
    return meta;
  }

  private async provisionEnvironment(meta: EnvironmentMeta, input: CreateEnvironmentInput): Promise<void> {
    const projectId = meta.id;
    const projectPath = meta.projectPath;
    try {
      await fs.mkdir(path.join(projectPath, "apps"), { recursive: true });
      this.emit(projectId, "log", "Gerando compose, SSH e rotas", input.name);
      const { config } = await this.writeStackFiles(projectId, projectPath, input);
      meta.config = config;
      meta.databases = config.databases;
      this.mirrorLegacyFields(
        meta,
        input.webservers || [],
        input.applications,
        config.databases
      );

      await fs.writeFile(path.join(projectPath, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

      this.emit(projectId, "pulling", "Baixando imagens e subindo containers", input.name);
      await this.composeUp(projectPath);
      await this.waitForLaravelApps(projectId, projectPath, input);
      this.emit(projectId, "starting", "Publicando rotas no Traefik", input.name);
      await this.writeTraefikRoutes(
        projectId,
        input.webservers || [],
        input.applications
      );

      meta.status = "running";
      this.emit(projectId, "running", `Ambiente ${input.name} liberado`, input.name);
      meta.updatedAt = new Date().toISOString();
      delete meta.errorMessage;
      await this.upsertMeta(meta);
      await fs.writeFile(path.join(projectPath, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      meta.status = "error";
      meta.errorMessage = message;
      meta.updatedAt = new Date().toISOString();
      this.emit(projectId, "error", message, input.name);
      await this.upsertMeta(meta);
    }
  }

  async listEnvironments(): Promise<EnvironmentMeta[]> {
    await this.ensureReady();
    const registry = await this.readRegistry();
    const refreshed = await Promise.all(
      registry.environments.map(async (env) => {
        const live = await this.resolveLiveStatus(env);
        const domain = live.applications?.[0]?.subdomain || live.domain;
        return {
          ...live,
          publicUrl: buildPublicUrl(domain, {
            traefikHttpPort: this.traefikHttpPort,
            publicScheme: this.publicScheme,
          }),
        };
      })
    );

    await this.writeRegistry({ environments: refreshed });
    return refreshed;
  }

  async getEnvironment(id: string): Promise<EnvironmentMeta | null> {
    const all = await this.listEnvironments();
    return all.find((e) => e.id === id) ?? null;
  }

  async getEnvironmentDetails(id: string): Promise<EnvironmentDetails> {
    const env = await this.requireEnvironment(id);
    const live = await this.resolveLiveStatus(env);
    const config = await this.loadEnvironmentConfig(live);

    const containersRaw = await this.docker.listContainers({
      all: true,
      filters: { label: [`docktopus.project.id=${id}`] },
    });

    const containers: EnvironmentContainerInfo[] = containersRaw.map((c) => ({
      id: c.Id.slice(0, 12),
      name: (c.Names?.[0] || "").replace(/^\//, ""),
      state: c.State,
      status: c.Status,
      image: c.Image,
    }));

    const apps = config.applications;
    const webservers = config.webservers || [];
    const primary = apps[0];
    const backend = primary
      ? TemplateEngine.resolveBackend(live.id, primary)
      : { host: `${live.id}-app`, port: 8080 };

    const endpoints = TemplateEngine.collectPublicEndpoints(live.id, webservers, apps);
    const publicUrls = endpoints.map((ep) => ({
      appId: ep.appId,
      webId: ep.kind === "webserver" ? ep.serviceId : undefined,
      name: ep.appId || ep.serviceId,
      subdomain: ep.subdomain,
      via: ep.kind,
      url: buildPublicUrl(ep.subdomain, {
        traefikHttpPort: this.traefikHttpPort,
        publicScheme: this.publicScheme,
      }),
    }));
    const networks = await this.preferLiveSubnets(id, config.networks || []);

    return {
      ...live,
      publicUrl: publicUrls[0]?.url ||
        buildPublicUrl(live.domain, {
          traefikHttpPort: this.traefikHttpPort,
          publicScheme: this.publicScheme,
        }),
      config: { ...config, networks },
      webservers,
      applications: apps,
      databases: config.databases,
      containers,
      runtimePort: primary ? TemplateEngine.getRuntimePort(primary.runtime) : 8080,
      backendHost: backend.host,
      publicUrls,
    };
  }

  private async loadEnvironmentConfig(env: EnvironmentMeta): Promise<EnvironmentConfig> {
    if (env.config?.applications?.length) {
      const databases = TemplateEngine.withAllocatedPorts(
        env.id,
        env.config.databases || [],
        env.config.databases
      );
      const connections =
        env.config.databaseConnections?.length === databases.length
          ? env.config.databaseConnections.map((c, i) => {
              const db = databases[i];
              if (c.jdbcUrl || databaseFamily(c.engine) === "redis")
                return { ...c, hostPort: db.hostPort ?? c.hostPort };
              return TemplateEngine.buildDatabaseConnection(db, {
                projectId: env.id,
                hostPort: db.hostPort,
              });
            })
          : databases.map((d) =>
              TemplateEngine.buildDatabaseConnection(d, {
                projectId: env.id,
                hostPort: d.hostPort,
              })
            );
      const needsRefresh = connections.some(
        (c) =>
          databaseFamily(c.engine) === "mysql" &&
          c.jdbcUrl &&
          !c.jdbcUrl.includes("allowPublicKeyRetrieval")
      );
      const webservers = env.config.webservers || [];
      const sshConnections = env.config.sshConnections || [];
      if (
        !needsRefresh &&
        env.config.databaseConnections?.length &&
        Array.isArray(env.config.webservers)
      ) {
        return {
          ...env.config,
          webservers,
          databases,
          databaseConnections: connections,
          sshConnections,
        };
      }
      const envVars = TemplateEngine.buildAppEnvVars(
        databases,
        connections,
        env.config.envVars
      );
      return this.buildConfig(
        webservers,
        env.config.applications,
        databases,
        connections,
        envVars,
        sshConnections,
        env.config.links,
        env.config.networks,
        env.config.positions,
        env.config.fail2ban
      );
    }

    try {
      const raw = await fs.readFile(path.join(env.projectPath, "config.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        config?: EnvironmentConfig;
        input?: CreateEnvironmentInput & Record<string, unknown>;
      };
      if (parsed.input || parsed.config) {
        const input = normalizeCreateInput({
          name: env.name,
          domain: env.domain,
          ...(parsed.input || {}),
          webservers: parsed.config?.webservers || parsed.input?.webservers,
          applications: parsed.config?.applications || parsed.input?.applications,
          databases: parsed.config?.databases || parsed.input?.databases,
          webserver: env.webserver,
          runtime: env.runtime,
          database: env.database,
          dbName: parsed.config?.dbName,
          dbUser: parsed.config?.dbUser,
          dbPassword: parsed.config?.dbPassword,
          dbRootPassword: parsed.config?.dbRootPassword,
        });
        const databases = TemplateEngine.withAllocatedPorts(
          env.id,
          input.databases,
          parsed.config?.databases
        );
        const connections = databases.map((d) =>
          TemplateEngine.buildDatabaseConnection(d, { projectId: env.id, hostPort: d.hostPort })
        );
        const envVars = TemplateEngine.buildAppEnvVars(databases, connections, input.envVars);
        return this.buildConfig(
          input.webservers,
          input.applications,
          databases,
          connections,
          envVars,
          parsed.config?.sshConnections || [],
          parsed.config?.links,
          parsed.config?.networks,
          parsed.config?.positions,
          parsed.config?.fail2ban
        );
      }
    } catch {
      // fallback
    }

    const input = normalizeCreateInput({
      name: env.name,
      domain: env.domain,
      webserver: env.webserver,
      runtime: env.runtime,
      database: env.database,
    });
    const databases = TemplateEngine.withAllocatedPorts(env.id, input.databases);
    const connections = databases.map((d) =>
      TemplateEngine.buildDatabaseConnection(d, { projectId: env.id, hostPort: d.hostPort })
    );
    return this.buildConfig(
      input.webservers,
      input.applications,
      databases,
      connections,
      TemplateEngine.buildAppEnvVars(databases, connections),
      []
    );
  }

  async updateEnvironment(id: string, input: CreateEnvironmentInput): Promise<EnvironmentDetails> {
    const env = await this.requireEnvironment(id);
    await this.assertSubdomainsAvailable(input.webservers || [], input.applications, id);
    const previousDatabases = env.config?.databases || [];
    const previousSsh = env.config?.sshConnections || [];
    const oldIds = new Set(previousDatabases.map((d) => `${d.id}:${databaseFamily(d.engine)}`));
    const newIds = new Set(input.databases.map((d) => `${d.id}:${databaseFamily(d.engine)}`));
    const familyChanged =
      [...oldIds].some((k) => !newIds.has(k)) || [...newIds].some((k) => !oldIds.has(k));

    const hosts = TemplateEngine.collectPublicHosts(input.webservers || [], input.applications);
    env.name = input.name;
    env.domain = hosts[0] || input.domain;
    env.status = "provisioning";
    env.updatedAt = new Date().toISOString();
    env.publicUrl = buildPublicUrl(env.domain, {
      traefikHttpPort: this.traefikHttpPort,
      publicScheme: this.publicScheme,
    });
    this.mirrorLegacyFields(env, input.webservers || [], input.applications, input.databases);
    await this.upsertMeta(env);
    this.emit(id, "provisioning", `Atualizando ${input.name}`, input.name);

    try {
      if (familyChanged) {
        try {
          await this.composeDestroy(env.projectPath);
        } catch {
          // ok
        }
      } else {
        try {
          await this.composeStop(env.projectPath);
        } catch {
          // ok
        }
      }

      const { config } = await this.writeStackFiles(
        env.id,
        env.projectPath,
        input,
        previousDatabases,
        previousSsh
      );
      env.config = config;
      this.mirrorLegacyFields(
        env,
        input.webservers || [],
        input.applications,
        config.databases
      );

      this.emit(id, "starting", "Recriando containers", input.name);
      await this.composeRecreate(env.projectPath);
      await this.waitForLaravelApps(id, env.projectPath, input);
      await this.writeTraefikRoutes(env.id, input.webservers || [], input.applications);

      env.status = "running";
      env.updatedAt = new Date().toISOString();
      delete env.errorMessage;
      this.emit(id, "running", `Ambiente ${input.name} liberado`, input.name);
      await this.upsertMeta(env);
      await fs.writeFile(path.join(env.projectPath, "meta.json"), JSON.stringify(env, null, 2), "utf8");

      return this.getEnvironmentDetails(env.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      env.status = "error";
      env.errorMessage = message;
      env.updatedAt = new Date().toISOString();
      this.emit(id, "error", message, input.name);
      await this.upsertMeta(env);
      throw error;
    }
  }

  async startEnvironment(id: string): Promise<EnvironmentMeta> {
    const env = await this.requireEnvironment(id);
    this.emit(id, "starting", `Iniciando ${env.name}`, env.name);
    await this.composeUp(env.projectPath);
    const webservers = env.config?.webservers || env.webservers || [];
    const apps =
      env.config?.applications ||
      env.applications || [
        {
          id: "app",
          name: "app",
          subdomain: env.domain,
          runtime: env.runtime as RuntimeChoice,
        },
      ];
    await this.writeTraefikRoutes(env.id, webservers, apps);
    env.status = "running";
    env.updatedAt = new Date().toISOString();
    delete env.errorMessage;
    this.emit(id, "running", `Ambiente ${env.name} em execução`, env.name);
    await this.upsertMeta(env);
    return env;
  }

  async stopEnvironment(id: string): Promise<EnvironmentMeta> {
    const env = await this.requireEnvironment(id);
    this.emit(id, "log", `Parando ${env.name}`, env.name);
    await this.composeStop(env.projectPath);
    await this.removeTraefikRoute(env.id);
    env.status = "stopped";
    this.emit(id, "stopped", `Ambiente ${env.name} parado`, env.name);
    env.updatedAt = new Date().toISOString();
    await this.upsertMeta(env);
    return env;
  }

  async deleteEnvironment(id: string): Promise<void> {
    const env = await this.requireEnvironment(id);
    this.emit(id, "deleting", `Removendo ${env.name}`, env.name);

    try {
      await this.composeDestroy(env.projectPath);
    } catch (error) {
      console.warn(`[docktopus] compose down falhou para ${id}, tentando limpeza por label:`, error);
    }

    await this.cleanupProjectDockerResources(id);
    await this.removeTraefikRoute(id);

    const leftover = await this.docker.listContainers({
      all: true,
      filters: { label: [`docktopus.project.id=${id}`] },
    });

    if (leftover.length) {
      env.status = "error";
      env.errorMessage = `Delete incompleto: ${leftover.length} container(s) ainda existem. Tente novamente.`;
      env.updatedAt = new Date().toISOString();
      await this.upsertMeta(env);
      this.emit(id, "error", env.errorMessage, env.name);
      throw Object.assign(new Error(env.errorMessage), { statusCode: 500 });
    }

    try {
      await fs.rm(env.projectPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[docktopus] falha ao remover pasta ${env.projectPath}:`, error);
      throw Object.assign(
        new Error(
          `Containers removidos, mas a pasta do projeto não pôde ser apagada: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        { statusCode: 500 }
      );
    }

    await this.removeFromRegistry(id);
    this.emit(id, "deleted", `Ambiente ${env.name} removido`, env.name);
  }

  /** Removes leftover containers/volumes labeled with this project after compose down. */
  private async cleanupProjectDockerResources(projectId: string): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`docktopus.project.id=${projectId}`] },
    });

    for (const summary of containers) {
      try {
        const container = this.docker.getContainer(summary.Id);
        await container.remove({ force: true, v: true });
      } catch (error) {
        console.warn(`[docktopus] falha ao remover container ${summary.Id.slice(0, 12)}:`, error);
      }
    }

    try {
      const volumes = await this.docker.listVolumes({
        filters: { name: [projectId] },
      });
      for (const vol of volumes.Volumes || []) {
        if (!vol.Name?.startsWith(`${projectId}-`)) continue;
        try {
          await this.docker.getVolume(vol.Name).remove({ force: true });
        } catch {
          // volume em uso ou já removido
        }
      }
    } catch (error) {
      console.warn(`[docktopus] falha ao listar volumes de ${projectId}:`, error);
    }

    try {
      const networks = await this.docker.listNetworks({
        filters: { name: [`${projectId}-internal`] },
      });
      for (const net of networks) {
        if (net.Name !== `${projectId}-internal`) continue;
        try {
          await this.docker.getNetwork(net.Id).remove();
        } catch {
          // ok
        }
      }
    } catch {
      // ok
    }
  }

  private async assertSubdomainsAvailable(
    webservers: WebserverSpec[],
    applications: ApplicationSpec[],
    excludeProjectId?: string
  ): Promise<void> {
    const registry = await this.readRegistry();
    const claimed = new Map<string, string>();

    for (const env of registry.environments) {
      if (excludeProjectId && env.id === excludeProjectId) continue;
      const ws = env.config?.webservers || env.webservers || [];
      const apps = env.config?.applications || env.applications || [];
      for (const host of TemplateEngine.collectPublicHosts(ws, apps)) {
        claimed.set(host.toLowerCase(), env.name);
      }
      if (env.domain) claimed.set(env.domain.toLowerCase(), env.name);
    }

    const hosts = TemplateEngine.collectPublicHosts(webservers, applications);
    if (!hosts.length) return;

    const seen = new Set<string>();
    for (const host of hosts) {
      const key = host.toLowerCase();
      if (seen.has(key)) {
        throw Object.assign(new Error(`Subdomínio duplicado: ${host}`), {
          statusCode: 400,
        });
      }
      seen.add(key);
      const owner = claimed.get(key);
      if (owner) {
        throw Object.assign(
          new Error(`Subdomínio '${host}' já está em uso pelo ambiente '${owner}'`),
          { statusCode: 409 }
        );
      }
    }
  }

  /** Host ports used by other environments and by live Docker bindings. */
  private async collectUsedHostPorts(excludeProjectId?: string): Promise<Set<number>> {
    const used = new Set<number>();
    const registry = await this.readRegistry();

    for (const env of registry.environments) {
      if (excludeProjectId && env.id === excludeProjectId) continue;
      const dbs = env.config?.databases || env.databases || [];
      for (const db of dbs) {
        if (db.hostPort) used.add(db.hostPort);
      }
      for (const conn of env.config?.databaseConnections || []) {
        if (conn.hostPort) used.add(conn.hostPort);
      }
      if (env.config?.databaseConnection?.hostPort) {
        used.add(env.config.databaseConnection.hostPort);
      }
      for (const app of env.config?.applications || env.applications || []) {
        if (app.hostPort) used.add(app.hostPort);
      }
      for (const ssh of env.config?.sshConnections || []) {
        if (ssh.hostPort) used.add(ssh.hostPort);
      }
    }

    try {
      const containers = await this.docker.listContainers({ all: true });
      for (const c of containers) {
        const labels = c.Labels || {};
        if (excludeProjectId && labels["docktopus.project.id"] === excludeProjectId) {
          continue;
        }
        for (const p of c.Ports || []) {
          if (p.PublicPort) used.add(p.PublicPort);
        }
      }
    } catch (error) {
      console.warn("[docktopus] não foi possível listar portas Docker:", error);
    }

    return used;
  }

  async readGatewayConf(id: string, gatewayId: string): Promise<{ gatewayId: string; filename: string; content: string }> {
    const env = await this.requireEnvironment(id);
    const gateway = this.requireNginxGateway(env, gatewayId);
    const filename = `nginx-${gateway.id}.conf`;
    const content = await fs.readFile(path.join(env.projectPath, filename), "utf8");
    return { gatewayId: gateway.id, filename, content };
  }

  async saveGatewayConf(
    id: string,
    gatewayId: string,
    content: string
  ): Promise<{ gatewayId: string; filename: string; content: string }> {
    const env = await this.requireEnvironment(id);
    const gateway = this.requireNginxGateway(env, gatewayId);
    if (content.length > 200_000) {
      throw Object.assign(new Error("O conf passou de 200 KB"), { statusCode: 400 });
    }
    const filename = `nginx-${gateway.id}.conf`;
    const file = path.join(env.projectPath, filename);
    const previous = await fs.readFile(file, "utf8").catch(() => "");
    await fs.writeFile(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    const container = await this.runningNginxContainer(id, gateway.id);
    const before = await this.containerLogTail(container);
    try {
      await container.kill({ signal: "HUP" });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const problem = this.freshNginxFailure(before, await this.containerLogTail(container));
      if (problem) {
        await fs.writeFile(file, previous, "utf8");
        await container.kill({ signal: "HUP" }).catch(() => undefined);
        throw Object.assign(new Error(problem), { statusCode: 400 });
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode) throw error;
      await fs.writeFile(file, previous, "utf8");
      const message = error instanceof Error ? error.message : "Não foi possível recarregar o Nginx";
      throw Object.assign(new Error(message), { statusCode: 400 });
    }
    const saved = await fs.readFile(file, "utf8");
    return { gatewayId: gateway.id, filename, content: saved };
  }

  private requireNginxGateway(env: EnvironmentMeta, gatewayId: string): WebserverSpec {
    if (!/^[a-z0-9-]+$/.test(gatewayId)) {
      throw Object.assign(new Error("Gateway inválido"), { statusCode: 400 });
    }
    const gateway = (env.config?.webservers || env.webservers || []).find((item) => item.id === gatewayId);
    if (!gateway || gateway.engine !== "nginx") {
      throw Object.assign(new Error("Nginx não encontrado neste ambiente"), { statusCode: 404 });
    }
    return gateway;
  }

  private async runningNginxContainer(projectId: string, gatewayId: string): Promise<Docker.Container> {
    const listed = await this.docker.listContainers({
      all: true,
      filters: {
        label: [
          `docktopus.project.id=${projectId}`,
          `docktopus.web.id=${gatewayId}`,
          "docktopus.role=webserver",
        ],
      },
    });
    const summary = listed.find((item) => item.State === "running");
    if (!summary) {
      throw Object.assign(new Error("O Nginx não está em execução"), { statusCode: 409 });
    }
    return this.docker.getContainer(summary.Id);
  }

  private async containerLogTail(container: Docker.Container): Promise<string> {
    const buffer = (await container.logs({ stdout: true, stderr: true, tail: 30 })) as Buffer;
    return this.demuxDockerLogs(buffer);
  }

  private freshNginxFailure(before: string, after: string): string | null {
    const fresh = after.startsWith(before) ? after.slice(before.length) : after;
    const line = fresh
      .split("\n")
      .map((item) => item.trim())
      .find((item) => /\[(emerg|alert)\]/i.test(item) || /test failed/i.test(item));
    return line || null;
  }

  private assertServiceId(env: EnvironmentMeta, service: string): string {
    if (!/^[a-z0-9-]+$/.test(service)) {
      throw Object.assign(new Error("Serviço inválido"), { statusCode: 400 });
    }
    const apps = env.config?.applications || env.applications || [];
    const known = new Set<string>([
      ...(env.config?.webservers || env.webservers || []).map((item) => item.id),
      ...apps.map((item) => item.id),
      ...apps.map((item) => `${item.id}-ssh`),
      ...(env.config?.databases || env.databases || []).map((item) => item.id),
      "fail2ban",
    ]);
    if (!known.has(service)) {
      throw Object.assign(new Error(`Serviço '${service}' não faz parte deste ambiente`), { statusCode: 404 });
    }
    return service;
  }

  async getLogs(id: string, tail = 200, service?: string): Promise<EnvironmentLogs> {
    const env = await this.requireEnvironment(id);
    const target = service ? this.assertServiceId(env, service) : undefined;
    try {
      const args = [
        "compose",
        "-f",
        path.join(env.projectPath, "docker-compose.yml"),
        "logs",
        "--no-color",
        "--tail",
        String(tail),
      ];
      if (target) args.push(target);
      const { stdout, stderr } = await execFileAsync("docker", args, {
        cwd: env.projectPath,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { id, logs: `${stdout}${stderr}`.trim() || "(sem logs)" };
    } catch (error) {
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
        const name = summary.Names?.[0]?.replace(/^\//, "") || "";
        if (target && name !== `${id}-${target}`) continue;
        const container = this.docker.getContainer(summary.Id);
        const buffer = (await container.logs({
          stdout: true,
          stderr: true,
          tail,
          timestamps: true,
        })) as Buffer;
        chunks.push(
          `=== ${summary.Names?.[0] ?? summary.Id.slice(0, 12)} ===\n${this.demuxDockerLogs(buffer)}`
        );
      }

      return { id, logs: chunks.join("\n\n") };
    }
  }

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

  private async syncTraefikRoutes(): Promise<void> {
    const registry = await this.readRegistry();
    for (const env of registry.environments) {
      if (env.status === "running" || env.status === "provisioning") {
        try {
          const webservers = env.config?.webservers || env.webservers || [];
          const apps =
            env.config?.applications ||
            env.applications || [
              {
                id: "app",
                name: "app",
                subdomain: env.domain,
                runtime: env.runtime as RuntimeChoice,
              },
            ];
          await this.writeTraefikRoutes(env.id, webservers, apps);
        } catch (error) {
          console.warn(`[docktopus] falha ao sincronizar rota Traefik de ${env.id}:`, error);
        }
      }
    }
  }

  private async writeTraefikRoutes(
    projectId: string,
    webservers: WebserverSpec[],
    applications: ApplicationSpec[]
  ): Promise<void> {
    await fs.mkdir(this.traefikDynamicDir, { recursive: true });
    const routerBase = projectId.replace(/[^a-zA-Z0-9-]/g, "-");
    const endpoints = TemplateEngine.collectPublicEndpoints(
      projectId,
      webservers,
      applications
    );

    const routers: string[] = [];
    const services: string[] = [];
    const seenServices = new Set<string>();

    for (const ep of endpoints) {
      const routerName = `${routerBase}-${ep.kind}-${ep.serviceId}-${ep.subdomain}`
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .slice(0, 64);
      const serviceName = `${routerBase}-${ep.kind}-${ep.serviceId}`.replace(
        /[^a-zA-Z0-9-]/g,
        "-"
      );

      routers.push(`    ${routerName}:
      rule: "Host(\`${ep.subdomain}\`)"
      entryPoints:
        - web
      service: ${serviceName}`);

      if (!seenServices.has(serviceName)) {
        seenServices.add(serviceName);
        services.push(`    ${serviceName}:
      loadBalancer:
        servers:
          - url: "http://${ep.host}:${ep.port}"`);
      }
    }

    if (!routers.length) {
      await this.removeTraefikRoute(projectId);
      return;
    }

    const content = `# Generated by Docktopus — ${projectId}
http:
  routers:
${routers.join("\n")}
  services:
${services.join("\n")}
`;
    await fs.writeFile(path.join(this.traefikDynamicDir, `${routerBase}.yml`), content, "utf8");
  }

  private async removeTraefikRoute(projectId: string): Promise<void> {
    const routerName = projectId.replace(/[^a-zA-Z0-9-]/g, "-");
    try {
      await fs.unlink(path.join(this.traefikDynamicDir, `${routerName}.yml`));
    } catch {
      // ok
    }
  }

  private emit(
    id: string,
    phase: RealtimePhase,
    message: string,
    name?: string
  ): void {
    publishEnvironment({ id, phase, message, name });
  }

  private async waitForLaravelApps(
    projectId: string,
    projectPath: string,
    input: CreateEnvironmentInput
  ): Promise<void> {
    const apps = input.applications.filter((app) => {
      if (app.source === "project" || !app.framework) return false;
      if (app.framework === "laravel") return app.runtime.startsWith("php");
      if (app.framework === "django") return app.runtime.startsWith("python");
      return app.runtime.startsWith("node");
    });
    for (const app of apps) {
      const label =
        app.framework === "next" ? "Next.js" : app.framework === "adonis" ? "AdonisJS" : app.framework === "django" ? "Django" : "Laravel";
      this.emit(projectId, "starting", `Instalando o ${label} em ${app.name || app.id}`, input.name);
      await this.waitForFramework(projectPath, app.id, app.name || app.id, label, app.framework === "next" || app.framework === "adonis" ? 15 : 8);
    }
  }

  private async waitForFramework(
    projectPath: string,
    serviceId: string,
    name: string,
    label: string,
    minutes: number
  ): Promise<void> {
    const deadline = Date.now() + minutes * 60 * 1000;
    while (Date.now() < deadline) {
      let text = "";
      try {
        const { stdout, stderr } = await execFileAsync(
          "docker",
          ["compose", "-f", "docker-compose.yml", "logs", "--no-color", "--tail", "400", serviceId],
          { cwd: projectPath, maxBuffer: 4 * 1024 * 1024 }
        );
        text = `${stdout}\n${stderr}`;
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string };
        text = `${failed.stdout || ""}\n${failed.stderr || ""}`;
      }
      if (text.includes("docktopus-laravel-failed") || text.includes("docktopus-framework-failed")) {
        throw new Error(`O ${label} de ${name} não ficou pronto. Veja os logs do container.`);
      }
      if (text.includes("docktopus-laravel-ready") || text.includes("docktopus-framework-ready")) return;
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    throw new Error(`O ${label} de ${name} não ficou pronto. Veja os logs do container.`);
  }

  private async composeUp(projectPath: string): Promise<void> {
    await execFileAsync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "up", "-d", "--build", "--remove-orphans"],
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    );
  }

  private async composeUpService(projectPath: string, service: string): Promise<void> {
    await execFileAsync(
      "docker",
      [
        "compose",
        "-f",
        "docker-compose.yml",
        "up",
        "-d",
        "--force-recreate",
        "--remove-orphans",
        service,
      ],
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    );
  }

  private async composeRecreate(projectPath: string): Promise<void> {
    await execFileAsync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "up", "-d", "--build", "--force-recreate", "--remove-orphans"],
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    );
  }

  private async existingNetworkKeys(projectId: string): Promise<string[]> {
    const keys: string[] = [];
    const prefix = `${projectId}-`;
    try {
      const listed = await this.docker.listNetworks();
      for (const net of listed) {
        const name = net.Name || "";
        if (name.startsWith(prefix)) keys.push(name.slice(prefix.length));
      }
    } catch {
      return [];
    }
    return keys;
  }

  private async preferLiveSubnets(
    projectId: string,
    networks: import("./TemplateEngine").CanvasNetwork[]
  ): Promise<import("./TemplateEngine").CanvasNetwork[]> {
    if (!networks.length) return networks;
    const live = new Map<string, { subnet: string; gateway?: string }>();
    try {
      const listed = await this.docker.listNetworks();
      for (const net of listed) {
        const name = net.Name || "";
        if (!name.startsWith(`${projectId}-`)) continue;
        const address = net.IPAM?.Config?.[0];
        if (!address?.Subnet) continue;
        live.set(name, { subnet: address.Subnet, gateway: address.Gateway });
      }
    } catch {
      return networks;
    }
    return networks.map((net) => {
      const hit = live.get(`${projectId}-${canvasNetworkName(net.id)}`);
      if (!hit) return net;
      return { ...net, subnet: hit.subnet, gateway: hit.gateway || net.gateway };
    });
  }

  private async composeStop(projectPath: string): Promise<void> {
    await execFileAsync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "stop"],
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    );
  }

  private async composeDestroy(projectPath: string): Promise<void> {
    await execFileAsync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "down", "-v", "--remove-orphans"],
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    );
  }

  private async resolveLiveStatus(env: EnvironmentMeta): Promise<EnvironmentMeta> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`docktopus.project.id=${env.id}`] },
      });

      if (!containers.length || env.status === "provisioning") {
        if (env.status === "provisioning") return env;
        return { ...env, status: "stopped", updatedAt: new Date().toISOString() };
      }

      const running = containers.some((c) => c.State === "running");
      const hasError = containers.some(
        (c) => c.State === "exited" && (c.Status ?? "").includes("Error")
      );

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

  /** Cria Dockerfile e compose só quando a pasta da app ainda não tem o compose do projeto. */
  private async ensureProjectDocker(appDir: string, composeFile: string, service: string, port: number): Promise<void> {
    const composePath = path.resolve(appDir, composeFile);
    const root = path.resolve(appDir);
    if (composePath !== root && !composePath.startsWith(`${root}${path.sep}`)) return;
    try {
      await fs.access(composePath);
      return;
    } catch {
      // arquivo ainda não existe
    }
    const dockerfilePath = path.join(path.dirname(composePath), "Dockerfile");
    const stubConf = path.join(path.dirname(composePath), "docktopus-stub.conf");
    await fs.mkdir(path.dirname(composePath), { recursive: true });
    try {
      await fs.access(dockerfilePath);
    } catch {
      await fs.writeFile(
        stubConf,
        `server {\n  listen ${port};\n  location / {\n    default_type text/plain;\n    return 200 "substitua pelo Dockerfile do projeto\\n";\n  }\n}\n`,
        "utf8"
      );
      await fs.writeFile(
        dockerfilePath,
        `FROM nginx:1.27-alpine\nCOPY docktopus-stub.conf /etc/nginx/conf.d/default.conf\nEXPOSE ${port}\n`,
        "utf8"
      );
    }
    await fs.writeFile(
      composePath,
      [
        "services:",
        `  ${service}:`,
        "    build:",
        "      context: .",
        "      dockerfile: Dockerfile",
        "    expose:",
        `      - "${port}"`,
        "",
      ].join("\n"),
      "utf8"
    );
  }

  private async writeFail2banFiles(projectPath: string, projectId: string, spec: Fail2banSpec): Promise<void> {
    const dataDir = path.join(projectPath, "fail2ban", "data");
    await fs.mkdir(path.join(dataDir, "jail.d"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "filter.d"), { recursive: true });
    await fs.mkdir(path.join(projectPath, "fail2ban", "logs"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "jail.d", "docktopus.local"), renderFail2banJail(projectId, spec), "utf8");
    await fs.writeFile(path.join(dataDir, "filter.d", "docktopus-ssh.conf"), renderFail2banFilter(), "utf8");
  }

  private async writeLaravelFiles(appDir: string, runtime: string): Promise<void> {
    const version = `${runtime.slice(3, 4)}.${runtime.slice(4)}`;
    const dockerfile = `FROM php:${version}-cli
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git unzip libzip-dev libpq-dev \\
 && docker-php-ext-install pdo_mysql pdo_pgsql zip \\
 && rm -rf /var/lib/apt/lists/* \\
 && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
COPY laravel-router.php /opt/docktopus/laravel-router.php
COPY laravel-up.sh /opt/docktopus/laravel-up.sh
RUN chmod +x /opt/docktopus/laravel-up.sh
WORKDIR /app
`;
    const router = `<?php
$public = '/app/public';
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');
$candidate = $public.$uri;
if ($uri !== '/' && is_file($candidate)) {
    return false;
}
$_SERVER['SCRIPT_FILENAME'] = $public.'/index.php';
$_SERVER['SCRIPT_NAME'] = '/index.php';
require $public.'/index.php';
`;
    const script = `#!/bin/sh
set -e
cd /app
if [ ! -f artisan ]; then
  find . -mindepth 1 -maxdepth 1 ! -name Dockerfile ! -name laravel-up.sh ! -name laravel-router.php -exec rm -rf {} +
  composer create-project laravel/laravel /tmp/laravel --no-interaction --prefer-dist
  cp -a /tmp/laravel/. /app/
  rm -rf /tmp/laravel
fi
if [ ! -f .env ]; then
  cp .env.example .env
fi
php artisan key:generate --force --no-interaction
if [ -z "$DB_HOST" ]; then
  mkdir -p database
  touch database/database.sqlite
  php artisan migrate --force --no-interaction
else
  i=0
  migrated=0
  while [ "$i" -lt 20 ]; do
    if php artisan migrate --force --no-interaction; then
      migrated=1
      break
    fi
    i=$((i + 1))
    sleep 3
  done
  if [ "$migrated" -ne 1 ]; then
    echo "docktopus-laravel-failed"
    exit 1
  fi
fi
echo "docktopus-laravel-ready"
exec php -S 0.0.0.0:8080 -t /app/public /opt/docktopus/laravel-router.php
`;
    await fs.writeFile(path.join(appDir, "Dockerfile"), dockerfile, "utf8");
    await fs.writeFile(path.join(appDir, "laravel-router.php"), router, "utf8");
    await fs.writeFile(path.join(appDir, "laravel-up.sh"), script, { encoding: "utf8", mode: 0o755 });
    await fs.unlink(path.join(appDir, "index.html")).catch(() => undefined);
  }

  private async writeDjangoFiles(appDir: string, runtime: string): Promise<void> {
    const digits = runtime.replace(/\D/g, "");
    const py = `${digits.slice(0, 1)}.${digits.slice(1)}`;
    const dockerfile = `FROM python:${py}-slim
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir "django>=5.1,<5.2" "psycopg[binary]" pymysql
COPY django-up.sh /opt/docktopus/django-up.sh
COPY django-db.py /opt/docktopus/django-db.py
RUN chmod +x /opt/docktopus/django-up.sh
WORKDIR /app
`;
    const script = `#!/bin/sh
set -e
cd /app
export PORT="\${PORT:-8000}"

fail() {
  echo "docktopus-framework-failed"
  exit 1
}

if [ ! -f manage.py ]; then
  find . -mindepth 1 -maxdepth 1 ! -name Dockerfile ! -name django-up.sh ! -name django-db.py -exec rm -rf {} +
  rm -rf /tmp/docktopus-django
  mkdir -p /tmp/docktopus-django
  django-admin startproject docktopus /tmp/docktopus-django || fail
  cp -a /tmp/docktopus-django/. /app/
  rm -rf /tmp/docktopus-django
fi
python /opt/docktopus/django-db.py || fail
i=0
migrated=0
while [ "$i" -lt 20 ]; do
  if python manage.py migrate --noinput; then
    migrated=1
    break
  fi
  i=$((i + 1))
  sleep 3
done
if [ "$migrated" -ne 1 ]; then
  fail
fi
echo "docktopus-framework-ready"
exec python manage.py runserver "0.0.0.0:$PORT" --noreload
`;
    const dbScript = `import json
import os
from pathlib import Path

settings = Path("docktopus/settings.py")
if not settings.exists():
    raise SystemExit("docktopus/settings.py ausente")
text = settings.read_text()
marker = "# docktopus-db"
if marker in text:
    text = text.split(marker)[0].rstrip() + "\\n"
if "ALLOWED_HOSTS = []" in text:
    text = text.replace("ALLOWED_HOSTS = []", "ALLOWED_HOSTS = ['*']", 1)
host = os.environ.get("DB_HOST", "")
if host:
    engine = "django.db.backends.postgresql" if os.environ.get("DB_CONNECTION") == "pgsql" else "django.db.backends.mysql"
    port = os.environ.get("DB_PORT") or ("5432" if engine.endswith("postgresql") else "3306")
    lines = ["", marker]
    if engine.endswith("mysql"):
        lines.append("import pymysql")
        lines.append("pymysql.install_as_MySQLdb()")
    lines.append("DATABASES = {")
    lines.append("    'default': {")
    lines.append("        'ENGINE': " + json.dumps(engine) + ",")
    lines.append("        'NAME': " + json.dumps(os.environ.get("DB_DATABASE", "")) + ",")
    lines.append("        'USER': " + json.dumps(os.environ.get("DB_USER", "")) + ",")
    lines.append("        'PASSWORD': " + json.dumps(os.environ.get("DB_PASSWORD", "")) + ",")
    lines.append("        'HOST': " + json.dumps(host) + ",")
    lines.append("        'PORT': " + json.dumps(port) + ",")
    lines.append("    }")
    lines.append("}")
    text = text.rstrip() + "\\n" + "\\n".join(lines) + "\\n"
settings.write_text(text)
`;
    await fs.writeFile(path.join(appDir, "Dockerfile"), dockerfile, "utf8");
    await fs.writeFile(path.join(appDir, "django-up.sh"), script, { encoding: "utf8", mode: 0o755 });
    await fs.writeFile(path.join(appDir, "django-db.py"), dbScript, "utf8");
    await fs.unlink(path.join(appDir, "index.html")).catch(() => undefined);
  }

  private async writeNodeFrameworkFiles(appDir: string, runtime: string, framework: "next" | "adonis"): Promise<void> {
    const image = framework === "adonis" ? "node:24-alpine" : `node:${runtime.replace(/^node/, "")}-alpine`;
    const dockerfile = `FROM ${image}
RUN apk add --no-cache libc6-compat git python3 make g++ \\
 && npm install -g pm2 \\
 && npm cache clean --force
COPY node-up.sh /opt/docktopus/node-up.sh
COPY node-db.mjs /opt/docktopus/node-db.mjs
RUN chmod +x /opt/docktopus/node-up.sh
WORKDIR /app
`;
    const script = `#!/bin/sh
set -e
cd /app
export CI=1
export HOST="\${HOST:-0.0.0.0}"
export HOSTNAME="\${HOSTNAME:-0.0.0.0}"
export PORT="\${PORT:-3000}"
FRAMEWORK=${framework}

fail() {
  echo "docktopus-framework-failed"
  exit 1
}

if [ "$FRAMEWORK" = "next" ]; then
  if [ ! -f next.config.ts ] && [ ! -f next.config.mjs ] && [ ! -f next.config.js ]; then
    find . -mindepth 1 -maxdepth 1 ! -name Dockerfile ! -name node-up.sh ! -name node-db.mjs -exec rm -rf {} +
    rm -rf /tmp/docktopus-next
    npx --yes create-next-app@latest /tmp/docktopus-next --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --disable-git --skip-install --yes \
      || { rm -rf /tmp/docktopus-next; npx --yes create-next-app@latest /tmp/docktopus-next --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --disable-git --skip-install; } \
      || fail
    cp -a /tmp/docktopus-next/. /app/
    rm -rf /tmp/docktopus-next
    npm install || fail
    if [ -n "$DATABASE_URL" ]; then
      printf 'DATABASE_URL=%s\\n' "$DATABASE_URL" >> .env.local
    fi
    npm run build || fail
  fi
  echo "docktopus-framework-ready"
  exec pm2-runtime start ./node_modules/next/dist/bin/next --name app --interpreter node -- start -H 0.0.0.0 -p "$PORT"
fi

if [ ! -f adonisrc.ts ]; then
  find . -mindepth 1 -maxdepth 1 ! -name Dockerfile ! -name node-up.sh ! -name node-db.mjs -exec rm -rf {} +
  npm init adonisjs@latest -- /tmp/docktopus-adonis --kit=hypermedia --pkg=npm --skip-migrations || fail
  cp -a /tmp/docktopus-adonis/. /app/
  rm -rf /tmp/docktopus-adonis
fi
if [ -f .env ]; then
  sed -i 's/^HOST=.*/HOST=0.0.0.0/' .env
  sed -i "s/^PORT=.*/PORT=$PORT/" .env
fi
if [ -n "$DB_HOST" ]; then
  if [ "$DB_CONNECTION" = "pgsql" ]; then
    export DB_PORT="\${DB_PORT:-5432}"
    if ! grep -q "client: 'pg'" config/database.ts 2>/dev/null; then
      npm install pg || fail
      node /opt/docktopus/node-db.mjs || fail
    fi
  else
    export DB_PORT="\${DB_PORT:-3306}"
    export DB_CONNECTION="\${DB_CONNECTION:-mysql}"
    if ! grep -q "client: 'mysql2'" config/database.ts 2>/dev/null; then
      npm install mysql2 || fail
      node /opt/docktopus/node-db.mjs || fail
    fi
  fi
fi
i=0
migrated=0
while [ "$i" -lt 20 ]; do
  if node ace.js migration:run; then
    migrated=1
    break
  fi
  i=$((i + 1))
  sleep 3
done
if [ "$migrated" -ne 1 ]; then
  fail
fi
echo "docktopus-framework-ready"
exec pm2-runtime start ./ace.js --name app --interpreter node -- serve
`;
    const dbScript = `import { readFileSync, writeFileSync } from "node:fs";

const connection = process.env.DB_CONNECTION === "pgsql" ? "pg" : "mysql";
const client = connection === "pg" ? "pg" : "mysql2";
const database = \`import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'
import env from '#start/env'

const dbConfig = defineConfig({
  connection: '\${connection}',
  prettyPrintDebugQueries: true,
  connections: {
    \${connection}: {
      client: '\${client}',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD'),
        database: env.get('DB_DATABASE'),
      },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
      debug: app.inDev,
    },
  },
})

export default dbConfig
\`;
writeFileSync("config/database.ts", database);

const envPath = "start/env.ts";
let envFile = readFileSync(envPath, "utf8");
if (!envFile.includes("DB_HOST:")) {
  const extra = \`  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string(),
  DB_DATABASE: Env.schema.string(),
\`;
  const idx = envFile.lastIndexOf("})");
  if (idx === -1) throw new Error("start/env.ts sem fechamento");
  envFile = envFile.slice(0, idx) + extra + envFile.slice(idx);
  writeFileSync(envPath, envFile);
}
`;
    await fs.writeFile(path.join(appDir, "Dockerfile"), dockerfile, "utf8");
    await fs.writeFile(path.join(appDir, "node-up.sh"), script, { encoding: "utf8", mode: 0o755 });
    await fs.writeFile(path.join(appDir, "node-db.mjs"), dbScript, "utf8");
    await fs.unlink(path.join(appDir, "index.html")).catch(() => undefined);
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

  private async removeFromRegistry(id: string): Promise<void> {
    const registry = await this.readRegistry();
    registry.environments = registry.environments.filter((e) => e.id !== id);
    await this.writeRegistry(registry);
  }
}
