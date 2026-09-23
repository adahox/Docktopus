import type { AppNode, DbNode } from "@/components/Topology";

export type DraftApp = AppNode;
export type DraftDb = DbNode & {
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbRootPassword: string;
};

export type EnvVarDraft = { key: string; value: string };
export type TopologyLink = { source: string; target: string };
export type Point = { x: number; y: number };

export const NODE_W = 148;
export const NODE_H = 156;
const COL_X = [24, 280, 540, 820];

export function at(column: number, index: number): Point {
  return { x: COL_X[column] || 24, y: 48 + index * (NODE_H + 28) };
}

export type DrawnNetwork = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  subnet?: string;
  gateway?: string;
};

export function laneAddress(used: Iterable<string | undefined>): { subnet: string; gateway: string } {
  const taken = new Set(used);
  for (let second = 80; second <= 94; second += 1) {
    for (let third = 1; third <= 254; third += 1) {
      const subnet = `10.${second}.${third}.0/24`;
      if (!taken.has(subnet)) return { subnet, gateway: `10.${second}.${third}.1` };
    }
  }
  return { subnet: "10.95.1.0/24", gateway: "10.95.1.1" };
}

export function centerInside(net: Pick<DrawnNetwork, "x" | "y" | "width" | "height">, point: Point) {
  const cx = point.x + NODE_W / 2;
  const cy = point.y + NODE_H / 2;
  return cx >= net.x && cx <= net.x + net.width && cy >= net.y && cy <= net.y + net.height;
}

export type Fail2banDraft = {
  enabled: boolean;
  bantime: number;
  findtime: number;
  maxretry: number;
  ignoreip: string;
};

export function defaultFail2ban(): Fail2banDraft {
  return { enabled: false, bantime: 3600, findtime: 600, maxretry: 5, ignoreip: "127.0.0.1/8 ::1" };
}

export type TopologyDraft = {
  name: string;
  domain: string;
  followDomain: boolean;
  gateways: ("nginx" | "apache")[];
  apps: DraftApp[];
  dbs: DraftDb[];
  envVars: EnvVarDraft[];
  links: TopologyLink[];
  networks?: DrawnNetwork[];
  positions?: Record<string, Point>;
  fail2ban?: Fail2banDraft;
};

export function nodeKind(id: string) {
  if (id === "edge") return "edge";
  return id.split(":")[0];
}

export function canLink(source: string, target: string) {
  if (!source || !target || source === target) return false;
  const pair = [nodeKind(source), nodeKind(target)].sort().join("-");
  return ["app-app", "app-db", "app-edge", "app-gw", "edge-gw"].includes(pair);
}

export function withLink(links: TopologyLink[], source: string, target: string): TopologyLink[] {
  if (!canLink(source, target)) return links;
  const [a, b] = [source, target].sort();
  if (links.some((link) => link.source === a && link.target === b)) return links;
  return [...links, { source: a, target: b }];
}

export function withoutNode(links: TopologyLink[], id: string) {
  return links.filter((link) => link.source !== id && link.target !== id);
}

export function slug(raw: string) {
  return (
    raw
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "app"
  );
}

export function domainFrom(name: string) {
  const base =
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "") || "app";
  return `${base}.localhost`;
}

export function randomSecret() {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function place(draft: TopologyDraft, key: string, fallback: Point): Point {
  return draft.positions?.[key] || fallback;
}

function together(draft: TopologyDraft, a: Point, b: Point) {
  return (draft.networks || []).some((net) => centerInside(net, a) && centerInside(net, b));
}

function pushLink(links: TopologyLink[], source: string, target: string) {
  const [a, b] = [source, target].sort();
  if (links.some((link) => link.source === a && link.target === b)) return;
  links.push({ source: a, target: b });
}

/** Rotas do balanceador e variáveis de banco saem de quem divide um quadrado. */
export function linksFromSquares(draft: TopologyDraft): TopologyLink[] {
  const links: TopologyLink[] = [];
  const gateways = draft.gateways.map((engine, index) => ({
    id: `gw:${engine}`,
    point: place(draft, `gw:${engine}`, at(1, index)),
  }));
  const apps = draft.apps.map((app, index) => ({
    id: `app:${slug(app.id || app.name)}`,
    point: place(draft, `app:${app.id}`, at(2, index)),
  }));
  const databases = draft.dbs.map((db, index) => ({
    id: `db:${slug(db.id || db.engine)}`,
    point: place(draft, `db:${db.id}`, at(3, index)),
  }));
  for (const gateway of gateways) {
    for (const app of apps) {
      if (together(draft, gateway.point, app.point)) pushLink(links, gateway.id, app.id);
    }
  }
  for (const app of apps) {
    for (const db of databases) {
      if (together(draft, app.point, db.point)) pushLink(links, app.id, db.id);
    }
  }
  const remap = (id: string) =>
    id.startsWith("app:") ? `app:${slug(id.slice(4))}` : id.startsWith("db:") ? `db:${slug(id.slice(3))}` : id;
  for (const link of draft.links || []) {
    const source = remap(link.source);
    const target = remap(link.target);
    const ends = [source, target];
    const app = ends.find((item) => item.startsWith("app:"));
    const db = ends.find((item) => item.startsWith("db:"));
    if (app && db) pushLink(links, app, db);
    if (source === "edge" || target === "edge") pushLink(links, source, target);
  }
  return links;
}

export function buildPayload(draft: TopologyDraft) {
  const domain = (draft.domain || domainFrom(draft.name || "app")).trim().toLowerCase();
  const applications = draft.apps.map((app, index) => ({
    id: slug(app.id || app.name),
    name: app.name,
    runtime: app.runtime,
    webserver: app.webserver || "none",
    subdomain: app.subdomain || (index === 0 ? domain : `${slug(app.id)}.${domain}`),
    source: app.source === "project" ? "project" : "runtime",
    composeFile: (app.composeFile || "docker-compose.yml").trim() || "docker-compose.yml",
    composeService: (app.composeService || "app").trim() || "app",
    containerPort: Number(app.containerPort) || 80,
    hostPort: app.hostPort ? Number(app.hostPort) : undefined,
    framework:
      app.source === "project"
        ? undefined
        : app.runtime.startsWith("php") && app.framework === "laravel"
          ? "laravel"
          : app.runtime.startsWith("node") && (app.framework === "next" || app.framework === "adonis")
            ? app.framework
            : app.runtime.startsWith("python") && app.framework === "django"
              ? "django"
              : undefined,
    githubRepo: (app.githubRepo || "")
      .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
      .replace(/^git@github\.com:/i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/g, ""),
  }));
  const routes = {
    nginx: [] as { subdomain: string; appId: string }[],
    apache: [] as { subdomain: string; appId: string }[],
  };
  const published = new Set<"nginx" | "apache">();
  const remap = (id: string) => (id.startsWith("app:") ? `app:${slug(id.slice(4))}` : id.startsWith("db:") ? `db:${slug(id.slice(3))}` : id);
  const links = (draft.networks || []).length
    ? linksFromSquares(draft)
    : (draft.links || []).map((link) => {
        const [source, target] = [remap(link.source), remap(link.target)].sort();
        return { source, target };
      });
  for (const link of links) {
    const ends = [link.source, link.target];
    const gateway = ends.find((item) => item.startsWith("gw:"));
    const appId = ends.find((item) => item.startsWith("app:"))?.slice(4);
    if (gateway && ends.includes("edge")) published.add(gateway.endsWith("apache") ? "apache" : "nginx");
    if (!gateway || !appId) continue;
    const engine = gateway.endsWith("apache") ? "apache" : "nginx";
    const app = applications.find((item) => item.id === appId);
    if (app) routes[engine].push({ subdomain: app.subdomain || domain, appId });
  }
  return {
    name: draft.name || "app",
    domain,
    webservers: (Object.entries(routes) as ["nginx" | "apache", { subdomain: string; appId: string }[]][])
      .filter(([engine, list]) => list.length || published.has(engine))
      .map(([engine, list]) => ({
        id: engine,
        name: engine,
        engine,
        routes: list,
        published: published.has(engine),
      })),
    applications,
    databases: draft.dbs.map((db) => ({
      id: slug(db.id || db.engine),
      name: db.name || db.id,
      engine: db.engine,
      dbName: db.dbName,
      dbUser: db.dbUser,
      dbPassword: db.dbPassword,
      dbRootPassword: db.engine.startsWith("mysql") ? db.dbRootPassword : undefined,
      hostPort: db.hostPort,
    })),
    envVars: draft.envVars.filter((item) => item.key.trim()),
    links,
    fail2ban: {
      enabled: Boolean(draft.fail2ban?.enabled),
      bantime: Number(draft.fail2ban?.bantime) || 3600,
      findtime: Number(draft.fail2ban?.findtime) || 600,
      maxretry: Number(draft.fail2ban?.maxretry) || 5,
      ignoreip: (draft.fail2ban?.ignoreip || "127.0.0.1/8 ::1").trim(),
    },
    networks: (draft.networks || []).map((net, index) => {
      const id = slug(net.id || net.name) || `net${index + 1}`;
      const occupants = [
        ...draft.apps.map((app, appIndex) => ({
          key: `app:${slug(app.id || app.name)}`,
          point: draft.positions?.[`app:${app.id}`] || at(2, appIndex),
        })),
        ...draft.dbs.map((db, dbIndex) => ({
          key: `db:${slug(db.id || db.engine)}`,
          point: draft.positions?.[`db:${db.id}`] || at(3, dbIndex),
        })),
        ...draft.gateways.map((engine, gatewayIndex) => ({
          key: `gw:${engine}`,
          point: draft.positions?.[`gw:${engine}`] || at(1, gatewayIndex),
        })),
      ];
      return {
        id,
        name: (net.name || `rede ${index + 1}`).trim() || id,
        x: net.x,
        y: net.y,
        width: net.width,
        height: net.height,
        color: net.color,
        subnet: net.subnet,
        gateway: net.gateway,
        members: occupants.filter((item) => centerInside(net, item.point)).map((item) => item.key),
      };
    }),
    positions: Object.fromEntries(
      Object.entries(draft.positions || {})
        .filter(([key]) => key !== "edge")
        .map(([key, point]) => {
          const remap = (id: string) =>
            id.startsWith("app:") ? `app:${slug(id.slice(4))}` : id.startsWith("db:") ? `db:${slug(id.slice(3))}` : id;
          return [remap(key), point];
        })
    ),
  };
}
