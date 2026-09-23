import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import Handlebars from "handlebars";

/** @deprecated Prefer WebserverEngine on WebserverSpec */
export type AppFramework = "laravel" | "next" | "adonis" | "django";
export type WebserverChoice = "nginx" | "apache" | "none";
export type WebserverEngine = "nginx" | "apache";

export type RuntimeChoice =
  | "php81"
  | "php82"
  | "php83"
  | "php84"
  | "node18"
  | "node20"
  | "node22"
  | "python310"
  | "python311"
  | "python312"
  | "go121"
  | "go122";

export type DatabaseChoice =
  | "mysql8"
  | "postgres14"
  | "postgres15"
  | "postgres16"
  | "redis"
  | "mongo"
  | "rabbitmq"
  | "none";

export type DatabaseEngine = Exclude<DatabaseChoice, "none">;

export interface EnvVar {
  key: string;
  value: string;
}

export interface WebserverRoute {
  subdomain: string;
  appId: string;
}

/** Gateway HTTP do cliente (nginx/apache), separado das apps. */
export interface WebserverSpec {
  id: string;
  name: string;
  engine: WebserverEngine;
  routes: WebserverRoute[];
  /** false = existe na rede interna, mas o Traefik não publica. */
  published?: boolean;
}

export type AppSource = "runtime" | "project";

export interface ApplicationSpec {
  id: string;
  name: string;
  /** Subdomínio público se exposta direto no Traefik (sem rota de webserver). */
  subdomain?: string | null;
  runtime: RuntimeChoice;
  /** owner/repo no GitHub, usado para automação de deploy. */
  githubRepo?: string | null;
  /** project = sobe pelo Dockerfile e docker-compose da pasta da aplicação. */
  source?: AppSource;
  composeFile?: string;
  composeService?: string;
  containerPort?: number;
  /** Porta publicada no host. Vazia deixa a aplicação só na rede Docker. */
  hostPort?: number | null;
  /** Framework instalado na criação: Laravel no PHP, Next.js ou AdonisJS no Node. */
  framework?: AppFramework;
  /** @deprecated migrated to webservers[] */
  webserver?: WebserverChoice;
}

/** Caminho relativo dentro da pasta da aplicação. */
export function normalizeAppFramework(runtime: string, source: string, raw: unknown): AppFramework | undefined {
  if (source === "project") return undefined;
  if (String(runtime).startsWith("php") && raw === "laravel") return "laravel";
  if (String(runtime).startsWith("node") && (raw === "next" || raw === "adonis")) return raw;
  if (String(runtime).startsWith("python") && raw === "django") return "django";
  return undefined;
}

export function normalizeProjectFile(raw: unknown, fallback: string): string {
  const value = String(raw ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  const file = value || fallback;
  if (!/^[A-Za-z0-9_./-]+$/.test(file) || file.startsWith("/") || file.split("/").includes("..")) {
    throw Object.assign(new Error(`Arquivo do projeto inválido '${file}'`), { statusCode: 400 });
  }
  return file;
}

export function normalizeComposeService(raw: unknown, fallback: string): string {
  const value = String(raw ?? "").trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/.test(value)) {
    throw Object.assign(new Error(`Serviço do compose inválido '${value}'`), { statusCode: 400 });
  }
  return value;
}

/** Aceita owner/repo, URL https ou git@github.com:owner/repo.git. */
export function normalizeGithubRepo(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const slug = value
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw Object.assign(
      new Error(
        `Repositório GitHub inválido '${value}'. Use org/repo ou https://github.com/org/repo`
      ),
      { statusCode: 400 }
    );
  }
  return slug;
}

export interface DatabaseSpec {
  id: string;
  name: string;
  engine: DatabaseEngine;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  dbRootPassword?: string;
  hostPort?: number;
}

export interface ServiceLink {
  source: string;
  target: string;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

/** Rede desenhada no canvas. Quem está dentro do quadrado entra em `members`. */
export interface CanvasNetwork {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  members: string[];
  color?: string;
  subnet?: string;
  gateway?: string;
}

export interface Fail2banSpec {
  enabled: boolean;
  /** Segundos que o IP fica bloqueado. */
  bantime: number;
  /** Janela, em segundos, em que as tentativas são contadas. */
  findtime: number;
  maxretry: number;
  ignoreip: string;
}

export function normalizeFail2ban(raw: unknown): Fail2banSpec {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const clamp = (value: number, min: number, max: number, fallback: number) => {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  const ignoreip = String(source.ignoreip ?? "127.0.0.1/8 ::1")
    .trim()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ");
  if (!ignoreip || !/^[0-9a-fA-F.:/\s]+$/.test(ignoreip)) {
    throw Object.assign(
      new Error("IPs ignorados pelo fail2ban devem ser endereços ou redes, separados por espaço"),
      { statusCode: 400 }
    );
  }
  return {
    enabled: source.enabled === true || source.enabled === "true",
    bantime: clamp(Number(source.bantime), 60, 7 * 24 * 3600, 3600),
    findtime: clamp(Number(source.findtime), 30, 24 * 3600, 600),
    maxretry: clamp(Number(source.maxretry), 1, 20, 5),
    ignoreip,
  };
}

export function fail2banJailName(projectId: string): string {
  const slug = projectId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  return `dt${slug || "env"}`;
}

export function renderFail2banJail(projectId: string, spec: Fail2banSpec): string {
  return `[DEFAULT]
bantime = ${spec.bantime}
findtime = ${spec.findtime}
maxretry = ${spec.maxretry}
ignoreip = ${spec.ignoreip}
ignoreself = true

[${fail2banJailName(projectId)}]
enabled = true
filter = docktopus-ssh
backend = polling
logpath = /remotelogs/*/openssh/current
banaction = iptables-allports
chain = DOCKER-USER
`;
}

export function renderFail2banFilter(): string {
  return `[Definition]
prefregex = ^(?:@\\d+\\s+)?<F-CONTENT>.+</F-CONTENT>$
failregex = ^Failed \\S+ for invalid user \\S+ from <HOST>
            ^Failed \\S+ for \\S+ from <HOST>
            ^Invalid user \\S+ from <HOST>
            ^Disconnected from(?: invalid user)? \\S+ <HOST> \\[preauth\\]
ignoreregex =
datepattern = {^LN-BEG}
`;
}

export interface CreateEnvironmentInput {
  name: string;
  domain: string;
  webservers: WebserverSpec[];
  applications: ApplicationSpec[];
  databases: DatabaseSpec[];
  envVars?: EnvVar[];
  /** Quando presente, as redes Docker seguem estas ligações em vez do compartilhamento total. */
  links?: ServiceLink[];
  networks?: CanvasNetwork[];
  positions?: Record<string, CanvasPoint>;
  fail2ban?: Fail2banSpec;
}

function cidr(value: unknown): string | undefined {
  const text = String(value || "");
  const match = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((part) => part > 255) || prefix < 8 || prefix > 32) return undefined;
  return text;
}

function ipv4(value: unknown): string | undefined {
  const text = String(value || "");
  const match = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return undefined;
  if (match.slice(1).some((part) => Number(part) > 255)) return undefined;
  return text;
}

export function canvasNetworkName(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `lane-${slug || "net"}`.slice(0, 48);
}

export function normalizeCanvasNetworks(raw: unknown, known: Set<string>): CanvasNetwork[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const networks: CanvasNetwork[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const id = String(source.id || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const width = Number(source.width);
    const height = Number(source.height);
    const members = Array.isArray(source.members)
      ? [...new Set(source.members.map((member) => String(member)).filter((member) => known.has(member)))]
      : [];
    const color = /^#[0-9a-fA-F]{6}$/.test(String(source.color || "")) ? String(source.color).toLowerCase() : undefined;
    const subnet = cidr(source.subnet);
    const gateway = ipv4(source.gateway);
    networks.push({
      id,
      name: String(source.name || id).trim().slice(0, 40) || id,
      x: Number.isFinite(Number(source.x)) ? Number(source.x) : 0,
      y: Number.isFinite(Number(source.y)) ? Number(source.y) : 0,
      width: Number.isFinite(width) ? Math.min(4000, Math.max(72, width)) : 220,
      height: Number.isFinite(height) ? Math.min(4000, Math.max(72, height)) : 180,
      members,
      color,
      subnet,
      gateway: gateway || (subnet ? subnet.replace(/\/\d+$/, "").replace(/\.\d+$/, ".1") : undefined),
    });
  }
  return networks;
}

export function normalizePositions(raw: unknown): Record<string, CanvasPoint> {
  if (!raw || typeof raw !== "object") return {};
  const positions: Record<string, CanvasPoint> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^(edge|gw:(nginx|apache)|app:[a-z0-9-]+|db:[a-z0-9-]+)$/.test(key)) continue;
    if (!value || typeof value !== "object") continue;
    const point = value as Record<string, unknown>;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 20000 || Math.abs(y) > 20000) continue;
    positions[key] = { x, y };
  }
  return positions;
}

export function linkEnds(link: ServiceLink): [string, string] {
  return [link.source, link.target];
}

export function canShareNetwork(source: string, target: string): boolean {
  if (!source || !target || source === target) return false;
  const kind = (id: string) => (id === "edge" ? "edge" : id.split(":")[0]);
  const pair = [kind(source), kind(target)].sort().join("-");
  return ["app-app", "app-db", "app-edge", "app-gw", "edge-gw"].includes(pair);
}

export function normalizeServiceLinks(raw: unknown): ServiceLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const links: ServiceLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = String((item as { source?: unknown }).source || "");
    const target = String((item as { target?: unknown }).target || "");
    if (!canShareNetwork(source, target)) continue;
    const [a, b] = [source, target].sort();
    const key = `${a}~${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: a, target: b });
  }
  return links;
}

export function shareNetworkName(source: string, target: string): string {
  const slug = [source, target]
    .sort()
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `share-${slug}`.slice(0, 48);
}

export function networksFor(self: string, links: ServiceLink[], skipPairShares = false): string[] {
  const nets = new Set<string>();
  for (const link of links) {
    const [a, b] = linkEnds(link);
    if (a !== self && b !== self) continue;
    const other = a === self ? b : a;
    if (other === "edge") nets.add("proxy");
    else if (!skipPairShares) nets.add(shareNetworkName(self, other));
  }
  if (!nets.size) {
    const solo = `solo-${self.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 48);
    nets.add(solo);
  }
  return [...nets];
}

export function attachLanes(base: string[], self: string, lanes: CanvasNetwork[] = []): string[] {
  const names = lanes.filter((lane) => lane.members.includes(self)).map((lane) => canvasNetworkName(lane.id));
  const merged = [...new Set([...base, ...names])];
  if (!names.length) return merged;
  return merged.filter((name) => !name.startsWith("solo-"));
}

/** App em outra rede entra na rede do banco para conseguir alcançá-lo. */
export function attachDatabaseReach(base: string[], self: string, links: ServiceLink[], lanes: CanvasNetwork[] = []): string[] {
  if (!lanes.length) return base;
  const extra = new Set(base);
  for (const link of links) {
    const [a, b] = linkEnds(link);
    if (a !== self && b !== self) continue;
    const other = a === self ? b : a;
    const isAppDb = (self.startsWith("app:") && other.startsWith("db:")) || (self.startsWith("db:") && other.startsWith("app:"));
    if (!isAppDb) continue;
    const dbKey = self.startsWith("db:") ? self : other;
    const dbLanes = lanes.filter((lane) => lane.members.includes(dbKey));
    if (dbLanes.length) {
      if (self.startsWith("app:")) {
        for (const lane of dbLanes) extra.add(canvasNetworkName(lane.id));
      }
    } else {
      extra.add(shareNetworkName(self, other));
    }
  }
  const merged = [...extra];
  return merged.some((name) => !name.startsWith("solo-")) ? merged.filter((name) => !name.startsWith("solo-")) : merged;
}

export function linkedDatabaseIds(appId: string, links: ServiceLink[]): string[] {
  const self = `app:${appId}`;
  const ids: string[] = [];
  for (const link of links) {
    const [a, b] = linkEnds(link);
    if (a === self && b.startsWith("db:")) ids.push(b.slice(3));
    if (b === self && a.startsWith("db:")) ids.push(a.slice(3));
  }
  return ids;
}

export function webserversFromLinks(
  links: ServiceLink[],
  applications: ApplicationSpec[],
  domain: string
): WebserverSpec[] {
  const byEngine = new Map<WebserverEngine, WebserverRoute[]>();
  const published = new Set<WebserverEngine>();
  for (const link of links) {
    const [a, b] = linkEnds(link);
    const gw = [a, b].find((item) => item.startsWith("gw:"));
    const app = [a, b].find((item) => item.startsWith("app:"));
    const edge = a === "edge" || b === "edge";
    if (!gw) continue;
    const engine: WebserverEngine = gw.endsWith("apache") ? "apache" : "nginx";
    if (edge) {
      published.add(engine);
      if (!byEngine.has(engine)) byEngine.set(engine, []);
    }
    if (!app) continue;
    const spec = applications.find((item) => item.id === app.slice(4));
    if (!spec) continue;
    const routes = byEngine.get(engine) || [];
    routes.push({ subdomain: (spec.subdomain || domain).toLowerCase(), appId: spec.id });
    byEngine.set(engine, routes);
  }
  return [...byEngine.entries()].map(([engine, routes]) => ({
    id: engine,
    name: engine,
    engine,
    routes,
    published: routes.length > 0 || published.has(engine),
  }));
}

export interface DatabaseConnectionInfo {
  id: string;
  engine: DatabaseEngine;
  host: string;
  port: number | null;
  hostPort: number | null;
  name: string | null;
  user: string | null;
  password: string | null;
  rootPassword: string | null;
  connectionUrl: string | null;
  externalUrl: string | null;
  jdbcUrl: string | null;
}

export interface ApplicationSshInfo {
  appId: string;
  user: string;
  password: string;
  hostPort: number;
  publicKey: string;
  privateKey: string;
  /** Ex.: ssh -p 22201 docktopus@127.0.0.1 */
  command: string;
}

export interface PublicEndpoint {
  subdomain: string;
  serviceId: string;
  kind: "webserver" | "application";
  host: string;
  port: number;
  appId?: string;
}

export interface RenderComposeInput extends CreateEnvironmentInput {
  projectId: string;
  proxyNetwork: string;
  databases: DatabaseSpec[];
  appEnvVars: Record<string, EnvVar[]>;
  sshConnections: ApplicationSshInfo[];
  /** Chaves de rede que já existem no Docker e não devem ser recriadas. */
  existingNetworks?: string[];
}

export interface RenderedStack {
  compose: string;
  nginxConfs: Array<{ filename: string; content: string }>;
}

export const WEBSERVER_OPTIONS: WebserverChoice[] = ["nginx", "apache", "none"];
export const WEBSERVER_ENGINE_OPTIONS: WebserverEngine[] = ["nginx", "apache"];

export const RUNTIME_OPTIONS: RuntimeChoice[] = [
  "php81",
  "php82",
  "php83",
  "php84",
  "node18",
  "node20",
  "node22",
  "python310",
  "python311",
  "python312",
  "go121",
  "go122",
];

export const DATABASE_OPTIONS: DatabaseChoice[] = [
  "mysql8",
  "postgres14",
  "postgres15",
  "postgres16",
  "redis",
  "mongo",
  "rabbitmq",
  "none",
];

export const DATABASE_ENGINE_OPTIONS: DatabaseEngine[] = [
  "mysql8",
  "postgres14",
  "postgres15",
  "postgres16",
  "redis",
  "mongo",
  "rabbitmq",
];

const RUNTIME_IMAGES: Record<RuntimeChoice, { image: string; port: number }> = {
  php81: { image: "php:8.1-cli", port: 8080 },
  php82: { image: "php:8.2-cli", port: 8080 },
  php83: { image: "php:8.3-cli", port: 8080 },
  php84: { image: "php:8.4-cli", port: 8080 },
  node18: { image: "node:18-alpine", port: 3000 },
  node20: { image: "node:20-alpine", port: 3000 },
  node22: { image: "node:22-alpine", port: 3000 },
  python310: { image: "python:3.10-slim", port: 8000 },
  python311: { image: "python:3.11-slim", port: 8000 },
  python312: { image: "python:3.12-slim", port: 8000 },
  go121: { image: "golang:1.21-alpine", port: 8080 },
  go122: { image: "golang:1.22-alpine", port: 8080 },
};

const WEBSERVER_IMAGES: Record<WebserverEngine, string> = {
  nginx: "nginx:1.27-alpine",
  apache: "httpd:2.4-alpine",
};

const DATABASE_IMAGES: Record<DatabaseEngine, string> = {
  mysql8: "mysql:8.0",
  postgres14: "postgres:14-alpine",
  postgres15: "postgres:15-alpine",
  postgres16: "postgres:16-alpine",
  redis: "redis:7-alpine",
  mongo: "mongo:7",
  rabbitmq: "rabbitmq:3-management-alpine",
};

export function databaseFamily(
  database: DatabaseChoice | DatabaseEngine
): "mysql" | "postgres" | "redis" | "mongo" | "rabbitmq" | "none" {
  if (database === "none") return "none";
  if (String(database).startsWith("mysql")) return "mysql";
  if (String(database).startsWith("postgres")) return "postgres";
  if (database === "redis") return "redis";
  if (database === "mongo") return "mongo";
  if (database === "rabbitmq") return "rabbitmq";
  return "none";
}

export function slugifyServiceId(raw: string, fallback = "svc"): string {
  const slug = String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || fallback;
}

export function appsBehindWebserver(webservers: WebserverSpec[]): Set<string> {
  const ids = new Set<string>();
  for (const ws of webservers || []) {
    for (const route of ws.routes || []) {
      if (route.appId) ids.add(route.appId);
    }
  }
  return ids;
}

/** Converts legacy payloads into webservers[] + applications[] + databases[]. */
export function normalizeCreateInput(raw: Record<string, unknown>): CreateEnvironmentInput {
  const name = String(raw.name || "").trim();
  const domain = String(raw.domain || "").trim().toLowerCase();
  const envVars = Array.isArray(raw.envVars)
    ? (raw.envVars as EnvVar[]).filter((e) => e?.key?.trim())
    : [];

  const parseDatabases = (): DatabaseSpec[] =>
    Array.isArray(raw.databases)
      ? (raw.databases as Record<string, unknown>[]).map((d, i) => {
          const engine = String(d.engine || "mysql8") as DatabaseEngine;
          const id = slugifyServiceId(String(d.id || d.name || engine), `db${i + 1}`);
          return {
            id,
            name: String(d.name || id).trim() || id,
            engine,
            dbName: d.dbName ? String(d.dbName).trim() : undefined,
            dbUser: d.dbUser ? String(d.dbUser).trim() : undefined,
            dbPassword: d.dbPassword != null ? String(d.dbPassword) : undefined,
            dbRootPassword: d.dbRootPassword != null ? String(d.dbRootPassword) : undefined,
            hostPort: d.hostPort != null ? Number(d.hostPort) : undefined,
          };
        })
      : [];

  if (Array.isArray(raw.applications) && raw.applications.length > 0) {
    const legacyRoutes: WebserverRoute[] = [];
    let legacyEngine: WebserverEngine = "nginx";

    const applications = (raw.applications as Record<string, unknown>[]).map((a, i) => {
      let runtime = String(a.runtime || "php82") as RuntimeChoice | "go";
      if (runtime === "go") runtime = "go122";
      const id = slugifyServiceId(String(a.id || a.name || `app${i + 1}`), `app${i + 1}`);
      const subdomain = String(a.subdomain || domain)
        .trim()
        .toLowerCase();
      const embedded = String(a.webserver || "none") as WebserverChoice;
      if (embedded === "nginx" || embedded === "apache") {
        legacyEngine = embedded;
        if (subdomain) legacyRoutes.push({ subdomain, appId: id });
      }
      return {
        id,
        name: String(a.name || id).trim() || id,
        subdomain: subdomain || null,
        runtime: runtime as RuntimeChoice,
        githubRepo: a.githubRepo ? String(a.githubRepo).trim() : null,
        source: a.source === "project" ? ("project" as const) : ("runtime" as const),
        composeFile: a.composeFile ? String(a.composeFile) : undefined,
        composeService: a.composeService ? String(a.composeService) : undefined,
        containerPort: a.containerPort != null && a.containerPort !== "" ? Number(a.containerPort) : undefined,
        hostPort: a.hostPort != null && a.hostPort !== "" ? Number(a.hostPort) : undefined,
        framework: normalizeAppFramework(String(runtime), a.source === "project" ? "project" : "runtime", a.framework),
      };
    });

    let webservers: WebserverSpec[] = Array.isArray(raw.webservers)
      ? (raw.webservers as Record<string, unknown>[]).map((w, i) => {
          const id = slugifyServiceId(String(w.id || w.name || `web${i + 1}`), `web${i + 1}`);
          const engine = (String(w.engine || "nginx") === "apache" ? "apache" : "nginx") as WebserverEngine;
          const routes = Array.isArray(w.routes)
            ? (w.routes as Record<string, unknown>[])
                .map((r) => ({
                  subdomain: String(r.subdomain || "").trim().toLowerCase(),
                  appId: String(r.appId || "").trim(),
                }))
                .filter((r) => r.subdomain && r.appId)
            : [];
          return {
            id,
            name: String(w.name || id).trim() || id,
            engine,
            routes,
          };
        })
      : [];

    // Migrate embedded per-app webservers into one gateway
    if (!webservers.length && legacyRoutes.length) {
      webservers = [
        {
          id: legacyEngine,
          name: legacyEngine,
          engine: legacyEngine,
          routes: legacyRoutes,
        },
      ];
    }

    return {
      name,
      domain,
      webservers,
      applications,
      databases: parseDatabases(),
      envVars,
    };
  }

  // Very legacy shape
  let runtime = String(raw.runtime || "php82") as RuntimeChoice | "go";
  if (runtime === "go") runtime = "go122";
  const webserver = String(raw.webserver || "nginx") as WebserverChoice;
  const database = String(raw.database || "none") as DatabaseChoice;

  const applications: ApplicationSpec[] = [
    {
      id: "app",
      name: "app",
      subdomain: domain,
      runtime: runtime as RuntimeChoice,
    },
  ];

  const webservers: WebserverSpec[] =
    webserver === "nginx" || webserver === "apache"
      ? [
          {
            id: webserver,
            name: webserver,
            engine: webserver,
            routes: [{ subdomain: domain, appId: "app" }],
          },
        ]
      : [];

  const databases: DatabaseSpec[] =
    database === "none"
      ? []
      : [
          {
            id: "db",
            name: "db",
            engine: database as DatabaseEngine,
            dbName: raw.dbName ? String(raw.dbName).trim() : undefined,
            dbUser: raw.dbUser ? String(raw.dbUser).trim() : undefined,
            dbPassword: raw.dbPassword != null ? String(raw.dbPassword) : undefined,
            dbRootPassword: raw.dbRootPassword != null ? String(raw.dbRootPassword) : undefined,
          },
        ];

  return { name, domain, webservers, applications, databases, envVars };
}

export class TemplateEngine {
  private readonly templatesDir: string;
  private composeTemplate: HandlebarsTemplateDelegate | null = null;

  constructor(templatesDir?: string) {
    this.templatesDir = templatesDir ?? path.join(__dirname, "..", "templates");
  }

  static getRuntimePort(runtime: RuntimeChoice): number {
    return RUNTIME_IMAGES[runtime].port;
  }

  /** Porta em que a aplicação escuta dentro do container. */
  static listenPort(app: ApplicationSpec): number {
    if (app.source === "project") {
      const port = Number(app.containerPort || 80);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
      return 80;
    }
    return RUNTIME_IMAGES[app.runtime].port;
  }

  static resolveBackend(
    projectId: string,
    app: ApplicationSpec
  ): { host: string; port: number } {
    return {
      host: `${projectId}-${app.id}`,
      port: TemplateEngine.listenPort(app),
    };
  }

  /** Hostnames públicos (webserver routes + apps diretas no Traefik). */
  static collectPublicHosts(
    webservers: WebserverSpec[],
    applications: ApplicationSpec[]
  ): string[] {
    return TemplateEngine.collectPublicEndpoints("x", webservers, applications).map(
      (e) => e.subdomain
    );
  }

  static collectPublicEndpoints(
    projectId: string,
    webservers: WebserverSpec[],
    applications: ApplicationSpec[]
  ): PublicEndpoint[] {
    const behind = appsBehindWebserver(webservers);
    const endpoints: PublicEndpoint[] = [];
    const seen = new Set<string>();

    for (const ws of webservers || []) {
      if (ws.published === false) continue;
      for (const route of ws.routes || []) {
        const host = route.subdomain?.toLowerCase();
        if (!host || seen.has(host)) continue;
        seen.add(host);
        endpoints.push({
          subdomain: host,
          serviceId: ws.id,
          kind: "webserver",
          host: `${projectId}-${ws.id}`,
          port: 80,
          appId: route.appId,
        });
      }
    }

    for (const app of applications || []) {
      const host = app.subdomain?.toLowerCase();
      if (!host || behind.has(app.id) || seen.has(host)) continue;
      seen.add(host);
      endpoints.push({
        subdomain: host,
        serviceId: app.id,
        kind: "application",
        host: `${projectId}-${app.id}`,
        port: TemplateEngine.listenPort(app),
        appId: app.id,
      });
    }

    return endpoints;
  }

  static resolveDatabaseDefaults(db: DatabaseSpec): {
    dbName: string;
    dbUser: string;
    dbPassword: string;
    dbRootPassword: string;
  } {
    return {
      dbName: (db.dbName || "app").trim() || "app",
      dbUser: (db.dbUser || "app").trim() || "app",
      dbPassword: (db.dbPassword || "appsecret").trim() || "appsecret",
      dbRootPassword: (db.dbRootPassword || "rootsecret").trim() || "rootsecret",
    };
  }

  static allocateDbHostPort(
    projectId: string,
    engine: DatabaseEngine,
    dbId = "db"
  ): number {
    const family = databaseFamily(engine);
    let hash = 0;
    const key = `${projectId}:${dbId}`;
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    const base =
      family === "mysql" ? 13306 : family === "postgres" ? 15432 : family === "mongo" ? 27017 : family === "rabbitmq" ? 25672 : 16379;
    return base + (hash % 600);
  }

  static findFreeHostPort(preferred: number, taken: Set<number>, span = 800): number {
    const start = Math.max(1024, Math.min(preferred, 65000));
    for (let i = 0; i < span; i += 1) {
      const candidate = start + i;
      if (candidate > 65535) break;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error(
      `Nenhuma porta livre a partir de ${preferred}. Libere portas ou remova ambientes antigos.`
    );
  }

  static allocateSshHostPort(projectId: string, appId: string): number {
    let hash = 0;
    const key = `${projectId}:ssh:${appId}`;
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return 22000 + (hash % 800);
  }

  static randomSshPassword(length = 20): string {
    const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(length);
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
  }

  /** Preserva SSH de apps existentes; gera user/senha/porta/chave para apps novas. */
  static withAllocatedSsh(
    projectId: string,
    applications: ApplicationSpec[],
    previous?: ApplicationSshInfo[],
    reservedPorts?: Set<number>,
    keyPairs?: Record<string, { publicKey: string; privateKey: string }>
  ): ApplicationSshInfo[] {
    const taken = new Set(reservedPorts || []);
    const prevByApp = new Map((previous || []).map((s) => [s.appId, s]));

    return applications.map((app) => {
      const prev = prevByApp.get(app.id);
      if (prev?.password && prev.privateKey && prev.publicKey && prev.hostPort) {
        taken.add(prev.hostPort);
        return {
          ...prev,
          command: `ssh -p ${prev.hostPort} ${prev.user}@127.0.0.1`,
        };
      }

      const preferred = prev?.hostPort || TemplateEngine.allocateSshHostPort(projectId, app.id);
      const hostPort = taken.has(preferred)
        ? TemplateEngine.findFreeHostPort(preferred, taken)
        : preferred;
      taken.add(hostPort);

      const user = prev?.user || "docktopus";
      const password = prev?.password || TemplateEngine.randomSshPassword();
      const keys = keyPairs?.[app.id];
      const publicKey = keys?.publicKey || prev?.publicKey || "";
      const privateKey = keys?.privateKey || prev?.privateKey || "";

      return {
        appId: app.id,
        user,
        password,
        hostPort,
        publicKey,
        privateKey,
        command: `ssh -p ${hostPort} ${user}@127.0.0.1`,
      };
    });
  }

  static withAllocatedPorts(
    projectId: string,
    databases: DatabaseSpec[],
    previous?: DatabaseSpec[],
    reservedPorts?: Set<number>
  ): DatabaseSpec[] {
    const taken = new Set(reservedPorts || []);
    const prevById = new Map((previous || []).map((d) => [d.id, d]));

    return databases.map((db) => {
      const prev = prevById.get(db.id);
      const preferred =
        (prev?.engine === db.engine && prev.hostPort) ||
        db.hostPort ||
        TemplateEngine.allocateDbHostPort(projectId, db.engine, db.id);

      let hostPort = preferred;
      if (taken.has(hostPort)) {
        hostPort = TemplateEngine.findFreeHostPort(preferred, taken);
      }
      taken.add(hostPort);

      const defaults = TemplateEngine.resolveDatabaseDefaults(db);
      return {
        ...db,
        ...defaults,
        hostPort,
      };
    });
  }

  static buildDatabaseConnection(
    db: DatabaseSpec,
    options?: { projectId?: string; hostPort?: number | null }
  ): DatabaseConnectionInfo {
    const defaults = TemplateEngine.resolveDatabaseDefaults(db);
    const host = db.id;
    const family = databaseFamily(db.engine);
    const hostPort =
      options?.hostPort ??
      (options?.projectId
        ? TemplateEngine.allocateDbHostPort(options.projectId, db.engine, db.id)
        : db.hostPort ?? null);

    if (family === "mysql") {
      return {
        id: db.id,
        engine: db.engine,
        host,
        port: 3306,
        hostPort,
        name: defaults.dbName,
        user: defaults.dbUser,
        password: defaults.dbPassword,
        rootPassword: defaults.dbRootPassword,
        connectionUrl: `mysql://${defaults.dbUser}:${encodeURIComponent(defaults.dbPassword)}@${host}:3306/${defaults.dbName}`,
        externalUrl: hostPort
          ? `mysql://${defaults.dbUser}:${encodeURIComponent(defaults.dbPassword)}@127.0.0.1:${hostPort}/${defaults.dbName}`
          : null,
        jdbcUrl: hostPort
          ? `jdbc:mysql://127.0.0.1:${hostPort}/${defaults.dbName}?allowPublicKeyRetrieval=true&useSSL=false`
          : null,
      };
    }

    if (family === "postgres") {
      return {
        id: db.id,
        engine: db.engine,
        host,
        port: 5432,
        hostPort,
        name: defaults.dbName,
        user: defaults.dbUser,
        password: defaults.dbPassword,
        rootPassword: null,
        connectionUrl: `postgres://${defaults.dbUser}:${encodeURIComponent(defaults.dbPassword)}@${host}:5432/${defaults.dbName}`,
        externalUrl: hostPort
          ? `postgres://${defaults.dbUser}:${encodeURIComponent(defaults.dbPassword)}@127.0.0.1:${hostPort}/${defaults.dbName}`
          : null,
        jdbcUrl: hostPort
          ? `jdbc:postgresql://127.0.0.1:${hostPort}/${defaults.dbName}`
          : null,
      };
    }

    if (family === "mongo") {
      return {
        id: db.id,
        engine: db.engine,
        host,
        port: 27017,
        hostPort,
        name: defaults.dbName,
        user: defaults.dbUser,
        password: defaults.dbPassword,
        rootPassword: null,
        connectionUrl: `mongodb://${defaults.dbUser}:${encodeURIComponent(defaults.dbPassword)}@${host}:27017/${defaults.dbName}`,
        externalUrl: hostPort
          ? `mongodb://${defaults.dbUser}:${encodeURIComponent(defaults.dbPassword)}@127.0.0.1:${hostPort}/${defaults.dbName}`
          : null,
        jdbcUrl: hostPort ? `mongodb://127.0.0.1:${hostPort}/${defaults.dbName}` : null,
      };
    }

    if (family === "rabbitmq") {
      return {
        id: db.id,
        engine: db.engine,
        host,
        port: 5672,
        hostPort,
        name: null,
        user: defaults.dbUser,
        password: defaults.dbPassword,
        rootPassword: null,
        connectionUrl: `amqp://${defaults.dbUser}:${encodeURIComponent(defaults.dbPassword)}@${host}:5672`,
        externalUrl: hostPort
          ? `amqp://${defaults.dbUser}:${encodeURIComponent(defaults.dbPassword)}@127.0.0.1:${hostPort}`
          : null,
        jdbcUrl: null,
      };
    }

    return {
      id: db.id,
      engine: "redis",
      host,
      port: 6379,
      hostPort,
      name: null,
      user: null,
      password: defaults.dbPassword !== "appsecret" ? defaults.dbPassword : null,
      rootPassword: null,
      connectionUrl:
        defaults.dbPassword !== "appsecret"
          ? `redis://:${encodeURIComponent(defaults.dbPassword)}@${host}:6379`
          : `redis://${host}:6379`,
      externalUrl: hostPort
        ? defaults.dbPassword !== "appsecret"
          ? `redis://:${encodeURIComponent(defaults.dbPassword)}@127.0.0.1:${hostPort}`
          : `redis://127.0.0.1:${hostPort}`
        : null,
      jdbcUrl: null,
    };
  }

  static buildAppEnvVars(
    databases: DatabaseSpec[],
    connections: DatabaseConnectionInfo[],
    customEnvVars?: EnvVar[]
  ): EnvVar[] {
    const custom = (customEnvVars || []).filter((e) => e.key?.trim());
    const generated: EnvVar[] = [];

    const sql = connections.find(
      (c) => databaseFamily(c.engine) === "mysql" || databaseFamily(c.engine) === "postgres"
    );
    const redis = connections.find((c) => databaseFamily(c.engine) === "redis");

    if (sql) {
      const defaults = TemplateEngine.resolveDatabaseDefaults(
        databases.find((d) => d.id === sql.id) || {
          id: sql.id,
          name: sql.id,
          engine: sql.engine,
        }
      );
      generated.push({ key: "DB_HOST", value: sql.host });
      if (sql.port) generated.push({ key: "DB_PORT", value: String(sql.port) });
      if (sql.name) {
        generated.push({ key: "DB_NAME", value: sql.name });
        generated.push({ key: "DB_DATABASE", value: sql.name });
      }
      if (sql.user) {
        generated.push({ key: "DB_USER", value: sql.user });
        generated.push({ key: "DB_USERNAME", value: sql.user });
      }
      if (sql.password) generated.push({ key: "DB_PASSWORD", value: sql.password });
      if (sql.connectionUrl) generated.push({ key: "DATABASE_URL", value: sql.connectionUrl });
      if (databaseFamily(sql.engine) === "mysql") {
        generated.push({ key: "DB_CONNECTION", value: "mysql" });
        generated.push({ key: "MYSQL_ROOT_PASSWORD", value: defaults.dbRootPassword });
      } else {
        generated.push({ key: "DB_CONNECTION", value: "pgsql" });
      }
    }

    if (redis) {
      generated.push({ key: "REDIS_HOST", value: redis.host });
      generated.push({ key: "REDIS_PORT", value: "6379" });
      if (redis.password) generated.push({ key: "REDIS_PASSWORD", value: redis.password });
      if (redis.connectionUrl) generated.push({ key: "REDIS_URL", value: redis.connectionUrl });
    }

    const mongo = connections.find((c) => databaseFamily(c.engine) === "mongo");
    if (mongo) {
      generated.push({ key: "MONGO_HOST", value: mongo.host });
      generated.push({ key: "MONGO_PORT", value: "27017" });
      if (mongo.name) generated.push({ key: "MONGO_DB", value: mongo.name });
      if (mongo.user) generated.push({ key: "MONGO_USER", value: mongo.user });
      if (mongo.password) generated.push({ key: "MONGO_PASSWORD", value: mongo.password });
      if (mongo.connectionUrl) generated.push({ key: "MONGO_URL", value: mongo.connectionUrl });
    }

    const rabbit = connections.find((c) => databaseFamily(c.engine) === "rabbitmq");
    if (rabbit) {
      generated.push({ key: "RABBITMQ_HOST", value: rabbit.host });
      generated.push({ key: "RABBITMQ_PORT", value: "5672" });
      if (rabbit.user) generated.push({ key: "RABBITMQ_USER", value: rabbit.user });
      if (rabbit.password) generated.push({ key: "RABBITMQ_PASSWORD", value: rabbit.password });
      if (rabbit.connectionUrl) generated.push({ key: "RABBITMQ_URL", value: rabbit.connectionUrl });
    }

    const customKeys = new Set(custom.map((e) => e.key));
    return [...generated.filter((e) => !customKeys.has(e.key)), ...custom];
  }

  async renderCompose(input: RenderComposeInput): Promise<RenderedStack> {
    const template = await this.loadComposeTemplate();
    const manual = Array.isArray(input.links);
    const links = input.links || [];
    const lanes = input.networks || [];
    const dbIds = input.databases.map((d) => d.id);
    const behind = appsBehindWebserver(input.webservers || []);
    const appById = new Map(input.applications.map((a) => [a.id, a]));

    const webservers = (input.webservers || []).map((ws) => {
      const routeApps = (ws.routes || [])
        .map((r) => appById.get(r.appId))
        .filter(Boolean) as ApplicationSpec[];
      const depends = [...new Set(routeApps.map((a) => a.id))];
      return {
        ...ws,
        isNginx: ws.engine === "nginx",
        isApache: ws.engine === "apache",
        webserverImage: WEBSERVER_IMAGES[ws.engine],
        nginxConfFile: `nginx-${ws.id}.conf`,
        apacheConfFile: `apache-${ws.id}.conf`,
        depends,
        hasDepends: depends.length > 0,
        networks: attachLanes(
          [
            ...(manual ? networksFor(`gw:${ws.engine}`, links, lanes.length > 0) : ["proxy", "internal"]),
            ...(ws.published !== false && (ws.routes || []).length ? ["proxy"] : []),
          ].filter((name, index, list) => name && list.indexOf(name) === index),
          `gw:${ws.engine}`,
          lanes
        ),
      };
    });

    const sshByApp = new Map((input.sshConnections || []).map((s) => [s.appId, s]));

    const applications = input.applications.map((app) => {
      const runtime = RUNTIME_IMAGES[app.runtime];
      const fromProject = app.source === "project";
      const envVars = [...(input.appEnvVars[app.id] || [])];
      const isNext = !fromProject && app.framework === "next" && app.runtime.startsWith("node");
      const isAdonis = !fromProject && app.framework === "adonis" && app.runtime.startsWith("node");
      const isDjango = !fromProject && app.framework === "django" && app.runtime.startsWith("python");
      if (!fromProject && app.framework === "laravel" && app.subdomain) {
        envVars.push({ key: "APP_URL", value: `http://${app.subdomain}` });
      }
      if (isAdonis && app.subdomain && !envVars.some((item) => item.key === "APP_URL")) {
        envVars.push({ key: "APP_URL", value: `http://${app.subdomain}` });
      }
      if (isAdonis && !envVars.some((item) => item.key === "HOST")) {
        envVars.push({ key: "HOST", value: "0.0.0.0" });
      }
      if (isNext && !envVars.some((item) => item.key === "HOSTNAME")) {
        envVars.push({ key: "HOSTNAME", value: "0.0.0.0" });
      }
      if ((app.runtime.startsWith("node") || isDjango) && !fromProject && !envVars.some((item) => item.key === "PORT")) {
        envVars.push({ key: "PORT", value: String(TemplateEngine.listenPort(app)) });
      }
      const isBehind = behind.has(app.id);
      const exposedDirect =
        !isBehind && Boolean(app.subdomain && String(app.subdomain).trim());
      const appNetworks = attachDatabaseReach(
        attachLanes(
          [
            ...(manual
              ? networksFor(`app:${app.id}`, links, lanes.length > 0)
              : [exposedDirect ? "proxy" : "", "internal"].filter(Boolean)),
            ...(exposedDirect ? ["proxy"] : []),
          ].filter((name, index, list) => name && list.indexOf(name) === index),
          `app:${app.id}`,
          lanes
        ),
        `app:${app.id}`,
        links,
        lanes
      );
      const linkedDbs = manual ? linkedDatabaseIds(app.id, links) : dbIds;
      const ssh = sshByApp.get(app.id);
      return {
        ...app,
        isBehindWebserver: isBehind,
        exposedDirect,
        onProxy: exposedDirect,
        networks: appNetworks,
        fromProject,
        composeFile: app.composeFile || "docker-compose.yml",
        composeService: app.composeService || "app",
        runtimeImage: runtime.image,
        runtimePort: TemplateEngine.listenPort(app),
        isNode: !fromProject && app.runtime.startsWith("node") && !isNext && !isAdonis,
        isNodeFramework: isNext || isAdonis,
        isDjango,
        isImageBuild:
          (!fromProject && app.framework === "laravel" && app.runtime.startsWith("php")) || isNext || isAdonis || isDjango,
        isPhp: !fromProject && app.runtime.startsWith("php") && app.framework !== "laravel",
        isLaravel: !fromProject && app.framework === "laravel" && app.runtime.startsWith("php"),
        phpVersion: app.runtime.startsWith("php") ? `${app.runtime.slice(3, 4)}.${app.runtime.slice(4)}` : "",
        isPython: !fromProject && app.runtime.startsWith("python") && !isDjango,
        isGo: !fromProject && app.runtime.startsWith("go"),
        envVars,
        hasEnvVars: envVars.length > 0,
        dbDepends: linkedDbs,
        hasDatabases: linkedDbs.length > 0,
        sshNetworks: manual ? [`solo-ssh-${app.id}`] : ["internal"],
        sshServiceId: `${app.id}-ssh`,
        sshUser: ssh?.user || "docktopus",
        sshPassword: ssh?.password || "",
        sshHostPort: ssh?.hostPort || 0,
        collectSshLogs: Boolean(input.fail2ban?.enabled),
        sshPublicKey: ssh?.publicKey || "",
        hasSsh: Boolean(ssh?.hostPort && ssh?.password),
      };
    });

    const databases = input.databases.map((db) => {
      const family = databaseFamily(db.engine);
      const defaults = TemplateEngine.resolveDatabaseDefaults(db);
      return {
        ...db,
        ...defaults,
        isMysql: family === "mysql",
        isPostgres: family === "postgres",
        isRedis: family === "redis",
        isMongo: family === "mongo",
        isRabbit: family === "rabbitmq",
        databaseImage: DATABASE_IMAGES[db.engine],
        volumeName: `${db.id}_data`,
        networks: attachDatabaseReach(
          attachLanes(
            manual ? networksFor(`db:${db.id}`, links, lanes.length > 0) : ["internal"],
            `db:${db.id}`,
            lanes
          ),
          `db:${db.id}`,
          links,
          lanes
        ),
      };
    });

    const networkNames = new Set<string>();
    for (const list of [
      ...webservers.map((item) => item.networks),
      ...applications.map((item) => item.networks),
      ...applications.map((item) => item.sshNetworks),
      ...databases.map((item) => item.networks),
    ]) {
      for (const name of list) {
        if (name !== "proxy") networkNames.add(name);
      }
    }
    for (const lane of lanes) networkNames.add(canvasNetworkName(lane.id));
    const existing = new Set(input.existingNetworks || []);
    const context = {
      projectId: input.projectId,
      projectName: input.name,
      domain: input.domain,
      proxyNetwork: input.proxyNetwork,
      webservers,
      applications,
      databases,
      hasDatabases: databases.length > 0,
      hasWebservers: webservers.length > 0,
      extraNetworks: [...networkNames].map((name) => ({ name, external: existing.has(name) })),
      fail2ban: { enabled: Boolean(input.fail2ban?.enabled) },
    };

    const compose = template(context).replace(/\n{3,}/g, "\n\n").trim() + "\n";

    const nginxConfs = [
      ...webservers
        .filter((w) => w.isNginx)
        .map((w) => ({
          filename: w.nginxConfFile,
          content: this.renderNginxGatewayConf(w.routes || [], appById),
        })),
      ...webservers
        .filter((w) => w.isApache)
        .map((w) => ({
          filename: w.apacheConfFile,
          content: this.renderApacheGatewayConf(w.routes || [], appById),
        })),
    ];

    return { compose, nginxConfs };
  }

  private renderNginxGatewayConf(
    routes: WebserverRoute[],
    appById: Map<string, ApplicationSpec>
  ): string {
    if (!routes.length) {
      return `server {
    listen 80 default_server;
    server_name _;
    return 503;
}
`;
    }

    return (
      routes
        .map((route) => {
          const app = appById.get(route.appId);
          const port = app ? TemplateEngine.listenPort(app) : 8080;
          const upstream = route.appId;
          return `server {
    listen 80;
    server_name ${route.subdomain};

    location / {
        proxy_pass http://${upstream}:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`;
        })
        .join("\n\n") + "\n"
    );
  }

  private renderApacheGatewayConf(
    routes: WebserverRoute[],
    appById: Map<string, ApplicationSpec>
  ): string {
    if (!routes.length) {
      return `<VirtualHost *:80>
    ServerName _
    DocumentRoot /usr/local/apache2/htdocs
    <Location />
        Require all denied
    </Location>
</VirtualHost>
`;
    }

    return (
      routes
        .map((route) => {
          const app = appById.get(route.appId);
          const port = app ? TemplateEngine.listenPort(app) : 8080;
          return `<VirtualHost *:80>
    ServerName ${route.subdomain}
    ProxyPreserveHost On
    ProxyPass / http://${route.appId}:${port}/
    ProxyPassReverse / http://${route.appId}:${port}/
    RequestHeader set X-Forwarded-Proto "http"
</VirtualHost>`;
        })
        .join("\n\n") + "\n"
    );
  }

  private async loadComposeTemplate(): Promise<HandlebarsTemplateDelegate> {
    const filePath = path.join(this.templatesDir, "docker-compose.hbs");
    const source = await fs.readFile(filePath, "utf8");
    this.composeTemplate = Handlebars.compile(source, { noEscape: true });
    return this.composeTemplate;
  }
}
