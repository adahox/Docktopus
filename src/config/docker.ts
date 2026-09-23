import path from "path";
import Dockerode from "dockerode";

export interface DockerAppConfig {
  dockerodeOptions: Dockerode.DockerOptions;
  proxyNetwork: string;
  projectsRoot: string;
  port: number;
  /** Host port published by Traefik (80 in prod; e.g. 8088 if 80 is taken). */
  traefikHttpPort: number;
  publicScheme: "http" | "https";
}

export function getProjectsRoot(): string {
  // Preferência: PROJECTS_ROOT; fallback local ./projects (equivale a /var/apps/projetos em produção)
  return (
    process.env.PROJECTS_ROOT ||
    path.resolve(process.cwd(), "projects")
  );
}

export function buildPublicUrl(
  domain: string,
  cfg?: Pick<DockerAppConfig, "traefikHttpPort" | "publicScheme">
): string {
  const scheme = cfg?.publicScheme || (process.env.PUBLIC_SCHEME as "http" | "https") || "http";
  const httpPort = cfg?.traefikHttpPort ?? Number(process.env.TRAEFIK_HTTP_PORT || 80);
  const needsPort =
    (scheme === "http" && httpPort !== 80) ||
    (scheme === "https" && httpPort !== 443);

  return needsPort ? `${scheme}://${domain}:${httpPort}` : `${scheme}://${domain}`;
}

export function getDockerConfig(): DockerAppConfig {
  const dockerHost = process.env.DOCKER_HOST || "";
  const dockerodeOptions: Dockerode.DockerOptions = dockerHost.startsWith("tcp://")
    ? {
        protocol: "http",
        host: new URL(dockerHost).hostname,
        port: Number(new URL(dockerHost).port || 2375),
      }
    : {
        socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
      };

  return {
    dockerodeOptions,
    proxyNetwork: process.env.PROXY_NETWORK || "proxy",
    projectsRoot: getProjectsRoot(),
    port: Number(process.env.PORT || 3000),
    traefikHttpPort: Number(process.env.TRAEFIK_HTTP_PORT || 80),
    publicScheme: (process.env.PUBLIC_SCHEME as "http" | "https") || "http",
  };
}
