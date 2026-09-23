import { Request, Response } from "express";
import { DockerService } from "../services/DockerService";
import {
  CreateEnvironmentInput,
  DatabaseEngine,
  AppSource,
  RuntimeChoice,
  WebserverEngine,
  WEBSERVER_ENGINE_OPTIONS,
  RUNTIME_OPTIONS,
  DATABASE_ENGINE_OPTIONS,
  databaseFamily,
  normalizeCreateInput,
  normalizeAppFramework,
  normalizeGithubRepo,
  normalizeProjectFile,
  normalizeComposeService,
  slugifyServiceId,
  appsBehindWebserver,
  normalizeServiceLinks,
  normalizeCanvasNetworks,
  normalizePositions,
  normalizeFail2ban,
  webserversFromLinks,
} from "../services/TemplateEngine";

export class EnvironmentController {
  constructor(private readonly dockerService: DockerService) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    try {
      const environments = await this.dockerService.listEnvironments();
      res.json({ data: environments.map((env) => this.redact(env)) });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  get = async (req: Request, res: Response): Promise<void> => {
    try {
      const env = await this.dockerService.getEnvironmentDetails(String(req.params.id));
      res.json({ data: this.redact(env) });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  create = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = this.parseCreateBody(req.body);
      const env = await this.dockerService.createEnvironment(input);
      res.status(201).json({ data: this.redact(env) });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  update = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = this.parseCreateBody(req.body);
      const env = await this.dockerService.updateEnvironment(String(req.params.id), input);
      res.json({ data: this.redact(env) });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  start = async (req: Request, res: Response): Promise<void> => {
    try {
      const env = await this.dockerService.startEnvironment(String(req.params.id));
      res.json({ data: this.redact(env) });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  stop = async (req: Request, res: Response): Promise<void> => {
    try {
      const env = await this.dockerService.stopEnvironment(String(req.params.id));
      res.json({ data: this.redact(env) });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    try {
      await this.dockerService.deleteEnvironment(String(req.params.id));
      res.status(204).send();
    } catch (error) {
      this.handleError(res, error);
    }
  };

  logs = async (req: Request, res: Response): Promise<void> => {
    try {
      const tail = Number(req.query.tail || 200);
      const service = typeof req.query.service === "string" ? req.query.service : undefined;
      const result = await this.dockerService.getLogs(String(req.params.id), tail, service);
      res.json({ data: result });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  gatewayConf = async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await this.dockerService.readGatewayConf(String(req.params.id), String(req.params.gatewayId));
      res.json({ data });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  saveGatewayConf = async (req: Request, res: Response): Promise<void> => {
    try {
      const content = String((req.body as { content?: unknown })?.content ?? "");
      const data = await this.dockerService.saveGatewayConf(
        String(req.params.id),
        String(req.params.gatewayId),
        content
      );
      res.json({ data });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  streamLogs = async (req: Request, res: Response): Promise<void> => {
    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const ac = new AbortController();
      req.on("close",() => ac.abort());

      await this.dockerService.streamLogs(
        String(req.params.id),
        (chunk) => {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
        ac.signal
      );
    } catch (error) {
      if (!res.headersSent) this.handleError(res, error);
      else res.end();
    }
  };

  private parseCreateBody(body: unknown): CreateEnvironmentInput {
    if (!body || typeof body !== "object") {
      throw Object.assign(new Error("Body JSON inválido"), { statusCode: 400 });
    }

    const b = body as Record<string, unknown>;
    const normalized = normalizeCreateInput(b);
    const name = normalized.name;
    const domain = this.normalizeDomain(normalized.domain || "");

    if (!name || name.length < 2) {
      throw Object.assign(new Error("Informe um nome de projeto válido"), { statusCode: 400 });
    }
    if (!domain || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain)) {
      throw Object.assign(
        new Error("Domínio inválido. Prefira algo como meusite.localhost"),
        { statusCode: 400 }
      );
    }

    if (!normalized.applications.length) {
      throw Object.assign(new Error("Adicione ao menos uma aplicação"), { statusCode: 400 });
    }

    const appIds = new Set<string>();
    const serviceIds = new Set<string>();

    const applications = normalized.applications.map((app, index) => {
      let runtime = app.runtime as RuntimeChoice | "go";
      if (runtime === "go") runtime = "go122";
      const id = slugifyServiceId(app.id || app.name || `app${index + 1}`, `app${index + 1}`);
      if (appIds.has(id)) {
        throw Object.assign(new Error(`Id de aplicação duplicado: ${id}`), { statusCode: 400 });
      }
      appIds.add(id);
      serviceIds.add(id);

      const subdomainRaw = app.subdomain ? this.normalizeDomain(app.subdomain) : "";
      if (subdomainRaw && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(subdomainRaw)) {
        throw Object.assign(new Error(`Subdomínio inválido na app '${id}'`), { statusCode: 400 });
      }

      if (!RUNTIME_OPTIONS.includes(runtime as RuntimeChoice)) {
        throw Object.assign(new Error(`Runtime inválido na app '${id}'`), { statusCode: 400 });
      }

      let githubRepo: string | null = null;
      try {
        githubRepo = normalizeGithubRepo(app.githubRepo);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Repositório GitHub inválido";
        throw Object.assign(new Error(`${message} (app '${id}')`), { statusCode: 400 });
      }

      const source: AppSource = app.source === "project" ? "project" : "runtime";
      let composeFile: string | undefined;
      let composeService: string | undefined;
      let containerPort: number | undefined;
      if (source === "project") {
        try {
          composeFile = normalizeProjectFile(app.composeFile, "docker-compose.yml");
          composeService = normalizeComposeService(app.composeService, "app");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Compose do projeto inválido";
          throw Object.assign(new Error(`${message} (app '${id}')`), { statusCode: 400 });
        }
        const port = Number(app.containerPort || 80);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw Object.assign(new Error(`Porta inválida na app '${id}'`), { statusCode: 400 });
        }
        containerPort = port;
      }

      const hostPort = this.parseHostPort(app.hostPort, id);

      return {
        id,
        name: (app.name || id).trim() || id,
        subdomain: subdomainRaw || null,
        runtime: runtime as RuntimeChoice,
        githubRepo,
        source,
        composeFile,
        composeService,
        containerPort,
        hostPort,
        framework: normalizeAppFramework(String(runtime), source, app.framework),
      };
    });

    const hostPorts = new Set<number>();
    for (const app of applications) {
      if (!app.hostPort) continue;
      if (hostPorts.has(app.hostPort)) {
        throw Object.assign(new Error(`Porta externa ${app.hostPort} repetida entre aplicações`), {
          statusCode: 400,
        });
      }
      hostPorts.add(app.hostPort);
    }
    for (const db of normalized.databases || []) {
      const port = Number(db.hostPort);
      if (!port || !hostPorts.has(port)) continue;
      throw Object.assign(new Error(`Porta externa ${port} já está no banco '${db.name || db.id}'`), {
        statusCode: 400,
      });
    }

    const webservers = (normalized.webservers || []).map((ws, index) => {
      const engine = (ws.engine === "apache" ? "apache" : "nginx") as WebserverEngine;
      if (!WEBSERVER_ENGINE_OPTIONS.includes(engine)) {
        throw Object.assign(new Error(`Engine de webserver inválida: ${engine}`), {
          statusCode: 400,
        });
      }
      const id = slugifyServiceId(ws.id || ws.name || engine, `web${index + 1}`);
      if (serviceIds.has(id)) {
        throw Object.assign(new Error(`Id de serviço duplicado: ${id}`), { statusCode: 400 });
      }
      serviceIds.add(id);

      const routes = (ws.routes || [])
        .map((r) => ({
          subdomain: this.normalizeDomain(r.subdomain || ""),
          appId: String(r.appId || "").trim(),
        }))
        .filter((r) => r.subdomain && r.appId);

      for (const route of routes) {
        if (!appIds.has(route.appId)) {
          throw Object.assign(
            new Error(`Rota do webserver '${id}' aponta para app inexistente: ${route.appId}`),
            { statusCode: 400 }
          );
        }
        if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(route.subdomain)) {
          throw Object.assign(new Error(`Subdomínio inválido na rota de '${id}'`), {
            statusCode: 400,
          });
        }
      }

      return {
        id,
        name: (ws.name || id).trim() || id,
        engine,
        routes,
      };
    });

    const links = normalizeServiceLinks((b as { links?: unknown }).links);
    let resolvedWebservers = webservers;
    if (links) {
      for (const app of applications) {
        if (!app.subdomain) app.subdomain = domain;
      }
      resolvedWebservers = webserversFromLinks(links, applications, domain);
    } else {
      const behind = appsBehindWebserver(webservers);
      for (const app of applications) {
        if (!behind.has(app.id) && !app.subdomain) {
          app.subdomain = domain;
        }
      }
    }

    const dbIds = new Set<string>();
    const databases = normalized.databases.map((db, index) => {
      const engine = db.engine as DatabaseEngine;
      if (!DATABASE_ENGINE_OPTIONS.includes(engine)) {
        throw Object.assign(new Error(`Engine de banco inválida: ${engine}`), { statusCode: 400 });
      }
      const id = slugifyServiceId(db.id || db.name || engine, `db${index + 1}`);
      if (dbIds.has(id) || serviceIds.has(id)) {
        throw Object.assign(new Error(`Id de serviço duplicado: ${id}`), { statusCode: 400 });
      }
      dbIds.add(id);
      serviceIds.add(id);

      const family = databaseFamily(engine);
      const dbName = db.dbName?.trim();
      const dbUser = db.dbUser?.trim();
      const dbPassword = db.dbPassword;
      const dbRootPassword = db.dbRootPassword;

      if (family === "mysql" || family === "postgres" || family === "mongo") {
        if (!dbName || !/^[a-zA-Z0-9_]+$/.test(dbName)) {
          throw Object.assign(
            new Error(`Nome de banco inválido em '${id}' (letras, números e _)`),
            { statusCode: 400 }
          );
        }
        if (!dbUser || !/^[a-zA-Z0-9_]+$/.test(dbUser)) {
          throw Object.assign(new Error(`Usuário de banco inválido em '${id}'`), {
            statusCode: 400,
          });
        }
        if (!dbPassword || dbPassword.length < 4) {
          throw Object.assign(new Error(`Senha do banco '${id}' deve ter ao menos 4 caracteres`), {
            statusCode: 400,
          });
        }
      }

      if (family === "rabbitmq") {
        if (!dbUser || !/^[a-zA-Z0-9_]+$/.test(dbUser)) {
          throw Object.assign(new Error(`Usuário do RabbitMQ '${id}' inválido`), { statusCode: 400 });
        }
        if (!dbPassword || dbPassword.length < 4) {
          throw Object.assign(new Error(`Senha do RabbitMQ '${id}' deve ter ao menos 4 caracteres`), {
            statusCode: 400,
          });
        }
      }

      if (family === "mysql" && dbRootPassword && dbRootPassword.length < 4) {
        throw Object.assign(new Error(`Senha root do MySQL '${id}' deve ter ao menos 4 caracteres`), {
          statusCode: 400,
        });
      }

      return {
        id,
        name: (db.name || id).trim() || id,
        engine,
        dbName,
        dbUser,
        dbPassword,
        dbRootPassword,
        hostPort: db.hostPort,
      };
    });

    const known = new Set<string>([
      ...applications.map((app) => `app:${app.id}`),
      ...databases.map((db) => `db:${db.id}`),
      ...resolvedWebservers.map((ws) => `gw:${ws.engine}`),
    ]);

    return {
      name,
      domain,
      webservers: resolvedWebservers,
      applications,
      databases,
      envVars: normalized.envVars,
      links,
      networks: normalizeCanvasNetworks((b as { networks?: unknown }).networks, known),
      positions: normalizePositions((b as { positions?: unknown }).positions),
      fail2ban: normalizeFail2ban((b as { fail2ban?: unknown }).fail2ban),
    };
  }

  private redact<T>(env: T): T {
    const source = env as {
      config?: { sshConnections?: Array<Record<string, unknown>> };
    };
    const connections = source.config?.sshConnections;
    if (!connections?.length) return env;
    return {
      ...(env as object),
      config: {
        ...source.config,
        sshConnections: connections.map(({ privateKey: _privateKey, ...rest }) => rest),
      },
    } as T;
  }

  private parseHostPort(raw: unknown, appId: string): number | undefined {
    if (raw == null || raw === "") return undefined;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error(`Porta externa inválida na app '${appId}'`), { statusCode: 400 });
    }
    return port;
  }

  private normalizeDomain(raw: string): string {
    let domain = raw.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (!domain) return domain;

    if (domain.endsWith(".local") && !domain.endsWith(".localhost")) {
      domain = `${domain.slice(0, -".local".length)}.localhost`;
    }

    if (!domain.includes(".")) {
      domain = `${domain}.localhost`;
    }

    return domain;
  }

  private handleError(res: Response, error: unknown): void {
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode: number }).statusCode)
        : 500;
    const message = error instanceof Error ? error.message : "Erro interno";
    res.status(statusCode || 500).json({ error: message });
  }
}
