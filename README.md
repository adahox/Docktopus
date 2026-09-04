# Docktopus

Painel de provisionamento dinâmico de ambientes Docker (estilo Coolify/Portainer simplificado).

## Stack

- **Backend:** Node.js + Express + TypeScript
- **Docker:** `dockerode` (socket `/var/run/docker.sock`) + `docker compose`
- **Templates:** Handlebars (`docker-compose.yml` dinâmico com labels Traefik)
- **Frontend:** Dashboard SaaS dark em HTML/CSS/JS (`src/public`)

## Início rápido

```bash
cp .env.example .env
npm install
npm run dev
```

Abra `http://localhost:3000`.

O processo Node precisa de acesso ao Docker socket. Em produção, monte:

```text
/var/run/docker.sock:/var/run/docker.sock
```

e defina `PROJECTS_ROOT=/var/apps/projetos`.

## API

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/environments` | Lista ambientes + status |
| `POST` | `/api/environments` | Provisiona nova stack |
| `POST` | `/api/environments/:id/start` | Sobe containers |
| `POST` | `/api/environments/:id/stop` | Para containers |
| `GET` | `/api/environments/:id/logs` | Logs agregados |
| `GET` | `/api/environments/:id/logs/stream` | SSE de logs |

### Exemplo de criação

```bash
curl -X POST http://localhost:3000/api/environments \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Meu Site",
    "domain": "meusite.local",
    "webserver": "nginx",
    "runtime": "node20",
    "database": "postgres15"
  }'
```

## Estrutura

```text
src/
  config/          # Dockerode + rotas
  controllers/     # HTTP
  services/        # TemplateEngine + DockerService
  templates/       # Handlebars
  public/          # Dashboard
  server.ts
projects/          # Ambientes gerados (compose + app)
```
