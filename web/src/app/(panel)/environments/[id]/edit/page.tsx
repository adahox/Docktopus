"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { TopologyCanvas } from "@/components/TopologyCanvas";
import type { AppNode, DbNode, GatewayNode } from "@/components/Topology";
import { api } from "@/lib/api";
import { defaultFail2ban, type DraftDb, type TopologyDraft, type TopologyLink, withLink } from "@/lib/topology-draft";
import { useLive, type LiveEvent } from "@/lib/useLive";

type Conn = {
  id: string;
  hostPort: number | null;
  name: string | null;
  user: string | null;
  password: string | null;
  rootPassword: string | null;
};
type StoredDb = DbNode & {
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  dbRootPassword?: string;
};
type Env = {
  name: string;
  domain: string;
  applications?: AppNode[];
  databases?: StoredDb[];
  webservers?: GatewayNode[];
  config?: {
    applications?: AppNode[];
    databases?: StoredDb[];
    webservers?: GatewayNode[];
    envVars?: { key: string; value: string }[];
    databaseConnections?: Conn[];
    links?: TopologyLink[];
    networks?: TopologyDraft["networks"];
    positions?: TopologyDraft["positions"];
    fail2ban?: TopologyDraft["fail2ban"];
  };
};

function gatewayOf(appId: string, webservers: GatewayNode[], fallback?: string) {
  const match = webservers.find((item) => item.engine && (item as { routes?: { appId: string }[] }).routes?.some((route) => route.appId === appId));
  return match?.engine || fallback || "none";
}

export default function EditEnvironmentPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [draft, setDraft] = useState<TopologyDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<LiveEvent[]>([]);

  useEffect(() => {
    api<{ data: Env }>(`/environments/${params.id}`)
      .then((json) => {
        const env = json.data;
        const webservers = (env.webservers || env.config?.webservers || []) as (GatewayNode & { routes?: { appId: string }[] })[];
        const apps = env.applications || env.config?.applications || [];
        const databases = env.config?.databases?.length ? env.config.databases : env.databases || [];
        const connections = env.config?.databaseConnections || [];
        const dbs: DraftDb[] = databases.map((db) => {
          const conn = connections.find((item) => item.id === db.id);
          return {
            id: db.id,
            name: db.name || db.id,
            engine: db.engine,
            hostPort: db.hostPort ?? conn?.hostPort ?? undefined,
            dbName: db.dbName || conn?.name || "app",
            dbUser: db.dbUser || conn?.user || "app",
            dbPassword: db.dbPassword || conn?.password || "",
            dbRootPassword: db.dbRootPassword || conn?.rootPassword || "",
          };
        });
        const saved = env.config?.links;
        let links = saved || [];
        if (!saved) {
          for (const gateway of webservers) {
            links = withLink(links, "edge", `gw:${gateway.engine}`);
            for (const route of gateway.routes || []) {
              links = withLink(links, `gw:${gateway.engine}`, `app:${route.appId}`);
            }
          }
          for (const app of apps) {
            const behind = webservers.some((gateway) => gateway.routes?.some((route) => route.appId === app.id));
            if (!behind) links = withLink(links, "edge", `app:${app.id}`);
            for (const db of dbs) links = withLink(links, `app:${app.id}`, `db:${db.id}`);
          }
        }
        const gateways = [...new Set(webservers.map((item) => (item.engine === "apache" ? "apache" : "nginx") as "nginx" | "apache"))];
        setDraft({
          name: env.name,
          domain: env.domain,
          followDomain: false,
          gateways,
          apps: apps.map((app) => ({
            ...app,
            webserver: gatewayOf(app.id, webservers, app.webserver),
            githubRepo: app.githubRepo || "",
            subdomain: app.subdomain || env.domain,
          })),
          dbs,
          envVars: env.config?.envVars || [],
          links,
          networks: env.config?.networks || [],
          positions: env.config?.positions || {},
          fail2ban: env.config?.fail2ban || defaultFail2ban(),
        });
      })
      .catch((err: Error) => setError(err.message));
  }, [params.id]);

  const onEvent = useCallback(
    (event: LiveEvent) => {
      if (event.id !== params.id) return;
      setLines((current) => [...current, event].slice(-40));
    },
    [params.id]
  );
  useLive(onEvent);

  if (!draft) {
    return <main className="p-8 text-slate-500">{error || "Carregando topologia…"}</main>;
  }

  return (
      <TopologyCanvas
      initial={draft}
      projectId={params.id}
      submitLabel="Aplicar mudanças"
      busy={busy}
      error={error}
      lines={lines}
      onSubmit={async (payload) => {
        setBusy(true);
        setError("");
        try {
          await api(`/environments/${params.id}`, { method: "PUT", body: JSON.stringify(payload) });
          router.push(`/environments/${params.id}`);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Falha ao atualizar");
          setBusy(false);
        }
      }}
    />
  );
}
