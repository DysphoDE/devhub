import { createGitWorkspace } from "./git-workspace.js";
import { createPalette } from "./palette.js";

const storedFavorites = JSON.parse(localStorage.getItem("devhub_favorites") || "[]");
const storedRecent = JSON.parse(localStorage.getItem("devhub_recent") || "[]");
const state = {
  token: "",
  root: "",
  projects: [],
  stack: null,
  capabilities: null,
  page: location.hash === "#git" ? "git" : "projects",
  filter: "all",
  technology: null,
  category: localStorage.getItem("devhub_category") || null,
  query: "",
  gitQuery: "",
  gitFilter: localStorage.getItem("devhub_git_filter") || "all",
  activeGitProjectId: localStorage.getItem("devhub_git_project") || null,
  sort: localStorage.getItem("devhub_sort") || "smart",
  view: localStorage.getItem("devhub_view") === "grid" ? "grid" : "list",
  group: localStorage.getItem("devhub_group") === "category" ? "category" : "none",
  favorites: new Set(Array.isArray(storedFavorites) ? storedFavorites : []),
  recent: Array.isArray(storedRecent) ? storedRecent : [],
  expandedProjects: new Set(),
  selectedProjectId: localStorage.getItem("devhub_selected_project") || null,
  panelOpen: false,
  panelDismissed: false,
  logTails: new Map(),
  stackPending: null,
  activeLogId: null,
  github: null,
  githubLoading: false
};

const elements = {
  projectsPage: document.querySelector("#projects-page"), gitPage: document.querySelector("#git-page"),
  grid: document.querySelector("#project-grid"), empty: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"), emptyMessage: document.querySelector("#empty-message"), emptyAction: document.querySelector("#empty-action"),
  rootLabel: document.querySelector("#drive-label"), rootPath: document.querySelector("#workspace-path"), workspaceSettings: document.querySelector("#workspace-settings"),
  workspaceDialog: document.querySelector("#workspace-dialog"), workspaceForm: document.querySelector("#workspace-form"), workspaceInput: document.querySelector("#workspace-input"),
  workspaceBrowse: document.querySelector("#workspace-browse"), workspaceSave: document.querySelector("#workspace-save"),
  groupToggle: document.querySelector("#group-toggle"),
  resultCount: document.querySelector("#result-count"), resultTotal: document.querySelector("#result-total"), allCount: document.querySelector("#all-count"),
  favoriteCount: document.querySelector("#favorite-count"), recentCount: document.querySelector("#recent-count"), runningFilterCount: document.querySelector("#running-filter-count"),
  attentionCount: document.querySelector("#attention-count"), gitRepositoryCount: document.querySelector("#git-repository-count"),
  scanStatus: document.querySelector("#scan-status"), search: document.querySelector("#search"), sort: document.querySelector("#sort"), rescan: document.querySelector("#rescan"),
  techSelect: document.querySelector("#tech-select"), categorySelect: document.querySelector("#category-select"), categorySelectWrap: document.querySelector("#category-select-wrap"),
  resetFilters: document.querySelector("#reset-filters"), panel: document.querySelector("#project-panel"), remote: document.querySelector("#remote-repos"),
  svc: document.querySelector("#svc"), svcPill: document.querySelector("#svc-pill"), svcName: document.querySelector("#svc-name"), svcState: document.querySelector("#svc-state"),
  svcPanel: document.querySelector("#svc-panel"), attention: document.querySelector("#attention"),
  logDialog: document.querySelector("#log-dialog"), logTitle: document.querySelector("#log-title"), logCommand: document.querySelector("#log-command"),
  logOutput: document.querySelector("#log-output"), logState: document.querySelector("#log-state"), restartLog: document.querySelector("#restart-log"),
  toastRegion: document.querySelector("#toast-region")
};

const isMac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
document.querySelector("#palette-shortcut").textContent = isMac ? "⌘K" : "Strg K";
document.querySelector("#palette-editor-key").textContent = isMac ? "⌘" : "Strg";
document.querySelector("#palette-browser-key").textContent = isMac ? "⌥" : "Alt";

document.querySelector("#local-address").textContent = location.host;

const statusLabels = { stopped: "bereit", starting: "startet", running: "läuft", stopping: "stoppt", error: "Fehler" };
const techPresentation = {
  "Laravel": ["L", "tech-laravel"], "WordPress": ["W", "tech-wordpress"], "Symfony": ["S", "tech-symfony"],
  "Next.js": ["N", "tech-next"], "React": ["R", "tech-react"], "Vue": ["V", "tech-vue"], "Svelte": ["S", "tech-svelte"],
  "PHP": ["P", "tech-php"], "HTML": ["H", "tech-html"], "Node.js": ["N", "tech-node"], "Python": ["Py", "tech-python"],
  "WoW Addon": ["W", "tech-addon"], "Docker": ["D", "tech-docker"], "Projektordner": ["·", "tech-folder"]
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function projectIsRunning(project) {
  return project.launchers.some((launcher) => ["starting", "running", "stopping"].includes(launcher.runtime.status));
}

function activeLauncher(project) {
  return project.launchers.find((launcher) => ["starting", "running", "stopping"].includes(launcher.runtime.status));
}

// Teilskripte (z. B. dev:php unter einem concurrently-dev) startet ihr Hauptstarter mit, sie erscheinen nur als Teile.
function topLaunchers(project) {
  return project.launchers.filter((launcher) => !launcher.parentId);
}

function preferredLauncher(project) {
  const top = topLaunchers(project);
  return activeLauncher(project) || top.find((launcher) => launcher.preferred) || top[0] || null;
}

function launcherParts(launcher) {
  if (!launcher.parts?.length) return "";
  const parentRunning = ["starting", "running"].includes(launcher.runtime.status);
  return `<div class="wb-parts" aria-label="Startet mit">${launcher.parts.map((part) => {
    const child = part.launcherId ? findLauncher(part.launcherId)?.launcher : null;
    const on = parentRunning || ["starting", "running"].includes(child?.runtime.status);
    return `<span class="wb-part ${on ? "on" : ""}" title="${escapeHtml(part.script)}${part.port ? ` · Port ${part.port}` : ""}">${escapeHtml(part.script)}${part.port ? `<b>${part.port}</b>` : ""}</span>`;
  }).join("")}</div>`;
}

function runtimePort(launcher) {
  if (!launcher?.runtime?.url) return null;
  try {
    const url = new URL(launcher.runtime.url);
    return `:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch { return null; }
}

function projectAttentionReasons(project) {
  const reasons = [];
  const failed = project.launchers.filter((launcher) => launcher.runtime.status === "error").length;
  const conflicts = project.git ? gitConflictCount(project.git) : 0;
  if (failed) reasons.push({ kind: "error", label: `${failed} Prozess${failed === 1 ? "" : "e"} fehlgeschlagen` });
  if (conflicts) reasons.push({ kind: "conflict", label: `${conflicts} Git-Konflikt${conflicts === 1 ? "" : "e"}` });
  if (project.git?.behind) reasons.push({ kind: "behind", label: `${project.git.behind} Commit${project.git.behind === 1 ? "" : "s"} zurück` });
  if (project.git?.ahead) reasons.push({ kind: "ahead", label: `${project.git.ahead} Push ausstehend` });
  if (project.git?.dirty && !conflicts) {
    const changed = project.git.changedFiles ?? project.git.files?.length ?? 0;
    reasons.push({ kind: "changes", label: `${changed} offene Änderung${changed === 1 ? "" : "en"}` });
  }
  return reasons;
}

function projectState(project) {
  const launcher = activeLauncher(project);
  const attention = projectAttentionReasons(project);
  if (attention[0]?.kind === "error") return { kind: "error", label: "Prozessfehler" };
  if (project.isSelf) return { kind: "running", label: "diese Instanz" };
  if (launcher) return { kind: "running", label: `läuft${runtimePort(launcher) ? ` · ${runtimePort(launcher)}` : ""}` };
  if (attention[0]) return { kind: attention[0].kind, label: attention[0].label };
  if (!topLaunchers(project).length) return { kind: "folder", label: "kein Starter" };
  return { kind: "ready", label: "bereit" };
}

function findLauncher(id) {
  for (const project of state.projects) {
    const launcher = project.launchers.find((item) => item.id === id);
    if (launcher) return { project, launcher };
  }
  return null;
}

function relativeTime(isoDate) {
  const delta = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return "gerade geändert";
  if (minutes < 60) return `vor ${minutes} Min. geändert`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std. geändert`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "gestern geändert";
  if (days < 30) return `vor ${days} Tagen`;
  const months = Math.round(days / 30);
  if (months < 12) return `vor ${months} Mon.`;
  return `vor ${Math.round(months / 12)} J.`;
}

function dateTime(isoDate) {
  if (!isoDate) return "unbekannt";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(isoDate));
}

function projectPath(project) {
  const separator = state.root.includes("\\") ? "\\" : "/";
  return `${state.root.replace(/[\\/]+$/, "")}${separator}${project.relativePath.replaceAll("/", separator)}`;
}

function setWorkspaceRoot(root) {
  state.root = root;
  const normalized = root.replace(/[\\/]+$/, "");
  const drive = normalized.match(/^[a-z]:$/i)?.[0];
  const name = drive || normalized.split(/[\\/]/).filter(Boolean).at(-1) || root;
  elements.rootLabel.textContent = name;
  elements.rootPath.textContent = root;
  elements.workspaceSettings.title = `Workspace wechseln · ${root}`;
  elements.workspaceInput.value = root;
}

function techClass(project) {
  return techPresentation[project.technologies[0]] || [project.technologies[0]?.slice(0, 2) || "·", "tech-folder"];
}

function runningBrowserUrl(project) {
  return project.launchers.find((launcher) => launcher.runtime.status === "running" && launcher.runtime.url)?.runtime.url || null;
}

function browserUrl(project) {
  return runningBrowserUrl(project) || (state.stack?.webServer ? project.defaultUrl : null);
}

function markRecent(projectId) {
  state.recent = [projectId, ...state.recent.filter((id) => id !== projectId)].slice(0, 16);
  localStorage.setItem("devhub_recent", JSON.stringify(state.recent));
}

function categoryLabel(categoryPath) {
  return state.projects.find((project) => project.categoryPath === categoryPath)?.category || categoryPath;
}

function setCategoryFilter(categoryPath) {
  state.category = categoryPath;
  if (categoryPath) localStorage.setItem("devhub_category", categoryPath);
  else localStorage.removeItem("devhub_category");
  render(false);
}

function getVisibleProjects() {
  const query = state.query.trim().toLocaleLowerCase("de");
  let projects = state.projects.filter((project) => {
    if (state.filter === "favorites" && !state.favorites.has(project.id)) return false;
    if (state.filter === "recent" && !state.recent.includes(project.id)) return false;
    if (state.filter === "running" && !projectIsRunning(project)) return false;
    if (state.filter === "attention" && projectAttentionReasons(project).length === 0) return false;
    if (state.category && project.categoryPath !== state.category) return false;
    if (state.technology && !project.technologies.includes(state.technology)) return false;
    if (!query) return true;
    return [project.name, project.description, project.relativePath, project.category, project.git?.branch, ...project.technologies,
      ...project.launchers.flatMap((launcher) => [launcher.name, launcher.command, launcher.relativeCwd])]
      .join(" ").toLocaleLowerCase("de").includes(query);
  });
  const recentIndex = (project) => { const index = state.recent.indexOf(project.id); return index < 0 ? 999 : index; };
  projects.sort((a, b) => {
    if (state.sort === "name") return a.name.localeCompare(b.name, "de");
    if (state.sort === "modified") return new Date(b.modifiedAt) - new Date(a.modifiedAt);
    if (state.sort === "opened") return recentIndex(a) - recentIndex(b) || a.name.localeCompare(b.name, "de");
    return Number(projectIsRunning(b)) - Number(projectIsRunning(a))
      || Number(state.favorites.has(b.id)) - Number(state.favorites.has(a.id))
      || recentIndex(a) - recentIndex(b)
      || new Date(b.modifiedAt) - new Date(a.modifiedAt);
  });
  return projects;
}

function launcherRow(launcher) {
  const runtime = launcher.runtime;
  const busy = ["starting", "stopping"].includes(runtime.status);
  const action = runtime.status === "running" ? "stop" : "start";
  return `<div class="launcher-row" data-launcher="${launcher.id}">
    <div class="launcher-copy"><span class="launcher-name">${escapeHtml(launcher.name)}</span><code class="launcher-command" title="${escapeHtml(launcher.command)}">${escapeHtml(launcher.command)}${launcher.parts?.length ? ` · startet ${launcher.parts.length} Teile` : ""}</code>${launcherParts(launcher)}</div>
    <span class="launcher-status ${runtime.status}">${statusLabels[runtime.status] || runtime.status}</span>
    <div class="launcher-tools">
      ${runtime.url && runtime.status === "running" ? `<a class="mini-action" href="${escapeHtml(runtime.url)}" data-open-id="${launcher.projectId}" target="_blank" rel="noopener noreferrer" aria-label="Im Browser öffnen"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span class="mini-label">Browser</span></a>` : ""}
      <button class="mini-action" data-log="${launcher.id}" data-focus-key="log-${launcher.id}" aria-label="Logs anzeigen"><i class="fa-solid fa-terminal" aria-hidden="true"></i><span class="mini-label">Logs</span></button>
      <button class="mini-action ${action === "stop" ? "stop" : ""} ${busy ? "busy" : ""}" data-launcher-action="${action}" data-id="${launcher.id}" data-focus-key="run-${launcher.id}" ${busy ? "disabled" : ""} aria-label="${action === "stop" ? "Stoppen" : "Starten"}"><i class="fa-solid ${busy ? "fa-spinner fa-spin" : action === "stop" ? "fa-stop" : "fa-play"}" aria-hidden="true"></i><span class="mini-label">${action === "stop" ? "Stoppen" : "Starten"}</span></button>
    </div>
  </div>`;
}

function primaryAction(project, compact = false) {
  const url = browserUrl(project);
  if (url) return `<a class="primary-card-action running" href="${escapeHtml(url)}" data-open-id="${project.id}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>${compact ? "Browser" : "Browser öffnen"}</a>`;
  const launcher = preferredLauncher(project);
  if (launcher) {
    const running = launcher.runtime.status === "running";
    const busy = ["starting", "stopping"].includes(launcher.runtime.status);
    const label = busy ? "Bitte warten …" : running ? "Stoppen" : "Starten";
    const title = `${escapeHtml(launcher.name)} ${running ? "stoppen" : "starten"} · ${escapeHtml(launcher.command)}`;
    return `<button class="primary-card-action ${running ? "running" : ""}" data-launcher-action="${running ? "stop" : "start"}" data-id="${launcher.id}" data-project-id="${project.id}" title="${title}" ${busy ? "disabled" : ""}><i class="fa-solid ${busy ? "fa-spinner fa-spin" : running ? "fa-stop" : "fa-play"}" aria-hidden="true"></i>${label}</button>`;
  }
  return `<button class="primary-card-action folder" data-project-action="folder" data-project-id="${project.id}"><i class="fa-regular fa-folder-open" aria-hidden="true"></i>${compact ? "Ordner" : "Ordner öffnen"}</button>`;
}

function gitConflictCount(git) {
  const conflictStates = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  return git.files?.filter((file) => conflictStates.has(`${file.indexStatus}${file.worktreeStatus}`)).length || 0;
}

function favoriteIcon(active) {
  return `<i class="${active ? "fa-solid" : "fa-regular"} fa-star favorite-icon" aria-hidden="true"></i>`;
}

function gitStatusPresentation(git) {
  const conflicts = gitConflictCount(git);
  const changed = git.changedFiles ?? git.files?.length ?? (git.staged + git.unstaged + git.untracked);
  if (conflicts) return { kind: "conflict", label: `${conflicts} Konflikt${conflicts === 1 ? "" : "e"}`, title: "Git-Konflikte müssen vor einem Commit gelöst werden" };
  if (git.dirty) return { kind: "changes", label: `${changed}${git.filesTruncated ? "+" : ""} Änderung${changed === 1 ? "" : "en"}`, title: `${changed} Dateien mit offenen Änderungen` };
  if (git.ahead || git.behind) return { kind: git.behind ? "behind" : "ahead", label: `${git.ahead ? `↑${git.ahead}` : ""}${git.ahead && git.behind ? " · " : ""}${git.behind ? `↓${git.behind}` : ""}`, title: "Abstand zum Upstream" };
  return { kind: "clean", label: "sauber", title: "Keine lokalen Git-Änderungen" };
}

function gitBranchMeta(git) {
  const status = gitStatusPresentation(git);
  return `<span class="meta-item git-meta ${status.kind}" title="${escapeHtml(status.title)}">
    <i class="fa-solid fa-code-branch git-branch-icon" aria-hidden="true"></i>
    <code>${escapeHtml(git.branch || "detached")}</code><span class="git-inline-status"><i></i>${escapeHtml(status.label)}</span>
  </span>`;
}

function projectCard(project) {
  const running = projectIsRunning(project);
  const status = projectState(project);
  const [symbol, className] = techClass(project);
  const expanded = state.expandedProjects.has(project.id);
  const focusedLauncher = preferredLauncher(project);
  const top = topLaunchers(project);
  const visibleLaunchers = expanded ? top : focusedLauncher ? [focusedLauncher] : [];
  const favorite = state.favorites.has(project.id);
  const editorName = state.capabilities?.editor.name || "Editor";
  return `<article class="project-card ${className} ${running ? "running" : ""}" data-project="${project.id}" tabindex="0" aria-label="Details zu ${escapeHtml(project.name)} öffnen">
    <div class="card-accent"></div>
    <div class="card-body">
      <div class="card-kicker">
        ${project.thumbnailUrl ? `<img class="card-thumb" src="${escapeHtml(project.thumbnailUrl)}" alt="">` : `<span class="stack-symbol">${escapeHtml(symbol)}</span>`}
        <span class="card-state ${status.kind}"><i></i>${escapeHtml(status.label)}</span>
        <button class="favorite-button ${favorite ? "active" : ""}" data-favorite="${project.id}" data-focus-key="fav-${project.id}" aria-label="${favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}" aria-pressed="${favorite}">${favoriteIcon(favorite)}</button>
      </div>
      <h2 title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</h2>
      <code class="project-path" title="${escapeHtml(project.relativePath)}">${escapeHtml(project.relativePath)}</code>
      ${project.descriptionAuto ? "" : `<p class="project-description">${escapeHtml(project.description)}</p>`}
      <div class="tech-list">${project.technologies.slice(0, 5).map((technology) => `<span class="tech-chip">${escapeHtml(technology)}</span>`).join("")}</div>
      <div class="card-meta">
        ${project.git ? gitBranchMeta(project.git) : `<span class="meta-item">${project.fileCount} Dateien</span>`}
        <span class="meta-time">${relativeTime(project.modifiedAt)}</span>
      </div>
    </div>
    ${top.length ? `<div class="launcher-panel focused-launcher-panel"><div class="launcher-panel-label"><span>${expanded ? "Alle Starter" : "Bevorzugter Starter"}</span><b>${top.length}</b></div>${visibleLaunchers.map(launcherRow).join("")}${top.length > 1 ? `<button class="more-launchers" data-expand="${project.id}">${expanded ? "Auf bevorzugten Starter reduzieren" : `${top.length - 1} weitere Starter anzeigen`}</button>` : ""}</div>` : ""}
    <div class="card-actions">
      ${primaryAction(project)}
      <button class="card-icon-action" data-project-action="editor" data-project-id="${project.id}" aria-label="In ${escapeHtml(editorName)} öffnen" ${state.capabilities?.editor.available ? "" : "disabled"}><i class="fa-solid fa-code" aria-hidden="true"></i><b>Editor</b></button>
      <button class="card-icon-action" data-project-action="terminal" data-project-id="${project.id}" aria-label="Terminal hier öffnen" ${state.capabilities?.terminal.available ? "" : "disabled"}><i class="fa-solid fa-terminal" aria-hidden="true"></i><b>Terminal</b></button>
      <button class="card-icon-action" data-project-action="folder" data-project-id="${project.id}" aria-label="Ordner öffnen"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><b>Ordner</b></button>
      <button class="card-icon-action" data-copy-path="${project.id}" aria-label="Pfad kopieren"><i class="fa-regular fa-copy" aria-hidden="true"></i><b>Pfad</b></button>
    </div>
  </article>`;
}

function renderPatch(patch) {
  if (!patch) return '<div class="diff-empty">Für diese Änderung hat Git keinen Text-Patch erzeugt.</div>';
  const sourceLines = patch.replace(/\r\n/g, "\n").split("\n");
  const limited = sourceLines.slice(0, 2500);
  let oldLine = null;
  let newLine = null;
  const html = limited.map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return `<div class="diff-line hunk"><span></span><span></span><code>${escapeHtml(line)}</code></div>`;
    }
    let type = "meta";
    let oldNumber = "";
    let newNumber = "";
    if (line.startsWith("+") && !line.startsWith("+++")) {
      type = "addition"; newNumber = newLine ?? ""; if (newLine !== null) newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      type = "deletion"; oldNumber = oldLine ?? ""; if (oldLine !== null) oldLine += 1;
    } else if (line.startsWith(" ")) {
      type = "context"; oldNumber = oldLine ?? ""; newNumber = newLine ?? ""; if (oldLine !== null) oldLine += 1; if (newLine !== null) newLine += 1;
    }
    return `<div class="diff-line ${type}"><span>${oldNumber}</span><span>${newNumber}</span><code>${escapeHtml(line || " ")}</code></div>`;
  }).join("");
  return html + (sourceLines.length > limited.length ? '<div class="diff-limit-note">Darstellung nach 2.500 Zeilen gekürzt.</div>' : "");
}

function shortAgo(isoDate) {
  if (!isoDate) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 60_000));
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "gestern";
  if (days < 30) return `vor ${days} Tagen`;
  const months = Math.round(days / 30);
  return months < 12 ? `vor ${months} Mon.` : `vor ${Math.round(months / 12)} J.`;
}

function sinceTime(isoDate) {
  if (!isoDate) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 60_000));
  if (minutes < 1) return "gerade gestartet";
  if (minutes < 60) return `seit ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `seit ${hours} Std.` : `seit ${Math.floor(hours / 24)} ${Math.floor(hours / 24) === 1 ? "Tag" : "Tagen"}`;
}

const displayUrl = (url) => String(url || "").replace(/^https?:\/\//, "").replace(/\/$/, "");

function rowAction(project) {
  if (project.isSelf) return '<span class="wb-quiet">läuft bereits</span>';
  const launcher = activeLauncher(project);
  if (launcher) {
    const status = launcher.runtime.status;
    if (status === "starting" || status === "stopping") return `<button type="button" class="wb-btn" disabled><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>${status === "starting" ? "startet …" : "stoppt …"}</button>`;
    const url = launcher.runtime.url;
    return `${url ? `<a class="wb-btn run" href="${escapeHtml(url)}" data-open-id="${project.id}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>Öffnen</a>` : ""}<button type="button" class="wb-btn ${url ? "icon" : ""}" data-launcher-action="stop" data-id="${launcher.id}" aria-label="${escapeHtml(launcher.name)} stoppen" title="${escapeHtml(launcher.name)} stoppen"><i class="fa-solid fa-stop" aria-hidden="true"></i>${url ? "" : "Stoppen"}</button>`;
  }
  const preferred = preferredLauncher(project);
  if (preferred) return `<button type="button" class="wb-btn primary" data-launcher-action="start" data-id="${preferred.id}" title="${escapeHtml(preferred.name)} starten · ${escapeHtml(preferred.command)}"><i class="fa-solid fa-play" aria-hidden="true"></i>Starten</button>`;
  const url = browserUrl(project);
  if (url) return `<a class="wb-btn" href="${escapeHtml(url)}" data-open-id="${project.id}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>Öffnen</a>`;
  return `<button type="button" class="wb-btn" data-project-action="folder" data-project-id="${project.id}"><i class="fa-regular fa-folder-open" aria-hidden="true"></i>Ordner</button>`;
}

function projectRow(project) {
  const launcher = activeLauncher(project);
  const failed = project.launchers.find((item) => item.runtime.status === "error");
  const status = project.isSelf ? "self" : launcher?.runtime.status === "running" ? "run" : launcher ? "busy" : failed ? "error" : "";
  const statusTitle = { self: "DevHub selbst", run: "läuft", busy: "wird gestartet oder gestoppt", error: "Starter abgebrochen" }[status] || "bereit";
  const live = project.isSelf ? `<span class="wb-live">diese Instanz · ${escapeHtml(location.host)}</span>`
    : launcher ? `<span class="wb-live">${escapeHtml(launcher.name)}${launcher.runtime.url ? ` · ${escapeHtml(displayUrl(launcher.runtime.url))}` : ` · ${statusLabels[launcher.runtime.status]}`}</span>`
    : failed ? `<span class="wb-live error">${escapeHtml(failed.name)} · abgebrochen</span>` : "";
  const tech = project.technologies.slice(0, 3);
  const more = project.technologies.length - tech.length;
  const git = project.git ? gitStatusPresentation(project.git) : null;
  const favorite = state.favorites.has(project.id);
  // Die Auswahl setzt renderPanel nachträglich, damit Zeilen beim Wechseln nicht neu entstehen und den Fokus behalten.
  return `<article class="wb-row ${status}" data-project="${project.id}" tabindex="0" role="button" aria-pressed="false" aria-label="${escapeHtml(project.name)}">
    <span class="wb-status ${status}" title="${statusTitle}"></span>
    <span class="wb-row-name"><strong>${escapeHtml(project.name)}${favorite ? ' <i class="fa-solid fa-star wb-fav" aria-label="Favorit"></i>' : ""}</strong><small><span>${escapeHtml(project.relativePath)}</span>${live}</small></span>
    <span class="wb-techs">${tech.map((technology) => `<span class="wb-tech">${escapeHtml(technology)}</span>`).join("")}${more > 0 ? `<span class="wb-tech" title="${escapeHtml(project.technologies.slice(3).join(", "))}">+${more}</span>` : ""}</span>
    <span class="wb-git">${git ? `<i class="fa-solid fa-code-branch" aria-hidden="true"></i><code>${escapeHtml(project.git.branch || "detached")}</code><span class="wb-git-state ${git.kind}" title="${escapeHtml(git.title)}">${escapeHtml(git.label)}</span>` : '<span class="wb-quiet">kein Git</span>'}</span>
    <span class="wb-when" title="${escapeHtml(dateTime(project.modifiedAt))}">${shortAgo(project.modifiedAt)}</span>
    <span class="wb-row-act">${rowAction(project)}</span>
  </article>`;
}

function rememberLogLine(launcherId, entry) {
  const tail = state.logTails.get(launcherId) || [];
  tail.push(entry);
  if (tail.length > 4) tail.splice(0, tail.length - 4);
  state.logTails.set(launcherId, tail);
  const project = findLauncher(launcherId)?.project;
  if (project && project.id === state.selectedProjectId) schedulePanelRender();
}

let panelFrame = 0;
function schedulePanelRender() {
  if (panelFrame) return;
  panelFrame = requestAnimationFrame(() => { panelFrame = 0; renderPanel(getVisibleProjects()); });
}

// Für Starter, die schon vor dem Öffnen der Seite liefen, holt DevHub die letzten Zeilen einmal nach.
async function loadMissingLogTails() {
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  if (!project) return;
  for (const launcher of project.launchers.filter((item) => item.runtime.status !== "stopped" && !state.logTails.has(item.id))) {
    state.logTails.set(launcher.id, []);
    try {
      const data = await api(`/api/launchers/${launcher.id}/logs`);
      state.logTails.set(launcher.id, data.logs.slice(-4));
      schedulePanelRender();
    } catch { /* der nächste Live-Eintrag füllt die Vorschau */ }
  }
}

function runBox(launcher) {
  const status = launcher.runtime.status;
  const busy = status === "starting" || status === "stopping";
  const tail = state.logTails.get(launcher.id) || [];
  const lines = tail.length ? tail.map((entry) => `<span class="${escapeHtml(entry.stream)}">${escapeHtml(entry.text)}</span>`).join("\n") : '<span class="wb-quiet">Noch keine Ausgabe.</span>';
  const url = launcher.runtime.url;
  return `<div class="wb-runbox ${status}">
    <div class="wb-runbox-head"><span class="wb-status ${status === "running" ? "run" : status === "error" ? "error" : "busy"}"></span><strong>${escapeHtml(launcher.name)}</strong><small>${status === "running" ? sinceTime(launcher.runtime.startedAt) : status === "error" ? "abgebrochen" : statusLabels[status]}</small></div>
    ${launcher.runtime.message && status === "error" ? `<p class="wb-runbox-error">${escapeHtml(launcher.runtime.message)}</p>` : ""}
    <pre class="wb-log" aria-label="Letzte Ausgabe">${lines}</pre>
    ${launcherParts(launcher)}
    <div class="wb-runbox-actions">
      ${url && status === "running" ? `<a class="wb-btn run" href="${escapeHtml(url)}" data-open-id="${launcher.projectId}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>${escapeHtml(displayUrl(url))}</a>` : ""}
      ${status === "error" ? `<button type="button" class="wb-btn primary" data-launcher-action="start" data-id="${launcher.id}"><i class="fa-solid fa-play" aria-hidden="true"></i>Erneut starten</button>` : `<button type="button" class="wb-btn" data-launcher-action="stop" data-id="${launcher.id}" ${busy ? "disabled" : ""}><i class="fa-solid fa-stop" aria-hidden="true"></i>Stoppen</button><button type="button" class="wb-btn" data-launcher-action="restart" data-id="${launcher.id}" ${busy ? "disabled" : ""}>Neu starten</button>`}
      <button type="button" class="wb-btn ghost" data-log="${launcher.id}">Ganzes Log</button>
    </div>
  </div>`;
}

function starterRow(launcher, preferred) {
  const status = launcher.runtime.status;
  const action = status === "running" ? '<span class="wb-quiet">läuft</span>'
    : status === "starting" || status === "stopping" ? `<span class="wb-quiet"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${statusLabels[status]}</span>`
    : `<button type="button" class="wb-btn ${preferred ? "primary" : ""}" data-launcher-action="start" data-id="${launcher.id}" title="${escapeHtml(launcher.command)}"><i class="fa-solid fa-play" aria-hidden="true"></i>Starten</button>`;
  return `<div class="wb-starter"><div><strong>${escapeHtml(launcher.name)}</strong><code>${escapeHtml(launcher.command)}${launcher.port ? ` · Port ${launcher.port}` : ""}${launcher.parts?.length ? ` · startet ${launcher.parts.length} Teile` : ""}</code>${status === "running" ? "" : launcherParts(launcher)}</div><div class="wb-starter-act">${action}</div></div>`;
}

function panelBlock(label, body) {
  return `<section class="wb-panel-block"><span class="wb-label">${label}</span>${body}</section>`;
}

function projectPanelHtml(project) {
  const favorite = state.favorites.has(project.id);
  const editorName = state.capabilities?.editor.name || "Editor";
  const blocks = [];
  if (project.isSelf) blocks.push(panelBlock("Läuft", `<div class="wb-runbox running"><div class="wb-runbox-head"><span class="wb-status self"></span><strong>Diese DevHub-Instanz</strong><small>${escapeHtml(location.host)}</small></div><p class="wb-hint">DevHub bietet sich nicht selbst zum Starten an, weil es bereits läuft.</p></div>`));
  for (const launcher of project.launchers.filter((item) => item.runtime.status !== "stopped")) blocks.push(panelBlock(launcher.runtime.status === "error" ? "Abgebrochen" : "Läuft", runBox(launcher)));
  const top = topLaunchers(project);
  const preferred = preferredLauncher(project);
  if (top.length) {
    const children = project.launchers.filter((launcher) => launcher.parentId);
    const childList = children.length ? `<details class="wb-children"><summary>Teile einzeln starten <b>${children.length}</b></summary><p class="wb-hint">Diese Skripte startet ${escapeHtml(top.find((launcher) => launcher.parts?.length)?.name || "der Hauptstarter")} bereits mit. Einzeln brauchst du sie nur zur Fehlersuche.</p>${children.map((launcher) => starterRow(launcher, false)).join("")}</details>` : "";
    blocks.push(panelBlock(top.length === 1 ? "Starter" : `Starter · ${top.length}`, top.map((launcher) => starterRow(launcher, launcher.id === preferred?.id)).join("") + childList));
  } else if (!project.isSelf) {
    blocks.push(panelBlock("Starter", '<p class="wb-hint">Kein Starter erkannt. Editor, Terminal und Ordner stehen trotzdem bereit.</p>'));
  }
  if (project.defaultUrl) {
    const web = webOnline();
    const stack = state.stack;
    blocks.push(panelBlock(`Adresse über ${escapeHtml(stack?.name || "den Webserver")}`, `<div class="wb-addr ${web ? "" : "off"}"><i class="fa-solid fa-globe" aria-hidden="true"></i>${web ? `<a href="${escapeHtml(project.defaultUrl)}" data-open-id="${project.id}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayUrl(project.defaultUrl))}</a>` : `<span>${escapeHtml(displayUrl(project.defaultUrl))}</span>`}<small>${web ? "erreichbar" : `${escapeHtml(stack?.webServerName || "Webserver")} ist aus`}</small></div>${!web && stackAction("start") ? `<button type="button" class="wb-btn" data-stack-action="start" ${state.stackPending ? "disabled" : ""}>Dienste starten</button>` : ""}`));
  }
  const git = project.git;
  if (git) {
    const presentation = gitStatusPresentation(git);
    const remote = git.remoteUrl ? displayUrl(git.remoteUrl).replace(/\.git$/, "") : null;
    blocks.push(panelBlock("Git", `<div class="wb-commit"><div class="wb-commit-meta"><i class="fa-solid fa-code-branch" aria-hidden="true"></i><code>${escapeHtml(git.branch || "detached")}</code><span class="wb-git-state ${presentation.kind}">${escapeHtml(presentation.label)}</span>${git.lastCommit ? `<small>${shortAgo(git.lastCommit.date)}</small>` : ""}</div>${git.lastCommit ? `<span class="wb-commit-subject">${escapeHtml(git.lastCommit.subject)}</span><code class="wb-commit-hash">${escapeHtml(git.lastCommit.hash)}${remote ? ` · ${escapeHtml(remote)}` : ""}</code>` : '<span class="wb-hint">Noch kein Commit.</span>'}</div>
      <div class="wb-inline-actions"><button type="button" class="wb-btn" data-open-git-workspace="${project.id}"><i class="fa-solid fa-code-branch" aria-hidden="true"></i>In der Git-Zentrale</button>${git.remoteUrl ? `<a class="wb-btn ghost" href="${escapeHtml(git.remoteUrl)}" target="_blank" rel="noopener noreferrer">Remote öffnen</a>` : ""}</div>`));
  } else {
    blocks.push(panelBlock("Git", `<p class="wb-hint">Kein Git-Repository. In der Git-Zentrale kannst du eines anlegen.</p><div class="wb-inline-actions"><button type="button" class="wb-btn" data-open-git-workspace="${project.id}">Zur Git-Zentrale</button></div>`));
  }
  const editor = state.capabilities?.editor.available;
  const terminal = state.capabilities?.terminal.available;
  blocks.push(panelBlock("Öffnen in", `<div class="wb-open-in">
    <button type="button" data-project-action="editor" data-project-id="${project.id}" ${editor ? "" : "disabled"} title="${editor ? `In ${escapeHtml(editorName)} öffnen` : "Kein Editor gefunden"}"><i class="fa-solid fa-code" aria-hidden="true"></i>${escapeHtml(editor ? editorName : "Editor")}</button>
    <button type="button" data-project-action="terminal" data-project-id="${project.id}" ${terminal ? "" : "disabled"}><i class="fa-solid fa-terminal" aria-hidden="true"></i>Terminal</button>
    <button type="button" data-project-action="folder" data-project-id="${project.id}"><i class="fa-regular fa-folder-open" aria-hidden="true"></i>Ordner</button>
    <button type="button" data-copy-path="${project.id}"><i class="fa-regular fa-copy" aria-hidden="true"></i>Pfad</button>
  </div>`));
  blocks.push(panelBlock("Technik", `<div class="wb-techs all">${project.technologies.map((technology) => `<span class="wb-tech">${escapeHtml(technology)}</span>`).join("")}</div><p class="wb-facts">${project.fileCount.toLocaleString("de-DE")} Dateien · zuletzt geändert ${escapeHtml(dateTime(project.modifiedAt))}</p>`));
  return `<header class="wb-panel-head">
      <div><h2>${escapeHtml(project.name)}</h2><code>${escapeHtml(projectPath(project))}</code></div>
      <button type="button" class="wb-btn icon ghost ${favorite ? "on" : ""}" data-favorite="${project.id}" aria-pressed="${favorite}" aria-label="${favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}" title="${favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}">${favoriteIcon(favorite)}</button>
      <button type="button" class="wb-btn icon ghost" data-close-panel aria-label="Details schließen" title="Details schließen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    </header>
    ${project.descriptionAuto || !project.description ? "" : `<p class="wb-panel-desc">${escapeHtml(project.description)}</p>`}
    ${blocks.join("")}`;
}

const widePanel = matchMedia("(min-width: 1180px)");

// Auf breiten Bildschirmen steht der Detailbereich in der Liste dauerhaft neben den Zeilen,
// sonst erscheint er erst nach einer Auswahl als Ebene.
function renderPanel(visibleProjects) {
  let project = state.projects.find((item) => item.id === state.selectedProjectId);
  const listAutoPanel = widePanel.matches && state.view === "list" && !state.panelDismissed;
  if (!project && listAutoPanel && visibleProjects.length) project = visibleProjects[0];
  const show = state.page === "projects" && Boolean(project) && (state.panelOpen || listAutoPanel);
  elements.panel.hidden = !show;
  document.querySelector("#project-split").classList.toggle("with-panel", show);
  document.body.classList.toggle("wb-panel-overlay", show && !widePanel.matches);
  if (!show) {
    elements.grid.querySelectorAll(".wb-row.selected").forEach((row) => { row.classList.remove("selected"); row.setAttribute("aria-pressed", "false"); });
    return;
  }
  if (project.id !== state.selectedProjectId) state.selectedProjectId = project.id;
  const html = projectPanelHtml(project);
  if (elements.panel.__devhubHtml !== html) {
    const scroll = elements.panel.scrollTop;
    const openDetails = elements.panel.querySelector("details[open]") !== null;
    elements.panel.__devhubHtml = html;
    elements.panel.innerHTML = html;
    if (openDetails) elements.panel.querySelector("details")?.setAttribute("open", "");
    elements.panel.scrollTop = scroll;
  }
  elements.grid.querySelectorAll(".wb-row").forEach((row) => {
    const selected = row.dataset.project === project.id;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-pressed", String(selected));
  });
}
widePanel.addEventListener("change", () => render(false));

function renderRemote() {
  const github = state.github;
  const missing = github?.available && state.page === "projects" && !state.query && state.filter === "all"
    ? github.repositories.filter((repo) => !gitWorkspace.isInWorkspace(repo)).sort((a, b) => new Date(b.pushedAt || 0) - new Date(a.pushedAt || 0))
    : [];
  elements.remote.hidden = !missing.length;
  if (!missing.length) return;
  const shown = missing.slice(0, 8);
  const html = `<header><strong>Auf GitHub, nicht im Workspace</strong><span>${missing.length} ${missing.length === 1 ? "Repository" : "Repositories"} von ${escapeHtml(github.account || "GitHub")}</span></header>
    <div class="wb-remote-list">${shown.map((repo) => `<span class="wb-remote-repo" title="${escapeHtml(repo.description || repo.nameWithOwner)}"><i class="fa-solid ${repo.isPrivate ? "fa-lock" : "fa-book"}" aria-hidden="true"></i><span>${escapeHtml(repo.name)}</span><button type="button" data-clone-repo="${escapeHtml(repo.nameWithOwner)}" data-clone-name="${escapeHtml(repo.name)}">Klonen</button></span>`).join("")}${missing.length > shown.length ? `<button type="button" class="wb-remote-more" data-palette-query="klonen ">${missing.length - shown.length} weitere</button>` : ""}</div>`;
  if (elements.remote.__devhubHtml !== html) { elements.remote.__devhubHtml = html; elements.remote.innerHTML = html; }
}

function renderGitPage() {
  gitWorkspace.render();
}

function renderWorkspaceNavigation() {
  const gitActive = state.page === "git";
  document.body.classList.toggle("git-page-active", gitActive);
  elements.projectsPage.hidden = gitActive;
  elements.gitPage.hidden = !gitActive;
  document.querySelector("#sidebar-git-repositories").hidden = !gitActive;
  document.querySelectorAll("[data-page]").forEach((button) => {
    const active = button.dataset.page === "git" ? gitActive : !gitActive && (!button.dataset.filter || button.dataset.filter === "all" || button.dataset.filter === state.filter);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const pageTitle = gitActive ? "Git-Zentrale" : "Projekte";
  const searchLabel = gitActive ? "Repositories durchsuchen" : "Projekte durchsuchen";
  document.querySelector("#workspace-page-title").textContent = pageTitle;
  const count = document.querySelector("#workspace-page-count");
  count.textContent = gitActive ? state.projects.filter(project => project.git).length : state.projects.length;
  count.setAttribute("aria-label", gitActive ? "Anzahl Repositories" : "Anzahl Projekte");
  document.querySelector("#workspace-search-label").textContent = searchLabel;
  elements.search.placeholder = `${searchLabel} …`;
  document.querySelector("#workspace-primary-label").textContent = gitActive ? "Repository hinzufügen" : "Workspace auswählen";
  document.querySelector("#workspace-primary-icon").className = gitActive ? "fa-solid fa-plus" : "fa-regular fa-folder-open";
  const primary = document.querySelector("#workspace-primary-action");
  primary.hidden = !gitActive;
  if (!gitActive) primary.disabled = false;
  elements.svc.hidden = gitActive;
}

function loadActiveGitSurface(force = false) {
  if (state.page === "git" && state.activeGitProjectId) gitWorkspace.load(state.activeGitProjectId, force);
}

function setWorkspacePage(page, projectId = null) {
  const nextPage = page === "git" ? "git" : "projects";
  if (projectId) {
    state.activeGitProjectId = projectId;
    localStorage.setItem("devhub_git_project", projectId);
  }
  state.page = nextPage;
  elements.search.value = nextPage === "git" ? state.gitQuery : state.query;
  history.replaceState(null, "", nextPage === "git" ? "#git" : location.pathname + location.search);
  render(false);
  loadActiveGitSurface();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openGitWorkspace(projectId) {
  setWorkspacePage("git", projectId);
}

// Wählt ein Projekt für den Detailbereich. Auf schmalen Bildschirmen öffnet sich der Bereich als Ebene über der Liste.
function openProjectDetails(projectId, { focusRow = false } = {}) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.selectedProjectId = projectId;
  state.panelOpen = true;
  state.panelDismissed = false;
  localStorage.setItem("devhub_selected_project", projectId);
  if (state.page !== "projects") setWorkspacePage("projects");
  else render();
  const row = elements.grid.querySelector(`[data-project="${CSS.escape(projectId)}"]`);
  row?.scrollIntoView({ block: "nearest" });
  if (focusRow) row?.focus({ preventScroll: true });
  loadMissingLogTails();
}

function closeProjectPanel() {
  state.panelOpen = false;
  state.panelDismissed = true;
  render();
}

function renderStats() {
  const count = (filter) => state.projects.filter(filter).length;
  const running = count(projectIsRunning);
  const attention = count((project) => projectAttentionReasons(project).length > 0);
  const favorites = count((project) => state.favorites.has(project.id));
  const recent = count((project) => state.recent.includes(project.id));
  elements.allCount.textContent = state.projects.length;
  elements.gitRepositoryCount.textContent = count((project) => project.git);
  elements.runningFilterCount.textContent = running;
  elements.attentionCount.textContent = attention;
  elements.favoriteCount.textContent = favorites || "";
  elements.recentCount.textContent = recent;
  // Ansichten ohne Inhalt verschwinden, die aktive Ansicht bleibt sichtbar.
  document.querySelector("#view-running").hidden = !running && state.filter !== "running";
  document.querySelector("#view-attention").hidden = !attention && state.filter !== "attention";
  document.querySelector("#view-recent").hidden = !recent && state.filter !== "recent";
}

function renderFilterSelects() {
  const techCounts = new Map();
  state.projects.forEach((project) => project.technologies.forEach((technology) => techCounts.set(technology, (techCounts.get(technology) || 0) + 1)));
  const techOptions = '<option value="">Alle Technologien</option>' + [...techCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de"))
    .map(([technology, total]) => `<option value="${escapeHtml(technology)}">${escapeHtml(technology)} · ${total}</option>`).join("");
  if (elements.techSelect.__devhubHtml !== techOptions) { elements.techSelect.__devhubHtml = techOptions; elements.techSelect.innerHTML = techOptions; }
  elements.techSelect.value = state.technology || "";
  elements.techSelect.classList.toggle("active", Boolean(state.technology));
  const categoryCounts = new Map();
  for (const project of state.projects) if (project.categoryPath) categoryCounts.set(project.categoryPath, (categoryCounts.get(project.categoryPath) || 0) + 1);
  const categories = [...categoryCounts.entries()].sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0]), "de"));
  elements.categorySelectWrap.hidden = categories.length === 0;
  const categoryOptions = '<option value="">Alle Kategorien</option>' + categories.map(([categoryPath, total]) => `<option value="${escapeHtml(categoryPath)}">${escapeHtml(categoryLabel(categoryPath))} · ${total}</option>`).join("");
  if (elements.categorySelect.__devhubHtml !== categoryOptions) { elements.categorySelect.__devhubHtml = categoryOptions; elements.categorySelect.innerHTML = categoryOptions; }
  elements.categorySelect.value = state.category || "";
  elements.categorySelect.classList.toggle("active", Boolean(state.category));
}

function stackAction(id) {
  return state.stack?.actions?.find((action) => action.id === id) || null;
}

function hostList(urls) {
  const hosts = urls.map((url) => { try { return new URL(url).host; } catch { return url; } });
  if (hosts.length <= 2) return hosts.join(" und ");
  return `${hosts.slice(0, 2).join(", ")} und ${hosts.length - 2} weitere`;
}

// Projekte, deren Adresse der lokale Webserver ausliefert. Ist er aus, sind genau diese nicht erreichbar.
function stackDependentProjects() {
  return state.projects.filter((project) => project.defaultUrl);
}

function runningLaunchers() {
  return state.projects.flatMap((project) => project.launchers
    .filter((launcher) => launcher.runtime.status === "running")
    .map((launcher) => ({ project, launcher })));
}

function servicePanelHtml() {
  const stack = state.stack;
  if (!stack) return '<p class="wb-svc-note">Dienste werden geprüft …</p>';
  const running = runningLaunchers();
  const runningList = running.length ? `<div class="wb-svc-block"><span class="wb-label">Laufende Starter</span>${running.map(({ project, launcher }) => `<div class="wb-svc-route"><button type="button" data-open-details="${project.id}">${escapeHtml(project.name)}<small>${escapeHtml(launcher.name)}</small></button>${launcher.runtime.url ? `<a href="${escapeHtml(launcher.runtime.url)}" data-open-id="${project.id}" target="_blank" rel="noopener noreferrer">${escapeHtml(runtimePort(launcher) || "öffnen")} <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ""}</div>`).join("")}</div>` : "";
  if (!stack.installed) {
    return `<div class="wb-svc-head"><i class="fa-solid fa-server" aria-hidden="true"></i><strong>Kein lokaler Stack</strong></div>
      <p class="wb-svc-note">DevHub hat weder Laragon noch Herd noch Valet gefunden. Projekte mit eigenem Starter laufen trotzdem.</p>${runningList}`;
  }
  const web = webOnline();
  const rows = [
    [stack.webServerName || "Webserver", web ? "läuft" : "aus", web],
    ["Datenbank", stack.database || "nicht aktiv", Boolean(stack.database)],
    ...(stack.mail ? [["Mail", "aktiv", true]] : []),
    [`${stack.name}-App`, stack.appRunning ? "geöffnet" : "geschlossen", stack.appRunning]
  ];
  const dependent = stackDependentProjects();
  const why = web
    ? (dependent.length ? `${dependent.length === 1 ? "Die lokale Adresse ist" : `Alle ${dependent.length} lokalen Adressen sind`} erreichbar.` : `${stack.webServerName || "Der Webserver"} läuft.`)
    : dependent.length ? `Ohne ${escapeHtml(stack.webServerName || "Webserver")} ${dependent.length === 1 ? "ist" : "sind"} ${escapeHtml(hostList(dependent.map((project) => project.defaultUrl)))} nicht erreichbar.`
    : "Kein Projekt braucht gerade den Webserver.";
  const toggle = stackAction(web ? "stop" : "start");
  const open = stackAction("open");
  const reload = stackAction("reload");
  const pending = state.stackPending;
  return `<div class="wb-svc-head"><i class="fa-solid fa-server" aria-hidden="true"></i><strong>${escapeHtml(stack.name)}</strong><small>${stack.sites ? `${stack.sites} ${stack.sites === 1 ? "Site" : "Sites"}${stack.tld ? ` unter .${escapeHtml(stack.tld)}` : ""}` : "keine Sites"}</small></div>
    <div class="wb-svc-list">${rows.map(([name, label, on]) => `<div class="wb-svc-row"><i class="wb-dot ${on ? "on" : ""}" aria-hidden="true"></i><span>${escapeHtml(name)}</span><small>${escapeHtml(label)}</small></div>`).join("")}</div>
    <p class="wb-svc-note">${why}</p>
    <div class="wb-svc-actions">
      ${toggle ? `<button type="button" class="wb-btn ${web ? "" : "primary"}" data-stack-action="${web ? "stop" : "start"}" title="${escapeHtml(toggle.description)}" ${pending ? "disabled" : ""}>${pending === "start" || pending === "stop" ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>' : ""}${web ? "Dienste stoppen" : "Dienste starten"}</button>` : ""}
      ${reload ? `<button type="button" class="wb-btn" data-stack-action="reload" title="${escapeHtml(reload.description)}" ${pending ? "disabled" : ""}>Neu starten</button>` : ""}
      ${open ? `<button type="button" class="wb-btn" data-stack-action="open" title="${escapeHtml(open.description)}" ${pending ? "disabled" : ""}>${escapeHtml(stack.name)} öffnen</button>` : ""}
    </div>${toggle?.description && !web ? `<p class="wb-svc-foot">${escapeHtml(toggle.description)}</p>` : ""}${runningList}`;
}

function renderServices() {
  const stack = state.stack;
  const web = webOnline();
  const tone = !stack ? "" : !stack.installed ? "none" : web ? "ok" : stackDependentProjects().length ? "warn" : "idle";
  elements.svcPill.dataset.tone = tone;
  elements.svcName.textContent = !stack ? "Dienste" : stack.installed ? stack.name : "Kein Stack";
  elements.svcState.textContent = !stack ? "werden geprüft" : !stack.installed ? "nur eigene Starter" : web ? "läuft" : `${stack.webServerName || "Webserver"} aus`;
  elements.svcPill.title = !stack ? "" : stack.installed ? `${stack.name}: ${web ? `${stack.webServerName} läuft` : `${stack.webServerName} ist aus`}` : "Kein lokaler Stack erkannt";
  if (!elements.svcPanel.hidden) {
    const html = servicePanelHtml();
    if (elements.svcPanel.__devhubHtml !== html) { elements.svcPanel.__devhubHtml = html; elements.svcPanel.innerHTML = html; }
  }
  renderAttention();
}

function renderAttention() {
  const stack = state.stack;
  const items = [];
  const dependent = stackDependentProjects();
  if (stack?.installed && !webOnline() && dependent.length && state.page === "projects") {
    const start = stackAction("start");
    items.push(`<div class="wb-attention-item warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><p><b>${escapeHtml(stack.webServerName || "Der Webserver")} ist aus.</b> Deshalb ${dependent.length === 1 ? "ist" : "sind"} ${escapeHtml(hostList(dependent.map((project) => project.defaultUrl)))} gerade nicht erreichbar.</p>${start ? `<button type="button" class="wb-btn primary" data-stack-action="start" ${state.stackPending ? "disabled" : ""}>${state.stackPending === "start" ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>' : ""}Dienste starten</button>` : ""}</div>`);
  }
  const failed = state.projects.flatMap((project) => project.launchers.filter((launcher) => launcher.runtime.status === "error").map((launcher) => ({ project, launcher })));
  if (failed.length) {
    const first = failed[0];
    items.push(`<div class="wb-attention-item danger"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><p><b>${failed.length === 1 ? "Ein Starter ist" : `${failed.length} Starter sind`} abgebrochen.</b> ${escapeHtml(first.project.name)} · ${escapeHtml(first.launcher.name)}${first.launcher.runtime.message ? `: ${escapeHtml(first.launcher.runtime.message)}` : ""}</p><button type="button" class="wb-btn" data-log="${first.launcher.id}">Log ansehen</button></div>`);
  }
  const html = items.join("");
  if (elements.attention.__devhubHtml !== html) { elements.attention.__devhubHtml = html; elements.attention.innerHTML = html; }
  elements.attention.hidden = !items.length;
}

function setServicePanel(open) {
  elements.svcPanel.hidden = !open;
  elements.svcPill.setAttribute("aria-expanded", String(open));
  if (open) { elements.svcPanel.__devhubHtml = null; renderServices(); }
}

const cardTemplate = document.createElement("template");

// Projekte ohne Kategorieordner liegen direkt im Workspace und bekommen eine eigene Sammelgruppe am Ende.
const UNCATEGORIZED_GROUP = " root";

function projectGroups(projects) {
  const groups = new Map();
  for (const project of projects) {
    const key = project.categoryPath || UNCATEGORIZED_GROUP;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(project);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({ key, label: key === UNCATEGORIZED_GROUP ? "Ohne Kategorie" : categoryLabel(key), items }))
    .sort((a, b) => Number(a.key === UNCATEGORIZED_GROUP) - Number(b.key === UNCATEGORIZED_GROUP) || a.label.localeCompare(b.label, "de"));
}

function groupHeading(group) {
  const filterable = group.key !== UNCATEGORIZED_GROUP;
  const title = filterable ? `Nur „${group.label}“ anzeigen` : "Projekte direkt im Workspace";
  return `<div class="group-heading" ${filterable ? `data-group-filter="${escapeHtml(group.key)}"` : ""} title="${escapeHtml(title)}" role="${filterable ? "button" : "presentation"}" ${filterable ? 'tabindex="0"' : ""}>
    <span class="group-heading-label">${escapeHtml(group.label)}</span>
    <span class="group-heading-count">${group.items.length}</span>
  </div>`;
}

function gridEntries(projects) {
  const list = state.view === "list";
  const renderer = list ? projectRow : projectCard;
  const head = list && projects.length ? [{ key: "head", html: '<div class="wb-row-head" aria-hidden="true"><span></span><span>Projekt</span><span>Technik</span><span>Git</span><span>Geändert</span><span>Aktion</span></div>' }] : [];
  if (state.group !== "category") return [...head, ...projects.map((project) => ({ key: `project:${project.id}`, html: renderer(project) }))];
  const entries = [...head];
  for (const group of projectGroups(projects)) {
    entries.push({ key: `group:${group.key}`, html: groupHeading(group) });
    for (const project of group.items) entries.push({ key: `project:${project.id}`, html: renderer(project) });
  }
  return entries;
}

function syncProjectGrid(projects) {
  const grid = elements.grid;
  const existing = new Map();
  for (const child of grid.children) {
    if (child.dataset.gridKey) existing.set(child.dataset.gridKey, child);
  }
  const desired = [];
  for (const { key, html } of gridEntries(projects)) {
    const current = existing.get(key);
    existing.delete(key);
    if (current && current.__devhubHtml === html) {
      desired.push(current);
      continue;
    }
    cardTemplate.innerHTML = html;
    const fresh = cardTemplate.content.firstElementChild;
    fresh.remove();
    fresh.dataset.gridKey = key;
    fresh.__devhubHtml = html;
    if (current) {
      fresh.classList.add("card-refresh");
      current.replaceWith(fresh);
    }
    desired.push(fresh);
  }
  for (const stale of existing.values()) stale.remove();
  let cursor = grid.firstElementChild;
  for (const node of desired) {
    if (node === cursor) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    if (node.isConnected) node.classList.add("card-refresh");
    grid.insertBefore(node, cursor);
  }
}

function render(preserveFocus = true) {
  const activeElement = document.activeElement;
  const focusKey = preserveFocus ? activeElement?.dataset?.focusKey : null;
  const focusSelection = focusKey && typeof activeElement.selectionStart === "number"
    ? [activeElement.selectionStart, activeElement.selectionEnd, activeElement.selectionDirection || "none"]
    : null;
  // Eine umbenannte oder verschobene Kategorie darf die Liste nicht dauerhaft leer filtern.
  if (state.category && state.projects.length && !state.projects.some((project) => project.categoryPath === state.category)) {
    state.category = null;
    localStorage.removeItem("devhub_category");
  }
  const projects = getVisibleProjects();
  const filtered = Boolean(state.query.trim() || state.technology || state.category || state.filter !== "all");
  elements.resultCount.textContent = projects.length;
  elements.resultTotal.textContent = state.projects.length;
  elements.resultCount.closest(".result-label").hidden = !filtered;
  elements.resetFilters.hidden = !filtered;
  elements.grid.classList.toggle("wb-rows", state.view === "list");
  elements.grid.classList.toggle("grouped", state.group === "category");
  elements.groupToggle.classList.toggle("active", state.group === "category");
  elements.groupToggle.setAttribute("aria-pressed", String(state.group === "category"));
  syncProjectGrid(projects);
  elements.grid.hidden = projects.length === 0;
  elements.empty.hidden = projects.length !== 0;
  const noWorkspaceProjects = state.projects.length === 0;
  elements.emptyTitle.textContent = noWorkspaceProjects ? "Keine Projektordner erkannt" : "Keine passenden Projekte";
  elements.emptyMessage.textContent = noWorkspaceProjects ? "Wähle den Ordner aus, der deine Projekt- oder Kategorieordner enthält, oder prüfe die Leserechte." : "Ändere Suche, Ansicht, Kategorie oder Technologie-Filter.";
  elements.emptyAction.textContent = noWorkspaceProjects ? "Workspace auswählen" : "Filter zurücksetzen";
  renderStats();
  renderFilterSelects();
  renderServices();
  renderPanel(projects);
  renderRemote();
  renderGitPage();
  renderWorkspaceNavigation();
  document.querySelectorAll("[data-view]").forEach((button) => { button.classList.toggle("active", button.dataset.view === state.view); button.setAttribute("aria-pressed", String(button.dataset.view === state.view)); });
  document.querySelectorAll("[data-mobile-filter]").forEach((button) => { const active = button.dataset.mobileFilter === state.filter; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); });
  if (focusKey) {
    const target = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (target) {
      target.focus({ preventScroll: true });
      if (focusSelection && typeof target.setSelectionRange === "function") {
        try { target.setSelectionRange(focusSelection[0], focusSelection[1], focusSelection[2]); } catch { /* Elementtyp ohne Auswahl */ }
      }
    }
  }
}

function toast(message, type = "success") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  if (type === "error") node.setAttribute("role", "alert");
  elements.toastRegion.append(node);
  setTimeout(() => node.remove(), type === "error" ? 6500 : 3800);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.method && options.method !== "GET" ? { "X-DevHub-Token": state.token } : {}), ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function bootstrap() {
  try {
    const data = await api("/api/bootstrap");
    Object.assign(state, { token: data.token, projects: data.projects, stack: data.stack, capabilities: data.capabilities });
    setWorkspaceRoot(data.root);
    elements.workspaceBrowse.hidden = !data.capabilities.folderPicker;
    elements.sort.value = state.sort;
    render(false);
    loadActiveGitSurface();
    loadMissingLogTails();
    setTimeout(connectEvents, 1000);
    setTimeout(loadGithubRepositories, 1500);
    setInterval(refreshStack, 8000);
  } catch (error) {
    elements.scanStatus.textContent = "Verbindung fehlgeschlagen";
    toast(error.message, "error");
  }
}

async function rescan() {
  elements.rescan.classList.add("loading"); elements.rescan.disabled = true; elements.rescan.setAttribute("aria-busy", "true");
  elements.scanStatus.textContent = `${state.root} wird analysiert …`;
  try {
    const data = await api("/api/rescan", { method: "POST" });
    state.projects = data.projects;
    render(false);
    loadActiveGitSurface(true);
    elements.scanStatus.textContent = "Gerade aktualisiert";
    toast(`${state.projects.length} Projekte neu eingelesen.`);
  } catch (error) { elements.scanStatus.textContent = "Einlesen fehlgeschlagen"; toast(error.message, "error"); }
  finally { elements.rescan.classList.remove("loading"); elements.rescan.disabled = false; elements.rescan.removeAttribute("aria-busy"); }
}

function openWorkspaceSettings() {
  elements.workspaceInput.value = state.root;
  elements.workspaceDialog.showModal();
  setTimeout(() => { elements.workspaceInput.focus(); elements.workspaceInput.select(); }, 0);
}

async function pickWorkspace() {
  elements.workspaceBrowse.disabled = true;
  elements.workspaceBrowse.textContent = "Auswahl läuft …";
  try {
    const data = await api("/api/settings/workspace/pick", { method: "POST" });
    if (data.root) elements.workspaceInput.value = data.root;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements.workspaceBrowse.disabled = false;
    elements.workspaceBrowse.textContent = "Ordner wählen";
  }
}

async function saveWorkspace(event) {
  event.preventDefault();
  const root = elements.workspaceInput.value.trim();
  if (!root || root === state.root) {
    elements.workspaceDialog.close();
    return;
  }
  elements.workspaceSave.disabled = true;
  elements.workspaceSave.textContent = "Workspace wird eingelesen …";
  try {
    const data = await api("/api/settings/workspace", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root })
    });
    setWorkspaceRoot(data.root);
    state.projects = data.projects;
    state.activeGitProjectId = null;
    state.selectedProjectId = null;
    elements.workspaceDialog.close();
    render(false);
    loadActiveGitSurface();
    elements.scanStatus.textContent = "Workspace aktualisiert";
    toast(`Workspace gewechselt: ${data.root}`);
  } catch (error) {
    toast(error.message, "error");
    elements.workspaceInput.focus();
  } finally {
    elements.workspaceSave.disabled = false;
    elements.workspaceSave.textContent = "Speichern & einlesen";
  }
}

async function refreshStack() {
  try { state.stack = (await api("/api/stack/status")).stack; renderServices(); } catch { /* next poll retries */ }
}

function webOnline() {
  return Boolean(state.stack?.webServer);
}

async function runStackAction(action) {
  if (state.stackPending) return;
  state.stackPending = action;
  renderServices();
  try {
    const data = await api(`/api/stack/${action}`, { method: "POST" });
    state.stack = data.stack;
    toast(data.message);
    if (action === "reload") setTimeout(rescan, 1100);
    if (action === "start" || action === "stop") setTimeout(refreshStack, 2500);
  } catch (error) { toast(error.message, "error"); }
  finally { state.stackPending = null; renderServices(); }
}

async function runProjectAction(projectId, action) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  try {
    const data = await api(`/api/projects/${projectId}/${action}`, { method: "POST" });
    markRecent(projectId); renderStats(); toast(data.message);
  } catch (error) { toast(error.message, "error"); }
}

async function runLauncher(id, action) {
  const found = findLauncher(id);
  if (!found) return;
  const oldStatus = found.launcher.runtime.status;
  found.launcher.runtime.status = action === "stop" ? "stopping" : "starting";
  markRecent(found.project.id); render();
  try {
    const data = await api(`/api/launchers/${id}/${action}`, { method: "POST" });
    found.launcher.runtime = data.runtime;
    toast(action === "stop" ? `${found.launcher.name} wird gestoppt.` : action === "restart" ? `${found.launcher.name} wurde neu gestartet.` : `${found.launcher.name} gestartet.`);
  } catch (error) { found.launcher.runtime.status = oldStatus === "running" ? "running" : "error"; found.launcher.runtime.message = error.message; toast(error.message, "error"); }
  render();
}

function updateRuntime(launcherId, runtime) {
  const found = findLauncher(launcherId);
  if (!found) return;
  found.launcher.runtime = runtime;
  render();
  if (state.activeLogId === launcherId) updateLogState(runtime);
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("runtime", (event) => { const data = JSON.parse(event.data); updateRuntime(data.launcherId, data.runtime); });
  events.addEventListener("log", (event) => {
    const data = JSON.parse(event.data);
    if (state.activeLogId === data.launcherId) appendLog(data.entry);
    rememberLogLine(data.launcherId, data.entry);
  });
  events.addEventListener("projects", (event) => {
    state.projects = JSON.parse(event.data).projects;
    render();
    loadActiveGitSurface(true);
    elements.scanStatus.textContent = "Automatisch aktualisiert";
  });
  events.addEventListener("workspace", (event) => { const data = JSON.parse(event.data); setWorkspaceRoot(data.root); state.projects = data.projects; render(false); });
  events.onopen = () => { elements.scanStatus.textContent = "Live verbunden"; };
  events.onerror = () => { elements.scanStatus.textContent = "Live-Verbindung wird wiederhergestellt …"; };
}

function updateLogState(runtime) {
  elements.logState.textContent = statusLabels[runtime.status] || runtime.status;
  document.querySelector(".live-indicator").classList.toggle("running", runtime.status === "running");
  elements.restartLog.disabled = ["starting", "stopping"].includes(runtime.status);
}

function logLine(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `<span class="log-line ${entry.stream}"><span class="log-time">${time}</span>${escapeHtml(entry.text)}</span>`;
}

function appendLog(entry) {
  elements.logOutput.querySelector(".log-placeholder")?.remove();
  elements.logOutput.insertAdjacentHTML("beforeend", logLine(entry));
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

async function loadLogs(id) {
  try {
    const data = await api(`/api/launchers/${id}/logs`);
    if (state.activeLogId !== id) return;
    elements.logOutput.innerHTML = data.logs.length ? data.logs.map(logLine).join("") : '<span class="log-placeholder">Noch keine Ausgabe. Starte den Prozess, um Logs zu sehen.</span>';
    elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
  } catch (error) { toast(error.message, "error"); }
}

function openLogs(id) {
  const found = findLauncher(id);
  if (!found) return;
  state.activeLogId = id;
  elements.logTitle.textContent = `${found.project.name} / ${found.launcher.name}`;
  elements.logCommand.textContent = `${found.launcher.relativeCwd} · ${found.launcher.command}`;
  updateLogState(found.launcher.runtime);
  elements.logDialog.showModal();
  loadLogs(id);
}

function resetFilters() {
  state.filter = "all"; state.technology = null; state.query = ""; elements.search.value = "";
  state.category = null; localStorage.removeItem("devhub_category");
  document.querySelectorAll(".side-link").forEach((button) => { const active = button.dataset.filter === "all"; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); });
  render(false);
}

function setViewFilter(filter) {
  state.filter = filter;
  state.page = "projects";
  elements.search.value = state.query;
  history.replaceState(null, "", location.pathname + location.search);
  render(false);
}

function copyToClipboard(value, successMessage) {
  navigator.clipboard.writeText(value).then(() => toast(successMessage)).catch(() => toast("Kopieren war nicht möglich.", "error"));
}

function handleProjectInteraction(event) {
  const gitWorkspaceLink = event.target.closest("[data-open-git-workspace]");
  if (gitWorkspaceLink) { openGitWorkspace(gitWorkspaceLink.dataset.openGitWorkspace); return; }
  const details = event.target.closest("[data-open-details]");
  if (details) { openProjectDetails(details.dataset.openDetails); return; }
  if (event.target.closest("[data-close-panel]")) { closeProjectPanel(); return; }
  const favorite = event.target.closest("[data-favorite]");
  if (favorite) { const id = favorite.dataset.favorite; state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id); localStorage.setItem("devhub_favorites", JSON.stringify([...state.favorites])); render(); return; }
  const launcherAction = event.target.closest("[data-launcher-action]");
  if (launcherAction?.dataset.id) { runLauncher(launcherAction.dataset.id, launcherAction.dataset.launcherAction); return; }
  const projectAction = event.target.closest("[data-project-action]");
  if (projectAction) { runProjectAction(projectAction.dataset.projectId, projectAction.dataset.projectAction); return; }
  const log = event.target.closest("[data-log]"); if (log) { openLogs(log.dataset.log); return; }
  const expand = event.target.closest("[data-expand]"); if (expand) { state.expandedProjects.has(expand.dataset.expand) ? state.expandedProjects.delete(expand.dataset.expand) : state.expandedProjects.add(expand.dataset.expand); render(); return; }
  const copy = event.target.closest("[data-copy-path]");
  if (copy) { const project = state.projects.find((item) => item.id === copy.dataset.copyPath); if (project) copyToClipboard(projectPath(project), "Projektpfad kopiert."); return; }
  const copyValue = event.target.closest("[data-copy-value]");
  if (copyValue) { copyToClipboard(copyValue.dataset.copyValue, copyValue.dataset.copyLabel || "Kopiert."); return; }
  const clone = event.target.closest("[data-clone-repo]");
  if (clone) { gitWorkspace.openGithubClone(clone.dataset.cloneRepo, clone.dataset.cloneName); return; }
  const paletteQuery = event.target.closest("[data-palette-query]");
  if (paletteQuery) { palette.open(paletteQuery.dataset.paletteQuery); return; }
  const opened = event.target.closest("[data-open-id]"); if (opened) { markRecent(opened.dataset.openId); renderStats(); return; }
  if (event.target.closest("a, button, input, select, textarea, summary")) return;
  const card = event.target.closest("[data-project]");
  if (card) openProjectDetails(card.dataset.project);
}

elements.grid.addEventListener("click", (event) => {
  const heading = event.target.closest("[data-group-filter]");
  if (heading) { setCategoryFilter(state.category === heading.dataset.groupFilter ? null : heading.dataset.groupFilter); return; }
  handleProjectInteraction(event);
});
elements.gitPage.addEventListener("click", (event) => {
  const filter = event.target.closest("[data-git-filter]");
  if (filter) {
    state.gitFilter = filter.dataset.gitFilter;
    localStorage.setItem("devhub_git_filter", state.gitFilter);
    renderGitPage();
    return;
  }
  if (event.target.closest("[data-rescan-workspace]")) { rescan(); return; }
  handleProjectInteraction(event);
});
elements.grid.addEventListener("keydown", (event) => {
  const heading = event.target.closest("[data-group-filter]");
  if (heading && event.target === heading && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    setCategoryFilter(state.category === heading.dataset.groupFilter ? null : heading.dataset.groupFilter);
    return;
  }
  const card = event.target.closest("[data-project]");
  if (card && event.target === card && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openProjectDetails(card.dataset.project, { focusRow: true });
    return;
  }
  // Pfeiltasten wandern durch die Zeilen und nehmen den Detailbereich mit.
  if (card && event.target === card && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    const rows = [...elements.grid.querySelectorAll("[data-project]")];
    const next = rows[rows.indexOf(card) + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) { event.preventDefault(); openProjectDetails(next.dataset.project, { focusRow: true }); }
  }
});
elements.panel.addEventListener("click", handleProjectInteraction);
elements.remote.addEventListener("click", handleProjectInteraction);
elements.attention.addEventListener("click", handleProjectInteraction);

document.querySelector("#view-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]"); if (!button) return;
  if (button.dataset.filter) setViewFilter(button.dataset.filter);
  else setWorkspacePage(button.dataset.page);
});
document.querySelector("#mobile-workspace-tabs").addEventListener("click", (event) => { const button = event.target.closest("[data-page]"); if (button) setWorkspacePage(button.dataset.page); });
document.querySelector("#mobile-view-filters").addEventListener("click", (event) => { const button = event.target.closest("[data-mobile-filter]"); if (button) setViewFilter(button.dataset.mobileFilter); });
elements.techSelect.addEventListener("change", () => { state.technology = elements.techSelect.value || null; render(false); });
elements.categorySelect.addEventListener("change", () => setCategoryFilter(elements.categorySelect.value || null));
elements.resetFilters.addEventListener("click", resetFilters);
elements.search.addEventListener("input", () => {
  if (state.page === "git") state.gitQuery = elements.search.value;
  else state.query = elements.search.value;
  render(false);
});
elements.sort.addEventListener("change", () => { state.sort = elements.sort.value; localStorage.setItem("devhub_sort", state.sort); render(false); });
document.querySelector(".view-switch").addEventListener("click", (event) => { const button = event.target.closest("[data-view]"); if (!button) return; state.view = button.dataset.view; localStorage.setItem("devhub_view", state.view); render(false); });
elements.groupToggle.addEventListener("click", () => { state.group = state.group === "category" ? "none" : "category"; localStorage.setItem("devhub_group", state.group); render(false); });
elements.rescan.addEventListener("click", rescan); elements.emptyAction.addEventListener("click", () => state.projects.length ? resetFilters() : openWorkspaceSettings());
elements.workspaceSettings.addEventListener("click", openWorkspaceSettings);
document.querySelector("#workspace-primary-action").addEventListener("click", () => {
  if (state.page === "git") gitWorkspace.openAddRepository();
  else openWorkspaceSettings();
});
document.querySelector("#sidebar-workspace-settings").addEventListener("click", openWorkspaceSettings);
elements.workspaceBrowse.addEventListener("click", pickWorkspace);
elements.workspaceForm.addEventListener("submit", saveWorkspace);
document.querySelector("#workspace-close").addEventListener("click", () => elements.workspaceDialog.close());
document.querySelector("#workspace-cancel").addEventListener("click", () => elements.workspaceDialog.close());
elements.workspaceDialog.addEventListener("click", (event) => { if (event.target === elements.workspaceDialog) elements.workspaceDialog.close(); });
elements.svcPill.addEventListener("click", () => setServicePanel(elements.svcPanel.hidden));
document.addEventListener("click", (event) => {
  const stackButton = event.target.closest("[data-stack-action]");
  if (stackButton && !stackButton.disabled) { runStackAction(stackButton.dataset.stackAction); return; }
  if (!elements.svcPanel.hidden && !elements.svc.contains(event.target)) setServicePanel(false);
  // Als Ebene schließt der Detailbereich bei einem Klick daneben, außer der Klick wählt ein anderes Projekt.
  if (!elements.panel.hidden && !widePanel.matches && event.target.isConnected && !elements.panel.contains(event.target) && !event.target.closest("[data-project], dialog, .toast-region")) closeProjectPanel();
});
elements.svcPanel.addEventListener("click", (event) => {
  const details = event.target.closest("[data-open-details]");
  if (details) { setServicePanel(false); openProjectDetails(details.dataset.openDetails); return; }
  const opened = event.target.closest("[data-open-id]");
  if (opened) markRecent(opened.dataset.openId);
});
document.querySelector("#mobile-search").addEventListener("click", () => { elements.search.scrollIntoView({ block: "center" }); elements.search.focus(); });
document.querySelector("#close-log").addEventListener("click", () => elements.logDialog.close());
document.querySelector("#clear-log").addEventListener("click", () => { elements.logOutput.innerHTML = '<span class="log-placeholder">Ansicht geleert. Neue Ausgaben erscheinen weiterhin live.</span>'; });
elements.restartLog.addEventListener("click", () => { if (state.activeLogId) runLauncher(state.activeLogId, "restart"); });
elements.logDialog.addEventListener("close", () => { state.activeLogId = null; }); elements.logDialog.addEventListener("click", (event) => { if (event.target === elements.logDialog) elements.logDialog.close(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.svcPanel.hidden) { setServicePanel(false); elements.svcPill.focus(); return; }
  if (event.key === "Escape" && !elements.panel.hidden && !widePanel.matches && !document.querySelector("dialog[open]")) { closeProjectPanel(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") { event.preventDefault(); palette.open(); return; }
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) { event.preventDefault(); elements.search.focus(); }
});

const gitWorkspace = createGitWorkspace({ root: elements.gitPage, state, api, renderApp: () => render(false), renderPatch, escapeHtml, toast, projectAction: runProjectAction, rescan });

// Einträge der Befehlspalette: zuerst Projekte mit ihren häufigsten Aktionen, dann allgemeine Befehle,
// zuletzt Repositories aus dem GitHub-Konto, die noch nicht im Workspace liegen.
function paletteItems() {
  const items = [];
  const editorName = state.capabilities?.editor.name || "Editor";
  for (const project of state.projects) {
    const keywords = `${project.relativePath} ${project.technologies.join(" ")}`;
    const url = browserUrl(project);
    const openEditor = state.capabilities?.editor.available ? () => runProjectAction(project.id, "editor") : null;
    const openBrowser = url ? () => { markRecent(project.id); window.open(url, "_blank", "noopener"); } : null;
    const base = { group: "Projekte", keywords, editor: openEditor, browser: openBrowser, rank: state.recent.includes(project.id) ? 4 - Math.min(3, state.recent.indexOf(project.id)) : 0 };
    items.push({ ...base, icon: "folder-open", label: project.name, hint: projectIsRunning(project) ? "läuft" : project.relativePath, run: () => openProjectDetails(project.id), rank: base.rank + 2 });
    for (const launcher of topLaunchers(project)) {
      const running = ["starting", "running"].includes(launcher.runtime.status);
      const single = topLaunchers(project).length === 1;
      items.push({ ...base, icon: running ? "stop" : "play", label: `${project.name}${single ? "" : ` · ${launcher.name}`} ${running ? "stoppen" : "starten"}`, hint: launcher.command, keywords: `${keywords} ${launcher.name}`, run: () => runLauncher(launcher.id, running ? "stop" : "start") });
    }
    if (url) items.push({ ...base, icon: "arrow-up-right-from-square", label: `${project.name} im Browser öffnen`, hint: url.replace(/^https?:\/\//, "").replace(/\/$/, ""), run: openBrowser });
    if (openEditor) items.push({ ...base, icon: "code", label: `${project.name} in ${editorName} öffnen`, hint: "", run: openEditor });
    if (state.capabilities?.terminal.available) items.push({ ...base, icon: "terminal", label: `${project.name} im Terminal öffnen`, hint: "", run: () => runProjectAction(project.id, "terminal") });
    items.push({ ...base, icon: "folder", label: `${project.name} im Ordner zeigen`, hint: "", run: () => runProjectAction(project.id, "folder") });
    if (project.git) items.push({ ...base, icon: "code-branch", label: `${project.name} in der Git-Zentrale`, hint: project.git.dirty ? `${project.git.changedFiles} geändert` : project.git.branch || "", run: () => openGitWorkspace(project.id) });
  }
  const command = (icon, label, hint, run, keywords = "") => items.push({ group: "Befehle", icon, label, hint, run, keywords });
  const stack = state.stack;
  if (stack?.installed) {
    const web = webOnline();
    if (stackAction(web ? "stop" : "start")) command(web ? "power-off" : "play", web ? `${stack.name}-Dienste stoppen` : `${stack.name}-Dienste starten`, stackAction(web ? "stop" : "start").description, () => runStackAction(web ? "stop" : "start"), "nginx apache webserver dienste");
    if (stackAction("reload")) command("arrows-rotate", `${stack.name}-Dienste neu starten`, "", () => runStackAction("reload"), "nginx apache webserver");
    if (stackAction("open")) command("up-right-from-square", `${stack.name} öffnen`, "", () => runStackAction("open"));
  }
  const running = state.projects.flatMap((project) => project.launchers).filter((launcher) => ["starting", "running"].includes(launcher.runtime.status));
  if (running.length) command("stop", "Alle laufenden Starter stoppen", `${running.length} ${running.length === 1 ? "läuft" : "laufen"}`, () => running.forEach((launcher) => runLauncher(launcher.id, "stop")));
  command("code-branch", "Git-Zentrale öffnen", "", () => setWorkspacePage("git"), "repositories");
  command("house", "Projekte anzeigen", "", () => setWorkspacePage("projects"));
  command("rotate", "Workspace neu einlesen", state.root, rescan, "scan aktualisieren");
  command("folder-tree", "Workspace wechseln …", state.root, openWorkspaceSettings, "ordner");
  command("plus", "Repository klonen oder anlegen …", "", () => { setWorkspacePage("git"); gitWorkspace.openAddRepository(); }, "github git clone");
  if (state.github?.available) {
    for (const repo of state.github.repositories.filter((item) => !gitWorkspace.isInWorkspace(item)).slice(0, 60)) {
      items.push({ group: "Von GitHub klonen", icon: "cloud-arrow-down", label: `${repo.name} klonen`, hint: repo.isPrivate ? "privat" : "öffentlich", keywords: `${repo.nameWithOwner} ${repo.description || ""} github`, run: () => { setWorkspacePage("git"); gitWorkspace.openGithubClone(repo.nameWithOwner, repo.name); } });
    }
  }
  return items;
}

async function loadGithubRepositories() {
  if (state.githubLoading || state.github) return;
  state.githubLoading = true;
  try { state.github = await gitWorkspace.githubRepositories(); }
  catch { state.github = { available: false, repositories: [] }; }
  finally { state.githubLoading = false; palette.refresh(); render(); }
}

const palette = createPalette({ items: paletteItems, escapeHtml, onOpen: loadGithubRepositories });
document.querySelector("#palette-open").addEventListener("click", () => palette.open());

bootstrap();
