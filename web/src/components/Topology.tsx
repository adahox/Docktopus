import { Mark } from "./Mark";
import { labelOf, DATABASES, RUNTIMES, WEBSERVERS } from "@/lib/catalog";

export type AppNode = {
  id: string;
  name: string;
  runtime: string;
  webserver?: string;
  subdomain?: string;
  githubRepo?: string;
  source?: "runtime" | "project";
  composeFile?: string;
  composeService?: string;
  containerPort?: number;
  hostPort?: number;
  framework?: "laravel" | "next" | "adonis" | "django";
};

export type GatewayNode = {
  id: string;
  name?: string;
  engine: string;
};

export type DbNode = {
  id: string;
  name: string;
  engine: string;
  hostPort?: number;
};

export type Power = "on" | "off" | "restarting";

export function Topology({
  apps,
  databases,
  webservers,
  onPick,
  selected,
  power,
}: {
  apps: AppNode[];
  databases: DbNode[];
  webservers?: GatewayNode[];
  onPick?: (kind: "app" | "db" | "gateway", id: string) => void;
  selected?: string;
  power?: Record<string, Power>;
}) {
  const derived: GatewayNode[] = [];
  for (const engine of ["nginx", "apache"] as const) {
    if (apps.some((app) => app.webserver === engine)) {
      derived.push({ id: engine, name: engine, engine });
    }
  }
  const gateways = webservers?.length ? webservers : derived;

  return (
    <div className="flex items-center gap-0 overflow-x-auto py-2">
      {gateways.length ? (
        <>
          <div className="flex flex-col gap-2">
            {gateways.map((gateway) => (
              <button
                key={gateway.id}
                type="button"
                onClick={() => onPick?.("gateway", gateway.id)}
                className={`text-left ${selected === `gateway:${gateway.id}` ? "ring-2 ring-sea rounded-2xl" : ""}`}
              >
                <Node
                  title={labelOf(WEBSERVERS, gateway.engine)}
                  subtitle="Gateway do cliente"
                  mark={gateway.engine}
                  power={power?.[`gateway:${gateway.id}`]}
                />
              </button>
            ))}
          </div>
          <span className="topo-line" />
        </>
      ) : null}
      <div className="flex flex-col gap-2">
        {apps.map((app) => (
          <button
            key={app.id}
            type="button"
            onClick={() => onPick?.("app", app.id)}
            className={`text-left ${selected === `app:${app.id}` ? "ring-2 ring-sea rounded-2xl" : ""}`}
          >
            <Node
              title={app.name}
              subtitle={labelOf(RUNTIMES, app.runtime)}
              mark={app.runtime}
              hint={app.hostPort ? `:${app.hostPort}` : app.subdomain}
              power={power?.[`app:${app.id}`]}
            />
          </button>
        ))}
      </div>
      {databases.length ? (
        <>
          <span className="topo-line" />
          <div className="flex flex-col gap-2">
            {databases.map((db) => (
              <button
                key={db.id}
                type="button"
                onClick={() => onPick?.("db", db.id)}
                className={`text-left ${selected === `db:${db.id}` ? "ring-2 ring-sea rounded-2xl" : ""}`}
              >
                <Node
                  title={db.name || db.id}
                  subtitle={labelOf(DATABASES, db.engine)}
                  mark={db.engine}
                  hint={db.hostPort ? `:${db.hostPort}` : "rede interna"}
                  power={power?.[`db:${db.id}`]}
                />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Node({
  title,
  subtitle,
  mark,
  hint,
  power,
}: {
  title: string;
  subtitle: string;
  mark: string;
  hint?: string;
  power?: Power;
}) {
  return (
    <div className="flex min-w-[180px] items-center gap-3 rounded-2xl border border-line bg-white px-3 py-3 shadow-card">
      <Mark id={mark} />
      <div className="min-w-0">
        <strong className="block truncate text-sm">{title}</strong>
        <span className="block truncate text-xs text-slate-500">{subtitle}</span>
        {hint ? <span className="block truncate font-mono text-[11px] text-sea">{hint}</span> : null}
        <PowerBadge power={power} />
      </div>
    </div>
  );
}

export function PowerBadge({ power }: { power?: Power }) {
  const state = power || "off";
  const label = state === "on" ? "Ligado" : state === "restarting" ? "Reiniciando" : "Desligado";
  const tone =
    state === "on"
      ? "bg-emerald-50 text-emerald-800"
      : state === "restarting"
        ? "bg-amber-50 text-amber-800"
        : "bg-slate-100 text-slate-500";
  const dot = state === "on" ? "bg-emerald-500" : state === "restarting" ? "bg-amber-500" : "bg-slate-300";
  return (
    <span className={`mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
