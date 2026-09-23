"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { TopologyCanvas } from "@/components/TopologyCanvas";
import { api } from "@/lib/api";
import { defaultFail2ban, domainFrom, type TopologyDraft } from "@/lib/topology-draft";
import { useLive, type LiveEvent } from "@/lib/useLive";

const initial: TopologyDraft = {
  name: "",
  domain: domainFrom("app"),
  followDomain: true,
  gateways: [],
  apps: [],
  dbs: [],
  envVars: [],
  links: [],
  networks: [],
  positions: {},
  fail2ban: defaultFail2ban(),
};

export default function NewEnvironmentPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<LiveEvent[]>([]);

  const onEvent = useCallback((event: LiveEvent) => {
    if (event.type !== "environment") return;
    setLines((current) => [...current, event].slice(-40));
  }, []);
  useLive(onEvent);

  return (
    <TopologyCanvas
      initial={initial}
      submitLabel="Criar e liberar"
      busy={busy}
      error={error}
      lines={lines}
      onSubmit={async (payload) => {
        setBusy(true);
        setError("");
        try {
          const json = await api<{ data: { id: string } }>("/environments", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          router.push("/");
        } catch (err) {
          setError(err instanceof Error ? err.message : "Falha ao criar");
          setBusy(false);
        }
      }}
    />
  );
}
