/* Logique du panel Palworld : statut, actions, console SSE, config, backups. */
"use strict";

const $ = (sel) => document.querySelector(sel);

let consoleSource = null;
let configLoaded = false;
let configMeta = {}; // clé -> { quoted: bool }
let isAdmin = false; // renseigné par /api/status

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

// Copie dans le presse-papiers. L'API navigator.clipboard n'existe qu'en HTTPS
// ou sur localhost ; le panel étant servi en HTTP simple, on utilise en secours
// l'ancienne méthode execCommand (compatible HTTP).
function copyText(text) {
  if (!text) return;
  const ok = () => toast("Copié : " + text);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(ok, () => fallbackCopy(text, ok));
  } else {
    fallbackCopy(text, ok);
  }
}

function fallbackCopy(text, ok) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  let done = false;
  try {
    done = document.execCommand("copy");
  } catch (err) {
    done = false;
  }
  document.body.removeChild(area);
  done ? ok() : toast("Copie impossible — copie manuellement : " + text, true);
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

  const banner = $("#install-banner");
  if (banner) banner.classList.toggle("hidden", status.server_installed !== false);

  isAdmin = !!status.is_admin;  // panel mono-utilisateur : tous les onglets visibles

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

  const playit = (status.playit_address || "").trim();
  const playitCard = $("#card-playit");
  if (playit) {
    $("#stat-playit").textContent = playit;
    playitCard.dataset.copy = playit;
    playitCard.classList.remove("hidden");
  } else {
    playitCard.classList.add("hidden");
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

// ----------------------------------------- réglages de connexion — page Paramètres
async function loadSettingsInfo() {
  try {
    const d = await api("/api/info");
    $("#vmpw-user").value = d.ssh_user || "ubuntu";
    $("#vmpw-pass").value = d.vm_password || "";
    $("#cf-email").value = d.cf_access_email || "";
    $("#cf-login-state").textContent =
      d.login_via === "cloudflare"
        ? "✅ Tu es connecté automatiquement via Cloudflare (Google)."
        : "🔑 Connexion actuelle par mot de passe (accès direct / LAN).";
  } catch (err) {
    /* silencieux */
  }
}

async function saveVmPassword() {
  try {
    await api("/api/credentials", {
      body: { vm_user: $("#vmpw-user").value.trim(), vm_password: $("#vmpw-pass").value },
    });
    toast("Mot de passe système mis à jour (visible dans Infos).");
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveAdminPassword() {
  const password = $("#admin-pw").value;
  if (password.length < 8) return toast("8 caractères minimum.", true);
  try {
    await api("/api/admin-password", { body: { password } });
    $("#admin-pw").value = "";
    toast("Mot de passe du panel changé.");
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveCfAccess() {
  try {
    await api("/api/cf-access", { body: { email: $("#cf-email").value.trim() } });
    toast("Réglage de connexion Cloudflare enregistré.");
  } catch (err) {
    toast(err.message, true);
  }
}

// -------------------------- notifications Discord (botpanel) — page Paramètres
function currentNotifySlugs() {
  const slugs = {};
  document.querySelectorAll("#notify-table [data-notify-slug]").forEach((el) => {
    slugs[el.dataset.notifySlug] = el.value.trim();
  });
  return slugs;
}

async function loadNotifyConfig() {
  try {
    const c = await api("/api/notifications-config");
    $("#notify-enabled").checked = !!c.enabled;
    $("#notify-url").value = c.url || "";
    $("#notify-table tbody").innerHTML = (c.events || [])
      .map(
        (e) => `<tr>
          <td>${escapeHtml(e.label)}</td>
          <td><input type="text" class="grow" data-notify-slug="${escapeHtml(e.key)}" value="${escapeHtml(e.slug)}" placeholder="(désactivé)" autocomplete="off"></td>
          <td><button class="btn small" data-notify-test="${escapeHtml(e.key)}">Tester</button></td>
        </tr>`
      )
      .join("");
  } catch (err) {
    /* silencieux */
  }
}

async function saveNotifyConfig() {
  await api("/api/notifications-config", {
    body: { enabled: $("#notify-enabled").checked, url: $("#notify-url").value.trim(), slugs: currentNotifySlugs() },
  });
}

async function testNotify(key) {
  const input = $(`#notify-table [data-notify-slug="${key}"]`);
  const slug = input ? input.value.trim() : "";
  if (!slug) return toast("Renseigne d'abord un slug pour cet événement.", true);
  try {
    await saveNotifyConfig(); // l'URL doit être enregistrée avant le test
    const r = await api("/api/notifications-config/test", { body: { slug } });
    toast("Test envoyé ✓" + (r.detail ? " — " + r.detail : ""));
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------- Home Assistant (valeurs dynamiques) — Paramètres
async function loadHaConfig() {
  try {
    const c = await api("/api/ha-config");
    $("#ha-enabled").checked = !!c.enabled;
    $("#ha-url").value = c.url || "";
    $("#ha-token").value = c.token || "";
    $("#ha-entities-table tbody").innerHTML = (c.entities || [])
      .map((e) => `<tr><td><code>${escapeHtml(e.entity)}</code></td><td>${escapeHtml(e.label)}</td></tr>`)
      .join("");
  } catch (err) {
    /* silencieux */
  }
}

async function saveHaConfig() {
  await api("/api/ha-config", {
    body: { enabled: $("#ha-enabled").checked, url: $("#ha-url").value.trim(), token: $("#ha-token").value.trim() },
  });
}

async function testHa() {
  try {
    await saveHaConfig(); // l'URL et le jeton doivent être enregistrés avant le test
    const r = await api("/api/ha-config/test", { method: "POST" });
    toast("Home Assistant OK ✓ — capteurs publiés : " + (r.entities || []).join(", "));
  } catch (err) {
    toast(err.message, true);
  }
}

// ----------------------------- adresse publique du tunnel — onglet Accès/Tunnel
async function loadPlayit() {
  try {
    const s = await api("/api/status");
    $("#playit-addr").value = s.playit_address || "";
  } catch (err) {
    /* silencieux */
  }
}

async function savePlayit() {
  try {
    await api("/api/playit", { body: { playit_address: $("#playit-addr").value.trim() } });
    toast("Adresse du tunnel enregistrée.");
    refreshStatus(); // met à jour la carte du tableau de bord
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
// Descriptions en français de chaque paramètre de PalWorldSettings.ini.
const SETTING_DESCRIPTIONS = {
  Difficulty: "Difficulté globale du serveur.",
  DayTimeSpeedRate: "Vitesse d'écoulement du jour (plus haut = jours plus courts).",
  NightTimeSpeedRate: "Vitesse d'écoulement de la nuit.",
  ExpRate: "Multiplicateur de gain d'expérience (joueurs et Pals).",
  PalCaptureRate: "Taux de réussite de capture des Pals.",
  PalSpawnNumRate: "Densité d'apparition des Pals sauvages.",
  PalDamageRateAttack: "Dégâts infligés par les Pals.",
  PalDamageRateDefense: "Dégâts subis par les Pals (plus haut = plus fragiles).",
  PlayerDamageRateAttack: "Dégâts infligés par les joueurs.",
  PlayerDamageRateDefense: "Dégâts subis par les joueurs.",
  PlayerStomachDecreaceRate: "Vitesse à laquelle la faim du joueur diminue.",
  PlayerStaminaDecreaceRate: "Vitesse à laquelle l'endurance du joueur diminue.",
  PlayerAutoHPRegeneRate: "Régénération automatique des PV du joueur.",
  PlayerAutoHpRegeneRateInSleep: "Régénération des PV du joueur pendant le sommeil.",
  PalStomachDecreaceRate: "Vitesse à laquelle la faim des Pals diminue.",
  PalStaminaDecreaceRate: "Vitesse à laquelle l'endurance des Pals diminue.",
  PalAutoHPRegeneRate: "Régénération automatique des PV des Pals.",
  PalAutoHpRegeneRateInSleep: "Régénération des PV des Pals dans la Palbox.",
  BuildObjectDamageRate: "Dégâts infligés aux constructions.",
  BuildObjectDeteriorationDamageRate: "Vitesse de détérioration des constructions.",
  CollectionDropRate: "Quantité de ressources obtenues par récolte.",
  CollectionObjectHpRate: "Points de vie des objets à récolter (arbres, rochers…).",
  CollectionObjectRespawnSpeedRate: "Vitesse de réapparition des ressources récoltables.",
  EnemyDropItemRate: "Quantité d'objets lâchés par les ennemis.",
  DeathPenalty: "Ce que le joueur perd à la mort (rien / objets / équipement / tout).",
  bEnablePlayerToPlayerDamage: "Autorise les dégâts entre joueurs (PvP).",
  bEnableFriendlyFire: "Active le tir allié (dégâts au sein d'une même guilde).",
  bEnableInvaderEnemy: "Active les raids d'ennemis sur les bases.",
  bActiveUNKO: "Paramètre spécial du jeu — à laisser par défaut.",
  bEnableAimAssistPad: "Assistance à la visée à la manette.",
  bEnableAimAssistKeyboard: "Assistance à la visée au clavier/souris.",
  DropItemMaxNum: "Nombre maximum d'objets lâchés au sol simultanément.",
  BaseCampMaxNum: "Nombre maximum de camps de base sur le serveur.",
  BaseCampWorkerMaxNum: "Nombre maximum de Pals travailleurs par camp de base.",
  DropItemAliveMaxHours: "Durée de vie (heures) d'un objet lâché au sol.",
  bAutoResetGuildNoOnlinePlayers: "Dissout automatiquement les guildes sans joueur connecté.",
  AutoResetGuildTimeNoOnlinePlayers: "Délai (heures) avant dissolution d'une guilde inactive.",
  GuildPlayerMaxNum: "Nombre maximum de joueurs par guilde.",
  PalEggDefaultHatchingTime: "Temps d'éclosion des gros œufs (heures).",
  WorkSpeedRate: "Vitesse de travail des Pals dans les bases.",
  bIsMultiplay: "Coop locale — à laisser par défaut sur un serveur dédié.",
  bIsPvP: "Active le mode Joueur contre Joueur (PvP).",
  bCanPickupOtherGuildDeathPenaltyDrop: "Autorise à ramasser le butin de mort des autres guildes.",
  bEnableNonLoginPenalty: "Applique une pénalité aux joueurs absents longtemps.",
  bEnableFastTravel: "Autorise le voyage rapide entre points de téléportation.",
  bIsStartLocationSelectByMap: "Le joueur choisit son point de départ sur la carte.",
  bExistPlayerAfterLogout: "Le personnage reste présent dans le monde après déconnexion.",
  bEnableDefenseOtherGuildPlayer: "Permet aux bases de se défendre contre les joueurs ennemis.",
  CoopPlayerMaxNum: "Nombre maximum de joueurs en coopération (partie privée).",
  ServerPlayerMaxNum: "Nombre maximum de joueurs sur le serveur.",
  ServerName: "Nom du serveur affiché dans la liste.",
  ServerDescription: "Description du serveur affichée dans la liste.",
  AdminPassword: "Mot de passe administrateur (API REST / RCON). Utilisé par ce panel.",
  ServerPassword: "Mot de passe demandé aux joueurs pour rejoindre (vide = public).",
  PublicPort: "Port UDP public du serveur de jeu.",
  PublicIP: "IP publique annoncée (laisser vide en général).",
  RCONEnabled: "Active l'accès RCON (administration à distance).",
  RCONPort: "Port RCON.",
  Region: "Région déclarée du serveur.",
  bUseAuth: "Exige l'authentification des joueurs.",
  BanListURL: "URL de la liste de bannissement partagée.",
  RESTAPIEnabled: "Active l'API REST — indispensable au fonctionnement de ce panel.",
  RESTAPIPort: "Port de l'API REST (8212 par défaut, utilisé par le panel).",
  bShowPlayerList: "Rend publique la liste des joueurs connectés.",
  AllowConnectPlatform: "Plateformes autorisées à se connecter (Steam, etc.).",
  bIsUseBackupSaveData: "Sauvegardes automatiques du monde par le serveur.",
  LogFormatType: "Format des journaux du serveur (Text / Json).",
  ServerReplicatePawnCullDistance: "Distance au-delà de laquelle les entités ne sont plus synchronisées.",
  CoopPlayerMaxNum_UNKO: "Paramètre spécial — à laisser par défaut.",
  DropItemMaxNum_UNKO: "Paramètre spécial — à laisser par défaut.",
};

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
      .map(([key, value]) => {
        const desc = SETTING_DESCRIPTIONS[key];
        return `<tr data-setting="${key.toLowerCase()}">
          <td>${key}${desc ? `<span class="setting-desc">${escapeHtml(desc)}</span>` : ""}</td>
          <td>${inputForSetting(key, value)}</td>
        </tr>`;
      })
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

// --------------------------------------------------------------- infos (admin)
function infoRow(label, value, opts = {}) {
  const empty = value == null || value === "";
  const shown = empty ? opts.empty || "—" : value;
  const val = opts.mono && !empty ? `<code>${escapeHtml(shown)}</code>` : escapeHtml(shown);
  const copy = opts.copyable && !empty
    ? `<button class="btn small" data-copy="${escapeHtml(String(value))}">Copier</button>`
    : "";
  return `<div class="info-row"><span class="info-label">${escapeHtml(label)}</span><span class="info-val">${val}</span>${copy}</div>`;
}

async function loadInfo() {
  const container = $("#info-content");
  try {
    const d = await api("/api/info");
    const panelUrl = `http://${d.ip}:${d.panel_port}`;
    const gameAddr = `${d.ip}:${d.game_port}`;
    container.innerHTML = `
      <div class="panel-block">
        <h2>Serveur de jeu</h2>
        ${infoRow("Nom du serveur", d.server_name)}
        ${infoRow("Adresse à donner aux joueurs (LAN)", gameAddr, { mono: true, copyable: true })}
        ${infoRow("Adresse publique (tunnel playit.gg)", d.playit_address, { empty: "(à renseigner dans Accès / Tunnel)", mono: true, copyable: !!d.playit_address })}
        ${infoRow("Mot de passe pour rejoindre", d.server_password, { empty: "(aucun — serveur public)", mono: true, copyable: !!d.server_password })}
        ${infoRow("Mot de passe admin (/AdminPassword en jeu, API, RCON)", d.admin_password, { mono: true, copyable: true })}
      </div>
      <div class="panel-block">
        <h2>Panel (le site)</h2>
        ${infoRow("Adresse du panel", panelUrl, { mono: true, copyable: true })}
        <p class="hint">Les mots de passe des comptes du panel ne sont pas affichables (stockés chiffrés). Gère-les dans Configuration → Comptes du panel.</p>
      </div>
      <div class="panel-block">
        <h2>Notifications Discord (via botpanel)</h2>
        ${infoRow("État", d.notify_enabled ? "Activées" : "Désactivées")}
        ${infoRow("URL du botpanel", d.notify_url, { empty: "(non renseignée)", mono: true, copyable: !!d.notify_url })}
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Événement</th><th>Slug configuré (dans botpanel)</th></tr></thead>
          <tbody>
            ${(d.notify_events || []).map((e) => `<tr><td>${escapeHtml(e.label)}</td><td>${e.slug ? `<code>${escapeHtml(e.slug)}</code>` : '<span class="muted">— désactivé</span>'}</td></tr>`).join("")}
          </tbody>
        </table></div>
        <p class="hint">Le texte de chaque message est défini dans ton botpanel (par slug). Pour modifier l'URL ou les slugs : Paramètres → Notifications Discord.</p>
      </div>
      <div class="panel-block">
        <h2>Accès système (VM) — secours</h2>
        ${infoRow("Utilisateur", d.ssh_user, { mono: true })}
        ${infoRow("Mot de passe système", d.vm_password, { empty: "(défini par toi / clé SSH)", mono: true, copyable: !!d.vm_password })}
        ${infoRow("Connexion SSH", `ssh ${d.ssh_user}@${d.ip}`, { mono: true, copyable: true })}
        ${infoRow("Passer administrateur (root)", "sudo -i", { mono: true, copyable: true })}
        <p class="hint">Pour bricoler la VM en direct (console Proxmox ou SSH). Au quotidien, tu n'en as pas besoin — le panel fait tout.</p>
      </div>
      <div class="panel-block">
        <h2>Ports</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Port</th><th>Protocole</th><th>Usage</th></tr></thead>
          <tbody>
            <tr><td><code>${d.game_port}</code></td><td>UDP</td><td>Serveur de jeu (à rediriger ou via tunnel)</td></tr>
            <tr><td><code>${d.panel_port}</code></td><td>TCP</td><td>Panel web</td></tr>
            <tr><td><code>${escapeHtml(d.rest_api_port)}</code></td><td>TCP</td><td>API REST (localhost)</td></tr>
            <tr><td><code>${escapeHtml(d.rcon_port)}</code></td><td>TCP</td><td>RCON (localhost)</td></tr>
          </tbody>
        </table></div>
      </div>
      <div class="panel-block">
        <h2>Chemins & commandes utiles</h2>
        ${infoRow("Dossier du serveur", d.server_dir, { mono: true })}
        ${infoRow("Sauvegardes", d.backup_dir, { mono: true })}
        ${infoRow("Fichier de configuration", d.settings_file, { mono: true })}
        ${infoRow("Voir les logs en direct", "journalctl -u palworld -f", { mono: true, copyable: true })}
      </div>`;
  } catch (err) {
    container.innerHTML = `<div class="panel-block"><p class="hint">${escapeHtml(err.message)}</p></div>`;
  }
}

// --------------------------------------------------------------- reproduction
let palIndex = null;
let lastCouple = null;      // dernier couple calculé (pour le favori)
let lastPathResult = null;  // dernières chaînes calculées (noms), pour les favoris
let lastParents = null;     // derniers couples « enfant → parents » (noms), pour les favoris

function initBreeding() {
  if (palIndex || !Array.isArray(window.PAL_NAMES)) return;
  palIndex = {};
  window.PAL_NAMES.forEach((n, i) => (palIndex[n.toLowerCase()] = i));
  // Auto-complétion visuelle sur chaque champ de Pal. Sélectionner le dernier
  // champ d'un mode lance directement le calcul.
  attachPalAutocomplete($("#breed-parent1"), computeChild);
  attachPalAutocomplete($("#breed-parent2"), computeChild);
  attachPalAutocomplete($("#breed-target"), findParents);
  attachPalAutocomplete($("#breed-have"), null);
  attachPalAutocomplete($("#breed-want"), findPath);
}

function palIdx(value) {
  if (!palIndex) return -1;
  const i = palIndex[(value || "").trim().toLowerCase()];
  return i == null ? -1 : i;
}

// Petite vignette du Pal (wiki Fandom) ; vide si indisponible. Les images
// cassées (hors ligne / 404) sont retirées par le gestionnaire d'erreur global.
function palIcon(name) {
  const url = window.PAL_IMAGES && window.PAL_IMAGES[name];
  return url ? `<img class="pal-ico" src="${escapeHtml(url)}" alt="" loading="lazy">` : "";
}

// Type (élément) → libellé FR + couleur.
const TYPE_INFO = {
  Neutral: { fr: "Neutre", c: "#9aa0a6" },
  Fire: { fr: "Feu", c: "#e8623c" },
  Water: { fr: "Eau", c: "#3aa0e8" },
  Grass: { fr: "Herbe", c: "#4fc36a" },
  Electric: { fr: "Électrique", c: "#e8c547" },
  Ice: { fr: "Glace", c: "#6fd6e8" },
  Ground: { fr: "Sol", c: "#c99a5b" },
  Dark: { fr: "Ténèbres", c: "#a78bfa" },
  Dragon: { fr: "Dragon", c: "#7c6cf0" },
};
function palMeta(name) { return (window.PAL_META && window.PAL_META[name]) || null; }
function palNumLabel(name) { const m = palMeta(name); return m && m.n ? `#${escapeHtml(m.n)}` : ""; }
function palTypeBadges(name) {
  const m = palMeta(name);
  if (!m || !m.t) return "";
  return m.t.map((t) => {
    const info = TYPE_INFO[t] || { fr: t, c: "#888" };
    return `<span class="ptype" style="--tc:${info.c}">${escapeHtml(info.fr)}</span>`;
  }).join("");
}
function palOptionHtml(name) {
  return `<div class="pal-ac-opt" data-name="${escapeHtml(name)}">${palIcon(name)}` +
    `<span class="pal-ac-num">${palNumLabel(name)}</span>` +
    `<span class="pal-ac-name">${escapeHtml(name)}</span>` +
    `<span class="pal-ac-types">${palTypeBadges(name)}</span></div>`;
}

// Auto-complétion visuelle : liste déroulante (photo + n° + nom + type) qui
// s'affiche au focus et se filtre à la frappe. onSelect() est appelé au choix.
function attachPalAutocomplete(input, onSelect) {
  if (!input) return;
  const wrap = document.createElement("div");
  wrap.className = "pal-ac";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const list = document.createElement("div");
  list.className = "pal-ac-list hidden";
  wrap.appendChild(list);
  let activeIdx = -1;

  const render = () => {
    const q = input.value.trim().toLowerCase();
    const names = window.PAL_NAMES || [];
    const matches = q ? names.filter((n) => n.toLowerCase().includes(q)) : names.slice();
    list.innerHTML = matches.length
      ? matches.map(palOptionHtml).join("")
      : '<div class="pal-ac-empty">Aucun Pal</div>';
    activeIdx = -1;
    list.classList.remove("hidden");
    list.scrollTop = 0;
  };
  const hide = () => list.classList.add("hidden");
  const pick = (name) => { input.value = name; hide(); if (onSelect) onSelect(); };

  input.addEventListener("focus", render);
  input.addEventListener("input", render);
  input.addEventListener("blur", () => setTimeout(hide, 150));
  input.addEventListener("keydown", (e) => {
    if (list.classList.contains("hidden")) return;
    const opts = [...list.querySelectorAll(".pal-ac-opt")];
    if (!opts.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, opts.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
    else if (e.key === "Enter") { e.preventDefault(); pick((opts[activeIdx] || opts[0]).dataset.name); return; }
    else if (e.key === "Escape") { hide(); return; }
    else return;
    opts.forEach((o, i) => o.classList.toggle("active", i === activeIdx));
    if (opts[activeIdx]) opts[activeIdx].scrollIntoView({ block: "nearest" });
  });
  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".pal-ac-opt");
    if (opt) { e.preventDefault(); pick(opt.dataset.name); }
  });
}

function computeChild() {
  const el = $("#breed-child-result");
  const a = palIdx($("#breed-parent1").value);
  const b = palIdx($("#breed-parent2").value);
  if (a < 0 || b < 0) { lastCouple = null; return void (el.innerHTML = ""); }
  const child = window.PAL_NAMES[window.PAL_COMBOS[a][b]];
  lastCouple = { a: window.PAL_NAMES[a], b: window.PAL_NAMES[b], child };
  el.innerHTML = `<div class="breed-egg">
      <span class="breed-pair">${palIcon(window.PAL_NAMES[a])}${escapeHtml(window.PAL_NAMES[a])} + ${palIcon(window.PAL_NAMES[b])}${escapeHtml(window.PAL_NAMES[b])}</span>
      <span class="breed-arrow">→</span>
      <span class="breed-out">${palIcon(child)}${escapeHtml(child)}</span>
    </div>
    <button class="btn small" id="breed-fav-couple" style="margin-top:10px">⭐ Ajouter aux favoris</button>`;
}

function findParents() {
  const el = $("#breed-parents-result");
  lastParents = null;
  const t = palIdx($("#breed-target").value);
  if (t < 0) return void (el.innerHTML = '<p class="hint">Choisis un Pal dans la liste.</p>');
  const N = window.PAL_NAMES, C = window.PAL_COMBOS;
  const pairs = [];
  for (let i = 0; i < N.length; i++) {
    for (let j = i; j < N.length; j++) {
      if (C[i][j] === t) pairs.push([N[i], N[j]]);
    }
  }
  const target = N[t];
  if (!pairs.length) {
    el.innerHTML = `<p class="hint">Aucun couple ne produit <b>${escapeHtml(target)}</b> (Pal non obtenable par reproduction).</p>`;
    return;
  }
  const shown = pairs.slice(0, 400);
  const extra = pairs.length - shown.length;
  lastParents = { child: target, pairs: shown };
  el.innerHTML =
    `<p class="breed-count"><b>${pairs.length}</b> couple(s) produisent <b>${escapeHtml(target)}</b> <span class="hint">— ⭐ pour enregistrer un couple.</span></p>` +
    `<div class="breed-pairs">${shown.map(([a, b], k) => `<span class="breed-chip">${palIcon(a)}${escapeHtml(a)} + ${palIcon(b)}${escapeHtml(b)}<button class="fav-star" data-fav-couple-idx="${k}" title="Ajouter aux favoris">☆</button></span>`).join("")}</div>` +
    (extra > 0 ? `<p class="hint">… et ${extra} autres couples.</p>` : "");
}

const MAX_CHAINS = 100;        // nb max de chaînes calculées (sécurité navigateur)
const MAX_PARTNERS_SHOWN = 20; // nb max de partenaires listés par étape
const CHAINS_INITIAL = 5;      // chaînes visibles d'emblée
const CHAINS_MORE = 5;         // chaînes révélées à chaque « Voir plus »

function findPath() {
  const el = $("#breed-path-result");
  lastPathResult = null;
  const s = palIdx($("#breed-have").value);
  const t = palIdx($("#breed-want").value);
  if (s < 0 || t < 0) return void (el.innerHTML = '<p class="hint">Choisis deux Pals dans la liste.</p>');
  const N = window.PAL_NAMES, C = window.PAL_COMBOS, n = N.length;
  if (s === t) return void (el.innerHTML = `<p class="breed-count">Tu as déjà <b>${escapeHtml(N[t])}</b> 🎉</p>`);

  // 1) Distances les plus courtes depuis le Pal possédé (BFS).
  const dist = new Int32Array(n).fill(-1);
  dist[s] = 0;
  let queue = [s];
  while (queue.length) {
    const next = [];
    for (const cur of queue) {
      const row = C[cur], d = dist[cur] + 1;
      for (let y = 0; y < n; y++) {
        const v = row[y];
        if (dist[v] === -1) { dist[v] = d; next.push(v); }
      }
    }
    queue = next;
  }
  if (dist[t] === -1) {
    el.innerHTML = `<p class="hint">Impossible d'atteindre <b>${escapeHtml(N[t])}</b> par reproduction depuis <b>${escapeHtml(N[s])}</b>.</p>`;
    return;
  }

  // Tous les partenaires réalisant une étape u → v (C[u][y] === v).
  const partnersFor = (u, v) => {
    const out = [], row = C[u];
    for (let y = 0; y < n; y++) if (row[y] === v) out.push(y);
    return out;
  };

  // 2) Énumère toutes les chaînes LES PLUS COURTES (remontée dans le DAG), plafonné.
  const chains = [];
  (function build(v, acc) {
    if (chains.length >= MAX_CHAINS) return;
    if (v === s) { chains.push(acc.slice().reverse()); return; }
    for (let u = 0; u < n && chains.length < MAX_CHAINS; u++) {
      if (dist[u] !== dist[v] - 1) continue;
      const partners = partnersFor(u, v);
      if (!partners.length) continue;
      acc.push({ from: u, to: v, partners });
      build(u, acc);
      acc.pop();
    }
  })(t, []);

  const stepLen = dist[t];

  // Nombre TOTAL de chaînes distinctes (comptage sur le DAG, sans les énumérer).
  const order = [];
  for (let i = 0; i < n; i++) if (dist[i] >= 0) order.push(i);
  order.sort((a, b) => dist[a] - dist[b]);
  const cnt = new Float64Array(n);
  cnt[s] = 1;
  for (const u of order) {
    if (!cnt[u]) continue;
    const succ = new Set(), row = C[u];
    for (let y = 0; y < n; y++) { const v = row[y]; if (dist[v] === dist[u] + 1) succ.add(v); }
    for (const v of succ) cnt[v] += cnt[u];
  }
  const total = cnt[t];

  const renderStep = (st, i) => {
    const shown = st.partners.slice(0, MAX_PARTNERS_SHOWN).map((y) => `<span class="breed-chip">${palIcon(N[y])}${escapeHtml(N[y])}</span>`).join("");
    const extra = st.partners.length - Math.min(st.partners.length, MAX_PARTNERS_SHOWN);
    const many = st.partners.length > 1;
    return `<li class="breed-step">` +
      `<div class="breed-step-out">Étape ${i + 1} → ${palIcon(N[st.to])}<b>${escapeHtml(N[st.to])}</b></div>` +
      `<div class="breed-recipe">` +
      `<span class="breed-parent">${palIcon(N[st.from])}${escapeHtml(N[st.from])}</span><span class="breed-op">+</span>` +
      (many ? `<span class="breed-choice">au choix&nbsp;:</span>` : "") +
      `<span class="breed-partners">${shown}${extra > 0 ? `<span class="breed-more-inline">+${extra} autres</span>` : ""}</span>` +
      `</div></li>`;
  };
  const note = total > chains.length
    ? ` <span class="hint">— ${chains.length} consultables (il y en a beaucoup ; pars d'un Pal intermédiaire pour cibler).</span>`
    : ` <span class="hint">— à chaque étape, l'un des partenaires proposés suffit.</span>`;
  lastPathResult = {
    have: N[s], want: N[t],
    chains: chains.map((chain) => chain.map((st) => ({
      from: N[st.from], to: N[st.to], partners: st.partners.map((y) => N[y]),
    }))),
  };
  const chainsHtml = chains.map((chain, i) =>
    `<div class="breed-chain"${i >= CHAINS_INITIAL ? " hidden" : ""}>` +
    `<div class="breed-chain-head">Option ${i + 1} <button class="btn small" data-fav-chain="${i}">⭐ Favori</button></div>` +
    `<ol class="breed-steps">${chain.map(renderStep).join("")}</ol></div>`
  ).join("");
  const remaining = chains.length - Math.min(chains.length, CHAINS_INITIAL);
  const moreBtn = remaining > 0
    ? `<button class="btn" id="breed-more" style="margin-top:12px">Voir ${Math.min(CHAINS_MORE, remaining)} de plus (${remaining} restantes)</button>`
    : "";
  el.innerHTML =
    `<p class="breed-count"><b>${total.toLocaleString("fr-FR")}</b> chaîne(s) en <b>${stepLen}</b> étape(s) : ${escapeHtml(N[s])} → ${escapeHtml(N[t])}${note}</p>` +
    chainsHtml + moreBtn;
}

// ------------------------------------------------------- favoris de reproduction
function favStepsHtml(steps) {
  return `<ol class="breed-steps">` + steps.map((st, i) =>
    `<li class="breed-step"><div class="breed-step-out">Étape ${i + 1} → ${palIcon(st.to)}<b>${escapeHtml(st.to)}</b></div>` +
    `<div class="breed-recipe"><span class="breed-parent">${palIcon(st.from)}${escapeHtml(st.from)}</span><span class="breed-op">+</span>` +
    (st.partners.length > 1 ? `<span class="breed-choice">au choix&nbsp;:</span>` : "") +
    `<span class="breed-partners">` +
    st.partners.slice(0, MAX_PARTNERS_SHOWN).map((p) => `<span class="breed-chip">${palIcon(p)}${escapeHtml(p)}</span>`).join("") +
    (st.partners.length > MAX_PARTNERS_SHOWN ? `<span class="breed-more-inline">+${st.partners.length - MAX_PARTNERS_SHOWN} autres</span>` : "") +
    `</span></div></li>`
  ).join("") + `</ol>`;
}

function renderFavorite(f) {
  const del = `<button class="btn small danger" data-fav-del="${escapeHtml(f.id)}">Retirer</button>`;
  if (f.type === "couple") {
    return `<div class="fav-item"><span class="fav-main">${palIcon(f.a)}${escapeHtml(f.a)} <span class="breed-op">+</span> ${palIcon(f.b)}${escapeHtml(f.b)} <span class="breed-arrow">→</span> ${palIcon(f.child)}<b class="fav-out">${escapeHtml(f.child)}</b></span>${del}</div>`;
  }
  return `<div class="fav-item fav-chain"><div class="fav-head"><span class="fav-main">${palIcon(f.have)}${escapeHtml(f.have)} <span class="breed-arrow">→</span> ${palIcon(f.want)}<b class="fav-out">${escapeHtml(f.want)}</b></span>${del}</div>${favStepsHtml(f.steps || [])}</div>`;
}

async function loadFavorites() {
  const el = $("#breed-favorites");
  try {
    const d = await api("/api/breeding/favorites");
    if (!d.favorites.length) {
      el.innerHTML = '<p class="hint">Aucun favori. Clique sur ⭐ sur un résultat pour le retrouver ici.</p>';
      return;
    }
    el.innerHTML = d.favorites.slice().reverse().map(renderFavorite).join("");
  } catch (err) {
    el.innerHTML = "";
  }
}

async function addFavorite(payload) {
  try {
    const r = await api("/api/breeding/favorites", { body: payload });
    toast(r.duplicate ? "Déjà dans tes favoris." : "Ajouté aux favoris ⭐");
    loadFavorites();
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeFavorite(id) {
  try {
    await api(`/api/breeding/favorites/${encodeURIComponent(id)}`, { method: "DELETE" });
    loadFavorites();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------- onglets
const SERVER_TABS = ["dashboard", "console", "config", "backups", "acces"];

function showTab(name) {
  const isServer = SERVER_TABS.includes(name);
  // grands onglets : « Serveur » est actif dès qu'un sous-onglet serveur l'est
  document.querySelectorAll(".main-tabs .tab").forEach((t) => {
    const active = t.dataset.group === "serveur" ? isServer : t.dataset.tab === name;
    t.classList.toggle("active", active);
  });
  // sous-barre serveur (visible seulement dans le groupe Serveur)
  const sub = $("#serveur-subtabs");
  sub.classList.toggle("hidden", !isServer);
  if (isServer) {
    sub.querySelectorAll(".subtab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  }
  // pages
  document.querySelectorAll(".tab-page").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  // chargements
  if (name === "console") startConsole();
  if (name === "config" && !configLoaded) loadConfig();
  if (name === "parametres") { loadSettingsInfo(); loadNotifyConfig(); loadHaConfig(); loadMaintenance(); }
  if (name === "acces") loadPlayit();
  if (name === "reproduction") { initBreeding(); loadFavorites(); }
  if (name === "backups") loadBackups();
  if (name === "infos") loadInfo();
}

// ------------------------------------------------------------------- init
document.addEventListener("DOMContentLoaded", () => {
  // Grands onglets : « Serveur » ouvre le sous-onglet Tableau de bord par défaut.
  document.querySelectorAll(".main-tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () =>
      showTab(tab.dataset.group === "serveur" ? "dashboard" : tab.dataset.tab));
  });
  document.querySelectorAll("#serveur-subtabs .subtab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });

  // Liens internes "aller à un onglet" (ex : bannière d'installation → Console)
  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-goto]");
    if (!link) return;
    event.preventDefault();
    showTab(link.dataset.goto);
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

  // Connexion : mot de passe du panel + auto-login Cloudflare
  $("#admin-pw-save").addEventListener("click", saveAdminPassword);
  $("#cf-email-save").addEventListener("click", saveCfAccess);

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

  // Mot de passe système (VM)
  $("#vmpw-save").addEventListener("click", saveVmPassword);

  // Adresse publique du tunnel playit.gg
  $("#playit-save").addEventListener("click", savePlayit);
  $("#playit-copy").addEventListener("click", () => copyText($("#playit-addr").value.trim()));

  // Notifications Discord (botpanel)
  $("#notify-save").addEventListener("click", async () => {
    try {
      await saveNotifyConfig();
      toast("Notifications enregistrées.");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#notify-table").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-notify-test]");
    if (btn) testNotify(btn.dataset.notifyTest);
  });

  // Reproduction (breeding)
  $("#breed-parent1").addEventListener("input", computeChild);
  $("#breed-parent2").addEventListener("input", computeChild);
  $("#breed-find").addEventListener("click", findParents);
  $("#breed-path").addEventListener("click", findPath);
  // Vignette de Pal indisponible (hors ligne / 404) : on la retire, le nom reste.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img && img.tagName === "IMG" && img.classList.contains("pal-ico")) img.remove();
  }, true);
  $("#breed-path-result").addEventListener("click", (e) => {
    const favBtn = e.target.closest("[data-fav-chain]");
    if (favBtn && lastPathResult) {
      const chain = lastPathResult.chains[+favBtn.dataset.favChain];
      if (chain) addFavorite({ type: "chain", have: lastPathResult.have, want: lastPathResult.want, steps: chain });
      return;
    }
    const btn = e.target.closest("#breed-more");
    if (!btn) return;
    const chains = [...document.querySelectorAll("#breed-path-result .breed-chain")];
    const shown = chains.filter((c) => !c.hidden).length;
    for (let i = shown; i < shown + CHAINS_MORE && i < chains.length; i++) chains[i].hidden = false;
    const rest = chains.filter((c) => c.hidden).length;
    if (rest === 0) btn.remove();
    else btn.textContent = `Voir ${Math.min(CHAINS_MORE, rest)} de plus (${rest} restantes)`;
  });

  // Favori d'un couple (mode « deux parents → enfant »)
  $("#breed-child-result").addEventListener("click", (e) => {
    if (e.target.closest("#breed-fav-couple") && lastCouple) {
      addFavorite({ type: "couple", ...lastCouple });
    }
  });

  // Favori d'un couple depuis la liste « enfant → parents »
  $("#breed-parents-result").addEventListener("click", (e) => {
    const star = e.target.closest("[data-fav-couple-idx]");
    if (star && lastParents) {
      const pair = lastParents.pairs[+star.dataset.favCoupleIdx];
      if (pair) addFavorite({ type: "couple", a: pair[0], b: pair[1], child: lastParents.child });
    }
  });

  // Retrait d'un favori depuis la liste
  $("#breed-favorites").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-fav-del]");
    if (btn) removeFavorite(btn.dataset.favDel);
  });

  // Home Assistant
  $("#ha-save").addEventListener("click", async () => {
    try {
      await saveHaConfig();
      toast("Home Assistant enregistré.");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#ha-test").addEventListener("click", testHa);

  // Maintenance
  $("#check-updates").addEventListener("click", checkUpdates);

  // Copie au clic partout (boutons [data-copy] : commandes tunnel, infos, adresse)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (btn) copyText(btn.dataset.copy);
  });
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
