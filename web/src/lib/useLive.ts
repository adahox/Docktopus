"use client";

import { useEffect } from "react";

export type LiveEvent = {
  type: string;
  id?: string;
  name?: string;
  phase?: string;
  message?: string;
  at?: string;
};

export function useLive(onEvent: (event: LiveEvent) => void) {
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as LiveEvent);
      } catch {
        // ignore
      }
    };
    return () => ws.close();
  }, [onEvent]);
}
