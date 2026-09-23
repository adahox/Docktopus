"use client";

import { useEffect, useRef, useState } from "react";
import { Mark } from "@/components/Mark";
import { DATABASES, labelOf, RUNTIMES, WEBSERVERS } from "@/lib/catalog";
import {
  at,
  buildPayload,
  centerInside,
  domainFrom,
  laneAddress,
  NODE_H,
  NODE_W,
  randomSecret,
  withLink,
  withoutNode,
  type DraftApp,
  type DraftDb,
  type DrawnNetwork,
  type Point,
  type TopologyDraft,
} from "@/lib/topology-draft";
import type { LiveEvent } from "@/lib/useLive";

type Selection =
  | { kind: "app"; id: string }
  | { kind: "db"; id: string }
  | { kind: "gateway"; id: "nginx" | "apache" }
  | { kind: "network"; id: string }
  | null;

type ToolId = "app" | "gateway" | "db" | "link";
type DragSession = {
  kind: "pan" | "node" | "draw" | "net" | "resize";
  key: string;
  originX: number;
  originY: number;
  panX: number;
  panY: number;
  nodeX: number;
  nodeY: number;
  moved: boolean;
  liveX?: number;
  liveY?: number;
  riders?: Record<string, Point>;
} | null;

const NET_COLORS = ["#0f766e", "#0e7490", "#4f46e5", "#b45309"];

function box(point: Point) {
  return { left: point.x, top: point.y };
}


export function TopologyCanvas({
  initial,
  submitLabel,
  busy,
  error,
  lines,
  projectId,
  onSubmit,
}: {
  initial: TopologyDraft;
  submitLabel: string;
  busy: boolean;
  error: string;
  lines: LiveEvent[];
  projectId?: string;
  onSubmit: (payload: ReturnType<typeof buildPayload>) => void;
}) {
  const [draft, setDraft] = useState(() => ({ ...initial, networks: describeNetworks(initial.networks) }));
  const [selected, setSelected] = useState<Selection>(initial.apps[0] ? { kind: "app", id: initial.apps[0].id } : null);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [wireFrom, setWireFrom] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 36, y: 28 });
  const [placed, setPlaced] = useState<Record<string, Point>>(initial.positions || {});
  const [drawMode, setDrawMode] = useState(false);
  const [rubber, setRubber] = useState<DrawnNetwork | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const panRef = useRef(pan);
  const dragRef = useRef<DragSession>(null);
  const suppressClick = useRef(false);
  const rubberRef = useRef<DrawnNetwork | null>(null);
  const seq = useRef(initial.apps.length + initial.dbs.length + (initial.networks?.length || 0) + 1);
  zoomRef.current = zoom;
  panRef.current = pan;

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = board.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;
      const nextZoom = clampZoom(currentZoom * Math.exp(-event.deltaY * 0.0012));
      const worldX = (pointerX - currentPan.x) / currentZoom;
      const worldY = (pointerY - currentPan.y) / currentZoom;
      const nextPan = { x: pointerX - worldX * nextZoom, y: pointerY - worldY * nextZoom };
      panRef.current = nextPan;
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      setPan(nextPan);
    };
    board.addEventListener("wheel", onWheel, { passive: false });
    return () => board.removeEventListener("wheel", onWheel);
  }, []);

  const domain = draft.domain || domainFrom(draft.name || "app");
  const gateways = draft.gateways || [];

  const app = selected?.kind === "app" ? draft.apps.find((item) => item.id === selected.id) : undefined;
  const db = selected?.kind === "db" ? draft.dbs.find((item) => item.id === selected.id) : undefined;
  const network = selected?.kind === "network" ? (draft.networks || []).find((item) => item.id === selected.id) : undefined;
  const lanes = draft.networks || [];

  function setName(name: string) {
    setDraft((current) => {
      const nextDomain = current.followDomain ? domainFrom(name) : current.domain;
      return {
        ...current,
        name,
        domain: nextDomain,
        apps: current.followDomain
          ? current.apps.map((item, index) => (index === 0 ? { ...item, subdomain: nextDomain } : item))
          : current.apps,
      };
    });
  }

  function patchApp(id: string, patch: Partial<DraftApp>) {
    setDraft((current) => ({
      ...current,
      apps: current.apps.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  }

  function patchDb(id: string, patch: Partial<DraftDb>) {
    setDraft((current) => ({
      ...current,
      dbs: current.dbs.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  }

  function addApp(runtime: string) {
    const id = `app${seq.current++}`;
    const node: DraftApp = {
      id,
      name: id,
      runtime,
      webserver: "none",
      subdomain: `${id}.${domain}`,
      githubRepo: "",
    };
    setDraft((current) => ({ ...current, apps: [...current.apps, node] }));
    setSelected({ kind: "app", id });
    setTool(null);
  }

  function addDb(engine: string) {
    const id =
      engine.startsWith("postgres")
        ? `pg${seq.current++}`
        : engine === "redis"
          ? `redis${seq.current++}`
          : engine === "mongo"
            ? `mongo${seq.current++}`
            : engine === "rabbitmq"
              ? `rabbit${seq.current++}`
              : `mysql${seq.current++}`;
    const node: DraftDb = {
      id,
      name: id,
      engine,
      dbName: "app",
      dbUser: "app",
      dbPassword: randomSecret(),
      dbRootPassword: randomSecret(),
    };
    setDraft((current) => ({ ...current, dbs: [...current.dbs, node] }));
    setSelected({ kind: "db", id });
    setTool(null);
  }

  function addGateway(engine: "nginx" | "apache") {
    setDraft((current) => ({
      ...current,
      gateways: current.gateways.includes(engine) ? current.gateways : [...current.gateways, engine],
    }));
    setSelected({ kind: "gateway", id: engine });
    setTool(null);
  }

  function toggleDbLink(appId: string, dbId: string) {
    setDraft((current) => {
      const source = `app:${appId}`;
      const target = `db:${dbId}`;
      const [a, b] = [source, target].sort();
      const exists = current.links.some((link) => link.source === a && link.target === b);
      return {
        ...current,
        links: exists ? current.links.filter((link) => !(link.source === a && link.target === b)) : withLink(current.links, source, target),
      };
    });
  }

  function pickForLink(kind: "app" | "db", id: string) {
    setSelected(kind === "app" ? { kind: "app", id } : { kind: "db", id });
    if (kind === "app") {
      setWireFrom(id);
      return;
    }
    if (!wireFrom) return;
    toggleDbLink(wireFrom, id);
    setWireFrom(null);
  }

  function removeApp(id: string) {
    setDraft((current) => ({
      ...current,
      apps: current.apps.filter((item) => item.id !== id),
      links: withoutNode(current.links, `app:${id}`),
    }));
    setSelected((current) => (current?.kind === "app" && current.id === id ? null : current));
  }

  function choose(action: () => void) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    action();
  }

  function spot(key: string, fallback: Point) {
    return placed[key] || fallback;
  }

  function worldFrom(event: { clientX: number; clientY: number }) {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (event.clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (event.clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }

  function movePointer(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.originX;
    const dy = event.clientY - drag.originY;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.kind === "pan") {
      setPan({ x: drag.panX + dx, y: drag.panY + dy });
      return;
    }
    if (drag.kind === "draw") {
      const cursorPoint = worldFrom(event);
      const next = rectFrom(drag.panX, drag.panY, cursorPoint.x, cursorPoint.y);
      rubberRef.current = next;
      setRubber(next);
      return;
    }
    if (drag.kind === "net" || drag.kind === "resize") {
      const shiftX = dx / zoomRef.current;
      const shiftY = dy / zoomRef.current;
      const riders = drag.kind === "net" ? drag.riders : undefined;
      setDraft((current) => {
        const positions = { ...(current.positions || {}) };
        if (riders) {
          for (const [key, origin] of Object.entries(riders)) {
            positions[key] = { x: origin.x + shiftX, y: origin.y + shiftY };
          }
        }
        return {
          ...current,
          positions,
          networks: (current.networks || []).map((item) => {
            if (item.id !== drag.key) return item;
            if (drag.kind === "resize") {
              return {
                ...item,
                width: Math.max(72, drag.nodeX + dx / zoomRef.current),
                height: Math.max(72, drag.nodeY + dy / zoomRef.current),
              };
            }
            return {
              ...item,
              x: drag.nodeX + shiftX,
              y: drag.nodeY + shiftY,
            };
          }),
        };
      });
      if (riders) {
        setPlaced((current) => {
          const next = { ...current };
          for (const [key, origin] of Object.entries(riders)) {
            next[key] = { x: origin.x + shiftX, y: origin.y + shiftY };
          }
          return next;
        });
      }
      return;
    }
    const x = drag.nodeX + dx / zoomRef.current;
    const y = drag.nodeY + dy / zoomRef.current;
    drag.liveX = x;
    drag.liveY = y;
    setPlaced((current) => ({
      ...current,
      [drag.key]: { x, y },
    }));
  }

  function endPointer() {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "draw") {
      const box = rubberRef.current;
      rubberRef.current = null;
      setRubber(null);
      if (box && box.width >= 72 && box.height >= 72) {
        const id = `net${seq.current++}`;
        setDraft((current) => {
          const networks = current.networks || [];
          const address = laneAddress(networks.map((item) => item.subnet));
          return {
            ...current,
            networks: [
              ...networks,
              {
                ...box,
                id,
                name: `rede ${networks.length + 1}`,
                color: NET_COLORS[networks.length % NET_COLORS.length],
                ...address,
              },
            ],
          };
        });
        setSelected({ kind: "network", id });
        setDrawMode(false);
        setTool(null);
      }
      suppressClick.current = true;
      dragRef.current = null;
      return;
    }
    if (drag.kind === "node" && drag.moved && drag.liveX != null && drag.liveY != null) {
      const point = { x: drag.liveX, y: drag.liveY };
      const key = drag.key;
      setDraft((current) => ({ ...current, positions: { ...(current.positions || {}), [key]: point } }));
    }
    if (drag.moved) suppressClick.current = true;
    dragRef.current = null;
  }

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (drawMode) {
      const origin = worldFrom(event);
      const next = { id: "", name: "", x: origin.x, y: origin.y, width: 0, height: 0 };
      rubberRef.current = next;
      setRubber(next);
      dragRef.current = {
        kind: "draw",
        originX: event.clientX,
        originY: event.clientY,
        panX: origin.x,
        panY: origin.y,
        nodeX: origin.x,
        nodeY: origin.y,
        key: "",
        moved: true,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    dragRef.current = {
      kind: "pan",
      originX: event.clientX,
      originY: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
      nodeX: 0,
      nodeY: 0,
      key: "",
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startNodeDrag(key: string, pos: Point, event: React.PointerEvent, selection?: Selection) {
    event.stopPropagation();
    if (selection) setSelected(selection);
    dragRef.current = {
      kind: "node",
      key,
      originX: event.clientX,
      originY: event.clientY,
      panX: 0,
      panY: 0,
      nodeX: pos.x,
      nodeY: pos.y,
      moved: false,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function releaseNode(key: string) {
    endPointer();
    suppressClick.current = true;
    void key;
  }

  function cardsInside(net: DrawnNetwork): Record<string, Point> {
    const found: Record<string, Point> = {};
    const cards: [string, Point][] = [
      ...draft.apps.map((item, index) => [`app:${item.id}`, placed[`app:${item.id}`] || at(2, index)] as [string, Point]),
      ...draft.dbs.map((item, index) => [`db:${item.id}`, placed[`db:${item.id}`] || at(3, index)] as [string, Point]),
      ...gateways.map((engine, index) => [`gw:${engine}`, placed[`gw:${engine}`] || at(1, index)] as [string, Point]),
    ];
    for (const [key, point] of cards) {
      if (centerInside(net, point)) found[key] = point;
    }
    return found;
  }

  function startNetworkDrag(net: DrawnNetwork, event: React.PointerEvent) {
    event.stopPropagation();
    setSelected({ kind: "network", id: net.id });
    dragRef.current = {
      kind: "net",
      key: net.id,
      originX: event.clientX,
      originY: event.clientY,
      panX: 0,
      panY: 0,
      nodeX: net.x,
      nodeY: net.y,
      moved: false,
      riders: cardsInside(net),
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function startResize(net: DrawnNetwork, event: React.PointerEvent) {
    event.stopPropagation();
    dragRef.current = {
      kind: "resize",
      key: net.id,
      originX: event.clientX,
      originY: event.clientY,
      panX: 0,
      panY: 0,
      nodeX: net.width,
      nodeY: net.height,
      moved: false,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function removeSelected() {
    if (!selected) return;
    if (selected.kind === "app") {
      removeApp(selected.id);
      return;
    } else if (selected.kind === "db") {
      setDraft((current) => ({
        ...current,
        dbs: current.dbs.filter((item) => item.id !== selected.id),
        links: withoutNode(current.links, `db:${selected.id}`),
      }));
    } else if (selected.kind === "gateway") {
      setDraft((current) => ({
        ...current,
        gateways: current.gateways.filter((item) => item !== selected.id),
        links: withoutNode(current.links, `gw:${selected.id}`),
      }));
    } else if (selected.kind === "network") {
      setDraft((current) => ({
        ...current,
        networks: (current.networks || []).filter((item) => item.id !== selected.id),
      }));
    } else {
      return;
    }
    setSelected(null);
  }

  function occupants() {
    return [
      ...draft.apps.map((item, index) => ({ key: `app:${item.id}`, title: item.name, point: spot(`app:${item.id}`, at(2, index)) })),
      ...draft.dbs.map((item, index) => ({ key: `db:${item.id}`, title: item.name, point: spot(`db:${item.id}`, at(3, index)) })),
      ...gateways.map((engine, index) => ({
        key: `gw:${engine}`,
        title: labelOf(WEBSERVERS, engine),
        point: spot(`gw:${engine}`, at(1, index)),
      })),
    ];
  }

  return (
    <div className="relative flex h-full w-full min-h-0 overflow-hidden">
      <aside className="relative z-20 flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-white py-3">
        <button
          type="button"
          aria-label="Rede"
          title="Rede"
          onClick={() => {
            setTool(null);
            setDrawMode((current) => !current);
          }}
          className={`grid h-10 w-10 place-items-center rounded-xl ${drawMode ? "bg-sea text-white" : "text-slate-500 hover:bg-mist"}`}
        >
          <NetworkIcon />
        </button>
        <ToolButton
          label="Aplicação"
          open={tool === "app"}
          active={tool === "app"}
          onClick={() => {
            setDrawMode(false);
            setTool((current) => (current === "app" ? null : "app"));
          }}
          icon={<Mark id="php" size={22} />}
        >
          {RUNTIME_FAMILIES.map((family) => (
            <div key={family.id} className="mt-1">
              <p className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{family.label}</p>
              {family.versions.map(([id, text]) => (
                <FlyoutItem key={id} mark={id} label={`${family.label} ${text}`} onClick={() => addApp(id)} />
              ))}
            </div>
          ))}
        </ToolButton>
        <ToolButton
          label="Balanceador"
          open={tool === "gateway"}
          active={tool === "gateway"}
          onClick={() => {
            setDrawMode(false);
            setTool((current) => (current === "gateway" ? null : "gateway"));
          }}
          icon={<Mark id="nginx" size={22} />}
        >
          {(["nginx", "apache"] as const).map((engine) => (
            <FlyoutItem key={engine} mark={engine} label={labelOf(WEBSERVERS, engine)} onClick={() => addGateway(engine)} />
          ))}
        </ToolButton>
        <ToolButton
          label="Banco"
          open={tool === "db"}
          active={tool === "db"}
          onClick={() => {
            setDrawMode(false);
            setTool((current) => (current === "db" ? null : "db"));
          }}
          icon={<Mark id="postgres" size={22} />}
        >
          {DATABASES.map(([id, text]) => (
            <FlyoutItem key={id} mark={id} label={text} onClick={() => addDb(id)} />
          ))}
        </ToolButton>
        <ToolButton
          label="Ligar banco"
          open={tool === "link"}
          active={tool === "link"}
          onClick={() => {
            setDrawMode(false);
            setWireFrom(null);
            setTool((current) => (current === "link" ? null : "link"));
          }}
          icon={<LinkIcon />}
        >
          <p className="px-2 py-1 text-sm text-slate-500">Clique na aplicação e depois no banco. Vale mesmo com os dois em redes diferentes.</p>
        </ToolButton>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-4 border-b border-line bg-white/90 px-6 py-3">
        <div className="min-w-0 flex-1">
          <input
            value={draft.name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nome do ambiente"
            className="w-full max-w-sm bg-transparent text-xl font-semibold outline-none placeholder:text-slate-300"
          />
          <input
            value={draft.domain}
            onChange={(event) => setDraft((current) => ({ ...current, domain: event.target.value, followDomain: false }))}
            className="mt-0.5 block w-full max-w-sm bg-transparent font-mono text-xs text-sea outline-none"
          />
        </div>
        <button
          type="button"
          disabled={busy || draft.apps.length === 0}
          onClick={() => onSubmit(buildPayload({ ...draft, domain, positions: { ...(draft.positions || {}), ...placed } }))}
          className="rounded-2xl bg-ink px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Aplicando topologia…" : submitLabel}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
        <div
          ref={boardRef}
          className={`canvas-grid h-full overflow-hidden ${drawMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
          onPointerDown={startPan}
          onPointerMove={movePointer}
          onPointerUp={() => {
            endPointer();
          }}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            setSelected(null);
            setTool(null);
            setWireFrom(null);
          }}
        >
          <div className="absolute left-0 top-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}>
            {lanes.map((net, index) => {
              const color = net.color || NET_COLORS[index % NET_COLORS.length];
              const active = selected?.kind === "network" && selected.id === net.id;
              return (
                <div
                  key={net.id}
                  className="absolute rounded-[28px] border-2 border-dashed"
                  style={{ left: net.x, top: net.y, width: net.width, height: net.height, borderColor: color, background: `${color}1a` }}
                  onPointerDown={(event) => startNetworkDrag(net, event)}
                  onPointerMove={movePointer}
                  onPointerUp={(event) => {
                    event.stopPropagation();
                    endPointer();
                    suppressClick.current = true;
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <span className="pointer-events-none absolute left-3 top-2 text-xs font-semibold" style={{ color }}>
                    {net.name}
                  </span>
                  {active ? (
                    <button
                      type="button"
                      aria-label="Redimensionar rede"
                      className="absolute -bottom-1.5 -right-1.5 h-4 w-4 rounded-full bg-white"
                      style={{ boxShadow: `0 0 0 2px ${color}` }}
                      onPointerDown={(event) => startResize(net, event)}
                      onPointerMove={movePointer}
                      onPointerUp={(event) => {
                        event.stopPropagation();
                        endPointer();
                        suppressClick.current = true;
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
            {rubber ? (
              <div
                className="pointer-events-none absolute rounded-[28px] border-2 border-dashed border-sea bg-teal-100/40"
                style={{ left: rubber.x, top: rubber.y, width: rubber.width, height: rubber.height }}
              />
            ) : null}
            <svg className="absolute overflow-visible" width="4000" height="2400" style={{ pointerEvents: "none" }}>
              {draft.links.flatMap((link) => {
                const ends = [link.source, link.target];
                const appId = ends.find((item) => item.startsWith("app:"))?.slice(4);
                const dbId = ends.find((item) => item.startsWith("db:"))?.slice(3);
                if (!appId || !dbId) return [];
                const appIndex = draft.apps.findIndex((item) => item.id === appId);
                const dbIndex = draft.dbs.findIndex((item) => item.id === dbId);
                if (appIndex < 0 || dbIndex < 0) return [];
                const from = spot(`app:${appId}`, at(2, appIndex));
                const to = spot(`db:${dbId}`, at(3, dbIndex));
                const sameLane = lanes.some((net) => centerInside(net, from) && centerInside(net, to));
                if (sameLane) return [];
                const x1 = from.x + NODE_W / 2;
                const y1 = from.y + NODE_H / 2;
                const x2 = to.x + NODE_W / 2;
                const y2 = to.y + NODE_H / 2;
                const midX = (x1 + x2) / 2;
                const midY = (y1 + y2) / 2 - 36;
                const badgeX = (x1 + 2 * midX + x2) / 4;
                const badgeY = (y1 + 2 * midY + y2) / 4;
                const d = `M ${x1} ${y1} Q ${midX} ${midY} ${x2} ${y2}`;
                return [
                  <g key={`${appId}-${dbId}`}>
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="16"
                      className="pointer-events-auto cursor-pointer"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleDbLink(appId, dbId);
                      }}
                    />
                    <path d={d} fill="none" stroke="#b45309" strokeWidth="2" strokeDasharray="7 5" />
                    <g transform={`translate(${badgeX - 11} ${badgeY - 11})`} className="pointer-events-none">
                      <circle cx="11" cy="11" r="11" fill="#fff" stroke="#b45309" strokeWidth="1.4" />
                      <g transform="translate(2 2)" fill="none" stroke="#b45309" strokeWidth="1.6">
                        <circle cx="4.2" cy="5" r="1.6" />
                        <circle cx="13.2" cy="4.6" r="1.6" />
                        <circle cx="9" cy="13" r="1.6" />
                        <path d="M5.6 5.7 11.8 5.1M5.3 6.3l2.4 4.8M11.8 5.9 10 12" strokeLinecap="round" />
                      </g>
                    </g>
                  </g>,
                ];
              })}
            </svg>
            {gateways.map((engine, index) => {
              const key = `gw:${engine}`;
              const pos = spot(key, at(1, index));
              return (
                <div key={engine} className="absolute" style={box(pos)}>
                  <NodeCard
                    mark={engine}
                    title={labelOf(WEBSERVERS, engine)}
                    subtitle="Balanceador"
                    active={selected?.kind === "gateway" && selected.id === engine}
                    onClick={() => choose(() => setSelected({ kind: "gateway", id: engine }))}
                    onRemove={selected?.kind === "gateway" && selected.id === engine ? removeSelected : undefined}
                    onPointerDown={(event) => startNodeDrag(key, pos, event, { kind: "gateway", id: engine })}
                    onPointerMove={movePointer}
                    onPointerUp={(event) => {
                      event.stopPropagation();
                      releaseNode(key);
                    }}
                  />
                </div>
              );
            })}
            {draft.apps.map((item, index) => {
              const key = `app:${item.id}`;
              const pos = spot(key, at(2, index));
              return (
                <div key={item.id} className="absolute" style={box(pos)}>
                  <NodeCard
                    mark={item.runtime}
                    title={item.name}
                    subtitle={labelOf(RUNTIMES, item.runtime)}
                    hint={item.hostPort ? `:${item.hostPort}` : item.subdomain}
                    active={selected?.kind === "app" && selected.id === item.id}
                    armed={tool === "link" && wireFrom === item.id}
                    onClick={() => choose(() => (tool === "link" ? pickForLink("app", item.id) : setSelected({ kind: "app", id: item.id })))}
                    onRemove={selected?.kind === "app" && selected.id === item.id ? () => removeApp(item.id) : undefined}
                    onPointerDown={(event) => {
                      if (tool === "link") {
                        event.stopPropagation();
                        pickForLink("app", item.id);
                        return;
                      }
                      startNodeDrag(key, pos, event, { kind: "app", id: item.id });
                    }}
                    onPointerMove={movePointer}
                    onPointerUp={(event) => {
                      event.stopPropagation();
                      releaseNode(key);
                    }}
                  />
                </div>
              );
            })}
            {draft.dbs.map((item, index) => {
              const key = `db:${item.id}`;
              const pos = spot(key, at(3, index));
              return (
                <div key={item.id} className="absolute" style={box(pos)}>
                  <NodeCard
                    mark={item.engine}
                    title={item.name}
                    subtitle={labelOf(DATABASES, item.engine)}
                    hint={item.hostPort ? `:${item.hostPort}` : "interno"}
                    active={selected?.kind === "db" && selected.id === item.id}
                    armed={tool === "link" && Boolean(wireFrom)}
                    onClick={() => choose(() => (tool === "link" ? pickForLink("db", item.id) : setSelected({ kind: "db", id: item.id })))}
                    onRemove={selected?.kind === "db" && selected.id === item.id ? removeSelected : undefined}
                    onPointerDown={(event) => {
                      if (tool === "link") {
                        event.stopPropagation();
                        pickForLink("db", item.id);
                        return;
                      }
                      startNodeDrag(key, pos, event, { kind: "db", id: item.id });
                    }}
                    onPointerMove={movePointer}
                    onPointerUp={(event) => {
                      event.stopPropagation();
                      releaseNode(key);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
          <p className="pointer-events-none absolute bottom-4 left-4 rounded-full bg-white/90 px-3 py-1 text-xs text-slate-500 shadow-card">
            {tool === "link"
              ? wireFrom
                ? "Agora clique no banco que esta aplicação deve usar"
                : "Clique na aplicação e depois no banco"
              : "Crie tudo pela coluna de ferramentas · arraste os itens para dentro do quadrado"}
          </p>
        </div>

        <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-white" onClick={(event) => event.stopPropagation()}>
          {app ? (
            <Inspector title={app.name} mark={app.runtime} onRemove={removeSelected}>
              <Panel title="Aplicação">
                <Field label="Alias" value={app.name} onChange={(value) => patchApp(app.id, { name: value })} />
                <Field label="Subdomínio" value={app.subdomain || ""} onChange={(value) => patchApp(app.id, { subdomain: value })} />
                <Field
                  label="Porta externa"
                  value={app.hostPort ? String(app.hostPort) : ""}
                  placeholder="vazio"
                  onChange={(value) => patchApp(app.id, { hostPort: Number(value.replace(/\D/g, "")) || undefined })}
                />
                <p className="text-xs text-slate-500">
                  {app.hostPort
                    ? `${app.hostPort} no host encaminha para ${listenPort(app)} no container.`
                    : `Sem publicação no host. O container escuta ${listenPort(app)}.`}
                </p>
              </Panel>
              <Panel title="Stack">
                <ProjectBuild
                  source={app.source || "runtime"}
                  composeFile={app.composeFile || "docker-compose.yml"}
                  composeService={app.composeService || "app"}
                  containerPort={String(app.containerPort || 80)}
                  onChange={(patch) => patchApp(app.id, patch)}
                />
                {app.source === "project" ? null : (
                  <RuntimePicker
                    value={app.runtime}
                    onChange={(value) =>
                      patchApp(app.id, {
                        runtime: value,
                        framework: value.startsWith("php") && app.framework === "laravel"
                          ? "laravel"
                          : value.startsWith("node") && (app.framework === "next" || app.framework === "adonis")
                            ? app.framework
                            : value.startsWith("python") && app.framework === "django"
                              ? "django"
                              : undefined,
                      })
                    }
                  />
                )}
                {app.source === "project" ? null : (
                  <FrameworkPicker
                    runtime={app.runtime}
                    framework={app.framework}
                    onChange={(framework) => patchApp(app.id, { framework })}
                  />
                )}
              </Panel>
              <GithubRepo value={app.githubRepo || ""} onChange={(value) => patchApp(app.id, { githubRepo: value })} />
              <Panel title="Ligações">
                <MembershipList items={lanes.filter((item) => centerInside(item, spot(`app:${app.id}`, at(2, draft.apps.findIndex((row) => row.id === app.id)))))} />
                <DbLinkList
                  title="Bancos"
                  items={draft.dbs.filter((item) => linked(draft.links, `app:${app.id}`, `db:${item.id}`))}
                  empty="Nenhum banco ligado. Use Ligar banco nas ferramentas."
                  onRemove={(id) => toggleDbLink(app.id, id)}
                />
                <p className="text-xs text-slate-500">No mesmo quadrado a conexão é automática. A curva âmbar liga um app de uma rede ao banco de outra.</p>
              </Panel>
            </Inspector>
          ) : null}

          {db ? (
            <Inspector title={db.name} mark={db.engine} onRemove={removeSelected}>
              <Field label="Alias" value={db.name} onChange={(value) => patchDb(db.id, { name: value })} />
              <div className="grid grid-cols-2 gap-2">
                {DATABASES.map(([id, text]) => (
                  <CatalogButton key={id} id={id} label={text} active={db.engine === id} onClick={() => patchDb(db.id, { engine: id })} />
                ))}
              </div>
              {db.engine === "redis" ? null : (
                <>
                  {db.engine === "rabbitmq" ? null : (
                    <Field label="Schema" value={db.dbName} onChange={(value) => patchDb(db.id, { dbName: value })} />
                  )}
                  <Field label="Usuário" value={db.dbUser} onChange={(value) => patchDb(db.id, { dbUser: value })} />
                  <Field label="Senha" value={db.dbPassword} onChange={(value) => patchDb(db.id, { dbPassword: value })} />
                  {db.engine.startsWith("mysql") ? (
                    <Field label="Senha root" value={db.dbRootPassword} onChange={(value) => patchDb(db.id, { dbRootPassword: value })} />
                  ) : null}
                  {db.engine === "rabbitmq" ? (
                    <p className="text-xs text-slate-500">A porta publicada é a do AMQP. O painel do RabbitMQ fica na porta 15672, dentro da rede.</p>
                  ) : null}
                </>
              )}
              <MembershipList items={lanes.filter((item) => centerInside(item, spot(`db:${db.id}`, at(3, draft.dbs.findIndex((row) => row.id === db.id)))))} />
              <DbLinkList
                title="Aplicações que usam este banco"
                items={draft.apps.filter((item) => linked(draft.links, `app:${item.id}`, `db:${db.id}`))}
                empty="Nenhuma aplicação ligada."
                onRemove={(id) => toggleDbLink(id, db.id)}
              />
            </Inspector>
          ) : null}

          {network ? (
            <Inspector title={network.name} mark="network" onRemove={removeSelected}>
              <Field
                label="Nome"
                value={network.name}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    networks: (current.networks || []).map((item) => (item.id === network.id ? { ...item, name: value } : item)),
                  }))
                }
              />
              <p className="text-sm text-slate-500">O centro de cada card dentro deste quadrado entra na rede. Arrastar o quadrado leva esses cards junto.</p>
              <dl className="grid grid-cols-[96px_1fr] gap-x-2 gap-y-2 text-sm">
                <dt className="text-slate-400">Subnet</dt>
                <dd className="font-mono">{network.subnet || "—"}</dd>
                <dt className="text-slate-400">Gateway</dt>
                <dd className="font-mono">{network.gateway || "—"}</dd>
                <dt className="text-slate-400">Rede Docker</dt>
                <dd className="break-all font-mono text-xs">{projectId ? `${projectId}-${laneKey(network.id)}` : laneKey(network.id)}</dd>
              </dl>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Cor de fundo</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {NET_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={color}
                      className={`h-7 w-7 rounded-full ${network.color === color ? "ring-2 ring-offset-2 ring-ink" : ""}`}
                      style={{ background: color }}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          networks: (current.networks || []).map((item) => (item.id === network.id ? { ...item, color } : item)),
                        }))
                      }
                    />
                  ))}
                </div>
              </div>
              <ul className="space-y-1">
                {occupants()
                  .filter((item) => centerInside(network, item.point))
                  .map((item) => (
                    <li key={item.key} className="rounded-xl bg-mist px-3 py-2 text-sm">
                      {item.title}
                    </li>
                  ))}
              </ul>
            </Inspector>
          ) : null}

          {selected?.kind === "gateway" ? (
            <Inspector title={labelOf(WEBSERVERS, selected.id)} mark={selected.id} onRemove={removeSelected}>
              <p className="text-sm text-slate-500">
                Coloque este balanceador no mesmo quadrado das aplicações que ele deve atender.
              </p>
              <MembershipList
                items={lanes.filter((item) => centerInside(item, spot(`gw:${selected.id}`, at(1, gateways.indexOf(selected.id)))))}
              />
            </Inspector>
          ) : null}

          {!selected ? (
            <Inspector title="Ambiente" mark="github">
              <p className="text-sm text-slate-500">Clique num nó para ajustar runtime, entrada ou banco. As variáveis valem para todas as aplicações.</p>
              <Fail2banPanel
                value={draft.fail2ban || { enabled: false, bantime: 3600, findtime: 600, maxretry: 5, ignoreip: "127.0.0.1/8 ::1" }}
                onChange={(fail2ban) => setDraft((current) => ({ ...current, fail2ban }))}
              />
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Variáveis</p>
                <button
                  type="button"
                  className="text-sm font-semibold text-sea"
                  onClick={() => setDraft((current) => ({ ...current, envVars: [...current.envVars, { key: "", value: "" }] }))}
                >
                  Adicionar
                </button>
              </div>
              {draft.envVars.map((item, index) => (
                <div key={index} className="grid grid-cols-2 gap-2">
                  <input
                    value={item.key}
                    placeholder="CHAVE"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        envVars: current.envVars.map((row, rowIndex) => (rowIndex === index ? { ...row, key: event.target.value } : row)),
                      }))
                    }
                    className="rounded-xl border border-line px-3 py-2 text-sm"
                  />
                  <input
                    value={item.value}
                    placeholder="valor"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        envVars: current.envVars.map((row, rowIndex) => (rowIndex === index ? { ...row, value: event.target.value } : row)),
                      }))
                    }
                    className="rounded-xl border border-line px-3 py-2 text-sm"
                  />
                </div>
              ))}
            </Inspector>
          ) : null}
        </aside>
      </div>
      {error || lines.length ? (
        <div className="pointer-events-none fixed left-1/2 top-4 z-50 flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2">
          {error ? <p className="rounded-2xl bg-red-600 px-4 py-3 text-sm font-medium text-white shadow-card">{error}</p> : null}
          {lines.length ? (
            <div className="rounded-2xl bg-ink/95 px-4 py-3 text-sm text-slate-100 shadow-card">
              {lines.slice(-3).map((line, index) => (
                <p key={`${line.at}-${index}`}>
                  <span className="mr-2 font-mono text-xs text-teal-300">{line.phase}</span>
                  {line.message}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
}

function ToolButton({
  label,
  open,
  active,
  onClick,
  icon,
  children,
}: {
  label: string;
  open: boolean;
  active?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={onClick}
        className={`relative grid h-10 w-10 place-items-center rounded-xl ${active ? "bg-sea text-white" : "text-slate-500 hover:bg-mist"}`}
      >
        {icon}
        <span className={`absolute bottom-1 right-1 border-b-[5px] border-l-[5px] border-b-current border-l-transparent ${active ? "text-white" : "text-slate-400"}`} />
      </button>
      {open ? (
        <div className="absolute left-12 top-0 z-30 w-56 rounded-2xl border border-line bg-white p-2 shadow-card">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function FlyoutItem({ mark, label, onClick }: { mark: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-mist"
    >
      <Mark id={mark} size={22} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function NetworkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="6" cy="7" r="2.1" />
      <circle cx="17.5" cy="6.5" r="2.1" />
      <circle cx="12" cy="17" r="2.1" />
      <path d="M8 8.1 15.6 7.2M7.5 8.8l3.2 6.2M15.6 8.2 13.2 15" strokeLinecap="round" />
    </svg>
  );
}

function rectFrom(x1: number, y1: number, x2: number, y2: number): DrawnNetwork {
  return {
    id: "",
    name: "",
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function Fail2banPanel({
  value,
  onChange,
}: {
  value: { enabled: boolean; bantime: number; findtime: number; maxretry: number; ignoreip: string };
  onChange: (value: { enabled: boolean; bantime: number; findtime: number; maxretry: number; ignoreip: string }) => void;
}) {
  const minutes = (seconds: number) => String(Math.max(1, Math.round(seconds / 60)));
  const asSeconds = (raw: string, fallbackMinutes: number) => {
    const minutesValue = Number(raw.replace(/\D/g, ""));
    return (minutesValue > 0 ? Math.min(10080, minutesValue) : fallbackMinutes) * 60;
  };
  return (
    <div className="rounded-2xl border border-line bg-[#f8fafc] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Fail2ban</p>
          <p className="text-xs text-slate-500">Bloqueia IPs que erram o SSH deste ambiente.</p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...value, enabled: !value.enabled })}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${value.enabled ? "bg-sea text-white" : "bg-white text-slate-500 ring-1 ring-line"}`}
        >
          {value.enabled ? "Ativo" : "Inativo"}
        </button>
      </div>
      {value.enabled ? (
        <div className="mt-3 flex flex-col gap-3">
          <Field label="Banimento (min)" value={minutes(value.bantime)} onChange={(next) => onChange({ ...value, bantime: asSeconds(next, 60) })} />
          <Field label="Janela (min)" value={minutes(value.findtime)} onChange={(next) => onChange({ ...value, findtime: asSeconds(next, 10) })} />
          <Field
            label="Tentativas"
            value={String(value.maxretry)}
            onChange={(next) => onChange({ ...value, maxretry: Math.min(20, Math.max(1, Number(next.replace(/\D/g, "")) || 5)) })}
          />
          <Field label="Ignorar IPs" value={value.ignoreip} onChange={(next) => onChange({ ...value, ignoreip: next })} />
          <p className="text-xs text-slate-500">O bloqueio vale para as portas publicadas no Docker deste host.</p>
        </div>
      ) : null}
    </div>
  );
}

function laneKey(id: string) {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `lane-${slug || "net"}`.slice(0, 48);
}

function describeNetworks(networks: DrawnNetwork[] = []): DrawnNetwork[] {
  const used: string[] = [];
  return networks.map((net, index) => {
    const address = net.subnet
      ? { subnet: net.subnet, gateway: net.gateway || net.subnet.replace(/\.0\/\d+$/, ".1") }
      : laneAddress(used);
    used.push(address.subnet);
    return { ...net, ...address, color: net.color || NET_COLORS[index % NET_COLORS.length] };
  });
}

function linked(links: { source: string; target: string }[], source: string, target: string) {
  const [a, b] = [source, target].sort();
  return links.some((link) => link.source === a && link.target === b);
}

function DbLinkList({
  title,
  items,
  empty,
  onRemove,
}: {
  title: string;
  items: { id: string; name: string }[];
  empty: string;
  onRemove: (id: string) => void;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</p>
      <ul className="mt-2 space-y-1">
        {items.length ? (
          items.map((item) => (
            <li key={item.id} className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2 text-sm">
              <span>{item.name}</span>
              <button type="button" className="text-xs font-semibold text-amber-800" onClick={() => onRemove(item.id)}>
                Desligar
              </button>
            </li>
          ))
        ) : (
          <li className="text-sm text-slate-500">{empty}</li>
        )}
      </ul>
    </div>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 12h6" strokeLinecap="round" />
      <path d="M8 8H6.5A3.5 3.5 0 0 0 6.5 15H8M16 8h1.5a3.5 3.5 0 0 1 0 7H16" strokeLinecap="round" />
    </svg>
  );
}

function MembershipList({ items }: { items: DrawnNetwork[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Networks</p>
      <ul className="mt-2 space-y-1">
        {items.length ? (
          items.map((item) => (
            <li key={item.id} className="rounded-xl bg-mist px-3 py-2 text-sm">
              {item.name}
            </li>
          ))
        ) : (
          <li className="text-sm text-slate-500">Arraste este item para dentro de um quadrado de rede.</li>
        )}
      </ul>
    </div>
  );
}

function clampZoom(value: number) {
  return Math.min(2.4, Math.max(0.35, value));
}

function NodeCard({
  mark,
  title,
  subtitle,
  hint,
  active,
  armed,
  locked,
  onClick,
  onRemove,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  mark: string;
  title: string;
  subtitle: string;
  hint?: string;
  active?: boolean;
  armed?: boolean;
  locked?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  onPointerDown?: (event: React.PointerEvent) => void;
  onPointerMove?: (event: React.PointerEvent) => void;
  onPointerUp?: (event: React.PointerEvent) => void;
}) {
  const className = `flex h-[156px] w-[148px] cursor-grab flex-col items-center justify-center rounded-[22px] border bg-white px-3 py-4 text-center shadow-card active:cursor-grabbing ${
    active ? "border-sea ring-4 ring-teal-100" : armed ? "border-amber-600 ring-4 ring-amber-100" : "border-line"
  } ${locked ? "" : ""}`;
  const body = (
    <>
      <Mark id={mark} size={52} />
      <strong className="mt-3 w-full truncate text-sm">{title}</strong>
      <span className="w-full truncate text-[11px] text-slate-500">{subtitle}</span>
      {hint ? <span className="mt-1 w-full truncate font-mono text-[10px] text-sea">{hint}</span> : null}
    </>
  );
  return (
    <div className="relative" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      {onClick ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          className={className}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remover ${title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="absolute -right-2 -top-2 grid h-7 w-7 place-items-center rounded-full bg-white text-red-600 shadow-card ring-1 ring-red-100"
        >
          <TrashIcon />
        </button>
      ) : null}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7h16" strokeLinecap="round" />
      <path d="M9 7V5h6v2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 7l.7 12h6.6L16 7" strokeLinejoin="round" />
    </svg>
  );
}

function CatalogButton({
  id,
  label,
  active,
  onClick,
}: {
  id: string;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 text-left text-xs font-medium ${
        active ? "border-sea bg-teal-50" : "border-transparent hover:bg-mist"
      }`}
    >
      <Mark id={id} size={22} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function Inspector({
  title,
  mark,
  onRemove,
  children,
}: {
  title: string;
  mark: string;
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-4">
        <Mark id={mark} />
        <strong className="min-w-0 flex-1 truncate">{title}</strong>
        {onRemove ? (
          <button type="button" onClick={onRemove} className="text-xs font-semibold text-red-600">
            Remover
          </button>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-auto px-4 py-4">{children}</div>
    </div>
  );
}

const RUNTIME_FAMILIES = [
  { id: "php", label: "PHP", versions: [["php84", "8.4"], ["php83", "8.3"], ["php82", "8.2"], ["php81", "8.1"]] },
  { id: "node", label: "Node", versions: [["node22", "22"], ["node20", "20"], ["node18", "18"]] },
  { id: "python", label: "Python", versions: [["python312", "3.12"], ["python311", "3.11"]] },
  { id: "go", label: "Go", versions: [["go122", "1.22"]] },
] as const;

function familyOf(runtime: string) {
  return RUNTIME_FAMILIES.find((family) => runtime.startsWith(family.id)) || RUNTIME_FAMILIES[0];
}

function RuntimePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const family = familyOf(value);
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Runtime</p>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {RUNTIME_FAMILIES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.versions[0][0])}
            className={`flex flex-col items-center gap-1 rounded-2xl border px-1 py-2 text-[11px] font-semibold ${
              family.id === item.id ? "border-sea bg-teal-50" : "border-line bg-white"
            }`}
          >
            <Mark id={item.id} size={28} />
            {item.label}
          </button>
        ))}
      </div>
      {family.versions.length > 1 ? (
        <div className="mt-2 flex rounded-xl bg-white/80 p-1">
          {family.versions.map(([id, text]) => (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className={`flex-1 rounded-lg py-1.5 text-xs font-semibold ${value === id ? "bg-white text-ink shadow-sm" : "text-slate-500"}`}
            >
              {text}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-500">{family.versions[0][1]}</p>
      )}
    </div>
  );
}

function ProjectBuild({
  source,
  composeFile,
  composeService,
  containerPort,
  onChange,
}: {
  source: "runtime" | "project";
  composeFile: string;
  composeService: string;
  containerPort: string;
  onChange: (patch: { source?: "runtime" | "project"; composeFile?: string; composeService?: string; containerPort?: number }) => void;
}) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-1.5">
        {(
          [
            ["runtime", "Imagem pronta"],
            ["project", "Docker do projeto"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange({ source: id })}
            className={`rounded-xl border px-2 py-2 text-xs font-semibold ${
              source === id ? "border-sea bg-white text-ink shadow-sm" : "border-transparent bg-white/70 text-slate-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {source === "project" ? (
        <div className="mt-3 flex flex-col gap-3">
          <Field label="docker-compose" value={composeFile} placeholder="docker-compose.yml" onChange={(value) => onChange({ composeFile: value })} />
          <Field label="Serviço" value={composeService} placeholder="app" onChange={(value) => onChange({ composeService: value })} />
          <Field
            label="Porta"
            value={containerPort}
            placeholder="80"
            onChange={(value) => onChange({ containerPort: Number(value.replace(/\D/g, "")) || 80 })}
          />
          <p className="text-xs text-slate-500">O compose faz o build. A porta é a que o balanceador usa para chegar no serviço.</p>
        </div>
      ) : null}
    </div>
  );
}

function FrameworkPicker({
  runtime,
  framework,
  onChange,
}: {
  runtime: string;
  framework?: "laravel" | "next" | "adonis" | "django";
  onChange: (framework: "laravel" | "next" | "adonis" | "django" | undefined) => void;
}) {
  const options = runtime.startsWith("php")
    ? [
        { id: undefined, label: "PHP", hint: "Servidor embutido nesta versão do PHP." },
        { id: "laravel" as const, label: "Laravel", hint: "Projeto pronto, com a chave gerada. MySQL ou Postgres ligado recebe as migrations." },
      ]
    : runtime.startsWith("node")
      ? [
          { id: undefined, label: "PM2", hint: "Sobe o start do package.json. ecosystem.config.js também é respeitado." },
          { id: "next" as const, label: "Next.js", hint: "Build de produção no PM2. MySQL ou Postgres ligado entra como DATABASE_URL." },
          { id: "adonis" as const, label: "AdonisJS", hint: "Kit web no Node 24, com PM2. MySQL ou Postgres ligado recebe as migrations." },
        ]
      : runtime.startsWith("python")
        ? [
            { id: undefined, label: "Python", hint: "Servidor embutido nesta versão do Python." },
            { id: "django" as const, label: "Django", hint: "Projeto pronto nesta versão do Python. MySQL ou Postgres ligado recebe as migrations." },
          ]
        : [];
  if (!options.length) return null;
  const selected = options.find((item) => item.id === framework) || options[0];
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Framework</p>
      <div className={`mt-2 grid gap-1.5 ${options.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
        {options.map((item) => {
          const active = item.id === (framework || undefined);
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => onChange(item.id)}
              className={`rounded-xl border px-2 py-2 text-xs font-semibold ${
                active ? "border-sea bg-white text-ink shadow-sm" : "border-transparent bg-white/70 text-slate-500"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">{selected.hint}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-mist/80 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{title}</p>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function repoSlug(raw: string) {
  return raw
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
}

function GithubRepo({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const slug = repoSlug(value);
  const valid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug);
  const [owner, repo] = valid ? slug.split("/") : ["", ""];
  return (
    <div className="rounded-2xl border border-line bg-[#f8fafc] p-3">
      <div className="flex items-center gap-3">
        <Mark id="github" size={36} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">Repositório GitHub</p>
          <p className="text-xs text-slate-500">A chave pública desta app entra como deploy key.</p>
        </div>
      </div>
      <label className="mt-3 flex items-center overflow-hidden rounded-xl border border-line bg-white">
        <span className="border-r border-line bg-mist px-2.5 py-2 font-mono text-[11px] text-slate-500">github.com/</span>
        <input
          value={value}
          placeholder="org/repo"
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            if (slug !== value.trim()) onChange(slug);
          }}
          className="min-w-0 flex-1 bg-transparent px-2.5 py-2 font-mono text-sm outline-none"
        />
      </label>
      {valid ? (
        <a
          href={`https://github.com/${owner}/${repo}`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm"
        >
          <span>
            <strong>{owner}</strong>
            <span className="text-slate-400"> / </span>
            {repo}
          </span>
          <span className="text-xs font-semibold text-sea">Abrir</span>
        </a>
      ) : value.trim() ? (
        <p className="mt-2 text-xs text-red-600">Use org/repo ou a URL do GitHub.</p>
      ) : null}
    </div>
  );
}

function listenPort(app: { source?: string; runtime: string; containerPort?: number }): number {
  if (app.source === "project") return Number(app.containerPort) || 80;
  if (app.runtime.startsWith("node")) return 3000;
  if (app.runtime.startsWith("python")) return 8000;
  return 8080;
}

function Field({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
      {label}
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-ink"
      />
    </label>
  );
}
