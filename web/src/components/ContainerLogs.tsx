"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Container = { id: string; name: string; state: string; status: string; image: string };
type Named = { id: string; name: string };

export function ContainerLogs({
  environmentId,
  containers,
  apps,
  databases,
}: {
  environmentId: string;
  containers: Container[];
  apps: Named[];
  databases: Named[];
}) {
  const [service, setService] = useState("");
  const [reload, setReload] = useState(0);
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);

  const items = [...containers].sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    setLogs("");
    setLoading(true);
    api<{ data: { logs: string } }>(`/environments/${environmentId}/logs?service=${encodeURIComponent(service)}&tail=200`)
      .then((json) => {
        if (!cancelled) setLogs(json.data.logs);
      })
      .catch((err: Error) => {
        if (!cancelled) setLogs(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, service, reload]);

  return (
    <section className="flex min-h-[32rem] flex-col rounded-3xl border border-line bg-white p-5 shadow-card xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Logs</h2>
        {service ? (
          <button
            type="button"
            className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-slate-600"
            onClick={() => setReload((current) => current + 1)}
          >
            Atualizar
          </button>
        ) : null}
      </div>
      {items.length ? (
        <>
          <ul className="mt-4 flex max-h-40 flex-col gap-2 overflow-auto">
            {items.map((item) => {
              const id = serviceId(environmentId, item.name);
              const active = id === service;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setService(id)}
                    className={`flex w-full items-center gap-2 rounded-2xl border px-3 py-2 text-left ${
                      active ? "border-sea bg-teal-50" : "border-line bg-white"
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${dot(item.state)}`} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-ink">{labelOf(id, apps, databases)}</span>
                      <span className="block truncate text-[11px] text-slate-400">{item.status}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <pre className="mt-4 min-h-48 flex-1 overflow-auto rounded-2xl bg-ink p-4 font-mono text-xs leading-relaxed text-slate-100">
            {service ? (loading && !logs ? "Carregando logs…" : logs || "(sem logs)") : "Escolha um container para ver os logs."}
          </pre>
        </>
      ) : (
        <p className="mt-4 text-sm text-slate-500">Nenhum container neste ambiente.</p>
      )}
    </section>
  );
}

function serviceId(environmentId: string, name: string) {
  const prefix = `${environmentId}-`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function labelOf(service: string, apps: Named[], databases: Named[]) {
  if (service.endsWith("-ssh")) {
    const app = apps.find((item) => item.id === service.slice(0, -4));
    return app ? `SSH · ${app.name}` : service;
  }
  return (
    apps.find((item) => item.id === service)?.name ||
    databases.find((item) => item.id === service)?.name ||
    (service === "nginx" ? "Nginx" : service === "apache" ? "Apache" : service === "fail2ban" ? "Fail2ban" : service)
  );
}

function dot(state: string) {
  if (state === "running") return "bg-emerald-500";
  if (state === "restarting") return "bg-amber-500";
  return "bg-slate-300";
}
