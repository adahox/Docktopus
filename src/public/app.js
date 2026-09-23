const state = {
  view: "dashboard",
  step: 1,
  environments: [],
  logsId: null,
  detailId: null,
  detail: null,
  detailAppId: null,
  detailAppTab: "overview",
  wizApps: [],
  wizDbs: [],
  editApps: [],
  editDbs: [],
};

const titles = {
  dashboard: ["Console", "Ambientes", "Stacks Docker isoladas com roteamento automático"],
  wizard: ["Provisionamento", "Novo ambiente", "Monte aplicações e bancos dinamicamente"],
  detail: ["Ambiente", "Detalhes", "Configuração, bancos e containers"],
  logs: ["Observabilidade", "Logs", "Saída agregada dos containers do ambiente"],
};

const LABELS = {
  webserver: { nginx: "Nginx", apache: "Apache", none: "Standalone" },
  runtime: {
    php81: "PHP 8.1",
    php82: "PHP 8.2",
    php83: "PHP 8.3",
    node18: "Node.js 18",
    node20: "Node.js 20",
    node22: "Node.js 22",
    python310: "Python 3.10",
    python311: "Python 3.11",
    python312: "Python 3.12",
    go121: "Go 1.21",
    go122: "Go 1.22",
    go: "Go 1.22",
  },
  database: {
    mysql8: "MySQL 8",
    postgres14: "PostgreSQL 14",
    postgres15: "PostgreSQL 15",
    postgres16: "PostgreSQL 16",
    redis: "Redis",
    none: "Sem banco",
  },
  status: {
    running: "Em execução",
    stopped: "Parado",
    error: "Erro",
    provisioning: "Provisionando",
  },
};

const RUNTIME_OPTS = [
  ["php81", "PHP 8.1"],
  ["php82", "PHP 8.2"],
  ["php83", "PHP 8.3"],
  ["node18", "Node.js 18"],
  ["node20", "Node.js 20"],
  ["node22", "Node.js 22"],
  ["python310", "Python 3.10"],
  ["python311", "Python 3.11"],
  ["python312", "Python 3.12"],
  ["go121", "Go 1.21"],
  ["go122", "Go 1.22"],
];

const WEBSERVER_OPTS = [
  ["nginx", "Nginx"],
  ["apache", "Apache"],
  ["none", "Standalone"],
];

const DB_ENGINE_OPTS = [
  ["mysql8", "MySQL 8"],
  ["postgres14", "PostgreSQL 14"],
  ["postgres15", "PostgreSQL 15"],
  ["postgres16", "PostgreSQL 16"],
  ["redis", "Redis"],
];

function dbFamily(database) {
  if (String(database).startsWith("mysql")) return "mysql";
  if (String(database).startsWith("postgres")) return "postgres";
  if (database === "redis") return "redis";
  return "none";
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  if (res.status === 204) return null;

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2800);
}

function setView(view) {
  state.view = view;
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $(`#view-${view}`)?.classList.remove("hidden");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));

  const [eyebrow, title, subtitle] = titles[view] || titles.dashboard;
  $("#view-eyebrow").textContent = eyebrow;
  $("#view-title").textContent = title;
  $("#view-subtitle").textContent = subtitle;

  const refresh = $("#btn-refresh");
  if (refresh) refresh.classList.toggle("hidden", view !== "dashboard");
}

function statusBadge(status) {
  const label = LABELS.status[status] || status;
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function initials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "DT";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

function secretValue(value, key) {
  if (value == null || value === "") return "<span class='muted'>—</span>";
  return `<span class="secret-row"><code data-secret-key="${escapeHtml(key)}">${escapeHtml(value)}</code>
    <button type="button" class="copy-btn" data-copy="${escapeHtml(value)}">Copiar</button></span>`;
}

function slugify(raw, fallback = "svc") {
  const slug = String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || fallback;
}

function normalizeDomain(raw) {
  let domain = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!domain) return domain;

  if (domain.endsWith(".local") && !domain.endsWith(".localhost")) {
    domain = `${domain.slice(0, -".local".length)}.localhost`;
  }
  if (!domain.includes(".")) {
    domain = `${domain}.localhost`;
  }
  return domain;
}

function defaultApp(domain, index = 0) {
  const id = index === 0 ? "app" : `app${index + 1}`;
  let subdomain = domain || "app.localhost";
  if (index > 0 && domain) {
    const parts = domain.split(".");
    subdomain = `${id}.${parts.slice(-2).join(".") === "localhost" ? domain.replace(/^[^.]+/, id) : `${id}.${domain}`}`;
    if (domain.endsWith(".localhost")) {
      const base = domain.replace(/\.localhost$/, "");
      subdomain = `${id}.${base}.localhost`.replace(/^\.+/, "");
      // api.portal.localhost style
      subdomain = `${id}.${domain}`;
    }
  }
  return {
    id,
    name: id,
    subdomain: normalizeDomain(subdomain),
    runtime: "php82",
    webserver: "nginx",
    githubRepo: "",
  };
}

function defaultDb(index = 0) {
  const id = index === 0 ? "mysql" : `db${index + 1}`;
  return {
    id,
    name: id,
    engine: "mysql8",
    dbName: "app",
    dbUser: "app",
    dbPassword: "appsecret",
    dbRootPassword: "rootsecret",
  };
}

function resetWizardServices() {
  const domain = normalizeDomain($("#wiz-domain")?.value || "app.localhost");
  state.wizApps = [defaultApp(domain, 0)];
  state.wizDbs = [];
}

function selectOptions(options, selected) {
  return options
    .map(
      ([value, label]) =>
        `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`
    )
    .join("");
}

function stackMarkKey(id) {
  const key = String(id || "");
  if (key.startsWith("php")) return "php";
  if (key.startsWith("node")) return "node";
  if (key.startsWith("python")) return "python";
  if (key.startsWith("go")) return "go";
  if (key.startsWith("mysql")) return "mysql";
  if (key.startsWith("postgres")) return "postgres";
  if (typeof STACK_MARKS !== "undefined" && STACK_MARKS[key]) return key;
  return "";
}

function stackLogo(id) {
  const key = stackMarkKey(id);
  const mark = typeof STACK_MARKS !== "undefined" ? STACK_MARKS[key] : null;
  if (!mark) {
    return `<span class="stack-mark" style="--mark:#64748b"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 7h10v2H7zm0 4h10v2H7zm0 4h7v2H7z"/></svg></span>`;
  }
  return `<span class="stack-mark" style="--mark:${mark.color}"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${mark.d}"/></svg></span>`;
}

function normalizeGithubInput(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
}

function githubUrl(repo) {
  const slug = normalizeGithubInput(repo);
  return slug ? `https://github.com/${slug}` : "";
}

function renderStackSelect({ field, kind, prefix, index, options, selected, label }) {
  const current = options.find(([value]) => value === selected) || options[0];
  const currentValue = current?.[0] || selected;
  const currentLabel = current?.[1] || selected;
  const items = options
    .map(([value, text]) => {
      const active = value === currentValue ? "active" : "";
      return `<button type="button" class="stack-option ${active}" role="option" data-stack-option="${escapeHtml(value)}" aria-selected="${value === currentValue}">
        ${stackLogo(value)}
        <span>${escapeHtml(text)}</span>
      </button>`;
    })
    .join("");

  return `<div class="field stack-field">
    <span class="field-caption">${escapeHtml(label)}</span>
    <div
      class="stack-select"
      data-stack-select
      data-f="${escapeHtml(field)}"
      data-kind="${escapeHtml(kind)}"
      data-prefix="${escapeHtml(prefix)}"
      data-index="${escapeHtml(index)}"
      data-value="${escapeHtml(currentValue)}"
    >
      <button type="button" class="stack-select-trigger" data-stack-toggle aria-haspopup="listbox" aria-expanded="false">
        <span class="stack-select-value">
          ${stackLogo(currentValue)}
          <span>${escapeHtml(currentLabel)}</span>
        </span>
        <svg class="stack-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="stack-select-menu hidden" role="listbox">${items}</div>
      <input type="hidden" data-f="${escapeHtml(field)}" data-kind="${escapeHtml(kind)}" data-prefix="${escapeHtml(prefix)}" data-index="${escapeHtml(index)}" value="${escapeHtml(currentValue)}" />
    </div>
  </div>`;
}

function closeAllStackSelects(except) {
  $$("[data-stack-select]").forEach((el) => {
    if (except && el === except) return;
    el.classList.remove("open");
    el.querySelector(".stack-select-menu")?.classList.add("hidden");
    const trigger = el.querySelector("[data-stack-toggle]");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  });
}

function setStackSelectValue(root, value) {
  const options = [...root.querySelectorAll("[data-stack-option]")];
  const opt = options.find((o) => o.dataset.stackOption === value) || options[0];
  if (!opt) return;
  const label = opt.querySelector("span")?.textContent || value;
  root.dataset.value = value;
  const hidden = root.querySelector('input[type="hidden"]');
  if (hidden) hidden.value = value;
  const valueEl = root.querySelector(".stack-select-value");
  if (valueEl) {
    valueEl.innerHTML = `${stackLogo(value)}<span>${escapeHtml(label)}</span>`;
  }
  options.forEach((o) => {
    const on = o.dataset.stackOption === value;
    o.classList.toggle("active", on);
    o.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function iconApp() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>`;
}

function iconDb(engine) {
  if (engine === "redis") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M5 12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2"/><path d="M5 12a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2"/><path d="M8 8h.01"/><path d="M8 16h.01"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>`;
}

function iconTrash() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;
}

function renderAppCard(app, index, prefix) {
  return `<div class="service-card" data-kind="app" data-index="${index}">
    <div class="service-card-head">
      <div class="service-card-identity">
        <span class="service-type app stack-mark-wrap">${stackLogo(app.runtime)}</span>
        <div>
          <strong>${escapeHtml(app.name || app.id || `App ${index + 1}`)}</strong>
          <small>${escapeHtml(app.subdomain || "—")}</small>
        </div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-builder-remove="app" data-prefix="${prefix}" data-index="${index}" title="Remover">
        ${iconTrash()} Remover
      </button>
    </div>
    <div class="field-grid">
      <label class="field">Id (serviço)
        <input data-f="id" data-prefix="${prefix}" data-index="${index}" data-kind="app" value="${escapeHtml(app.id)}" pattern="[a-z0-9-]+" required />
      </label>
      <label class="field">Nome
        <input data-f="name" data-prefix="${prefix}" data-index="${index}" data-kind="app" value="${escapeHtml(app.name)}" required />
      </label>
      <label class="field">Subdomínio
        <input data-f="subdomain" data-prefix="${prefix}" data-index="${index}" data-kind="app" value="${escapeHtml(app.subdomain)}" pattern="[a-z0-9.-]+" required />
      </label>
      <label class="field field-wide">Repositório GitHub <span class="optional">(opcional)</span>
        <input data-f="githubRepo" data-prefix="${prefix}" data-index="${index}" data-kind="app" value="${escapeHtml(app.githubRepo || "")}" placeholder="org/repo ou https://github.com/org/repo" />
      </label>
      ${renderStackSelect({
        field: "runtime",
        kind: "app",
        prefix,
        index,
        options: RUNTIME_OPTS,
        selected: app.runtime || "php82",
        label: "Runtime",
      })}
      ${renderStackSelect({
        field: "webserver",
        kind: "app",
        prefix,
        index,
        options: WEBSERVER_OPTS,
        selected: app.webserver || "nginx",
        label: "Servidor web",
      })}
    </div>
  </div>`;
}

function renderDbCard(db, index, prefix) {
  const family = dbFamily(db.engine);
  const sqlHidden = family === "redis" ? "hidden" : "";
  const redisHidden = family === "redis" ? "" : "hidden";
  const rootHidden = family === "mysql" ? "" : "hidden";

  return `<div class="service-card" data-kind="db" data-index="${index}">
    <div class="service-card-head">
      <div class="service-card-identity">
        <span class="service-type db stack-mark-wrap">${stackLogo(db.engine)}</span>
        <div>
          <strong>${escapeHtml(db.name || db.id || `DB ${index + 1}`)}</strong>
          <small>${escapeHtml(LABELS.database[db.engine] || db.engine)} · host <code>${escapeHtml(db.id)}</code></small>
        </div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-builder-remove="db" data-prefix="${prefix}" data-index="${index}" title="Remover">
        ${iconTrash()} Remover
      </button>
    </div>
    <div class="field-grid">
      <label class="field">Id (host Docker)
        <input data-f="id" data-prefix="${prefix}" data-index="${index}" data-kind="db" value="${escapeHtml(db.id)}" pattern="[a-z0-9-]+" required />
      </label>
      <label class="field">Nome
        <input data-f="name" data-prefix="${prefix}" data-index="${index}" data-kind="db" value="${escapeHtml(db.name)}" required />
      </label>
      ${renderStackSelect({
        field: "engine",
        kind: "db",
        prefix,
        index,
        options: DB_ENGINE_OPTS,
        selected: db.engine || "mysql8",
        label: "Engine",
      })}
    </div>
    <div class="field-grid db-sql-fields ${sqlHidden}" data-db-sql="${prefix}-${index}">
      <label class="field">Database
        <input data-f="dbName" data-prefix="${prefix}" data-index="${index}" data-kind="db" value="${escapeHtml(db.dbName || "app")}" />
      </label>
      <label class="field">Usuário
        <input data-f="dbUser" data-prefix="${prefix}" data-index="${index}" data-kind="db" value="${escapeHtml(db.dbUser || "app")}" />
      </label>
      <label class="field">Senha
        <input data-f="dbPassword" data-prefix="${prefix}" data-index="${index}" data-kind="db" type="password" value="${escapeHtml(db.dbPassword || "")}" autocomplete="new-password" />
      </label>
      <label class="field ${rootHidden}" data-db-root="${prefix}-${index}">Senha root
        <input data-f="dbRootPassword" data-prefix="${prefix}" data-index="${index}" data-kind="db" type="password" value="${escapeHtml(db.dbRootPassword || "")}" autocomplete="new-password" />
      </label>
    </div>
    <div class="field-grid db-redis-fields ${redisHidden}" data-db-redis="${prefix}-${index}">
      <label class="field">Senha Redis <span class="optional">(opcional)</span>
        <input data-f="dbPassword" data-prefix="${prefix}" data-index="${index}" data-kind="db" data-redis="1" type="password" value="${escapeHtml(family === "redis" ? db.dbPassword || "" : "")}" autocomplete="new-password" />
      </label>
    </div>
  </div>`;
}

function getBuilderLists(prefix) {
  return prefix === "edit"
    ? { apps: state.editApps, dbs: state.editDbs }
    : { apps: state.wizApps, dbs: state.wizDbs };
}

function renderBuilder(prefix) {
  const { apps, dbs } = getBuilderLists(prefix);
  const appsEl = $(prefix === "edit" ? "#edit-apps" : "#wiz-apps");
  const dbsEl = $(prefix === "edit" ? "#edit-dbs" : "#wiz-dbs");
  if (!appsEl || !dbsEl) return;

  appsEl.innerHTML = apps.length
    ? apps.map((a, i) => renderAppCard(a, i, prefix)).join("")
    : `<div class="service-empty">${iconApp()}<span>Nenhuma aplicação ainda</span><small>Adicione ao menos uma para publicar no Traefik</small></div>`;
  dbsEl.innerHTML = dbs.length
    ? dbs.map((d, i) => renderDbCard(d, i, prefix)).join("")
    : `<div class="service-empty">${iconDb("mysql")}<span>Nenhum banco</span><small>Opcional — MySQL, Postgres ou Redis</small></div>`;
}

function syncBuilderFromDom(prefix) {
  const { apps, dbs } = getBuilderLists(prefix);
  $$("[data-kind=app][data-f]").forEach((el) => {
    if (el.dataset.prefix !== prefix) return;
    if (el.matches("[data-stack-select]")) return;
    const i = Number(el.dataset.index);
    if (!apps[i]) return;
    apps[i][el.dataset.f] = el.value;
  });
  $$("[data-kind=db][data-f]").forEach((el) => {
    if (el.dataset.prefix !== prefix) return;
    if (el.matches("[data-stack-select]")) return;
    const i = Number(el.dataset.index);
    if (!dbs[i]) return;
    if (el.dataset.redis && dbFamily(dbs[i].engine) !== "redis") return;
    if (!el.dataset.redis && dbFamily(dbs[i].engine) === "redis" && el.dataset.f === "dbPassword") {
      const sqlBlock = el.closest(".db-sql-fields");
      if (sqlBlock) return;
    }
    dbs[i][el.dataset.f] = el.value;
  });

  apps.forEach((a) => {
    a.id = slugify(a.id || a.name, "app");
    a.subdomain = normalizeDomain(a.subdomain);
  });
  dbs.forEach((d) => {
    d.id = slugify(d.id || d.name || d.engine, "db");
  });
}

function collectPayload(prefix) {
  syncBuilderFromDom(prefix);
  const { apps, dbs } = getBuilderLists(prefix);
  const nameEl = prefix === "edit" ? $("#edit-name") : $("#wiz-name");
  const domainEl = prefix === "edit" ? $("#edit-domain") : $("#wiz-domain");
  const name = String(nameEl?.value || "").trim();
  const domain = ensureLocalhostDomain(domainEl?.value || apps[0]?.subdomain || "") ||
    domainFromProjectName(name);

  const applications = apps.map((a) => ({
    id: slugify(a.id || a.name, "app"),
    name: a.name || a.id,
    subdomain: ensureLocalhostDomain(a.subdomain || domain) || domain,
    runtime: a.runtime || "php82",
    webserver: a.webserver || "nginx",
    githubRepo: normalizeGithubInput(a.githubRepo),
  }));

  // Agrupa apps com nginx/apache em um gateway por engine
  const routesByEngine = { nginx: [], apache: [] };
  for (const a of applications) {
    if (a.webserver === "nginx" || a.webserver === "apache") {
      routesByEngine[a.webserver].push({ subdomain: a.subdomain, appId: a.id });
    }
  }
  const webservers = Object.entries(routesByEngine)
    .filter(([, routes]) => routes.length)
    .map(([engine, routes]) => ({
      id: engine,
      name: engine,
      engine,
      routes,
    }));

  return {
    name,
    domain: applications[0]?.subdomain || domain,
    webservers,
    applications,
    databases: dbs.map((d) => {
      const row = {
        id: slugify(d.id || d.name || d.engine, "db"),
        name: d.name || d.id,
        engine: d.engine,
      };
      if (dbFamily(d.engine) === "redis") {
        if (d.dbPassword) row.dbPassword = d.dbPassword;
      } else {
        row.dbName = d.dbName || "app";
        row.dbUser = d.dbUser || "app";
        row.dbPassword = d.dbPassword || "appsecret";
        if (dbFamily(d.engine) === "mysql") {
          row.dbRootPassword = d.dbRootPassword || "rootsecret";
        }
      }
      if (d.hostPort) row.hostPort = d.hostPort;
      return row;
    }),
  };
}

function updateStats() {
  const total = state.environments.length;
  const running = state.environments.filter((e) => e.status === "running").length;
  const stopped = state.environments.filter((e) => e.status === "stopped").length;
  const row = $("#stats-row");

  if (!total) {
    row.hidden = true;
    return;
  }

  row.hidden = false;
  $("#stat-total").textContent = String(total);
  $("#stat-running").textContent = String(running);
  $("#stat-stopped").textContent = String(stopped);
}

function actionIcons(env) {
  return `
    <div class="row-actions">
      <button type="button" class="btn btn-icon btn-start" data-action="start" data-id="${escapeHtml(env.id)}" title="Iniciar" aria-label="Iniciar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="6 3 20 12 6 21 6 3"></polygon>
        </svg>
      </button>
      <button type="button" class="btn btn-icon btn-stop" data-action="stop" data-id="${escapeHtml(env.id)}" title="Parar" aria-label="Parar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2"></rect>
        </svg>
      </button>
      <button type="button" class="btn btn-icon btn-primary" data-action="logs" data-id="${escapeHtml(env.id)}" title="Ver logs" aria-label="Ver logs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path>
          <path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path>
        </svg>
      </button>
      <button type="button" class="btn btn-icon btn-edit" data-action="edit" data-id="${escapeHtml(env.id)}" title="Editar ambiente" aria-label="Editar ambiente">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
        </svg>
      </button>
      <button type="button" class="btn btn-icon btn-danger" data-action="delete" data-id="${escapeHtml(env.id)}" data-name="${escapeHtml(env.name)}" title="Remover" aria-label="Remover">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6h18"></path>
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
          <path d="M10 11v6"></path><path d="M14 11v6"></path>
        </svg>
      </button>
    </div>`;
}

function stackTags(env) {
  const apps = env.applications || env.config?.applications || [];
  const dbs = env.databases || env.config?.databases || [];
  if (apps.length || dbs.length) {
    const tags = [
      ...apps.map((a) => LABELS.runtime[a.runtime] || a.runtime),
      ...dbs.map((d) => LABELS.database[d.engine] || d.engine),
    ];
    return tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
  }
  return `
    <span class="tag">${escapeHtml(LABELS.webserver[env.webserver] || env.webserver)}</span>
    <span class="tag">${escapeHtml(LABELS.runtime[env.runtime] || env.runtime)}</span>
    <span class="tag">${escapeHtml(LABELS.database[env.database] || env.database)}</span>`;
}

function renderDashboard() {
  const tbody = $("#env-tbody");
  const empty = $("#empty-state");
  const wrap = $("#env-table-wrap");
  updateStats();

  if (!state.environments.length) {
    tbody.innerHTML = "";
    wrap.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  wrap.classList.remove("hidden");

  tbody.innerHTML = state.environments
    .map(
      (env) => `
      <tr class="env-row" data-action="open" data-id="${escapeHtml(env.id)}" style="cursor:pointer">
        <td>
          <div class="env-cell">
            <span class="env-avatar">${escapeHtml(initials(env.name))}</span>
            <button type="button" class="env-name-btn" data-action="open" data-id="${escapeHtml(env.id)}">
              <span class="env-name">${escapeHtml(env.name)}</span>
              <span class="env-id">${escapeHtml(env.id)}</span>
            </button>
          </div>
        </td>
        <td>
          <a class="url-link" href="${escapeHtml(env.publicUrl)}" target="_blank" rel="noreferrer" title="${escapeHtml(env.publicUrl)}" onclick="event.stopPropagation()">${escapeHtml(env.publicUrl)}</a>
        </td>
        <td><div class="stack-tags">${stackTags(env)}</div></td>
        <td>${statusBadge(env.status)}</td>
        <td>${actionIcons(env)}</td>
      </tr>`
    )
    .join("");
}

function slugifyDomainBase(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function domainFromProjectName(name) {
  const base = slugifyDomainBase(name) || "app";
  return `${base}.localhost`;
}

function ensureLocalhostDomain(raw) {
  let domain = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!domain) return "";

  // strip accidental schemes/paths
  domain = domain.replace(/^https?:\/\//, "").split("/")[0];

  if (domain.endsWith(".local") && !domain.endsWith(".localhost")) {
    domain = `${domain.slice(0, -".local".length)}.localhost`;
  }

  if (!domain.includes(".")) {
    domain = `${domain}.localhost`;
  } else if (!domain.endsWith(".localhost")) {
    // single extra TLD like foo.com kept; bare labels already handled
    const label = domain.split(".")[0];
    if (/^[a-z0-9-]+$/.test(label) && domain === label) {
      domain = `${label}.localhost`;
    }
  }

  return normalizeDomain(domain);
}

function updateWizardPreview() {
  const name = String($("#wiz-name")?.value || "").trim() || "Seu projeto";
  const domain = ensureLocalhostDomain($("#wiz-domain")?.value) || "portal.localhost";
  const avatar = $("#wiz-preview-avatar");
  const nameEl = $("#wiz-preview-name");
  const domainEl = $("#wiz-preview-domain");
  if (avatar) avatar.textContent = initials(name);
  if (nameEl) nameEl.textContent = name;
  if (domainEl) domainEl.textContent = domain;
}

function syncDomainFromName({ force = false } = {}) {
  const nameInput = $("#wiz-name");
  const domainInput = $("#wiz-domain");
  if (!nameInput || !domainInput) return;

  const name = String(nameInput.value || "").trim();
  if (!name) return;

  const auto = domainFromProjectName(name);
  const touched = domainInput.dataset.manual === "1";
  if (force || !touched || !domainInput.value.trim()) {
    domainInput.value = auto;
    domainInput.dataset.manual = "0";
  }
  updateWizardPreview();
}

function updateWizardUI() {
  $$(".progress-item").forEach((s) => {
    const n = Number(s.dataset.step);
    s.classList.toggle("active", n === state.step);
    s.classList.toggle("done", n < state.step);
  });
  $$("#wizard-form .panel").forEach((p) =>
    p.classList.toggle("hidden", Number(p.dataset.panel) !== state.step)
  );
  $("#btn-prev").disabled = state.step === 1;
  $("#btn-next").classList.toggle("hidden", state.step === 3);
  $("#btn-provision").classList.toggle("hidden", state.step !== 3);
  const chip = $("#step-chip");
  if (chip) chip.textContent = `${state.step} / 3`;
  if (state.step === 1) updateWizardPreview();
  if (state.step === 2) {
    if (!state.wizApps.length) resetWizardServices();
    renderBuilder("wiz");
  }
  if (state.step === 3) renderSummary();
}

function renderSummary() {
  const d = collectPayload("wiz");
  const appsHtml = d.applications.length
    ? d.applications
        .map(
          (a) => `<div class="summary-item">
            <div>
              <strong>${escapeHtml(a.name)}</strong>
              <div><code>${escapeHtml(a.subdomain)}</code></div>
            </div>
            <span>${escapeHtml(LABELS.runtime[a.runtime])} · ${escapeHtml(LABELS.webserver[a.webserver] || "nginx")}${a.githubRepo ? ` · ${escapeHtml(a.githubRepo)}` : ""}</span>
          </div>`
        )
        .join("")
    : `<div class="summary-item muted">Nenhuma aplicação</div>`;

  const dbsHtml = d.databases.length
    ? d.databases
        .map(
          (db) => `<div class="summary-item">
            <div>
              <strong>${escapeHtml(db.name || db.id)}</strong>
              <div><code>${escapeHtml(db.id)}</code></div>
            </div>
            <span>${escapeHtml(LABELS.database[db.engine])}</span>
          </div>`
        )
        .join("")
    : `<div class="summary-item"><span class="muted">Nenhum banco</span></div>`;

  $("#summary").innerHTML = `
    <div class="summary-card">
      <div class="summary-card-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        <strong>Projeto</strong>
      </div>
      <div class="summary-item">
        <div><strong>${escapeHtml(d.name)}</strong></div>
        <code>${escapeHtml(d.domain)}</code>
      </div>
    </div>
    <div class="summary-card">
      <div class="summary-card-head">${iconApp()}<strong>Aplicações (${d.applications.length})</strong></div>
      ${appsHtml}
    </div>
    <div class="summary-card">
      <div class="summary-card-head">${iconDb("mysql")}<strong>Bancos (${d.databases.length})</strong></div>
      ${dbsHtml}
    </div>
  `;
}

function containerStateClass(stateName) {
  const s = String(stateName || "").toLowerCase();
  if (s === "running") return "running";
  if (s === "exited" || s === "dead") return "error";
  return "stopped";
}

function getAppPublicUrl(env, app) {
  const publicUrls = env.publicUrls || [];
  return (
    publicUrls.find((u) => u.appId === app.id)?.url ||
    (app.subdomain ? `http://${app.subdomain}` : env.publicUrl)
  );
}

function getAppContainers(env, appId) {
  return (env.containers || []).filter((c) => {
    const name = String(c.name || "");
    return (
      name === `${env.id}-${appId}` ||
      name.endsWith(`-${appId}`) ||
      name.includes(`-${appId}-`) ||
      name.endsWith(`-${appId}-ssh`)
    );
  });
}

function openAppDrawer(appId, tab = "overview") {
  state.detailAppId = appId;
  state.detailAppTab = tab;
  renderAppDrawer();
}

function closeAppDrawer() {
  state.detailAppId = null;
  state.detailAppTab = "overview";
  renderAppDrawer();
}

function renderAppDrawer() {
  const host = $("#app-drawer-host");
  if (!host) return;

  $$(".app-row").forEach((row) => {
    row.classList.toggle("selected", row.dataset.appId === state.detailAppId);
  });

  const env = state.detail;
  const appId = state.detailAppId;
  if (!env || !appId) {
    host.innerHTML = "";
    host.classList.add("hidden");
    document.body.classList.remove("drawer-open");
    return;
  }

  const cfg = env.config || {};
  const apps = env.applications || cfg.applications || [];
  const app = apps.find((a) => a.id === appId);
  if (!app) {
    host.innerHTML = "";
    host.classList.add("hidden");
    document.body.classList.remove("drawer-open");
    return;
  }

  const ssh = (cfg.sshConnections || []).find((s) => s.appId === app.id);
  const url = getAppPublicUrl(env, app);
  const appContainers = getAppContainers(env, app.id);
  const envVars = cfg.envVars || [];
  const tab = state.detailAppTab || "overview";

  const repo = githubUrl(app.githubRepo);
  const tabs = [
    ["overview", "Geral"],
    ["ssh", "SSH"],
    ["containers", "Containers"],
    ["env", "Variáveis"],
  ];

  let body = "";
  if (tab === "overview") {
    body = `
      <div class="drawer-stack">
        <a class="drawer-link-card" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">
          <span>URL pública</span>
          <strong>${escapeHtml(url)}</strong>
        </a>
        <div class="drawer-facts">
          <div class="drawer-fact">
            <span>Runtime</span>
            <strong>${stackLogo(app.runtime)} ${escapeHtml(LABELS.runtime[app.runtime] || app.runtime)}</strong>
          </div>
          <div class="drawer-fact">
            <span>Serviço</span>
            <strong><code>${escapeHtml(app.id)}</code></strong>
          </div>
          <div class="drawer-fact">
            <span>Subdomínio</span>
            <strong><code>${escapeHtml(app.subdomain || "—")}</code></strong>
          </div>
          <div class="drawer-fact">
            <span>SSH</span>
            <strong>${ssh ? `:${escapeHtml(ssh.hostPort)}` : "—"}</strong>
          </div>
        </div>
        <section class="drawer-card">
          <header class="drawer-card-head">
            ${stackLogo("github")}
            <div>
              <strong>GitHub</strong>
              <small>Repositório para automação de deploy</small>
            </div>
          </header>
          ${
            repo
              ? `<a class="drawer-repo" href="${escapeHtml(repo)}" target="_blank" rel="noreferrer">${escapeHtml(normalizeGithubInput(app.githubRepo))}</a>
                 <p class="drawer-note">A chave pública desta app pode ser cadastrada como deploy key neste repositório.</p>`
              : `<p class="drawer-empty">Nenhum repositório vinculado. Edite o ambiente e informe <code>org/repo</code>.</p>`
          }
        </section>
      </div>`;
  } else if (tab === "ssh") {
    body = ssh
      ? `<div class="drawer-stack">
          <div class="drawer-facts">
            <div class="drawer-fact"><span>Host</span><strong>127.0.0.1</strong></div>
            <div class="drawer-fact"><span>Porta</span><strong>${escapeHtml(ssh.hostPort)}</strong></div>
            <div class="drawer-fact"><span>Usuário</span><strong>${escapeHtml(ssh.user)}</strong></div>
            <div class="drawer-fact"><span>Senha</span><strong>${secretValue(ssh.password, `${app.id}-ssh-pass`)}</strong></div>
          </div>
          <section class="drawer-card">
            <header class="drawer-card-head">
              <div>
                <strong>Comando</strong>
                <small>Acesso ao workspace <code>/config/workspace</code></small>
              </div>
            </header>
            <div class="drawer-code-row">
              <code>${escapeHtml(ssh.command)}</code>
              <button type="button" class="copy-btn" data-copy="${escapeHtml(ssh.command)}">Copiar</button>
            </div>
          </section>
          <section class="drawer-card">
            <header class="drawer-card-head">
              <div>
                <strong>Chave pública</strong>
                <small>Cole em GitHub → Settings → Deploy keys</small>
              </div>
              <button type="button" class="btn btn-primary btn-sm" data-copy-ssh="${escapeHtml(app.id)}">Copiar chave</button>
            </header>
            <pre class="ssh-key-pre">${escapeHtml(ssh.publicKey || "")}</pre>
          </section>
        </div>`
      : `<div class="drawer-card"><p class="drawer-empty">SSH ainda não provisionado. Salve o ambiente para gerar a chave.</p></div>`;
  } else if (tab === "containers") {
    body = appContainers.length
      ? `<div class="drawer-stack">
          ${appContainers
            .map((c) => {
              const st = containerStateClass(c.state);
              return `<article class="drawer-card drawer-container">
                <span class="container-dot ${escapeHtml(st)}" aria-hidden="true"></span>
                <div>
                  <strong>${escapeHtml(c.name)}</strong>
                  <small>${escapeHtml(c.image)}</small>
                </div>
                <span class="badge ${escapeHtml(st)}">${escapeHtml(c.state)}</span>
              </article>`;
            })
            .join("")}
        </div>`
      : `<div class="drawer-card"><p class="drawer-empty">Nenhum container desta aplicação.</p></div>`;
  } else {
    body = `
      <div class="drawer-stack">
        ${
          envVars.length
            ? envVars
                .map(
                  (row) => `<article class="drawer-card drawer-env">
                    <code>${escapeHtml(row.key)}</code>
                    <div>${secretValue(row.value, `${app.id}-${row.key}`)}</div>
                  </article>`
                )
                .join("")
            : `<div class="drawer-card"><p class="drawer-empty">Nenhuma variável injetada nesta aplicação.</p></div>`
        }
      </div>`;
  }

  host.classList.remove("hidden");
  document.body.classList.add("drawer-open");
  host.innerHTML = `
    <div class="app-drawer-backdrop" data-action="close-app-drawer"></div>
    <aside class="app-drawer" role="dialog" aria-modal="true" aria-label="Detalhes da aplicação ${escapeHtml(app.name)}">
      <header class="app-drawer-head">
        <div class="app-drawer-identity">
          ${stackLogo(app.runtime)}
          <div>
            <strong>${escapeHtml(app.name)}</strong>
            <small>${escapeHtml(LABELS.runtime[app.runtime] || app.runtime)}</small>
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" data-action="close-app-drawer" title="Fechar" aria-label="Fechar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>
          </svg>
        </button>
      </header>
      <nav class="app-drawer-tabs" aria-label="Seções da aplicação">
        ${tabs
          .map(
            ([id, label]) =>
              `<button type="button" class="app-drawer-tab ${tab === id ? "active" : ""}" data-app-tab="${id}">${label}</button>`
          )
          .join("")}
      </nav>
      <div class="app-drawer-body">${body}</div>
    </aside>
  `;
}

function renderDetail(env) {
  const cfg = env.config || {};
  const apps = env.applications || cfg.applications || [];
  const dbs = env.databases || cfg.databases || [];
  const connections = cfg.databaseConnections || (cfg.databaseConnection ? [cfg.databaseConnection] : []);
  const sshConnections = cfg.sshConnections || [];
  const envVars = cfg.envVars || [];
  const containers = env.containers || [];
  const runningCount = containers.filter((c) => String(c.state).toLowerCase() === "running").length;

  const appsHtml = apps.length
    ? apps
        .map((a) => {
          const url = getAppPublicUrl(env, a);
          const ssh = sshConnections.find((s) => s.appId === a.id);
          const selected = state.detailAppId === a.id ? "selected" : "";
          return `<button type="button" class="app-row ${selected}" data-action="open-app" data-app-id="${escapeHtml(a.id)}">
            <span class="app-row-mark">${stackLogo(a.runtime)}</span>
            <span class="app-row-copy">
              <strong>${escapeHtml(a.name)}</strong>
              <small>${escapeHtml(a.subdomain || a.id)}</small>
            </span>
            <span class="app-row-meta">
              <span class="chip chip-stack">${stackLogo(a.runtime)} ${escapeHtml(LABELS.runtime[a.runtime] || a.runtime)}</span>
              ${ssh ? `<span class="chip chip-muted">SSH :${escapeHtml(ssh.hostPort)}</span>` : ""}
            </span>
            <span class="app-row-chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
            </span>
          </button>`;
        })
        .join("")
    : `<div class="service-empty">${iconApp()}<span>Nenhuma aplicação</span></div>`;

  const dbsHtml = dbs.length
    ? dbs
        .map((db) => {
          const conn =
            connections.find((c) => c.id === db.id) ||
            connections.find((c) => c.engine === db.engine) ||
            {};
          const family = dbFamily(db.engine);
          const typeClass = family === "redis" ? "redis" : "db";
          const hostPort = conn.hostPort ?? db.hostPort;
          return `<article class="detail-tile detail-tile-db">
            <div class="detail-tile-top">
              <span class="service-type ${typeClass}">${iconDb(db.engine)}</span>
              <div class="detail-tile-copy">
                <strong>${escapeHtml(db.name || db.id)}</strong>
                <small>${escapeHtml(LABELS.database[db.engine] || db.engine)}</small>
              </div>
              ${
                hostPort
                  ? `<span class="port-pill" title="Porta externa"><code>:${escapeHtml(hostPort)}</code></span>`
                  : ""
              }
            </div>
            <div class="conn-strip">
              <div><span>Host app</span><code>${escapeHtml(db.id)}</code></div>
              <div><span>Host local</span><code>127.0.0.1</code></div>
              <div><span>Porta</span><code>${escapeHtml(hostPort ?? "—")}</code></div>
            </div>
            <dl class="kv-list kv-compact">
              <dt>Database</dt><dd>${escapeHtml(conn.name ?? db.dbName ?? "—")}</dd>
              <dt>Usuário</dt><dd>${escapeHtml(conn.user ?? db.dbUser ?? "—")}</dd>
              <dt>Senha</dt><dd>${secretValue(conn.password ?? db.dbPassword, `${db.id}-password`)}</dd>
              ${
                family === "mysql"
                  ? `<dt>Root</dt><dd>${secretValue(conn.rootPassword ?? db.dbRootPassword, `${db.id}-root`)}</dd>`
                  : ""
              }
              <dt>URL app</dt><dd>${secretValue(conn.connectionUrl, `${db.id}-url`)}</dd>
              <dt>URL local</dt><dd>${secretValue(conn.externalUrl, `${db.id}-ext`)}</dd>
              ${
                conn.jdbcUrl
                  ? `<dt>JDBC</dt><dd>${secretValue(conn.jdbcUrl, `${db.id}-jdbc`)}</dd>`
                  : ""
              }
            </dl>
          </article>`;
        })
        .join("")
    : `<div class="service-empty">${iconDb("mysql")}<span>Nenhum banco neste ambiente</span></div>`;

  const containersHtml = containers.length
    ? containers
        .map((c) => {
          const st = containerStateClass(c.state);
          return `<div class="container-row">
            <span class="container-dot ${escapeHtml(st)}" aria-hidden="true"></span>
            <div class="container-copy">
              <strong>${escapeHtml(c.name)}</strong>
              <small>${escapeHtml(c.image)}</small>
            </div>
            <span class="badge ${escapeHtml(st)}">${escapeHtml(c.state)}</span>
            <span class="container-status muted">${escapeHtml(c.status)}</span>
          </div>`;
        })
        .join("")
    : `<div class="service-empty"><span>Nenhum container</span></div>`;

  const envRows = envVars.length
    ? envVars
        .map(
          (row) => `<tr>
            <td><code>${escapeHtml(row.key)}</code></td>
            <td>${secretValue(row.value, row.key)}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="muted">Nenhuma variável</td></tr>`;

  $("#detail-root").innerHTML = `
    <div class="detail-shell">
      <div class="detail-toolbar">
        <button type="button" class="btn btn-ghost" data-view="dashboard">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
          Ambientes
        </button>
        <div class="detail-toolbar-actions">
          <a class="btn btn-primary" href="${escapeHtml(env.publicUrl)}" target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>
            Abrir
          </a>
          <button type="button" class="btn btn-start" data-action="start" data-id="${escapeHtml(env.id)}" title="Iniciar">Iniciar</button>
          <button type="button" class="btn btn-stop" data-action="stop" data-id="${escapeHtml(env.id)}" title="Parar">Parar</button>
          <button type="button" class="btn btn-ghost" data-action="logs" data-id="${escapeHtml(env.id)}">Logs</button>
          <button type="button" class="btn btn-edit" data-action="edit" data-id="${escapeHtml(env.id)}">Editar</button>
          <button type="button" class="btn btn-danger" data-action="delete" data-id="${escapeHtml(env.id)}" data-name="${escapeHtml(env.name)}">Remover</button>
        </div>
      </div>

      <header class="detail-hero detail-hero-v2">
        <div class="detail-hero-main">
          <span class="env-avatar env-avatar-lg">${escapeHtml(initials(env.name))}</span>
          <div class="detail-hero-copy">
            <div class="detail-hero-title-row">
              <h2>${escapeHtml(env.name)}</h2>
              ${statusBadge(env.status)}
            </div>
            <p class="detail-hero-domain">
              <a href="${escapeHtml(env.publicUrl)}" target="_blank" rel="noreferrer">${escapeHtml(env.publicUrl)}</a>
            </p>
            <code class="env-id">${escapeHtml(env.id)}</code>
          </div>
        </div>
        <div class="detail-hero-stats">
          <div class="detail-stat">
            <span>Apps</span>
            <strong>${apps.length}</strong>
          </div>
          <div class="detail-stat">
            <span>Bancos</span>
            <strong>${dbs.length}</strong>
          </div>
          <div class="detail-stat">
            <span>Containers</span>
            <strong>${runningCount}<small>/${containers.length}</small></strong>
          </div>
        </div>
      </header>

      ${
        env.errorMessage
          ? `<div class="detail-alert" role="alert">${escapeHtml(env.errorMessage)}</div>`
          : ""
      }

      <div class="detail-meta-bar">
        <div><span>Criado</span><strong>${escapeHtml(formatDate(env.createdAt))}</strong></div>
        <div><span>Atualizado</span><strong>${escapeHtml(formatDate(env.updatedAt))}</strong></div>
        <div><span>Pasta</span><code>${escapeHtml(env.projectPath)}</code></div>
      </div>

      <section class="detail-section">
        <div class="detail-section-head">
          <div class="builder-title">
            <span class="builder-ico builder-ico-app">${iconApp()}</span>
            <div>
              <h3>Aplicações</h3>
              <small>${apps.length} serviço(s) · clique para ver detalhes</small>
            </div>
          </div>
        </div>
        <div class="app-list">${appsHtml}</div>
      </section>

      <section class="detail-section">
        <div class="detail-section-head">
          <div class="builder-title">
            <span class="builder-ico builder-ico-db">${iconDb("mysql")}</span>
            <div>
              <h3>Bancos de dados</h3>
              <small>Credenciais e portas publicadas</small>
            </div>
          </div>
        </div>
        <div class="detail-tiles detail-tiles-db">${dbsHtml}</div>
      </section>

      <div class="detail-grid detail-grid-v2">
        <section class="detail-card">
          <div class="detail-card-head">
            <div class="detail-card-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
              <div>
                <h3>Variáveis de ambiente</h3>
                <p>Injetadas nos containers de app</p>
              </div>
            </div>
          </div>
          <div class="detail-card-body">
            <table class="containers-table">
              <thead><tr><th>Chave</th><th>Valor</th></tr></thead>
              <tbody>${envRows}</tbody>
            </table>
          </div>
        </section>

        <section class="detail-card">
          <div class="detail-card-head">
            <div class="detail-card-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/></svg>
              <div>
                <h3>Containers</h3>
                <p>${runningCount} em execução de ${containers.length}</p>
              </div>
            </div>
          </div>
          <div class="detail-card-body detail-containers">
            ${containersHtml}
          </div>
        </section>
      </div>

      <div id="app-drawer-host" class="app-drawer-host hidden"></div>
    </div>
  `;

  renderAppDrawer();
}

async function openDetail(id) {
  state.detailId = id;
  state.detailAppId = null;
  state.detailAppTab = "overview";
  setView("detail");
  titles.detail = ["Ambiente", "Detalhes", id];
  $("#view-title").textContent = "Detalhes";
  $("#view-subtitle").textContent = id;
  $("#detail-root").innerHTML = `<p class="muted">Carregando ambiente…</p>`;

  try {
    const { data } = await api(`/environments/${id}`);
    state.detail = data;
    titles.detail = ["Ambiente", data.name, data.publicUrl];
    $("#view-title").textContent = data.name;
    $("#view-subtitle").textContent = data.publicUrl;
    renderDetail(data);
  } catch (ex) {
    $("#detail-root").innerHTML = `<p class="error" style="margin:0">${escapeHtml(ex.message)}</p>`;
  }
}

async function loadEnvironments() {
  const { data } = await api("/environments");
  state.environments = data;
  renderDashboard();
}

async function checkHealth() {
  try {
    await api("/health");
    $("#health-dot").className = "dot ok";
    $("#health-label").textContent = "API operacional";
  } catch {
    $("#health-dot").className = "dot err";
    $("#health-label").textContent = "API indisponível";
  }
}

async function provision(e) {
  e.preventDefault();
  const err = $("#wizard-error");
  err.classList.add("hidden");
  const payload = collectPayload("wiz");
  if (!payload.applications.length) {
    err.textContent = "Adicione ao menos uma aplicação";
    err.classList.remove("hidden");
    return;
  }
  $("#btn-provision").disabled = true;
  try {
    const { data } = await api("/environments", { method: "POST", body: JSON.stringify(payload) });
    toast(`Ambiente pronto: ${data.publicUrl}`);
    state.step = 1;
    $("#wizard-form").reset();
    resetWizardServices();
    updateWizardUI();
    await loadEnvironments();
    await openDetail(data.id);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  } finally {
    $("#btn-provision").disabled = false;
  }
}

async function openLogs(id) {
  state.logsId = id;
  setView("logs");
  $("#logs-title").textContent = `Logs · ${id}`;
  $("#logs-meta").textContent = "Últimas 300 linhas";
  $("#logs-output").textContent = "Carregando…";
  try {
    const { data } = await api(`/environments/${id}/logs?tail=300`);
    $("#logs-output").textContent = data.logs || "(sem saída)";
  } catch (ex) {
    $("#logs-output").textContent = ex.message;
  }
}

async function openEditModal(id) {
  const modal = $("#edit-modal");
  const err = $("#edit-error");
  if (!modal) {
    toast("Modal de edição não encontrada. Recarregue a página.");
    return;
  }

  err?.classList.add("hidden");
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("#edit-modal-title").textContent = "Carregando…";

  try {
    const { data } = await api(`/environments/${id}`);
    const cfg = data.config || {};
    const apps = data.applications || cfg.applications || [];
    const dbs = data.databases || cfg.databases || [];

    $("#edit-id").value = data.id;
    $("#edit-name").value = data.name;
    $("#edit-domain").value = data.domain;
    const editDomain = $("#edit-domain");
    if (editDomain) editDomain.dataset.manual = "1";

    const webservers = data.webservers || cfg.webservers || [];
    const behind = new Map();
    for (const ws of webservers) {
      for (const route of ws.routes || []) {
        if (route.appId) behind.set(route.appId, ws.engine || "nginx");
      }
    }

    state.editApps = apps.length
      ? apps.map((a) => ({
          ...a,
          runtime: a.runtime === "go" ? "go122" : a.runtime,
          webserver: a.webserver || behind.get(a.id) || "none",
          githubRepo: a.githubRepo || "",
        }))
      : [
          {
            id: "app",
            name: "app",
            subdomain: data.domain,
            runtime: data.runtime === "go" ? "go122" : data.runtime,
            webserver: data.webserver === "apache" || data.webserver === "nginx" ? data.webserver : "nginx",
            githubRepo: "",
          },
        ];

    state.editDbs = dbs.length
      ? dbs.map((d) => ({ ...d }))
      : data.database && data.database !== "none"
        ? [
            {
              id: "db",
              name: "db",
              engine: data.database,
              dbName: cfg.dbName || "app",
              dbUser: cfg.dbUser || "app",
              dbPassword: cfg.dbPassword || "",
              dbRootPassword: cfg.dbRootPassword || "",
              hostPort: cfg.databaseConnection?.hostPort,
            },
          ]
        : [];

    $("#edit-modal-title").textContent = `Editar · ${data.name}`;
    renderBuilder("edit");
  } catch (ex) {
    if (err) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    } else {
      toast(ex.message);
    }
  }
}

function closeEditModal() {
  $("#edit-modal")?.classList.add("hidden");
  $("#edit-error")?.classList.add("hidden");
  document.body.style.overflow = "";
}

async function handleEnvAction(action, id, name) {
  if (action === "open") {
    await openDetail(id);
    return;
  }
  if (action === "edit") {
    await openEditModal(id);
    return;
  }
  if (action === "close-modal") {
    closeEditModal();
    return;
  }
  if (action === "start") {
    await api(`/environments/${id}/start`, { method: "POST" });
    toast("Ambiente iniciado");
  }
  if (action === "stop") {
    await api(`/environments/${id}/stop`, { method: "POST" });
    toast("Ambiente parado");
  }
  if (action === "delete") {
    const ok = window.confirm(
      `Remover o ambiente "${name || id}"?\n\nIsso apaga containers, volumes, rota Traefik e a pasta do projeto.`
    );
    if (!ok) return;
    await api(`/environments/${id}`, { method: "DELETE" });
    toast("Ambiente removido");
    if (state.logsId === id) state.logsId = null;
    if (state.detailId === id) {
      state.detailId = null;
      state.detail = null;
      state.detailAppId = null;
      setView("dashboard");
    }
  }
  if (action === "logs") {
    await openLogs(id);
    return;
  }

  await loadEnvironments();
  if (state.view === "detail" && state.detailId) {
    await openDetail(state.detailId);
  }
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  const stackToggle = t.closest("[data-stack-toggle]");
  if (stackToggle instanceof HTMLElement) {
    const root = stackToggle.closest("[data-stack-select]");
    if (!root) return;
    const willOpen = !root.classList.contains("open");
    closeAllStackSelects(willOpen ? root : null);
    root.classList.toggle("open", willOpen);
    root.querySelector(".stack-select-menu")?.classList.toggle("hidden", !willOpen);
    stackToggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    return;
  }

  const stackOption = t.closest("[data-stack-option]");
  if (stackOption instanceof HTMLElement) {
    const root = stackOption.closest("[data-stack-select]");
    if (!root) return;
    const value = stackOption.dataset.stackOption || "";
    const field = root.dataset.f;
    const prefix = root.dataset.prefix;
    const kind = root.dataset.kind;
    const index = Number(root.dataset.index);
    setStackSelectValue(root, value);
    closeAllStackSelects();

    if (kind === "app" && prefix) {
      const lists = getBuilderLists(prefix);
      if (lists.apps[index]) lists.apps[index][field] = value;
      if (field === "runtime") {
        const type = root.closest(".service-card")?.querySelector(".stack-mark-wrap");
        if (type) type.innerHTML = stackLogo(value);
      }
    }
    if (kind === "db" && prefix && field === "engine") {
      syncBuilderFromDom(prefix);
      const lists = getBuilderLists(prefix);
      if (lists.dbs[index]) lists.dbs[index].engine = value;
      renderBuilder(prefix);
    }
    return;
  }

  if (!t.closest("[data-stack-select]")) {
    closeAllStackSelects();
  }

  const copyBtn = t.closest("[data-copy]");
  if (copyBtn instanceof HTMLElement) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.copy || "");
      toast("Copiado");
    } catch {
      toast("Não foi possível copiar");
    }
    return;
  }

  const copySshBtn = t.closest("[data-copy-ssh]");
  if (copySshBtn instanceof HTMLElement) {
    const appId = copySshBtn.dataset.copySsh;
    const ssh = (state.detail?.config?.sshConnections || []).find((s) => s.appId === appId);
    try {
      await navigator.clipboard.writeText(ssh?.publicKey || "");
      toast("Chave pública copiada");
    } catch {
      toast("Não foi possível copiar");
    }
    return;
  }

  const appTabBtn = t.closest("[data-app-tab]");
  if (appTabBtn instanceof HTMLElement && state.detailAppId) {
    state.detailAppTab = appTabBtn.dataset.appTab || "overview";
    renderAppDrawer();
    return;
  }

  const openAppBtn = t.closest("[data-action=open-app]");
  if (openAppBtn instanceof HTMLElement) {
    openAppDrawer(openAppBtn.dataset.appId || "");
    return;
  }

  if (t.closest("[data-action=close-app-drawer]")) {
    closeAppDrawer();
    return;
  }

  const removeBtn = t.closest("[data-builder-remove]");
  if (removeBtn instanceof HTMLElement) {
    const prefix = removeBtn.dataset.prefix;
    const kind = removeBtn.dataset.builderRemove;
    const index = Number(removeBtn.dataset.index);
    syncBuilderFromDom(prefix);
    const lists = getBuilderLists(prefix);
    if (kind === "app") {
      if (lists.apps.length <= 1) return toast("Mantenha ao menos uma aplicação");
      lists.apps.splice(index, 1);
    } else {
      lists.dbs.splice(index, 1);
    }
    renderBuilder(prefix);
    return;
  }

  if (t.closest("#btn-add-app") || t.id === "btn-add-app") {
    syncBuilderFromDom("wiz");
    const domain = normalizeDomain($("#wiz-domain")?.value || "app.localhost");
    state.wizApps.push(defaultApp(domain, state.wizApps.length));
    renderBuilder("wiz");
    return;
  }
  if (t.closest("#btn-add-db") || t.id === "btn-add-db") {
    syncBuilderFromDom("wiz");
    state.wizDbs.push(defaultDb(state.wizDbs.length));
    renderBuilder("wiz");
    return;
  }
  if (t.closest("#edit-add-app") || t.id === "edit-add-app") {
    syncBuilderFromDom("edit");
    const domain = normalizeDomain($("#edit-domain")?.value || "app.localhost");
    state.editApps.push(defaultApp(domain, state.editApps.length));
    renderBuilder("edit");
    return;
  }
  if (t.closest("#edit-add-db") || t.id === "edit-add-db") {
    syncBuilderFromDom("edit");
    state.editDbs.push(defaultDb(state.editDbs.length));
    renderBuilder("edit");
    return;
  }

  const trigger =
    t.closest("button[data-action], [data-action]:not(tr)") ||
    t.closest("[data-view]") ||
    t.closest("button") ||
    t.closest("tr.env-row");
  if (!(trigger instanceof HTMLElement)) return;

  if (trigger.dataset.view) {
    if (trigger.dataset.view === "wizard") {
      state.step = 1;
      resetWizardServices();
      const domainInput = $("#wiz-domain");
      if (domainInput) domainInput.dataset.manual = "0";
      updateWizardUI();
      syncDomainFromName({ force: true });
    }
    if (trigger.dataset.view !== "detail") {
      closeAppDrawer();
    }
    setView(trigger.dataset.view);
    return;
  }

  if (trigger.id === "btn-refresh") {
    await loadEnvironments();
    toast("Lista atualizada");
    return;
  }

  if (trigger.id === "btn-next") {
    if (state.step === 1) {
      const name = String($("#wiz-name")?.value || "").trim();
      syncDomainFromName();
      const domain = ensureLocalhostDomain($("#wiz-domain")?.value);
      if (domain) $("#wiz-domain").value = domain;
      if (!name || !domain) return toast("Preencha nome e domínio");
      if (!state.wizApps.length) resetWizardServices();
      else if (state.wizApps[0]) {
        state.wizApps[0].subdomain = domain;
      }
    }
    if (state.step === 2) {
      const payload = collectPayload("wiz");
      if (!payload.applications.length) return toast("Adicione ao menos uma aplicação");
      for (const db of payload.databases) {
        if (dbFamily(db.engine) === "mysql" || dbFamily(db.engine) === "postgres") {
          if (!db.dbName || !db.dbUser || !db.dbPassword) {
            return toast(`Preencha credenciais do banco ${db.id}`);
          }
        }
      }
    }
    state.step = Math.min(3, state.step + 1);
    updateWizardUI();
    return;
  }

  if (trigger.id === "btn-prev") {
    state.step = Math.max(1, state.step - 1);
    updateWizardUI();
    return;
  }

  if (trigger.id === "btn-refresh-logs" && state.logsId) {
    await openLogs(state.logsId);
    return;
  }

  const action = trigger.dataset.action;
  if (action === "close-modal") {
    closeEditModal();
    return;
  }

  const id = trigger.dataset.id;
  if (!action || !id) return;

  try {
    await handleEnvAction(action, id, trigger.dataset.name);
  } catch (ex) {
    toast(ex.message);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAllStackSelects();
    if (state.detailAppId) closeAppDrawer();
  }
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.id === "wiz-name") {
    syncDomainFromName();
    return;
  }
  if (t.id === "wiz-domain") {
    t.dataset.manual = "1";
    updateWizardPreview();
  }
  if (t.id === "edit-name") {
    const domainInput = $("#edit-domain");
    if (domainInput && domainInput.dataset.manual !== "1") {
      domainInput.value = domainFromProjectName(t.value);
    }
  }
  if (t.id === "edit-domain") {
    t.dataset.manual = "1";
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.id === "wiz-domain" || t.id === "edit-domain") {
    const next = ensureLocalhostDomain(t.value);
    if (next) t.value = next;
    if (t.id === "wiz-domain") updateWizardPreview();
  }
  if (t.dataset.f === "engine" && t.dataset.kind === "db" && t.tagName === "SELECT") {
    const prefix = t.dataset.prefix;
    syncBuilderFromDom(prefix);
    renderBuilder(prefix);
  }
});

document.addEventListener("blur", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.id === "wiz-domain" || t.id === "edit-domain") {
    const next = ensureLocalhostDomain(t.value);
    if (next) t.value = next;
    if (t.id === "wiz-domain") updateWizardPreview();
  }
}, true);

$("#wizard-form").addEventListener("submit", provision);

$("#edit-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#edit-error");
  err.classList.add("hidden");
  const id = $("#edit-id").value;
  const payload = collectPayload("edit");
  if (!payload.applications.length) {
    err.textContent = "Adicione ao menos uma aplicação";
    err.classList.remove("hidden");
    return;
  }
  const submit = $("#edit-submit");
  submit.disabled = true;
  submit.textContent = "Recriando stack…";
  try {
    const { data } = await api(`/environments/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    toast("Ambiente atualizado");
    closeEditModal();
    await loadEnvironments();
    if (state.view === "detail" || state.detailId === id) {
      await openDetail(data.id);
    }
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  } finally {
    submit.disabled = false;
    submit.textContent = "Salvar e recriar stack";
  }
});

(async function init() {
  resetWizardServices();
  updateWizardUI();
  setView("dashboard");
  await checkHealth();
  try {
    await loadEnvironments();
  } catch (ex) {
    toast(ex.message);
  }
})();
