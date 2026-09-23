"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Mark } from "@/components/Mark";
import { type AppNode, type DbNode, type GatewayNode } from "@/components/Topology";
import { DATABASES, labelOf, WEBSERVERS } from "@/lib/catalog";
import { api } from "@/lib/api";
import { useLive, type LiveEvent } from "@/lib/useLive";

type Env = {
  id: string;
  name: string;
  status: string;
  publicUrl: string;
  applications?: AppNode[];
  databases?: DbNode[];
  webservers?: GatewayNode[];
  config?: { applications?: AppNode[]; databases?: DbNode[]; webservers?: GatewayNode[] };
};

const tone: Record<string, string> = {
  running: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  provisioning: "bg-amber-50 text-amber-800 ring-amber-200",
  pulling: "bg-amber-50 text-amber-800 ring-amber-200",
  starting: "bg-amber-50 text-amber-800 ring-amber-200",
  stopped: "bg-slate-100 text-slate-600 ring-slate-200",
  error: "bg-red-50 text-red-700 ring-red-200",
};

const dot: Record<string, string> = {
  running: "bg-emerald-500",
  provisioning: "bg-amber-500",
  pulling: "bg-amber-500",
  starting: "bg-amber-500",
  stopped: "bg-slate-400",
  error: "bg-red-500",
};

const statusLabel: Record<string, string> = {
  running: "No ar",
  provisioning: "Processando",
  pulling: "Baixando",
  starting: "Subindo",
  stopped: "Parado",
  error: "Erro",
};

export default function DashboardPage() {
  const [envs, setEnvs] = useState<Env[]>([]);
  const [error, setError] = useState("");
  const [live, setLive] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const json = await api<{ data: Env[] }>("/environments");
    setEnvs(json.data || []);
  }, []);

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, [load]);

  const onEvent = useCallback(
    (event: LiveEvent) => {
      if (!event.id || !event.phase) return;
      setLive((current) => ({ ...current, [event.id!]: event.message || event.phase || "" }));
      if (event.phase !== "log") {
        setEnvs((current) => current.map((env) => (env.id === event.id ? { ...env, status: event.phase || env.status } : env)));
      }
      if (["provisioning", "running", "stopped", "deleted", "error"].includes(event.phase)) {
        load().catch(() => undefined);
      }
    },
    [load]
  );
  useLive(onEvent);

  const running = envs.filter((env) => env.status === "running").length;

  return (
    <main className="mx-auto max-w-6xl px-8 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sea">Docktopus</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink">Ambientes</h1>
          <p className="mt-1 text-sm text-slate-500">
            {envs.length} {envs.length === 1 ? "topologia" : "topologias"}
            {envs.length ? ` · ${running} no ar` : ""}
          </p>
        </div>
        <Link href="/environments/new" className="rounded-2xl bg-ink px-4 py-2.5 text-sm font-semibold text-white shadow-card">
          Nova topologia
        </Link>
      </header>
      {error ? <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {envs.map((env) => {
          const apps = env.applications || env.config?.applications || [];
          const databases = env.databases || env.config?.databases || [];
          const webservers = env.webservers || env.config?.webservers || [];
          const pieces = [
            ...webservers.map((item) => ({ id: item.engine, label: labelOf(WEBSERVERS, item.engine) })),
            ...apps.map((item) => ({ id: item.runtime, label: item.name })),
            ...databases.map((item) => ({ id: item.engine, label: item.name || labelOf(DATABASES, item.engine) })),
          ];
          return (
            <Link
              key={env.id}
              href={`/environments/${env.id}`}
              className="group flex flex-col rounded-3xl border border-line bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-sea/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold text-ink">{env.name}</h2>
                  <p className="mt-1 truncate font-mono text-xs text-slate-500">{env.publicUrl}</p>
                </div>
                <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${tone[env.status] || tone.provisioning}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${dot[env.status] || dot.provisioning}`} />
                  {statusLabel[env.status] || env.status}
                </span>
              </div>
              {live[env.id] ? <p className="mt-3 truncate text-xs text-slate-500">{live[env.id]}</p> : null}
              <div className="mt-4 flex flex-wrap gap-2">
                {pieces.length ? (
                  pieces.slice(0, 6).map((item, index) => (
                    <span key={`${item.id}-${index}`} className="inline-flex items-center gap-2 rounded-full bg-mist px-2 py-1 text-xs font-medium text-ink">
                      <Mark id={item.id} size={16} />
                      <span className="max-w-[8rem] truncate">{item.label}</span>
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-slate-400">Canvas vazio</span>
                )}
                {pieces.length > 6 ? <span className="self-center text-xs text-slate-400">+{pieces.length - 6}</span> : null}
              </div>
              <p className="mt-4 text-xs font-semibold text-sea opacity-0 transition group-hover:opacity-100">Abrir ambiente</p>
            </Link>
          );
        })}
        {!envs.length && !error ? (
          <div className="rounded-3xl border border-dashed border-line bg-white/80 p-12 text-center md:col-span-2">
            <h2 className="text-lg font-semibold text-ink">Nenhum ambiente ainda</h2>
            <p className="mt-1 text-sm text-slate-500">Monte a primeira topologia no canvas.</p>
            <Link href="/environments/new" className="mt-4 inline-flex rounded-2xl bg-sea px-4 py-2 text-sm font-semibold text-white">
              Nova topologia
            </Link>
          </div>
        ) : null}
      </div>
    </main>
  );
}
