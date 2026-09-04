import { Router } from "express";
import { EnvironmentController } from "../controllers/EnvironmentController";
import { DockerService } from "../services/DockerService";

export function createEnvironmentRoutes(dockerService: DockerService): Router {
  const router = Router();
  const controller = new EnvironmentController(dockerService);

  router.get("/", (req, res) => void controller.list(req, res));
  router.post("/", (req, res) => void controller.create(req, res));
  router.get("/:id", (req, res) => void controller.get(req, res));
  router.post("/:id/start", (req, res) => void controller.start(req, res));
  router.post("/:id/stop", (req, res) => void controller.stop(req, res));
  router.get("/:id/logs", (req, res) => void controller.logs(req, res));
  router.get("/:id/logs/stream", (req, res) => void controller.streamLogs(req, res));

  return router;
}
