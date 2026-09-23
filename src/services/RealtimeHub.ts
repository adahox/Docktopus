import { EventEmitter } from "events";

export type RealtimePhase =
  | "provisioning"
  | "pulling"
  | "starting"
  | "running"
  | "stopped"
  | "deleting"
  | "deleted"
  | "error"
  | "log";

export interface RealtimeEvent {
  type: "environment";
  id: string;
  name?: string;
  phase: RealtimePhase;
  message: string;
  at: string;
}

const hub = new EventEmitter();
hub.setMaxListeners(100);

export function publishEnvironment(event: Omit<RealtimeEvent, "type" | "at">): void {
  const payload: RealtimeEvent = {
    type: "environment",
    at: new Date().toISOString(),
    ...event,
  };
  hub.emit("event", payload);
}

export function subscribeEnvironment(
  listener: (event: RealtimeEvent) => void
): () => void {
  hub.on("event", listener);
  return () => hub.off("event", listener);
}
