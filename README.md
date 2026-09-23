# Docktopus

Painel de provisionamento dinâmico de ambientes Docker (estilo Coolify/Portainer simplificado).

## Stack

- **Backend:** Node.js + Express + TypeScript
- **Docker:** `dockerode` (socket `/var/run/docker.sock`) + `docker compose`
- **Proxy:** Traefik v3 (roteamento automático por domínio)
- **Templates:** Handlebars (`docker-compose.yml` dinâmico com labels Traefik)
- **Frontend:** Dashboard SaaS em HTML/CSS/JS (`src/public`)

## Início rápido

```bash
cp .env.example .env
npm install

# 1) Sobe o Traefik (rede proxy + porta 80)
npm run proxy:up

# 2) Sobe o painel
npm run dev
```

Abra o painel em `http://localhost:3000` e o dashboard do Traefik em `http://localhost:8080`.

### Domínios locais

Use sufixo **`.localhost`** (ex.: `meusite.localhost`). Ele resolve para `127.0.0.1` automaticamente — sem editar `/etc/hosts`.

Evite **`.local`**: é reservado para mDNS e costuma gerar `DNS_PROBE_FINISHED_NXDOMAIN` no navegador. O Docktopus converte `.local` → `.localhost` automaticamente.

Com Traefik na porta 8088: `http://meusite.localhost:8088`.

O processo Node precisa de acesso ao Docker socket. Em produção, monte:

```text
/var/run/docker.sock:/var/run/docker.sock
```

e defina `PROJECTS_ROOT=/var/apps/projetos`.

## Traefik

| Comando | Ação |
|---------|------|
| `npm run proxy:up` | Garante a rede `proxy` e sobe o Traefik |
| `npm run proxy:down` | Para o Traefik |
| `npm run proxy:logs` | Logs do proxy |

Arquivos em `infra/traefik/`. O Docktopus escreve rotas em `infra/traefik/dynamic/*.yml` a cada provisionamento (file provider). Assim o roteamento funciona mesmo quando o provider Docker do Traefik é incompatível com Engines recentes.

Se a porta **80** do host estiver ocupada, defina no `.env`:

```env
TRAEFIK_HTTP_PORT=8088
```

A URL pública no painel passa a incluir a porta (`http://meusite.localhost:8088`).

## API

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/environments` | Lista ambientes + status |
| `POST` | `/api/environments` | Provisiona nova stack |
| `POST` | `/api/environments/:id/start` | Sobe containers |
| `POST` | `/api/environments/:id/stop` | Para containers |
| `DELETE` | `/api/environments/:id` | Remove stack, volumes, rota e pasta |
| `GET` | `/api/environments/:id/logs` | Logs agregados |
| `GET` | `/api/environments/:id/logs/stream` | SSE de logs |

### Exemplo de criação

```bash
curl -X POST http://localhost:3000/api/environments \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Meu Site",
    "domain": "meusite.localhost",
    "webserver": "nginx",
    "runtime": "node20",
    "database": "postgres15"
  }'
```

## Estrutura

```text
infra/traefik/     # Reverse proxy
src/
  config/          # Dockerode + rotas
  controllers/     # HTTP
  services/        # TemplateEngine + DockerService
  templates/       # Handlebars
  public/          # Dashboard
  server.ts
projects/          # Ambientes gerados (compose + app)
```
