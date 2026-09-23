import "dotenv/config";
import { timingSafeEqual } from "crypto";
import http from "http";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { getDockerConfig } from "./config/docker";
import { createEnvironmentRoutes } from "./config/routes";
import { DockerService } from "./services/DockerService";
import { subscribeEnvironment } from "./services/RealtimeHub";

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(req: Request): string {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function bootstrap(): Promise<void> {
  const config = getDockerConfig();
  const app = express();
  const dockerService = new DockerService();
  const apiToken = process.env.DOCKTOPUS_API_TOKEN || "";

  if (!apiToken && process.env.NODE_ENV === "production") {
    throw new Error("DOCKTOPUS_API_TOKEN é obrigatório em produção");
  }

  await dockerService.ensureReady();

  const allowedOrigin = process.env.DOCKTOPUS_WEB_ORIGIN || "";
  app.use(
    cors({
      origin: allowedOrigin || false,
      credentials: false,
    })
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "docktopus",
      projectsRoot: config.projectsRoot,
      proxyNetwork: config.proxyNetwork,
    });
  });

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (!apiToken) return next();
    if (tokenMatches(bearerToken(req), apiToken)) return next();
    res.status(401).json({ error: "Não autorizado" });
  });

  app.use("/api/environments", createEnvironmentRoutes(dockerService));

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error("[docktopus]", err);
      res.status(500).json({ error: err.message || "Erro interno" });
    }
  );

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get("ticket") || "";
    const header = req.headers.authorization || "";
    const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : ticket;
    if (apiToken && !tokenMatches(provided, apiToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "hello", at: new Date().toISOString() }));
  });

  subscribeEnvironment((event) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  server.listen(config.port, () => {
    console.log(`🐙 Docktopus API em http://localhost:${config.port}`);
    console.log(`   Projects root: ${config.projectsRoot}`);
    console.log(`   Proxy network: ${config.proxyNetwork}`);
    console.log(`   Docker: ${process.env.DOCKER_HOST || process.env.DOCKER_SOCKET || "/var/run/docker.sock"}`);
  });
}

bootstrap().catch((err) => {
  console.error("Falha ao iniciar Docktopus:", err);
  process.exit(1);
});
