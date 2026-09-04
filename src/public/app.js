const state = {
  view: "dashboard",
  step: 1,
  environments: [],
  logsId: null,
};

const titles = {
  dashboard: ["Ambientes", "Gerencie stacks Docker isoladas"],
  wizard: ["Novo Ambiente", "Wizard de provisionamento em 5 passos"],
  logs: ["Logs", "Saída dos containers do ambiente"],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2800);
}

function setView(view) {
  state.view = view;
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $(`#view-${view}`)?.classList.remove("hidden");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const [title, subtitle] = titles[view] || titles.dashboard;
  $("#view-title").textContent = title;
  $("#view-subtitle").textContent = subtitle;
}

function statusBadge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

function renderDashboard() {
  const grid = $("#env-grid");
  const empty = $("#empty-state");
  if (!state.environments.length) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  grid.innerHTML = state.environments
    .map(
      (env) => `
      <article class="card">
        <div class="card-head">
          <div>
            <h3>${escapeHtml(env.name)}</h3>
            <div class="meta">${escapeHtml(env.id)}</div>
          </div>
          ${statusBadge(env.status)}
        </div>
        <div class="meta">URL: <a href="${escapeHtml(env.publicUrl)}" target="_blank" rel="noreferrer">${escapeHtml(env.publicUrl)}</a></div>
        <div class="meta">${escapeHtml(env.webserver)} · ${escapeHtml(env.runtime)} · ${escapeHtml(env.database)}</div>
        <div class="card-actions">
          <button class="btn btn-ghost" data-action="start" data-id="${env.id}">Iniciar</button>
          <button class="btn btn-ghost" data-action="stop" data-id="${env.id}">Parar</button>
          <button class="btn btn-primary" data-action="logs" data-id="${env.id}">Ver Logs</button>
        </div>
      </article>`
    )
    .join("");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
    $("#health-label").textContent = "API online";
  } catch {
    $("#health-dot").className = "dot err";
    $("#health-label").textContent = "API offline";
  }
}

function updateWizardUI() {
  $$(".step").forEach((s) => s.classList.toggle("active", Number(s.dataset.step) === state.step));
  $$(".panel").forEach((p) => p.classList.toggle("hidden", Number(p.dataset.panel) !== state.step));
  $("#btn-prev").disabled = state.step === 1;
  $("#btn-next").classList.toggle("hidden", state.step === 5);
  $("#btn-provision").classList.toggle("hidden", state.step !== 5);
  if (state.step === 5) renderSummary();
}

function formData() {
  const fd = new FormData($("#wizard-form"));
  return {
    name: String(fd.get("name") || "").trim(),
    domain: String(fd.get("domain") || "").trim().toLowerCase(),
    webserver: String(fd.get("webserver")),
    runtime: String(fd.get("runtime")),
    database: String(fd.get("database")),
  };
}

function renderSummary() {
  const d = formData();
  $("#summary").innerHTML = `
    <div><strong>Projeto:</strong> ${escapeHtml(d.name)}</div>
    <div><strong>Domínio:</strong> ${escapeHtml(d.domain)}</div>
    <div><strong>Webserver:</strong> ${escapeHtml(d.webserver)}</div>
    <div><strong>Runtime:</strong> ${escapeHtml(d.runtime)}</div>
    <div><strong>Database:</strong> ${escapeHtml(d.database)}</div>
  `;
}

async function provision(e) {
  e.preventDefault();
  const err = $("#wizard-error");
  err.classList.add("hidden");
  const payload = formData();
  $("#btn-provision").disabled = true;
  try {
    await api("/environments", { method: "POST", body: JSON.stringify(payload) });
    toast("Ambiente provisionado");
    state.step = 1;
    $("#wizard-form").reset();
    updateWizardUI();
    await loadEnvironments();
    setView("dashboard");
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
  $("#logs-output").textContent = "Carregando...";
  try {
    const { data } = await api(`/environments/${id}/logs?tail=300`);
    $("#logs-output").textContent = data.logs || "(vazio)";
  } catch (ex) {
    $("#logs-output").textContent = ex.message;
  }
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  if (t.dataset.view) {
    if (t.dataset.view === "wizard") {
      state.step = 1;
      updateWizardUI();
    }
    setView(t.dataset.view);
  }

  if (t.id === "btn-refresh") {
    await loadEnvironments();
    toast("Lista atualizada");
  }

  if (t.id === "btn-next") {
    if (state.step === 1) {
      const d = formData();
      if (!d.name || !d.domain) return toast("Preencha nome e domínio");
    }
    state.step = Math.min(5, state.step + 1);
    updateWizardUI();
  }

  if (t.id === "btn-prev") {
    state.step = Math.max(1, state.step - 1);
    updateWizardUI();
  }

  if (t.id === "btn-refresh-logs" && state.logsId) {
    await openLogs(state.logsId);
  }

  const action = t.dataset.action;
  const id = t.dataset.id;
  if (!action || !id) return;

  try {
    if (action === "start") {
      await api(`/environments/${id}/start`, { method: "POST" });
      toast("Ambiente iniciado");
      await loadEnvironments();
    }
    if (action === "stop") {
      await api(`/environments/${id}/stop`, { method: "POST" });
      toast("Ambiente parado");
      await loadEnvironments();
    }
    if (action === "logs") await openLogs(id);
  } catch (ex) {
    toast(ex.message);
  }
});

$("#wizard-form").addEventListener("submit", provision);

(async function init() {
  updateWizardUI();
  setView("dashboard");
  await checkHealth();
  try {
    await loadEnvironments();
  } catch (ex) {
    toast(ex.message);
  }
})();
