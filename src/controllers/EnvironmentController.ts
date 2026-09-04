import { Request, Response } from "express";
import { DockerService } from "../services/DockerService";
import {
  CreateEnvironmentInput,
  DatabaseChoice,
  RuntimeChoice,
  WebserverChoice,
} from "../services/TemplateEngine";

const WEBSERVERS: WebserverChoice[] = ["nginx", "apache", "none"];
const RUNTIMES: RuntimeChoice[] = ["php82", "node20", "python311", "go"];
const DATABASES: DatabaseChoice[] = ["mysql8", "postgres15", "redis", "none"];

export class EnvironmentController {
  constructor(private readonly dockerService: DockerService) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    try {
      const environments = await this.dockerService.listEnvironments();
      res.json({ data: environments });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  get = async (req: Request, res: Response): Promise<void> => {
    try {
      const env = await this.dockerService.getEnvironment(req.params.id);
      if (!env) {
        res.status(404).json({ error: "Ambiente não encontrado" });
        return;
      }
      res.json({ data: env });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  create = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = this.parseCreateBody(req.body);
      const env = await this.dockerService.createEnvironment(input);
      res.status(201).json({ data: env });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  start = async (req: Request, res: Response): Promise<void> => {
    try {
      const env = await this.dockerService.startEnvironment(req.params.id);
      res.json({ data: env });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  stop = async (req: Request, res: Response): Promise<void> => {
    try {
      const env = await this.dockerService.stopEnvironment(req.params.id);
      res.json({ data: env });
    } catch (error) {
      this.handleError(res, error);
    }
  };

  logs = async (req: Request, res: Response): Promise<void> => {
    try {
      const tail = Number(req.query.tail || 200);
      const result = await this.dockerService.getLogs(req.params.id, tail);
      res.json({ data: result });
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
      req.on("close", () => ac.abort());

      await this.dockerService.streamLogs(
        req.params.id,
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
    const name = String(b.name || "").trim();
    const domain = String(b.domain || "").trim().toLowerCase();
    const webserver = String(b.webserver || "none") as WebserverChoice;
    const runtime = String(b.runtime || "") as RuntimeChoice;
    const database = String(b.database || "none") as DatabaseChoice;

    if (!name || name.length < 2) {
      throw Object.assign(new Error("Informe um nome de projeto válido"), { statusCode: 400 });
    }
    if (!domain || !/^[a-z0-9.-]+$/.test(domain)) {
      throw Object.assign(new Error("Domínio/subdomínio inválido"), { statusCode: 400 });
    }
    if (!WEBSERVERS.includes(webserver)) {
      throw Object.assign(new Error("Webserver inválido"), { statusCode: 400 });
    }
    if (!RUNTIMES.includes(runtime)) {
      throw Object.assign(new Error("Runtime inválido"), { statusCode: 400 });
    }
    if (!DATABASES.includes(database)) {
      throw Object.assign(new Error("Banco de dados inválido"), { statusCode: 400 });
    }

    const envVarsRaw = Array.isArray(b.envVars) ? b.envVars : [];
    const envVars = envVarsRaw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        return {
          key: String(row.key || "").trim(),
          value: String(row.value ?? ""),
        };
      })
      .filter((v): v is { key: string; value: string } => Boolean(v && v.key));

    return {
      name,
      domain,
      webserver,
      runtime,
      database,
      envVars,
      dbName: b.dbName ? String(b.dbName) : undefined,
      dbUser: b.dbUser ? String(b.dbUser) : undefined,
      dbPassword: b.dbPassword ? String(b.dbPassword) : undefined,
      dbRootPassword: b.dbRootPassword ? String(b.dbRootPassword) : undefined,
    };
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
