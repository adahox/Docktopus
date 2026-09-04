import { promises as fs } from "fs";
import path from "path";
import Handlebars from "handlebars";

export type WebserverChoice = "nginx" | "apache" | "none";
export type RuntimeChoice = "php82" | "node20" | "python311" | "go";
export type DatabaseChoice = "mysql8" | "postgres15" | "redis" | "none";

export interface EnvVar {
  key: string;
  value: string;
}

export interface CreateEnvironmentInput {
  name: string;
  domain: string;
  webserver: WebserverChoice;
  runtime: RuntimeChoice;
  database: DatabaseChoice;
  envVars?: EnvVar[];
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  dbRootPassword?: string;
}

export interface RenderComposeInput extends CreateEnvironmentInput {
  projectId: string;
  proxyNetwork: string;
}

export interface RenderedStack {
  compose: string;
  nginxConf?: string;
}

const RUNTIME_IMAGES: Record<RuntimeChoice, { image: string; port: number }> = {
  php82: { image: "php:8.2-cli", port: 8080 },
  node20: { image: "node:20-alpine", port: 3000 },
  python311: { image: "python:3.11-slim", port: 8000 },
  go: { image: "golang:1.22-alpine", port: 8080 },
};

const WEBSERVER_IMAGES: Record<Exclude<WebserverChoice, "none">, string> = {
  nginx: "nginx:1.27-alpine",
  apache: "httpd:2.4-alpine",
};

const DATABASE_IMAGES: Record<Exclude<DatabaseChoice, "none">, string> = {
  mysql8: "mysql:8.0",
  postgres15: "postgres:15-alpine",
  redis: "redis:7-alpine",
};

export class TemplateEngine {
  private readonly templatesDir: string;
  private composeTemplate: HandlebarsTemplateDelegate | null = null;

  constructor(templatesDir?: string) {
    this.templatesDir = templatesDir ?? path.join(__dirname, "..", "templates");
  }

  async renderCompose(input: RenderComposeInput): Promise<RenderedStack> {
    const template = await this.loadComposeTemplate();
    const runtime = RUNTIME_IMAGES[input.runtime];
    const hasWebserver = input.webserver !== "none";
    const hasDatabase = input.database !== "none";

    const context = {
      projectId: input.projectId,
      projectName: input.name,
      domain: input.domain,
      proxyNetwork: input.proxyNetwork,

      hasWebserver,
      isNginx: input.webserver === "nginx",
      isApache: input.webserver === "apache",
      webserverImage: hasWebserver
        ? WEBSERVER_IMAGES[input.webserver as Exclude<WebserverChoice, "none">]
        : "",

      runtimeImage: runtime.image,
      runtimePort: runtime.port,
      isNode: input.runtime === "node20",
      isPhp: input.runtime === "php82",
      isPython: input.runtime === "python311",
      isGo: input.runtime === "go",

      hasDatabase,
      isMysql: input.database === "mysql8",
      isPostgres: input.database === "postgres15",
      isRedis: input.database === "redis",
      databaseImage: hasDatabase
        ? DATABASE_IMAGES[input.database as Exclude<DatabaseChoice, "none">]
        : "",
      dbName: input.dbName || "app",
      dbUser: input.dbUser || "app",
      dbPassword: input.dbPassword || "appsecret",
      dbRootPassword: input.dbRootPassword || "rootsecret",

      envVars: (input.envVars || []).filter((e) => e.key?.trim()),
      hasEnvVars: (input.envVars || []).some((e) => e.key?.trim()),
    };

    const compose = template(context).replace(/\n{3,}/g, "\n\n").trim() + "\n";

    const result: RenderedStack = { compose };

    if (input.webserver === "nginx") {
      result.nginxConf = this.renderNginxConf(runtime.port);
    }

    return result;
  }

  private renderNginxConf(upstreamPort: number): string {
    return `server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://app:${upstreamPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
  }

  private async loadComposeTemplate(): Promise<HandlebarsTemplateDelegate> {
    if (this.composeTemplate) return this.composeTemplate;

    const filePath = path.join(this.templatesDir, "docker-compose.hbs");
    const source = await fs.readFile(filePath, "utf8");
    this.composeTemplate = Handlebars.compile(source, { noEscape: true });
    return this.composeTemplate;
  }
}
