/* Logique du panel Palworld : statut, actions, console SSE, config, backups. */
"use strict";

const $ = (sel) => document.querySelector(sel);

let consoleSource = null;
let configLoaded = false;
let configMeta = {}; // clé -> { quoted: bool }

// ------------------------------------------------------------------ helpers
async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && typeof opts.body === "object") {
    opts.body = JSON.stringify(opts.body);
    opts.headers["Content-Type"] = "application/json";
    opts.method = opts.method || "POST";
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    window.location = "/login";
    throw new Error("Session expirée");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return "–";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function formatSize(bytes) {
  if (bytes > 1024 * 1024 * 1024) return (bytes / 1024 ** 3).toFixed(2) + " Go";
  if (bytes > 1024 * 1024) return (bytes / 1024 ** 2).toFixed(1) + " Mo";
  return Math.round(bytes / 1024) + " Ko";
}

// ------------------------------------------------------------------- statut
function renderStatus(status) {
  const pill = $("#status-pill");
  const running = status.service === "active";
  if (running && status.api_ok) {
    pill.textContent = "● En ligne";
    pill.className = "pill online";
  } else if (running || status.service === "activating") {
    pill.textContent = "● Démarrage…";
    pill.className = "pill starting";
  } else {
    pill.textContent = "● Hors ligne";
    pill.className = "pill offline";
  }

  const taskPill = $("#task-pill");
  if (status.task) {
    taskPill.textContent = status.task === "update" ? "Mise à jour en cours…" : "Sauvegarde en cours…";
    taskPill.classList.remove("hidden");
  } else {
    taskPill.classList.add("hidden");
  }

  const metrics = status.metrics || {};
  const info = status.info || {};
  $("#server-name").textContent = info.servername || "—";
  $("#stat-players").textContent =
    metrics.currentplayernum != null ? `${metrics.currentplayernum} / ${metrics.maxplayernum}` : "–";
  $("#stat-fps").textContent = metrics.serverfps != null ? metrics.serverfps : "–";
  $("#stat-uptime").textContent = status.api_ok ? formatUptime(metrics.uptime) : "–";
  $("#stat-version").textContent = info.version || "–";

  renderPlayers(status.players || []);
}

function renderPlayers(players) {
  const tbody = $("#players-table tbody");
  if (!players.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Aucun joueur connecté</td></tr>';
    return;
  }
  tbody.innerHTML = players
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.name || "?")}</td>
        <td><code>${escapeHtml(p.userId || p.playerId || "?")}</code></td>
        <td>${p.level ?? "–"}</td>
        <td>${p.ping != null ? Math.round(p.ping) + " ms" : "–"}</td>
        <td>
          <button class="btn small warn" data-player-action="kick" data-userid="${escapeHtml(p.userId || "")}">Kick</button>
          <button class="btn small danger" data-player-action="ban" data-userid="${escapeHtml(p.userId || "")}">Ban</button>
        </td>
      </tr>`
    )
    .join("");
}

async function refreshStatus() {
  try {
    renderStatus(await api("/api/status"));
  } catch (err) {
    /* panel injoignable : on garde le dernier état affiché */
  }
}

// ------------------------------------------------------------------ actions
const CONFIRMATIONS = {
  stop: "Arrêter le serveur ? Le monde sera sauvegardé avant l'arrêt.",
  restart: "Redémarrer le serveur ? Le monde sera sauvegardé avant.",
  update: "Mettre à jour le serveur ? Il sera arrêté pendant la mise à jour SteamCMD.",
};

async function doAction(action) {
  if (CONFIRMATIONS[action] && !confirm(CONFIRMATIONS[action])) return;
  try {
    await api("/api/action", { body: { action } });
    const labels = {
      start: "Démarrage demandé.",
      stop: "Arrêt demandé.",
      restart: "Redémarrage demandé.",
      save: "Monde sauvegardé.",
      update: "Mise à jour lancée (suivez la progression dans la console).",
      backup: "Sauvegarde lancée.",
    };
    toast(labels[action] || "OK");
    setTimeout(refreshStatus, 1500);
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------------------------------------------ console
function startConsole() {
  if (consoleSource) return;
  const output = $("#console");
  consoleSource = new EventSource("/api/console");
  consoleSource.onmessage = (event) => {
    const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 60;
    output.textContent += JSON.parse(event.data) + "\n";
    const lines = output.textContent.split("\n");
    if (lines.length > 1200) output.textContent = lines.slice(-1000).join("\n");
    if (nearBottom) output.scrollTop = output.scrollHeight;
  };
}

// ------------------------------------------------------------- configuration
function inputForSetting(key, rawValue) {
  const quoted = /^".*"$/.test(rawValue);
  configMeta[key] = { quoted };
  if (rawValue === "True" || rawValue === "False") {
    return `<select data-key="${key}">
      <option value="True" ${rawValue === "True" ? "selected" : ""}>True</option>
      <option value="False" ${rawValue === "False" ? "selected" : ""}>False</option>
    </select>`;
  }
  if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
    return `<input type="number" step="any" data-key="${key}" value="${rawValue}">`;
  }
  const display = quoted ? rawValue.slice(1, -1) : rawValue;
  return `<input type="text" data-key="${key}" value="${escapeHtml(display)}">`;
}

async function loadConfig() {
  try {
    const data = await api("/api/config");
    configMeta = {};
    const rows = Object.entries(data.settings)
      .map(([key, value]) => `<tr data-setting="${key.toLowerCase()}">
          <td>${key}</td>
          <td>${inputForSetting(key, value)}</td>
        </tr>`)
      .join("");
    $("#config-table tbody").innerHTML =
      rows || '<tr><td class="muted">Configuration introuvable — le serveur a-t-il été installé ?</td></tr>';
    $("#config-table").querySelectorAll("input, select").forEach((el) => {
      el.addEventListener("input", () => el.classList.add("changed"));
    });
    configLoaded = true;
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveConfig() {
  const settings = {};
  $("#config-table").querySelectorAll("input, select").forEach((el) => {
    const key = el.dataset.key;
    let value = String(el.value);
    if (configMeta[key] && configMeta[key].quoted) {
      value = '"' + value.replace(/"/g, "") + '"';
    }
    settings[key] = value;
  });
  try {
    await api("/api/config", { body: { settings } });
    $("#config-table").querySelectorAll(".changed").forEach((el) => el.classList.remove("changed"));
    toast("Configuration enregistrée. Redémarrez le serveur pour l'appliquer.");
  } catch (err) {
    toast(err.message, true);
  }
}

function filterConfig(query) {
  const needle = query.trim().toLowerCase();
  $("#config-table tbody").querySelectorAll("tr[data-setting]").forEach((row) => {
    row.style.display = row.dataset.setting.includes(needle) ? "" : "none";
  });
}

// ---------------------------------------------------------------- backups
async function loadBackups() {
  try {
    const data = await api("/api/backups");
    const tbody = $("#backups-table tbody");
    if (!data.backups.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">Aucune sauvegarde pour le moment</td></tr>';
      return;
    }
    tbody.innerHTML = data.backups
      .map(
        (b) => `<tr>
          <td><code>${escapeHtml(b.name)}</code></td>
          <td>${formatSize(b.size)}</td>
          <td>${new Date(b.mtime * 1000).toLocaleString("fr-FR")}</td>
          <td><a class="btn small" href="/api/backups/${encodeURIComponent(b.name)}/download">Télécharger</a></td>
        </tr>`
      )
      .join("");
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------- onglets
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-page").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "console") startConsole();
  if (name === "config" && !configLoaded) loadConfig();
  if (name === "backups") loadBackups();
}

// ------------------------------------------------------------------- init
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });

  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => doAction(btn.dataset.action));
  });

  $("#announce-btn").addEventListener("click", async () => {
    const input = $("#announce-input");
    if (!input.value.trim()) return;
    try {
      await api("/api/announce", { body: { message: input.value.trim() } });
      toast("Annonce envoyée.");
      input.value = "";
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#announce-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#announce-btn").click();
  });

  $("#players-table").addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-player-action]");
    if (!btn) return;
    const action = btn.dataset.playerAction;
    const userid = btn.dataset.userid;
    if (!userid) return toast("Identifiant joueur introuvable.", true);
    if (!confirm(`${action === "kick" ? "Expulser" : "Bannir"} ce joueur ?`)) return;
    try {
      await api(`/api/players/${action}`, { body: { userid } });
      toast(action === "kick" ? "Joueur expulsé." : "Joueur banni.");
      setTimeout(refreshStatus, 1000);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#console-clear").addEventListener("click", () => ($("#console").textContent = ""));
  $("#config-save").addEventListener("click", saveConfig);
  $("#config-search").addEventListener("input", (e) => filterConfig(e.target.value));
  $("#backup-create").addEventListener("click", async () => {
    await doAction("backup");
    setTimeout(loadBackups, 4000);
  });

  refreshStatus();
  setInterval(refreshStatus, 5000);
});
