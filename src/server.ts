import "dotenv/config";
import path from "path";
import cors from "cors";
import express from "express";
import { getDockerConfig } from "./config/docker";
import { createEnvironmentRoutes } from "./config/routes";
import { DockerService } from "./services/DockerService";

async function bootstrap(): Promise<void> {
  const config = getDockerConfig();
  const app = express();
  const dockerService = new DockerService();

  await dockerService.ensureReady();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "docktopus",
      projectsRoot: config.projectsRoot,
      proxyNetwork: config.proxyNetwork,
    });
  });

  app.use("/api/environments", createEnvironmentRoutes(dockerService));

  // SPA fallback for dashboard routes
  app.get(["/", "/new", "/environments/:id/logs"], (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

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

  app.listen(config.port, () => {
    console.log(`🐙 Docktopus rodando em http://localhost:${config.port}`);
    console.log(`   Projects root: ${config.projectsRoot}`);
    console.log(`   Proxy network: ${config.proxyNetwork}`);
  });
}

bootstrap().catch((err) => {
  console.error("Falha ao iniciar Docktopus:", err);
  process.exit(1);
});
