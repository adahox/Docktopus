"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ContainerLogs } from "@/components/ContainerLogs";
import { Mark } from "@/components/Mark";
import { PowerBadge, Topology, type AppNode, type DbNode, type GatewayNode, type Power } from "@/components/Topology";
import { DATABASES, labelOf, RUNTIMES } from "@/lib/catalog";
import { api } from "@/lib/api";
import { useLive, type LiveEvent } from "@/lib/useLive";

type Ssh = { appId: string; user: string; hostPort: number; password: string; command: string; publicKey: string };
type Container = { id: string; name: string; state: string; status: string; image: string };
type EnvVar = { key: string; value: string };
type DbConn = { id: string; engine: string; host: string; hostPort: number | null; user: string | null; name: string | null; externalUrl: string | null };
type Env = {
  id: string;
  name: string;
  status: string;
  publicUrl: string;
  applications?: AppNode[];
  databases?: DbNode[];
  webservers?: GatewayNode[];
  containers?: Container[];
  config?: {
    applications?: AppNode[];
    databases?: DbNode[];
    webservers?: GatewayNode[];
    sshConnections?: Ssh[];
    envVars?: EnvVar[];
    databaseConnections?: DbConn[];
    fail2ban?: { enabled: boolean; bantime: number; findtime: number; maxretry: number; ignoreip: string };
  };
};

const tabs = ["geral", "ssh", "github", "containers", "variaveis"] as const;
const tabLabel: Record<(typeof tabs)[number], string> = {
  geral: "Geral",
  ssh: "SSH",
  github: "GitHub",
  containers: "Containers",
  variaveis: "Variáveis",
};

const tone: Record<string, string> = {
  running: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  provisioning: "bg-amber-50 text-amber-800 ring-amber-200",
  pulling: "bg-amber-50 text-amber-800 ring-amber-200",
  starting: "bg-amber-50 text-amber-800 ring-amber-200",
  stopped: "bg-slate-100 text-slate-600 ring-slate-200",
  error: "bg-red-50 text-red-700 ring-red-200",
};
function itemPower(containers: { name: string; state: string }[], environmentId: string, serviceId: string): Power {
  const item = containers.find((container) => container.name === `${environmentId}-${serviceId}`);
  if (item?.state === "running") return "on";
  if (item?.state === "restarting") return "restarting";
  return "off";
}

function powerMap(
  environmentId: string,
  containers: { name: string; state: string }[],
  apps: { id: string }[],
  databases: { id: string }[],
  webservers: { id: string }[]
): Record<string, Power> {
  const power: Record<string, Power> = {};
  for (const app of apps) power[`app:${app.id}`] = itemPower(containers, environmentId, app.id);
  for (const db of databases) power[`db:${db.id}`] = itemPower(containers, environmentId, db.id);
  for (const gateway of webservers) power[`gateway:${gateway.id}`] = itemPower(containers, environmentId, gateway.id);
  return power;
}

const statusLabel: Record<string, string> = {
  running: "No ar",
  provisioning: "Processando",
  pulling: "Baixando",
  starting: "Subindo",
  stopped: "Parado",
  error: "Erro",
};

export default function EnvironmentPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [env, setEnv] = useState<Env | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{ kind: "app" | "db" | "gateway"; id: string } | null>(null);
  const [tab, setTab] = useState<(typeof tabs)[number]>("geral");
  const [conf, setConf] = useState("");
  const [confNote, setConfNote] = useState("");
  const [gatewayLogs, setGatewayLogs] = useState("");

  const load = useCallback(async () => {
    const json = await api<{ data: Env }>(`/environments/${params.id}`);
    setEnv(json.data);
  }, [params.id]);

  useEffect(() => {
    if (selected?.kind !== "gateway") return;
    setConf("");
    setConfNote("");
    setGatewayLogs("");
    api<{ data: { content: string } }>(`/environments/${params.id}/gateways/${selected.id}/conf`)
      .then((json) => setConf(json.data.content))
      .catch((err: Error) => setConfNote(err.message));
  }, [params.id, selected?.id, selected?.kind]);

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
    const timer = window.setInterval(() => {
      load().catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  const onEvent = useCallback(
    (event: LiveEvent) => {
      if (event.id !== params.id) return;
      if (event.phase && ["running", "stopped", "error", "deleted"].includes(event.phase)) {
        if (event.phase === "deleted") router.push("/");
        else load().catch(() => undefined);
      }
    },
    [load, params.id, router]
  );
  useLive(onEvent);

  async function act(action: "start" | "stop") {
    if (!env) return;
    await api(`/environments/${env.id}/${action}`, { method: "POST" });
    await load();
  }

  if (!env) {
    return <main className="p-8 text-slate-500">{error || "Carregando topologia…"}</main>;
  }

  const apps = env.applications || env.config?.applications || [];
  const databases = env.databases || env.config?.databases || [];
  const webservers = env.webservers || env.config?.webservers || [];
  const app = selected?.kind === "app" ? apps.find((item) => item.id === selected.id) || null : null;
  const db = selected?.kind === "db" ? databases.find((item) => item.id === selected.id) || null : null;
  const ssh = env.config?.sshConnections?.find((item) => item.appId === app?.id);
  const containers = (env.containers || []).filter((item) =>
    app ? item.name === `${env.id}-${app.id}` || item.name.startsWith(`${env.id}-${app.id}-`) : true
  );
  const connection = env.config?.databaseConnections?.find((item) => item.id === db?.id);
  const gateway = selected?.kind === "gateway" ? webservers.find((item) => item.id === selected.id) || null : null;
  const environment = env;

  async function saveConf() {
    if (!gateway) return;
    setConfNote("");
    try {
      const json = await api<{ data: { content: string } }>(`/environments/${environment.id}/gateways/${gateway.id}/conf`, {
        method: "PUT",
        body: JSON.stringify({ content: conf }),
      });
      setConf(json.data.content);
      setConfNote("Conf aplicado e o Nginx recarregado.");
    } catch (err) {
      setConfNote(err instanceof Error ? err.message : "Falha ao salvar o conf");
    }
  }

  async function loadGatewayLogs() {
    if (!gateway) return;
    setGatewayLogs("Carregando logs…");
    try {
      const json = await api<{ data: { logs: string } }>(`/environments/${environment.id}/logs?service=${gateway.id}&tail=200`);
      setGatewayLogs(json.data.logs);
    } catch (err) {
      setGatewayLogs(err instanceof Error ? err.message : "Falha ao ler os logs");
    }
  }

  return (
    <main className="w-full min-w-0 px-6 py-6">
      <Link href="/" className="text-sm font-medium text-slate-500">
        ← Ambientes
      </Link>
      <header className="mt-3 flex flex-wrap items-start justify-between gap-4 rounded-3xl border border-line bg-white p-5 shadow-card">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-ink">{env.name}</h1>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${tone[env.status] || tone.provisioning}`}>
              {statusLabel[env.status] || env.status}
            </span>
          </div>
          <a className="mt-2 inline-block font-mono text-sm text-sea" href={env.publicUrl} target="_blank" rel="noreferrer">
            {env.publicUrl}
          </a>
          <p className="mt-2 text-sm text-slate-500">
            {env.config?.fail2ban?.enabled
              ? `Fail2ban ativo · ${env.config.fail2ban.maxretry} tentativas em ${Math.round(env.config.fail2ban.findtime / 60)} min · ban ${Math.round(env.config.fail2ban.bantime / 60)} min`
              : "Fail2ban desligado"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/environments/${env.id}/edit`} className="rounded-xl bg-ink px-3 py-2 text-sm font-semibold text-white">
            Editar topologia
          </Link>
          <button className="rounded-xl border border-line bg-white px-3 py-2 text-sm font-semibold" onClick={() => act("start")}>
            Iniciar
          </button>
          <button className="rounded-xl border border-line bg-white px-3 py-2 text-sm font-semibold" onClick={() => act("stop")}>
            Parar
          </button>
          <button
            className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
            onClick={async () => {
              if (!confirm(`Remover ${env.name}?`)) return;
              await api(`/environments/${env.id}`, { method: "DELETE" });
            }}
          >
            Remover
          </button>
        </div>
      </header>

      <section className="mt-5 rounded-3xl border border-line bg-white p-5 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Topologia</h2>
          <p className="text-xs text-slate-400">Ligado segue no ar. Desligado pede Iniciar. Reiniciando: abra os logs.</p>
        </div>
        <div className="overflow-x-auto rounded-2xl bg-mist/70 p-4">
          <Topology
            apps={apps}
            databases={databases}
            webservers={webservers}
            power={powerMap(env.id, env.containers || [], apps, databases, webservers)}
            selected={selected ? `${selected.kind}:${selected.id}` : undefined}
            onPick={(kind, id) => setSelected({ kind, id })}
          />
        </div>
      </section>

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,36%)]">
      <div className="flex min-w-0 flex-col gap-5">
      {app ? (
        <section className="rounded-3xl border border-line bg-white p-5 shadow-card">
          <div className="flex items-center gap-3">
            <Mark id={app.runtime} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-ink">{app.name}</h2>
                <PowerBadge power={itemPower(env.containers || [], env.id, app.id)} />
              </div>
              <p className="text-sm text-slate-500">
                {labelOf(RUNTIMES, app.runtime)}
                {app.framework === "laravel" ? " · Laravel" : ""}
                {app.framework === "next" ? " · Next.js" : ""}
                {app.framework === "adonis" ? " · AdonisJS" : ""}
                {app.framework === "django" ? " · Django" : ""}
                {app.runtime.startsWith("node") && app.source !== "project" ? " · PM2" : ""}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-b border-line pb-3">
            {tabs.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                className={`rounded-full px-3 py-1 text-sm font-semibold ${tab === item ? "bg-ink text-white" : "bg-mist text-slate-600"}`}
              >
                {tabLabel[item]}
              </button>
            ))}
          </div>
          <div className="mt-4 text-sm">
            {tab === "geral" ? (
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl bg-mist px-4 py-3">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Subdomínio</dt>
                  <dd className="mt-1 font-mono text-ink">{app.subdomain || "via gateway"}</dd>
                </div>
                <div className="rounded-2xl bg-mist px-4 py-3">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Origem</dt>
                  <dd className="mt-1 text-ink">
                    {app.source === "project"
                      ? `${app.composeFile || "docker-compose.yml"} · ${app.composeService || "app"} · ${app.containerPort || 80}`
                      : `Runtime ${labelOf(RUNTIMES, app.runtime)}`}
                  </dd>
                </div>
                {app.hostPort ? (
                  <div className="rounded-2xl bg-mist px-4 py-3 sm:col-span-2">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Endereço publicado</dt>
                    <dd className="mt-1">
                      <a className="break-all font-semibold text-sea" href={`http://${app.subdomain || "127.0.0.1"}:${app.hostPort}/`} target="_blank" rel="noreferrer">
                        http://{app.subdomain || "127.0.0.1"}:{app.hostPort}/
                      </a>
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {tab === "github" ? (
              <p className="rounded-2xl bg-mist px-4 py-3">
                {app.githubRepo ? (
                  <a className="font-semibold text-sea" href={`https://github.com/${app.githubRepo}`}>
                    {app.githubRepo}
                  </a>
                ) : (
                  "Nenhum repositório vinculado."
                )}
              </p>
            ) : null}
            {tab === "ssh" && ssh ? (
              <div className="space-y-3">
                <div className="rounded-2xl bg-mist px-4 py-3 font-mono text-xs text-ink">{ssh.command}</div>
                <p className="text-slate-500">Usuário {ssh.user} · porta {ssh.hostPort}</p>
                <pre className="max-h-40 overflow-auto rounded-2xl bg-ink p-3 text-xs text-slate-100">{ssh.publicKey}</pre>
                <button
                  type="button"
                  className="rounded-xl bg-sea px-3 py-1.5 text-sm font-semibold text-white"
                  onClick={() => navigator.clipboard.writeText(ssh.publicKey)}
                >
                  Copiar chave pública
                </button>
              </div>
            ) : null}
            {tab === "ssh" && !ssh ? <p className="text-slate-500">SSH ainda não gerado.</p> : null}
            {tab === "containers" ? (
              <ul className="space-y-2">
                {containers.map((item) => (
                  <li key={item.id} className="rounded-2xl border border-line px-4 py-3">
                    <strong className="text-ink">{item.name}</strong>
                    <p className="text-slate-500">{item.status} · {item.image}</p>
                  </li>
                ))}
                {!containers.length ? <li className="text-slate-500">Nenhum container desta aplicação.</li> : null}
              </ul>
            ) : null}
            {tab === "variaveis" ? (
              <ul className="space-y-1 rounded-2xl bg-ink p-4 font-mono text-xs text-slate-100">
                {(env.config?.envVars || []).map((item) => (
                  <li key={item.key}>{item.key}={item.value}</li>
                ))}
                {!env.config?.envVars?.length ? <li className="text-slate-400">Nenhuma variável compartilhada.</li> : null}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}

      {db ? (
        <section className="rounded-3xl border border-line bg-white p-5 shadow-card">
          <div className="flex items-center gap-3">
            <Mark id={db.engine} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-ink">{db.name || db.id}</h2>
                <PowerBadge power={itemPower(env.containers || [], env.id, db.id)} />
              </div>
              <p className="text-sm text-slate-500">{labelOf(DATABASES, db.engine)}</p>
            </div>
          </div>
          {connection ? (
            <p className="mt-4 rounded-2xl bg-mist px-4 py-3 font-mono text-sm text-ink">
              {connection.externalUrl || `${connection.host}${connection.hostPort ? `:${connection.hostPort}` : ""}`}
            </p>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Conexão ainda não publicada.</p>
          )}
        </section>
      ) : null}

      {gateway?.engine === "nginx" ? (
        <section className="rounded-3xl border border-line bg-white p-5 shadow-card">
          <div className="flex items-center gap-3">
            <Mark id="nginx" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-ink">Nginx</h2>
                <PowerBadge power={itemPower(env.containers || [], env.id, gateway.id)} />
              </div>
              <p className="text-sm text-slate-500">Conf deste ambiente. Laravel é servido a partir da pasta public.</p>
            </div>
          </div>
          <textarea
            value={conf}
            onChange={(event) => setConf(event.target.value)}
            spellCheck={false}
            className="mt-4 h-72 w-full rounded-2xl bg-ink p-3 font-mono text-xs text-slate-100"
          />
          <div className="mt-3 flex gap-2">
            <button type="button" className="rounded-xl bg-sea px-3 py-1.5 text-sm font-semibold text-white" onClick={() => void saveConf()}>
              Salvar conf
            </button>
            <button type="button" className="rounded-xl border border-line px-3 py-1.5 text-sm font-semibold" onClick={() => void loadGatewayLogs()}>
              Ver logs
            </button>
          </div>
          {confNote ? <p className="mt-3 text-sm text-slate-600">{confNote}</p> : null}
          {gatewayLogs ? (
            <pre className="mt-3 max-h-64 overflow-auto rounded-2xl bg-ink p-3 text-xs text-slate-100">{gatewayLogs}</pre>
          ) : null}
        </section>
      ) : null}

      {!app && !db && !gateway ? (
        <p className="rounded-3xl border border-dashed border-line bg-white/70 px-5 py-8 text-center text-sm text-slate-500">
          Clique numa aplicação, num banco ou no Nginx da topologia.
        </p>
      ) : null}
      </div>
      <ContainerLogs environmentId={env.id} containers={env.containers || []} apps={apps} databases={databases} />
      </div>
    </main>
  );
}
