FROM docker:27-cli AS dockercli
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY docker/api-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && npm ci \
  && npm run build \
  && npm prune --omit=dev \
  && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV HOME=/tmp
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
