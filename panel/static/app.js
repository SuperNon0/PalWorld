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

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
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
  const TASK_LABELS = {
    update: "Mise à jour serveur…",
    "update-panel": "Mise à jour panel…",
    backup: "Sauvegarde en cours…",
    restore: "Restauration en cours…",
    tunnel: "Installation du tunnel…",
  };
  if (status.task) {
    taskPill.textContent = TASK_LABELS[status.task] || "Tâche en cours…";
    taskPill.classList.remove("hidden");
  } else {
    taskPill.classList.add("hidden");
  }

  renderNotifications(status.notifications);

  const metrics = status.metrics || {};
  const info = status.info || {};
  $("#server-name").textContent = info.servername || "—";
  $("#stat-players").textContent =
    metrics.currentplayernum != null ? `${metrics.currentplayernum} / ${metrics.maxplayernum}` : "–";
  $("#stat-fps").textContent = metrics.serverfps != null ? metrics.serverfps : "–";
  $("#stat-uptime").textContent = status.api_ok ? formatUptime(metrics.uptime) : "–";
  $("#stat-version").textContent = info.version || "–";

  const sys = status.system || {};
  $("#stat-ram").textContent = sys.mem_total
    ? `${(sys.mem_used / 1e9).toFixed(1)} / ${(sys.mem_total / 1e9).toFixed(1)} Go`
    : "–";
  $("#stat-disk").textContent = sys.disk_free != null ? formatSize(sys.disk_free) : "–";

  const port = status.game_port || 8211;
  const ipEl = $("#server-ip");
  if (sys.ip) {
    ipEl.textContent = sys.ip;
    ipEl.dataset.copy = sys.ip;
    ipEl.classList.remove("hidden");
    $("#stat-addr").textContent = `${sys.ip}:${port}`;
    $("#card-addr").dataset.copy = `${sys.ip}:${port}`;
  } else {
    ipEl.classList.add("hidden");
    $("#stat-addr").textContent = "–";
  }

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

// ------------------------------------------------------------ notifications
function renderNotifications(notes) {
  notes = notes || [];
  const count = $("#bell-count");
  const menu = $("#bell-menu");
  if (!notes.length) {
    count.classList.add("hidden");
    menu.innerHTML = '<div class="bell-empty muted">Aucune notification</div>';
    return;
  }
  count.textContent = notes.length;
  count.classList.remove("hidden");
  menu.innerHTML = notes
    .map((n) => {
      const cls = { warn: "warn", danger: "danger", info: "info" }[n.level] || "info";
      const btn = n.action
        ? `<button class="btn small" data-notif-action="${escapeHtml(n.action)}">Traiter</button>`
        : "";
      return `<div class="bell-item ${cls}"><span>${escapeHtml(n.text)}</span>${btn}</div>`;
    })
    .join("");
}

// ------------------------------------------------------------------ actions
const CONFIRMATIONS = {
  stop: "Arrêter le serveur ? Le monde sera sauvegardé avant l'arrêt.",
  restart: "Redémarrer le serveur ? Le monde sera sauvegardé avant.",
  update: "Mettre à jour le serveur ? Il sera arrêté pendant la mise à jour SteamCMD.",
  "update-panel": "Mettre à jour le panel depuis GitHub ? Le panel va redémarrer (bref instant d'indisponibilité).",
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
      update: "Mise à jour du serveur lancée (suivez la console).",
      backup: "Sauvegarde lancée.",
      "update-panel": "Mise à jour du panel lancée, il va redémarrer…",
    };
    toast(labels[action] || "OK");
    if (action === "update-panel") {
      // le panel redémarre : on recharge la page après quelques secondes
      setTimeout(() => window.location.reload(), 8000);
    } else {
      setTimeout(refreshStatus, 1500);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// --------------------------------------------------------------- tunnel playit
async function loadTunnel() {
  try {
    const t = await api("/api/tunnel");
    const pill = $("#tunnel-pill");
    const installBlock = $("#tunnel-install-block");
    const manageBlock = $("#tunnel-manage-block");
    if (!t.installed) {
      pill.textContent = "Non installé";
      pill.className = "pill offline";
      installBlock.classList.remove("hidden");
      manageBlock.classList.add("hidden");
      return;
    }
    installBlock.classList.add("hidden");
    manageBlock.classList.remove("hidden");
    const active = t.active === "active";
    pill.textContent = active ? "● Actif" : "○ Arrêté";
    pill.className = "pill " + (active ? "online" : "starting");
    const claim = $("#tunnel-claim");
    if (t.claim_url) {
      $("#tunnel-claim-link").href = t.claim_url;
      claim.classList.remove("hidden");
    } else {
      claim.classList.add("hidden");
    }
  } catch (err) {
    /* onglet inactif ou panel occupé */
  }
}

async function tunnelInstall() {
  if (!confirm("Installer l'agent playit.gg sur cette machine ? (installation en root, une seule fois)")) return;
  try {
    await api("/api/tunnel/install", { method: "POST" });
    toast("Installation du tunnel lancée (30 s à 1 min)…");
    setTimeout(loadTunnel, 5000);
    setTimeout(loadTunnel, 20000);
  } catch (err) {
    toast(err.message, true);
  }
}

async function tunnelAction(action) {
  try {
    await api(`/api/tunnel/${action}`, { method: "POST" });
    toast("Tunnel : " + action);
    setTimeout(loadTunnel, 1200);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------- maintenance
function fmtBuild(b) {
  return b ? `#${b}` : "inconnu";
}

async function loadMaintenance() {
  try {
    const s = await api("/api/scheduler");
    $("#server-build-info").textContent =
      `Build installé : ${fmtBuild(s.server_local_build)}` +
      (s.server_latest_build ? ` · dernier disponible : ${fmtBuild(s.server_latest_build)}` : "");
    const sState = $("#server-update-state");
    if (s.server_update_available) {
      sState.textContent = "⬆ Mise à jour disponible";
      sState.className = "update-state avail";
    } else if (s.server_local_build) {
      sState.textContent = "✓ À jour";
      sState.className = "update-state ok";
    } else {
      sState.textContent = "—";
      sState.className = "update-state";
    }
    const pState = $("#panel-update-state");
    if (s.panel_update_available) {
      pState.textContent = "⬆ Mise à jour disponible sur GitHub";
      pState.className = "update-state avail";
    } else {
      pState.textContent = "✓ À jour";
      pState.className = "update-state ok";
    }
  } catch (err) {
    /* silencieux */
  }
}

async function checkUpdates() {
  toast("Vérification des mises à jour…");
  try {
    await api("/api/check-updates", { method: "POST" });
    loadMaintenance();
    refreshStatus();
    toast("Vérification terminée.");
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
    } else if (value.trim() === "") {
      return; // champ numérique/énuméré vidé : on ne touche pas à la valeur existante
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
          <td class="backup-actions">
            <a class="btn small" href="/api/backups/${encodeURIComponent(b.name)}/download">Télécharger</a>
            <button class="btn small warn" data-backup-restore="${escapeHtml(b.name)}">Restaurer</button>
            <button class="btn small danger" data-backup-delete="${escapeHtml(b.name)}">Supprimer</button>
          </td>
        </tr>`
      )
      .join("");
  } catch (err) {
    toast(err.message, true);
  }
}

async function restoreBackup(name) {
  const warning =
    `Restaurer la sauvegarde ${name} ?\n\n` +
    "• Le serveur sera arrêté puis redémarré.\n" +
    "• Le monde ACTUEL sera d'abord archivé (sauvegarde de sécurité).\n" +
    "• Il sera ensuite remplacé par le contenu de cette sauvegarde.";
  if (!confirm(warning)) return;
  try {
    await api(`/api/backups/${encodeURIComponent(name)}/restore`, { method: "POST" });
    toast("Restauration lancée (suivez la progression dans la console).");
    setTimeout(refreshStatus, 1500);
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteBackup(name) {
  if (!confirm(`Supprimer définitivement la sauvegarde ${name} ?`)) return;
  try {
    await api(`/api/backups/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast("Sauvegarde supprimée.");
    loadBackups();
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------------------------------------ automatisation
async function loadScheduler() {
  try {
    const s = await api("/api/scheduler");
    $("#auto-restart-enabled").checked = !!s.auto_restart_enabled;
    $("#auto-restart-time").value = s.auto_restart_time || "05:00";
    $("#auto-backup-enabled").checked = !!s.auto_backup_enabled;
    $("#auto-backup-interval").value = s.auto_backup_interval_hours ?? 24;
    $("#auto-backup-keep").value = s.auto_backup_keep ?? 14;
  } catch (err) {
    /* panel injoignable : on laisse les valeurs par défaut */
  }
}

async function saveScheduler() {
  try {
    await api("/api/scheduler", {
      body: {
        auto_restart_enabled: $("#auto-restart-enabled").checked,
        auto_restart_time: $("#auto-restart-time").value,
        auto_backup_enabled: $("#auto-backup-enabled").checked,
        auto_backup_interval_hours: parseFloat($("#auto-backup-interval").value),
        auto_backup_keep: parseInt($("#auto-backup-keep").value, 10),
      },
    });
    toast("Automatisation enregistrée.");
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------------------------------------- historique
const chartState = new Map();

function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function loadHistory() {
  try {
    const data = await api("/api/history");
    drawCharts(data.history);
  } catch (err) {
    /* silencieux : le tableau de bord reste utilisable sans historique */
  }
}

function drawCharts(history) {
  drawChart($("#chart-players"), history, (e) => e.players, {
    color: themeColor("--accent"), nowEl: "#now-players", fmt: (v) => String(Math.round(v)),
  });
  drawChart($("#chart-fps"), history, (e) => e.fps, {
    color: themeColor("--green"), nowEl: "#now-fps", fmt: (v) => String(Math.round(v)),
  });
  drawChart($("#chart-mem"), history, (e) => (e.mem != null ? e.mem / 1e9 : null), {
    color: themeColor("--orange"), nowEl: "#now-mem", fmt: (v) => v.toFixed(1) + " Go",
  });
}

function drawChart(canvas, history, getValue, opts) {
  const points = history
    .map((e) => ({ t: e.t, v: getValue(e) }))
    .filter((p) => p.v != null && !Number.isNaN(p.v));
  chartState.set(canvas, { points, opts });
  renderChart(canvas, null);
  const last = points[points.length - 1];
  if (opts.nowEl) $(opts.nowEl).textContent = last ? opts.fmt(last.v) : "–";
}

function renderChart(canvas, hoverX) {
  const state = chartState.get(canvas);
  if (!state) return;
  const { points, opts } = state;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const muted = themeColor("--muted");
  const border = themeColor("--border");
  const padL = 40, padR = 8, padT = 10, padB = 16;
  if (points.length < 2) {
    ctx.fillStyle = muted;
    ctx.font = "12px sans-serif";
    ctx.fillText("Pas encore assez de données (1 point/min)…", padL, h / 2);
    return;
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const vmax = Math.max(...points.map((p) => p.v)) * 1.15 || 1;
  const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
  const y = (v) => padT + (1 - v / vmax) * (h - padT - padB);
  const fmtTime = (t) =>
    new Date(t * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  // grille discrète + graduations en encre neutre
  ctx.strokeStyle = border;
  ctx.fillStyle = muted;
  ctx.font = "10px sans-serif";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const v = (vmax * i) / 2;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.fillText(opts.fmt(v), 2, yy + 3);
  }
  ctx.fillText(fmtTime(t0), padL, h - 4);
  const endLabel = fmtTime(t1);
  ctx.fillText(endLabel, w - padR - ctx.measureText(endLabel).width, h - 4);

  // ligne fine + aire légère
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.lineTo(x(t1), y(0));
  ctx.lineTo(x(t0), y(0));
  ctx.closePath();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = opts.color;
  ctx.fill();
  ctx.globalAlpha = 1;

  // survol : point le plus proche + infobulle
  if (hoverX != null) {
    let best = points[0];
    for (const p of points) {
      if (Math.abs(x(p.t) - hoverX) < Math.abs(x(best.t) - hoverX)) best = p;
    }
    const bx = x(best.t);
    const by = y(best.v);
    ctx.strokeStyle = muted;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(bx, padT);
    ctx.lineTo(bx, h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = opts.color;
    ctx.beginPath();
    ctx.arc(bx, by, 3.5, 0, Math.PI * 2);
    ctx.fill();
    const label = `${fmtTime(best.t)} — ${opts.fmt(best.v)}`;
    ctx.font = "11px sans-serif";
    const tw = ctx.measureText(label).width + 12;
    const tx = Math.min(Math.max(bx - tw / 2, padL), w - padR - tw);
    ctx.fillStyle = themeColor("--bg-card");
    ctx.strokeStyle = border;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(tx, padT, tw, 18, 4);
    else ctx.rect(tx, padT, tw, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = themeColor("--text");
    ctx.fillText(label, tx + 6, padT + 13);
  }
}

// ---------------------------------------------------------------- onglets
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-page").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "console") startConsole();
  if (name === "config" && !configLoaded) loadConfig();
  if (name === "backups") loadBackups();
  if (name === "acces") loadTunnel();
  if (name === "maintenance") loadMaintenance();
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
    const defaultMsg = action === "kick" ? "Expulsé par un administrateur" : "Banni par un administrateur";
    const message = prompt(
      `${action === "kick" ? "Expulser" : "Bannir"} ce joueur — raison affichée en jeu :`,
      defaultMsg
    );
    if (message === null) return; // annulé
    try {
      await api(`/api/players/${action}`, { body: { userid, message: message.trim() } });
      toast(action === "kick" ? "Joueur expulsé." : "Joueur banni.");
      setTimeout(refreshStatus, 1000);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#unban-btn").addEventListener("click", async () => {
    const userid = $("#unban-input").value.trim();
    if (!userid) return;
    try {
      await api("/api/players/unban", { body: { userid } });
      toast("Joueur débanni.");
      $("#unban-input").value = "";
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#shutdown-btn").addEventListener("click", async () => {
    const minutes = parseInt($("#shutdown-minutes").value, 10);
    if (!minutes || minutes < 1 || minutes > 60) return toast("Délai invalide (1 à 60 min).", true);
    if (!confirm(`Programmer l'arrêt du serveur dans ${minutes} min ?`)) return;
    try {
      await api("/api/action", {
        body: { action: "shutdown", waittime: minutes * 60, message: $("#shutdown-message").value.trim() },
      });
      toast(`Arrêt programmé dans ${minutes} min.`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#pw-save").addEventListener("click", async () => {
    const current = $("#pw-current").value;
    const next = $("#pw-new").value;
    if (next !== $("#pw-confirm").value) return toast("La confirmation ne correspond pas.", true);
    try {
      await api("/api/panel-password", { body: { current, new: next } });
      toast("Mot de passe du panel modifié.");
      ["#pw-current", "#pw-new", "#pw-confirm"].forEach((sel) => ($(sel).value = ""));
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

  $("#backups-table").addEventListener("click", (event) => {
    const restoreBtn = event.target.closest("[data-backup-restore]");
    if (restoreBtn) return restoreBackup(restoreBtn.dataset.backupRestore);
    const deleteBtn = event.target.closest("[data-backup-delete]");
    if (deleteBtn) return deleteBackup(deleteBtn.dataset.backupDelete);
  });

  $("#scheduler-save").addEventListener("click", saveScheduler);

  // Tunnel playit.gg
  $("#tunnel-install").addEventListener("click", tunnelInstall);
  $("#tunnel-start").addEventListener("click", () => tunnelAction("start"));
  $("#tunnel-stop").addEventListener("click", () => tunnelAction("stop"));
  $("#tunnel-restart").addEventListener("click", () => tunnelAction("restart"));

  // Maintenance
  $("#check-updates").addEventListener("click", checkUpdates);

  // Copie de l'adresse / IP au clic
  const copyText = (text) => {
    if (!text) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast("Copié : " + text));
    } else {
      toast(text);
    }
  };
  $("#card-addr").addEventListener("click", (e) => copyText(e.currentTarget.dataset.copy));
  $("#server-ip").addEventListener("click", (e) => copyText(e.currentTarget.dataset.copy));

  // Cloche de notifications
  $("#bell").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#bell-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", () => $("#bell-menu").classList.add("hidden"));
  $("#bell-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = e.target.closest("[data-notif-action]");
    if (!btn) return;
    $("#bell-menu").classList.add("hidden");
    const action = btn.dataset.notifAction;
    if (action === "update-panel" || action === "update") doAction(action);
  });

  document.querySelectorAll(".chart canvas").forEach((canvas) => {
    canvas.addEventListener("mousemove", (event) => {
      const rect = canvas.getBoundingClientRect();
      renderChart(canvas, event.clientX - rect.left);
    });
    canvas.addEventListener("mouseleave", () => renderChart(canvas, null));
  });
  window.addEventListener("resize", () => {
    document.querySelectorAll(".chart canvas").forEach((canvas) => renderChart(canvas, null));
  });

  loadScheduler();
  loadHistory();
  setInterval(loadHistory, 60000);
  refreshStatus();
  setInterval(refreshStatus, 5000);
});
