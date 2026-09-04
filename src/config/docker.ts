import path from "path";
import Dockerode from "dockerode";

export interface DockerAppConfig {
  dockerodeOptions: Dockerode.DockerOptions;
  proxyNetwork: string;
  projectsRoot: string;
  port: number;
}

export function getProjectsRoot(): string {
  // Preferência: PROJECTS_ROOT; fallback local ./projects (equivale a /var/apps/projetos em produção)
  return (
    process.env.PROJECTS_ROOT ||
    path.resolve(process.cwd(), "projects")
  );
}

export function getDockerConfig(): DockerAppConfig {
  const socketPath = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

  return {
    dockerodeOptions: {
      socketPath,
    },
    proxyNetwork: process.env.PROXY_NETWORK || "proxy",
    projectsRoot: getProjectsRoot(),
    port: Number(process.env.PORT || 3000),
  };
}
