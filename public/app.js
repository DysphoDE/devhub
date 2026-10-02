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
  view: localStorage.getItem("devhub_view") || "grid",
  group: localStorage.getItem("devhub_group") === "category" ? "category" : "none",
  favorites: new Set(Array.isArray(storedFavorites) ? storedFavorites : []),
  recent: Array.isArray(storedRecent) ? storedRecent : [],
  expandedProjects: new Set(),
  activeProjectId: null,
  stackPending: null,
  gitCommitMessages: new Map(),
  gitSuggestedMessages: new Set(),
  gitSuggestionLoading: new Set(),
  pendingGitAction: null,
  gitMode: localStorage.getItem("devhub_git_mode") === "history" ? "history" : "changes",
  activeGitFiles: new Map(),
  selectedGitFiles: new Map(),
  gitDiffs: new Map(),
  gitDiffLoading: null,
  gitHistories: new Map(),
  gitHistoryLoading: new Set(),
  activeGitCommits: new Map(),
  gitCommitDetails: new Map(),
  gitCommitLoading: null,
  pendingGitDiscard: null,
  gitBranches: new Map(),
  gitBranchLoading: new Set(),
  gitBranchMenu: null,
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
  resultCount: document.querySelector("#result-count"), projectCount: document.querySelector("#project-count"),
  runningCount: document.querySelector("#running-count"), launcherCount: document.querySelector("#launcher-count"), allCount: document.querySelector("#all-count"),
  favoriteCount: document.querySelector("#favorite-count"), recentCount: document.querySelector("#recent-count"), runningFilterCount: document.querySelector("#running-filter-count"),
  attentionCount: document.querySelector("#attention-count"), gitRepositoryCount: document.querySelector("#git-repository-count"),
  scanStatus: document.querySelector("#scan-status"), search: document.querySelector("#search"), sort: document.querySelector("#sort"), rescan: document.querySelector("#rescan"),
  techFilters: document.querySelector("#tech-filters"), mobileTech: document.querySelector("#mobile-tech"), clearTech: document.querySelector("#clear-tech"), activeFilter: document.querySelector("#active-filter"),
  categoryGroup: document.querySelector("#category-group"), categoryFilters: document.querySelector("#category-filters"),
  mobileCategory: document.querySelector("#mobile-category"), clearCategory: document.querySelector("#clear-category"),
  svc: document.querySelector("#svc"), svcPill: document.querySelector("#svc-pill"), svcName: document.querySelector("#svc-name"), svcState: document.querySelector("#svc-state"),
  svcPanel: document.querySelector("#svc-panel"), attention: document.querySelector("#attention"),
  discardDescription: document.querySelector("#git-discard-description"), discardWarning: document.querySelector("#git-discard-warning-text"),
  projectDialog: document.querySelector("#project-dialog"), projectDialogContent: document.querySelector("#project-dialog-content"),
  discardDialog: document.querySelector("#git-discard-dialog"), discardCount: document.querySelector("#git-discard-count"), discardFiles: document.querySelector("#git-discard-files"),
  discardCancel: document.querySelector("#git-discard-cancel"), discardConfirm: document.querySelector("#git-discard-confirm"),
  logDialog: document.querySelector("#log-dialog"), logTitle: document.querySelector("#log-title"), logCommand: document.querySelector("#log-command"),
  logOutput: document.querySelector("#log-output"), logState: document.querySelector("#log-state"), restartLog: document.querySelector("#restart-log"),
  toastRegion: document.querySelector("#toast-region")
};

const isMac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
document.querySelector("#palette-shortcut").textContent = isMac ? "⌘K" : "Strg K";
document.querySelector("#palette-editor-key").textContent = isMac ? "⌘" : "Strg";
document.querySelector("#palette-browser-key").textContent = isMac ? "⌥" : "Alt";

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

function projectListItem(project) {
  const running = projectIsRunning(project);
  const status = projectState(project);
  const [symbol, className] = techClass(project);
  const favorite = state.favorites.has(project.id);
  const editorName = state.capabilities?.editor.name || "Editor";
  const hasDirectLaunchAction = Boolean(browserUrl(project) || preferredLauncher(project));
  const visibleTechnologies = project.technologies.slice(0, 3);
  const extraTechnologies = Math.max(0, project.technologies.length - visibleTechnologies.length);
  const projectMeta = project.git
    ? gitBranchMeta(project.git)
    : `<span class="meta-item">${project.fileCount} Dateien</span>`;

  return `<article class="project-card project-list-row ${className} ${running ? "running" : ""}" data-project="${project.id}" tabindex="0" aria-label="Details zu ${escapeHtml(project.name)} öffnen">
    <div class="card-accent"></div>
    <section class="list-identity">
      ${project.thumbnailUrl ? `<img class="card-thumb list-project-symbol" src="${escapeHtml(project.thumbnailUrl)}" alt="">` : `<span class="stack-symbol list-project-symbol">${escapeHtml(symbol)}</span>`}
      <div class="list-project-copy">
        <div class="list-title-row">
          <h2 title="${escapeHtml(project.name)}">${escapeHtml(project.name)}</h2>
          <span class="card-state ${status.kind}"><i></i>${escapeHtml(status.label)}</span>
        </div>
        <code class="project-path" title="${escapeHtml(project.relativePath)}">${escapeHtml(project.relativePath)}</code>
        <p class="project-description" title="${escapeHtml(project.description)}">${escapeHtml(project.description)}</p>
        <div class="list-detail-row">
          <div class="tech-list">${visibleTechnologies.map((technology) => `<span class="tech-chip">${escapeHtml(technology)}</span>`).join("")}${extraTechnologies ? `<span class="tech-chip tech-more">+${extraTechnologies}</span>` : ""}</div>
          <div class="list-project-meta">${projectMeta}<span class="meta-time">${relativeTime(project.modifiedAt)}</span></div>
        </div>
      </div>
      <button class="favorite-button ${favorite ? "active" : ""}" data-favorite="${project.id}" data-focus-key="fav-${project.id}" aria-label="${favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}" aria-pressed="${favorite}">${favoriteIcon(favorite)}</button>
    </section>
    <section class="launcher-panel list-launchers" aria-label="Starter für ${escapeHtml(project.name)}">
      <div class="list-launcher-head">
        <span>Alle Starter</span><b>${project.launchers.length}</b>
      </div>
      ${project.launchers.length ? project.launchers.map(launcherRow).join("") : '<p class="list-no-launcher">Kein automatischer Starter erkannt</p>'}
    </section>
    <div class="card-actions list-actions">
      <span class="list-actions-label">Projekt steuern</span>
      <div class="list-action-grid">
        ${primaryAction(project, true)}
        <div class="list-utility-actions" aria-label="Projektaktionen">
          <button class="card-icon-action" data-project-action="editor" data-project-id="${project.id}" aria-label="In ${escapeHtml(editorName)} öffnen" title="In ${escapeHtml(editorName)} öffnen" ${state.capabilities?.editor.available ? "" : "disabled"}><i class="fa-solid fa-code" aria-hidden="true"></i><b>Editor</b></button>
          <button class="card-icon-action" data-project-action="terminal" data-project-id="${project.id}" aria-label="Terminal hier öffnen" title="Terminal hier öffnen" ${state.capabilities?.terminal.available ? "" : "disabled"}><i class="fa-solid fa-terminal" aria-hidden="true"></i><b>Terminal</b></button>
          ${hasDirectLaunchAction ? `<button class="card-icon-action" data-project-action="folder" data-project-id="${project.id}" aria-label="Ordner öffnen" title="Ordner öffnen"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><b>Ordner</b></button>` : ""}
          <button class="card-icon-action" data-copy-path="${project.id}" aria-label="Pfad kopieren" title="Pfad kopieren"><i class="fa-regular fa-copy" aria-hidden="true"></i><b>Pfad</b></button>
        </div>
      </div>
    </div>
  </article>`;
}

function gitStatusLabel(code) {
  return ({ M: "Geändert", A: "Neu", D: "Gelöscht", R: "Umbenannt", C: "Kopiert", U: "Konflikt", T: "Typ geändert", "?": "Unversioniert" })[code] || "Geändert";
}

function activeGitFile(project) {
  const selected = state.activeGitFiles.get(project.id);
  if (project.git?.files.some((file) => file.path === selected)) return selected;
  const first = project.git?.files[0]?.path || null;
  if (first) state.activeGitFiles.set(project.id, first);
  else state.activeGitFiles.delete(project.id);
  return first;
}

function selectedGitFileSet(project) {
  const available = new Set(project.git?.files.map((file) => file.path) || []);
  const current = state.selectedGitFiles.get(project.id) || new Set();
  const selected = new Set([...current].filter((file) => available.has(file)));
  if (selected.size) state.selectedGitFiles.set(project.id, selected);
  else state.selectedGitFiles.delete(project.id);
  return selected;
}

function selectGitFile(projectId, file, additive = false) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project?.git?.files.some((item) => item.path === file)) return;
  const selected = new Set(additive ? selectedGitFileSet(project) : []);
  if (additive && selected.has(file)) selected.delete(file);
  else selected.add(file);
  if (selected.size) state.selectedGitFiles.set(projectId, selected);
  else state.selectedGitFiles.delete(projectId);
  if (selected.has(file) || !additive) loadGitDiff(projectId, file);
  else renderGitSurfaces();
}

function selectAllGitFiles(projectId, selected) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project?.git) return;
  if (selected) state.selectedGitFiles.set(projectId, new Set(project.git.files.map((file) => file.path)));
  else state.selectedGitFiles.delete(projectId);
  renderGitSurfaces();
}

function diffKey(projectId, file) {
  return `${projectId}\u0000${file}`;
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

function gitDiffViewer(project) {
  const file = activeGitFile(project);
  if (!file) return `<section class="git-diff-panel empty"><span>✓</span><strong>Arbeitsbaum sauber</strong><small>Wähle nach der nächsten Änderung hier eine Datei aus.</small></section>`;
  const key = diffKey(project.id, file);
  if (state.gitDiffLoading === key) return `<section class="git-diff-panel"><div class="git-diff-head"><strong>${escapeHtml(file)}</strong></div><div class="diff-loading"><i></i>Diff wird geladen …</div></section>`;
  const data = state.gitDiffs.get(key);
  if (data?.error) return `<section class="git-diff-panel"><div class="git-diff-head"><strong>${escapeHtml(file)}</strong><button data-reload-diff data-project-id="${project.id}" data-file="${escapeHtml(file)}">Erneut laden</button></div><div class="diff-error">${escapeHtml(data.error)}</div></section>`;
  if (!data) return `<section class="git-diff-panel"><div class="git-diff-head"><strong>${escapeHtml(file)}</strong></div><div class="diff-loading">Datei auswählen, um den Diff zu laden.</div></section>`;
  let additions = 0;
  let deletions = 0;
  data.sections.forEach((section) => section.patch.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }));
  return `<section class="git-diff-panel">
    <div class="git-diff-head"><strong title="${escapeHtml(file)}">${escapeHtml(file)}</strong><div><span class="diff-additions">+${additions}</span><span class="diff-deletions">−${deletions}</span><button data-reload-diff data-project-id="${project.id}" data-file="${escapeHtml(file)}" title="Diff neu laden"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button></div></div>
    <div class="git-diff-scroll">
      ${data.sections.map((section) => `<section class="diff-section ${section.scope}"><header><i></i>${escapeHtml(section.label)}</header><div class="diff-code">${renderPatch(section.patch)}</div>${section.truncated ? '<div class="diff-limit-note">Sehr großer Diff wurde gekürzt.</div>' : ""}</section>`).join("") || '<div class="diff-empty">Keine darstellbaren Textänderungen.</div>'}
    </div>
  </section>`;
}

async function loadGitDiff(projectId, file, force = false) {
  const key = diffKey(projectId, file);
  state.activeGitFiles.set(projectId, file);
  if (!force && state.gitDiffs.has(key)) {
    if (elements.projectDialog.open) renderProjectDialog();
    if (state.page === "git") renderGitPage();
    return;
  }
  state.gitDiffLoading = key;
  if (elements.projectDialog.open) renderProjectDialog();
  if (state.page === "git") renderGitPage();
  try {
    const data = await api(`/api/projects/${projectId}/git/diff?file=${encodeURIComponent(file)}`);
    state.gitDiffs.set(key, data);
  } catch (error) {
    state.gitDiffs.set(key, { error: error.message });
  } finally {
    if (state.gitDiffLoading === key) state.gitDiffLoading = null;
    if (state.activeProjectId === projectId && elements.projectDialog.open) renderProjectDialog();
    if (state.page === "git" && state.activeGitProjectId === projectId) renderGitPage();
  }
}

function renderGitSurfaces() {
  if (elements.projectDialog.open) renderProjectDialog();
  if (state.page === "git") renderGitPage();
}

function gitCommitKey(projectId, hash) {
  return `${projectId}\u0000${hash}`;
}

function gitHistoryDate(isoDate) {
  if (!isoDate) return "unbekannt";
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(isoDate));
}

function gitHistoryCommitRow(project, commit) {
  const active = state.activeGitCommits.get(project.id) === commit.hash;
  return `<button class="git-history-commit ${active ? "active" : ""}" data-git-commit="${commit.hash}" data-project-id="${project.id}" aria-pressed="${active}">
    <span class="git-history-node"><i></i></span>
    <span class="git-history-copy"><strong title="${escapeHtml(commit.subject)}">${escapeHtml(commit.subject)}</strong><small>${escapeHtml(commit.author)} · ${gitHistoryDate(commit.date)}</small></span>
    <code>${escapeHtml(commit.shortHash)}</code>
  </button>`;
}

function gitCommitViewer(project) {
  const hash = state.activeGitCommits.get(project.id);
  if (!hash) return `<section class="git-history-detail empty"><span><i class="fa-solid fa-code-commit" aria-hidden="true"></i></span><strong>Commit auswählen</strong><p>Wähle links einen Commit, um Dateien und Diff zu sehen.</p></section>`;
  const key = gitCommitKey(project.id, hash);
  if (state.gitCommitLoading === key) return `<section class="git-history-detail"><div class="git-history-detail-loading"><i></i>Commit wird geladen …</div></section>`;
  const detail = state.gitCommitDetails.get(key);
  if (detail?.error) return `<section class="git-history-detail"><div class="diff-error">${escapeHtml(detail.error)}</div></section>`;
  if (!detail) return `<section class="git-history-detail empty"><span><i class="fa-solid fa-code-commit" aria-hidden="true"></i></span><strong>Commit auswählen</strong></section>`;
  let additions = 0;
  let deletions = 0;
  detail.patch.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  });
  return `<section class="git-history-detail">
    <header class="git-commit-head">
      <div><p class="eyebrow">Ausgewählter Commit</p><h4>${escapeHtml(detail.subject)}</h4><span>${escapeHtml(detail.author)} · ${dateTime(detail.date)}</span></div>
      <div class="git-commit-head-meta"><code>${escapeHtml(detail.shortHash)}</code><span class="diff-additions">+${additions}</span><span class="diff-deletions">−${deletions}</span></div>
    </header>
    <div class="git-commit-files" aria-label="Dateien im Commit">
      ${detail.files.slice(0, 16).map((file) => `<span title="${escapeHtml(file.path)}"><b class="status-${escapeHtml(file.status)}">${escapeHtml(file.status)}</b>${escapeHtml(file.path)}</span>`).join("") || '<span class="empty">Keine geänderten Dateien erkannt</span>'}
      ${detail.files.length > 16 ? `<span class="more">+${detail.files.length - 16} weitere</span>` : ""}
    </div>
    <div class="git-history-diff"><div class="diff-code">${detail.patch ? renderPatch(detail.patch) : '<div class="diff-empty">Dieser Commit enthält keinen darstellbaren Text-Diff.</div>'}</div>${detail.truncated ? '<div class="diff-limit-note">Sehr großer Commit-Diff wurde gekürzt.</div>' : ""}</div>
  </section>`;
}

function gitHistoryView(project) {
  const history = state.gitHistories.get(project.id);
  const loading = state.gitHistoryLoading.has(project.id);
  if (!history && loading) return `<div class="git-history-loading"><i></i><strong>Verlauf wird geladen</strong><span>Commits und Metadaten werden eingelesen …</span></div>`;
  if (history?.error) return `<div class="git-history-loading error"><strong>Verlauf konnte nicht geladen werden</strong><span>${escapeHtml(history.error)}</span><button data-git-history-retry="${project.id}">Erneut laden</button></div>`;
  const commits = history?.commits || [];
  if (!commits.length) return `<div class="git-history-loading"><span class="history-empty-icon"><i class="fa-solid fa-code-commit" aria-hidden="true"></i></span><strong>Noch keine Commits</strong><span>Der Verlauf beginnt mit dem ersten Commit dieses Repositorys.</span></div>`;
  if (!state.activeGitCommits.has(project.id)) state.activeGitCommits.set(project.id, commits[0].hash);
  return `<div class="git-history-workbench">
    <section class="git-history-list-panel">
      <header><div><strong>Commit-Verlauf</strong><span>${commits.length}${history.hasMore ? "+" : ""} geladen</span></div><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></header>
      <div class="git-history-list">${commits.map((commit) => gitHistoryCommitRow(project, commit)).join("")}</div>
      ${history.hasMore ? `<button class="git-history-more" data-git-history-more="${project.id}" ${loading ? "disabled" : ""}>${loading ? "Weitere Commits werden geladen …" : "Weitere Commits laden"}</button>` : `<p class="git-history-end"><i></i>Beginn des Repositorys</p>`}
    </section>
    ${gitCommitViewer(project)}
  </div>`;
}

async function loadGitCommit(projectId, hash, force = false) {
  if (!hash) return;
  const key = gitCommitKey(projectId, hash);
  state.activeGitCommits.set(projectId, hash);
  if (!force && state.gitCommitDetails.has(key)) { renderGitSurfaces(); return; }
  state.gitCommitLoading = key;
  renderGitSurfaces();
  try {
    state.gitCommitDetails.set(key, await api(`/api/projects/${projectId}/git/commits/${hash}`));
  } catch (error) {
    state.gitCommitDetails.set(key, { error: error.message });
  } finally {
    if (state.gitCommitLoading === key) state.gitCommitLoading = null;
    renderGitSurfaces();
  }
}

async function loadGitHistory(projectId, more = false, force = false) {
  if (state.gitHistoryLoading.has(projectId)) return;
  const existing = state.gitHistories.get(projectId);
  if (!more && !force && existing?.commits?.length) {
    const hash = state.activeGitCommits.get(projectId) || existing.commits[0].hash;
    if (!state.gitCommitDetails.has(gitCommitKey(projectId, hash))) loadGitCommit(projectId, hash);
    else renderGitSurfaces();
    return;
  }
  state.gitHistoryLoading.add(projectId);
  if (!more) state.gitHistories.delete(projectId);
  renderGitSurfaces();
  try {
    const offset = more && existing?.commits ? existing.commits.length : 0;
    const data = await api(`/api/projects/${projectId}/git/history?offset=${offset}&limit=60`);
    const commits = more && existing?.commits ? [...existing.commits, ...data.commits] : data.commits;
    state.gitHistories.set(projectId, { commits, hasMore: data.hasMore });
    if (commits.length) {
      const active = state.activeGitCommits.get(projectId);
      const hash = commits.some((commit) => commit.hash === active) ? active : commits[0].hash;
      state.activeGitCommits.set(projectId, hash);
      if (!state.gitCommitDetails.has(gitCommitKey(projectId, hash))) loadGitCommit(projectId, hash);
    }
  } catch (error) {
    state.gitHistories.set(projectId, { error: error.message, commits: [], hasMore: false });
  } finally {
    state.gitHistoryLoading.delete(projectId);
    renderGitSurfaces();
  }
}

function gitFileRow(project, file) {
  const staged = file.indexStatus !== "." && file.indexStatus !== "?";
  const working = file.worktreeStatus !== ".";
  const primaryStatus = staged ? file.indexStatus : file.worktreeStatus;
  const slash = file.path.lastIndexOf("/");
  const directory = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const pending = state.pendingGitAction?.startsWith(`${project.id}:`);
  const selected = selectedGitFileSet(project).has(file.path);
  return `<div class="git-file-row ${activeGitFile(project) === file.path ? "active" : ""} ${selected ? "selected" : ""}" data-git-file="${escapeHtml(file.path)}" data-project-id="${project.id}" tabindex="0" aria-selected="${selected}">
    <label class="git-file-check" title="Datei auswählen"><input type="checkbox" data-git-select-file="${escapeHtml(file.path)}" data-project-id="${project.id}" ${selected ? "checked" : ""} ${pending ? "disabled" : ""}><span aria-hidden="true"><i class="fa-solid fa-check"></i></span><span class="sr-only">${escapeHtml(file.path)} auswählen</span></label>
    <span class="git-file-status status-${escapeHtml(primaryStatus)}" title="${escapeHtml(gitStatusLabel(primaryStatus))}">${escapeHtml(primaryStatus)}</span>
    <div class="git-file-path" title="${escapeHtml(file.path)}"><span>${escapeHtml(directory)}</span><strong>${escapeHtml(name)}</strong>${file.originalPath ? `<small>von ${escapeHtml(file.originalPath)}</small>` : ""}</div>
    <div class="git-file-flags">
      ${staged ? '<span class="file-flag staged">vorgemerkt</span>' : ""}
      ${working && file.worktreeStatus !== "?" ? '<span class="file-flag working">lokal</span>' : ""}
      ${file.worktreeStatus === "?" ? '<span class="file-flag untracked">neu</span>' : ""}
    </div>
    <button class="git-file-action ${staged ? "unstage" : "stage"}" data-git-action="${staged ? "unstage" : "stage"}" data-project-id="${project.id}" data-file="${escapeHtml(file.path)}" aria-label="${staged ? "Vormerkung lösen" : "Datei vormerken"}: ${escapeHtml(file.path)}" title="${staged ? "Vormerkung lösen" : "Datei vormerken"}" ${pending ? "disabled" : ""}><i class="fa-solid ${staged ? "fa-minus" : "fa-plus"}" aria-hidden="true"></i><span>${staged ? "Lösen" : "Vormerken"}</span></button>
  </div>`;
}

function gitLastCommit(project) {
  const commit = project.git?.lastCommit;
  if (!commit) return '<p class="git-empty-note">Noch kein Commit vorhanden.</p>';
  const git = project.git;
  const pending = state.pendingGitAction?.startsWith(`${project.id}:`);
  const pushed = Boolean(git.upstream) && git.ahead === 0;
  const canUndo = Boolean(git.branch) && !pushed;
  const undoTitle = pushed ? "Der Commit wurde bereits gepusht und kann nicht zurückgenommen werden"
    : !git.branch ? "Im detached-HEAD-Zustand nicht verfügbar"
    : "Commit zurücknehmen – die Änderungen bleiben vorgemerkt";
  return `<div class="last-commit"><span class="commit-hash">${escapeHtml(commit.hash)}</span><div><strong>${escapeHtml(commit.subject)}</strong><small>${escapeHtml(commit.author)} · ${dateTime(commit.date)}</small></div>
    <button class="commit-undo-button" data-git-action="undo-commit" data-project-id="${project.id}" ${pending || !canUndo ? "disabled" : ""} title="${escapeHtml(undoTitle)}"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i>Commit zurücknehmen</button></div>`;
}

function gitRemotePanel(project) {
  const git = project.git;
  const pending = state.pendingGitAction?.startsWith(`${project.id}:`);
  const canPush = Boolean(git.remoteName && git.branch && (!git.upstream || git.ahead > 0));
  const canFetch = Boolean(git.remoteName);
  const canPull = Boolean(git.upstream && git.branch && git.behind > 0);
  return `<div class="push-panel">
    <div><strong>${git.upstream ? escapeHtml(git.upstream) : "Branch veröffentlichen"}</strong><span>${git.upstream ? `${git.ahead} voraus · ${git.behind} zurück` : `auf ${escapeHtml(git.remoteName || "Remote")}`}</span></div>
    <div class="push-actions">
      <button class="fetch-button" data-git-action="fetch" data-project-id="${project.id}" ${pending || !canFetch ? "disabled" : ""}>${state.pendingGitAction === `${project.id}:fetch` ? "Abrufen …" : "Fetch"}</button>
      <button class="pull-button" data-git-action="pull" data-project-id="${project.id}" ${pending || !canPull ? "disabled" : ""}>${state.pendingGitAction === `${project.id}:pull` ? "Pull läuft …" : `Pull · ↓${git.behind}`}</button>
      <button data-git-action="push" data-project-id="${project.id}" ${pending || !canPush ? "disabled" : ""}>${state.pendingGitAction === `${project.id}:push` ? "Push läuft …" : git.upstream ? `Push · ↑${git.ahead}` : "Push & Upstream"}</button>
    </div>
  </div>`;
}

function gitInlineActions(project, surface) {
  const branch = project.git?.branch || "detached HEAD";
  return `<div class="detail-inline-actions">
    ${surface === "drawer" ? `<button class="detail-secondary-action open-git-page-action" data-open-git-workspace="${project.id}"><i class="fa-solid fa-code-branch" aria-hidden="true"></i>In Git-Zentrale öffnen</button>` : ""}
    ${project.git?.remoteUrl ? `<a class="detail-secondary-action" href="${escapeHtml(project.git.remoteUrl)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>Remote öffnen</a>` : ""}
    <button class="detail-secondary-action" data-copy-value="${escapeHtml(branch)}" data-copy-label="Branch kopiert.">Branch kopieren</button>
    <button class="detail-secondary-action" data-project-action="terminal" data-project-id="${project.id}" ${state.capabilities?.terminal.available ? "" : "disabled"}><i class="fa-solid fa-terminal" aria-hidden="true"></i>Terminal</button>
  </div>`;
}

function gitSelectionToolbar(project) {
  const git = project.git;
  const selected = selectedGitFileSet(project);
  const files = git.files.filter((file) => selected.has(file.path));
  const pending = state.pendingGitAction?.startsWith(`${project.id}:`);
  const canStage = files.some((file) => file.worktreeStatus !== "." || file.indexStatus === "?");
  const canUnstage = files.some((file) => file.indexStatus !== "." && file.indexStatus !== "?");
  const allSelected = git.files.length > 0 && selected.size === git.files.length;
  return `<div class="git-selection-bar ${selected.size ? "has-selection" : ""}">
    <label class="git-select-all ${selected.size && !allSelected ? "partial" : ""}" title="Alle angezeigten Dateien auswählen">
      <input type="checkbox" data-git-select-all="${project.id}" ${allSelected ? "checked" : ""} ${pending ? "disabled" : ""}>
      <span aria-hidden="true"><i class="fa-solid ${selected.size && !allSelected ? "fa-minus" : "fa-check"}"></i></span>
      <span class="sr-only">Alle angezeigten Dateien auswählen</span>
    </label>
    <div class="git-selection-copy"><strong>${selected.size ? `${selected.size} ausgewählt` : "Dateien auswählen"}</strong><small>${selected.size ? "Aktionen gelten für die Auswahl" : "Checkbox oder Strg/Cmd für Mehrfachauswahl"}</small></div>
    <div class="git-selection-actions">
      <button class="stage" data-git-selection-action="stage-files" data-project-id="${project.id}" ${pending || !canStage ? "disabled" : ""}><i class="fa-solid fa-plus" aria-hidden="true"></i>Vormerken</button>
      <button data-git-selection-action="unstage-files" data-project-id="${project.id}" ${pending || !canUnstage ? "disabled" : ""}><i class="fa-solid fa-minus" aria-hidden="true"></i>Lösen</button>
      <button class="discard" data-git-selection-action="discard-files" data-project-id="${project.id}" ${pending || !selected.size ? "disabled" : ""}><i class="fa-solid fa-rotate-left" aria-hidden="true"></i>Verwerfen</button>
    </div>
  </div>`;
}

function gitChangesView(project, surface) {
  const git = project.git;
  const changes = git.changedFiles ?? git.files.length;
  const pending = state.pendingGitAction?.startsWith(`${project.id}:`);
  if (!changes) return `<div class="git-clean-layout">
    <section class="git-clean-summary">
      <span><i class="fa-solid fa-check" aria-hidden="true"></i></span>
      <div><p class="eyebrow">Arbeitsbaum</p><h4>Alles committed</h4><p>Keine lokalen Änderungen. Der Verlauf und Remote-Stand sind bereit.</p></div>
      <button data-git-mode="history" data-project-id="${project.id}"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>Verlauf öffnen</button>
    </section>
    <aside class="git-clean-side"><div><p class="eyebrow">Letzter Commit</p>${gitLastCommit(project)}</div>${gitRemotePanel(project)}${gitInlineActions(project, surface)}</aside>
  </div>`;
  const draft = state.gitCommitMessages.get(project.id) || "";
  const suggested = state.gitSuggestedMessages.has(project.id);
  const suggestionLoading = state.gitSuggestionLoading.has(project.id);
  const commitInputId = surface === "page" ? "git-page-commit-message" : "git-commit-message";
  return `<div class="git-workbench">
    <div class="git-files-panel">
      <div class="git-files-head"><div><strong>Geänderte Dateien</strong><span>${changes}${git.filesTruncated ? "+" : ""} im Arbeitsbaum</span></div><div>
        <button data-git-action="refresh" data-project-id="${project.id}" ${pending ? "disabled" : ""} title="Git-Status aktualisieren"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button>
        <button data-git-action="${git.staged ? "unstage-all" : "stage-all"}" data-project-id="${project.id}" ${pending ? "disabled" : ""}>${git.staged ? "Vormerkungen lösen" : "Alle vormerken"}</button>
      </div></div>
      ${gitSelectionToolbar(project)}
      <div class="git-file-list">${git.files.map((file) => gitFileRow(project, file)).join("")}${git.filesTruncated ? '<p class="git-files-truncated">Weitere Dateien werden aus Performancegründen nicht einzeln angezeigt. „Alle vormerken“ erfasst sie trotzdem.</p>' : ""}</div>
    </div>
    ${gitDiffViewer(project)}
    <aside class="git-commit-panel">
      <div><p class="eyebrow">Letzter Commit</p>${gitLastCommit(project)}</div>
      <div class="commit-composer ${suggested ? "suggested" : ""}"><label for="${commitInputId}">Commit-Nachricht <span class="commit-suggestion-status">${suggestionLoading ? "wird erstellt …" : suggested ? "Vorschlag" : `${git.staged} vorgemerkt`}</span></label><div class="commit-message-field"><input id="${commitInputId}" data-commit-message="${project.id}" data-focus-key="git-commit-${project.id}" value="${escapeHtml(draft)}" maxlength="200" placeholder="${suggestionLoading ? "Vorschlag wird erstellt …" : "Was wurde geändert?"}" autocomplete="off"><button type="button" class="commit-suggest-button" data-git-suggest-message="${project.id}" title="Commit-Vorschlag aktualisieren" aria-label="Commit-Vorschlag aktualisieren" ${pending || !git.staged || suggestionLoading ? "disabled" : ""}><i class="fa-solid ${suggestionLoading ? "fa-spinner fa-spin" : "fa-wand-magic-sparkles"}" aria-hidden="true"></i></button></div><button class="git-commit-button" data-git-action="commit" data-project-id="${project.id}" ${pending || !git.staged || draft.trim().length < 3 ? "disabled" : ""}>${state.pendingGitAction === `${project.id}:commit` ? "Commit läuft …" : "Commit erstellen"}</button><small class="commit-composer-note">${suggested ? '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Automatisch vorgeschlagen · frei bearbeitbar' : "Der Commit enthält nur vorgemerkte Dateien."}</small></div>
      ${gitRemotePanel(project)}${gitInlineActions(project, surface)}
    </aside>
  </div>`;
}

function gitBranchSwitcher(project) {
  const git = project.git;
  const open = state.gitBranchMenu === project.id;
  const pending = state.pendingGitAction?.startsWith(`${project.id}:`);
  const entry = state.gitBranches.get(project.id);
  const loading = state.gitBranchLoading.has(project.id);
  let menu = "";
  if (open) {
    const list = entry?.error
      ? `<p class="git-branch-menu-note error">${escapeHtml(entry.error)}</p>`
      : loading && !entry?.branches ? '<p class="git-branch-menu-note"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Branches werden geladen …</p>'
        : (entry?.branches || []).map((branch) => `<button class="git-branch-option ${branch.current ? "current" : ""}" data-git-checkout="${escapeHtml(branch.name)}" data-project-id="${project.id}" ${pending || branch.current ? "disabled" : ""} title="${branch.current ? "Aktueller Branch" : `Zu „${escapeHtml(branch.name)}“ wechseln`}">
            <i class="fa-solid ${branch.current ? "fa-check" : "fa-code-branch"}" aria-hidden="true"></i><span>${escapeHtml(branch.name)}</span>${branch.upstream ? "<small>remote</small>" : ""}
          </button>`).join("") || '<p class="git-branch-menu-note">Noch keine lokalen Branches vorhanden.</p>';
    menu = `<div class="git-branch-menu">
      <div class="git-branch-menu-list">${list}</div>
      <form class="git-branch-create" data-git-create-branch="${project.id}">
        <input name="branch" placeholder="neuer-branch" maxlength="100" autocomplete="off" spellcheck="false" aria-label="Name für neuen Branch" ${pending ? "disabled" : ""}>
        <button type="submit" ${pending ? "disabled" : ""}>Erstellen</button>
      </form>
    </div>`;
  }
  return `<div class="git-status-branch ${open ? "open" : ""}">
    <span class="git-node"></span>
    <button type="button" class="git-branch-toggle" data-git-branch-menu="${project.id}" aria-expanded="${open}" aria-haspopup="true" title="Branch wechseln oder erstellen">
      <code>${escapeHtml(git.branch || "detached HEAD")}</code><i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
    </button>
    ${menu}
  </div>`;
}

function gitDetail(project, surface = "drawer") {
  const git = project.git;
  if (!git) return `<section class="detail-panel git-detail empty-git"><div class="detail-section-head"><div><p class="eyebrow">Versionskontrolle</p><h3>Kein Git-Repository</h3></div></div><p>In diesem Projektordner wurde kein Repository erkannt. Du kannst direkt ein Terminal öffnen, um eines anzulegen.</p><button class="detail-secondary-action" data-project-action="terminal" data-project-id="${project.id}" ${state.capabilities?.terminal.available ? "" : "disabled"}>&gt;_ Terminal öffnen</button></section>`;
  const changes = git.changedFiles ?? git.files.length;
  const repoHint = git.repositoryRoot === "." ? "Projektstamm" : git.repositoryRoot;
  return `<section class="detail-panel git-detail ${surface === "page" ? "git-page-detail" : ""}">
    <div class="git-detail-toolbar">
      <nav class="git-mode-tabs" aria-label="Git-Arbeitsmodus">
        <button class="${state.gitMode === "changes" ? "active" : ""}" data-git-mode="changes" data-project-id="${project.id}" aria-pressed="${state.gitMode === "changes"}"><i class="fa-solid fa-code-branch" aria-hidden="true"></i>Änderungen <b>${changes}</b></button>
        <button class="${state.gitMode === "history" ? "active" : ""}" data-git-mode="history" data-project-id="${project.id}" aria-pressed="${state.gitMode === "history"}"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>Verlauf</button>
      </nav>
      <span>Git · ${escapeHtml(repoHint)}</span>
    </div>
    <div class="git-status-strip" aria-label="Git-Status">
      ${gitBranchSwitcher(project)}
      <span class="git-health ${git.dirty ? "dirty" : "clean"}"><i></i>${git.dirty ? `${changes} offen` : "sauber"}</span>
      <div class="git-status-changes"><span><b>${git.staged}</b> vorgemerkt</span><span><b>${git.unstaged}</b> lokal</span><span><b>${git.untracked}</b> neu</span></div>
      <div class="git-status-sync"><small>${escapeHtml(git.upstream || git.remoteName || "kein Remote")}</small><span>↑ ${git.ahead}</span><span>↓ ${git.behind}</span></div>
    </div>
    ${state.gitMode === "history" ? gitHistoryView(project) : gitChangesView(project, surface)}
  </section>`;
}

function gitOverview(project) {
  return `<section class="detail-panel git-overview empty-git-overview"><div><p class="eyebrow">Versionskontrolle</p><h3>Kein Git-Repository</h3></div><p>Für dieses Projekt wurde kein Repository erkannt.</p></section>`;
}

function gitRepositoryTone(project) {
  const git = project.git;
  if (!git) return "clean";
  if (gitConflictCount(git)) return "conflict";
  if (git.dirty) return "changes";
  if (git.behind) return "behind";
  if (git.ahead) return "ahead";
  return "clean";
}

function gitRepositoryMatches(project, filter) {
  const git = project.git;
  if (!git) return false;
  if (filter === "changed") return git.dirty;
  if (filter === "staged") return git.staged > 0;
  if (filter === "sync") return git.ahead > 0 || git.behind > 0;
  if (filter === "conflicts") return gitConflictCount(git) > 0;
  if (filter === "clean") return !git.dirty && git.ahead === 0 && git.behind === 0;
  return true;
}

function gitRepositoryItem(project) {
  const git = project.git;
  const status = gitStatusPresentation(git);
  const selected = project.id === state.activeGitProjectId;
  const changes = git.changedFiles ?? git.files.length;
  const conflicts = gitConflictCount(git);
  return `<button class="git-repository-item ${gitRepositoryTone(project)} ${selected ? "active" : ""}" data-git-repository="${project.id}" aria-pressed="${selected}">
    <span class="git-repository-node"><i class="fa-solid fa-code-branch" aria-hidden="true"></i></span>
    <span class="git-repository-copy">
      <strong>${escapeHtml(project.name)}</strong>
      <code title="${escapeHtml(project.relativePath)}">${escapeHtml(project.relativePath)}</code>
      <span><b>${escapeHtml(git.branch || "detached")}</b><em>${escapeHtml(status.label)}</em></span>
    </span>
    <span class="git-repository-signals">
      ${conflicts ? `<b class="conflict"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>${conflicts}</b>` : ""}
      ${changes ? `<b class="changes" title="Offene Änderungen">${changes}</b>` : ""}
      ${git.ahead ? `<b class="ahead" title="Commits voraus">↑${git.ahead}</b>` : ""}
      ${git.behind ? `<b class="behind" title="Commits zurück">↓${git.behind}</b>` : ""}
    </span>
  </button>`;
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

async function loadGitCommitSuggestion(projectId, force = false) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project?.git?.staged || state.gitSuggestionLoading.has(projectId)) return;
  if (!force && state.gitCommitMessages.has(projectId)) return;
  state.gitSuggestionLoading.add(projectId);
  renderGitSurfaces();
  try {
    const data = await api(`/api/projects/${projectId}/git/commit-message`);
    if (force || !state.gitCommitMessages.has(projectId)) {
      state.gitCommitMessages.set(projectId, data.message);
      state.gitSuggestedMessages.add(projectId);
    }
  } catch (error) {
    if (force) toast(error.message, "error");
  } finally {
    state.gitSuggestionLoading.delete(projectId);
    renderGitSurfaces();
  }
}

function loadGitSurfaceForProject(projectId, force = false) {
  if (state.page === "git" && !elements.projectDialog.open) { gitWorkspace.load(projectId, force); return; }
  const project = state.projects.find((item) => item.id === projectId);
  if (!project?.git) return;
  if (state.gitMode === "history") loadGitHistory(projectId, false, force);
  else {
    loadGitCommitSuggestion(projectId);
    const file = activeGitFile(project);
    if (file) loadGitDiff(project.id, file, force);
  }
}

function loadActiveGitSurface(force = false) {
  if (state.page === "git" && state.activeGitProjectId) loadGitSurfaceForProject(state.activeGitProjectId, force);
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
  if (elements.projectDialog.open) elements.projectDialog.close();
  setWorkspacePage("git", projectId);
}

function renderProjectDialog() {
  const project = state.projects.find((item) => item.id === state.activeProjectId);
  if (!project) {
    if (elements.projectDialog.open) elements.projectDialog.close();
    return;
  }
  const running = projectIsRunning(project);
  const [symbol, className] = techClass(project);
  const favorite = state.favorites.has(project.id);
  const editorName = state.capabilities?.editor.name || "Editor";
  const workbench = Boolean(project.git);
  elements.projectDialog.classList.toggle("workbench", workbench);
  const dialogHtml = `<article class="project-detail ${className} ${running ? "running" : ""}">
    <header class="project-detail-head">
      <div class="detail-accent"></div>
      <div class="detail-title-row">
        ${project.thumbnailUrl ? `<img class="detail-symbol" src="${escapeHtml(project.thumbnailUrl)}" alt="">` : `<span class="stack-symbol detail-symbol">${escapeHtml(symbol)}</span>`}
        <div class="detail-title-copy"><p class="eyebrow">Projektakte${project.category ? ` · ${escapeHtml(project.category)}` : ""}</p><h2 id="project-dialog-title">${escapeHtml(project.name)}</h2><code>${escapeHtml(projectPath(project))}</code></div>
        <button class="favorite-button detail-favorite ${favorite ? "active" : ""}" data-favorite="${project.id}" aria-label="${favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}" aria-pressed="${favorite}">${favoriteIcon(favorite)}</button>
        <button class="project-dialog-close" data-close-project aria-label="Projektdetails schließen">×</button>
      </div>
      <p class="detail-description">${escapeHtml(project.description)}</p>
      <div class="detail-tech-list">${project.technologies.map((technology) => `<span class="tech-chip">${escapeHtml(technology)}</span>`).join("")}</div>
      <div class="detail-primary-actions">
        ${primaryAction(project)}
        <button class="detail-action-button" data-project-action="editor" data-project-id="${project.id}" ${state.capabilities?.editor.available ? "" : "disabled"}><i class="fa-solid fa-code" aria-hidden="true"></i><span>${escapeHtml(editorName)}</span></button>
        <button class="detail-action-button" data-project-action="terminal" data-project-id="${project.id}" ${state.capabilities?.terminal.available ? "" : "disabled"}><i class="fa-solid fa-terminal" aria-hidden="true"></i><span>Terminal</span></button>
        <button class="detail-action-button" data-project-action="folder" data-project-id="${project.id}"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><span>Ordner</span></button>
        <button class="detail-action-button" data-copy-path="${project.id}"><i class="fa-regular fa-copy" aria-hidden="true"></i><span>Pfad</span></button>
      </div>
    </header>
    <div class="project-detail-body combined-body">
      <section class="detail-facts" aria-label="Projektübersicht">
        <div><strong>${project.fileCount.toLocaleString("de-DE")}</strong><span>Dateien erkannt</span></div>
        <div><strong>${project.launchers.length}</strong><span>Starter</span></div>
        <div><strong>${running ? "Aktiv" : "Bereit"}</strong><span>Laufzeitstatus</span></div>
        <div><strong>${dateTime(project.modifiedAt)}</strong><span>Zuletzt geändert</span></div>
      </section>
      ${project.git ? gitDetail(project) : gitOverview(project)}
      <section class="detail-panel launcher-detail">
        <div class="detail-section-head"><div><p class="eyebrow">Ausführung</p><h3>Starter</h3></div><span class="detail-count">${project.launchers.length}</span></div>
        ${project.launchers.length ? `<div class="detail-launcher-list">${project.launchers.map(launcherRow).join("")}</div>` : '<p class="detail-empty-note">Kein automatischer Starter erkannt. Ordner, IDE und Terminal stehen trotzdem bereit.</p>'}
      </section>
    </div>
  </article>`;
  if (elements.projectDialogContent.__devhubHtml !== dialogHtml) {
    elements.projectDialogContent.__devhubHtml = dialogHtml;
    elements.projectDialogContent.innerHTML = dialogHtml;
  }
}

function openProjectDetails(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.activeProjectId = projectId;
  markRecent(projectId);
  renderProjectDialog();
  if (!elements.projectDialog.open) elements.projectDialog.showModal();
  if (project.git) loadGitSurfaceForProject(projectId);
  renderStats();
}

function renderStats() {
  const launchers = state.projects.flatMap(topLaunchers);
  const running = state.projects.flatMap((project) => project.launchers).filter((launcher) => launcher.runtime.status === "running").length;
  elements.runningCount.textContent = running;
  elements.projectCount.textContent = state.projects.length;
  elements.launcherCount.textContent = launchers.length;
  elements.allCount.textContent = state.projects.length;
  elements.gitRepositoryCount.textContent = state.projects.filter((project) => project.git).length;
  elements.favoriteCount.textContent = state.projects.filter((project) => state.favorites.has(project.id)).length;
  elements.recentCount.textContent = state.projects.filter((project) => state.recent.includes(project.id)).length;
  elements.runningFilterCount.textContent = state.projects.filter(projectIsRunning).length;
  elements.attentionCount.textContent = state.projects.filter((project) => projectAttentionReasons(project).length > 0).length;
}

function renderCategoryFilters() {
  const counts = new Map();
  for (const project of state.projects) {
    if (project.categoryPath) counts.set(project.categoryPath, (counts.get(project.categoryPath) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0]), "de"));
  elements.categoryGroup.hidden = entries.length === 0;
  elements.mobileCategory.hidden = entries.length === 0;
  elements.categoryFilters.innerHTML = entries.map(([categoryPath, count]) => {
    const active = state.category === categoryPath;
    return `<button class="tech-filter ${active ? "active" : ""}" data-category="${escapeHtml(categoryPath)}" aria-pressed="${active}">${escapeHtml(categoryLabel(categoryPath))} · ${count}</button>`;
  }).join("");
  elements.mobileCategory.innerHTML = '<option value="">Kategorie</option>' + entries
    .map(([categoryPath, count]) => `<option value="${escapeHtml(categoryPath)}">${escapeHtml(categoryLabel(categoryPath))} · ${count}</option>`).join("");
  elements.mobileCategory.value = state.category || "";
  elements.clearCategory.hidden = !state.category;
}

function renderTechFilters() {
  const counts = new Map();
  state.projects.forEach((project) => project.technologies.forEach((technology) => counts.set(technology, (counts.get(technology) || 0) + 1)));
  elements.techFilters.innerHTML = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de")).slice(0, 12)
    .map(([technology, count]) => `<button class="tech-filter ${state.technology === technology ? "active" : ""}" data-tech="${escapeHtml(technology)}" aria-pressed="${state.technology === technology}">${escapeHtml(technology)} · ${count}</button>`).join("");
  elements.mobileTech.innerHTML = '<option value="">Technologie</option>' + [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de"))
    .map(([technology, count]) => `<option value="${escapeHtml(technology)}">${escapeHtml(technology)} · ${count}</option>`).join("");
  elements.mobileTech.value = state.technology || "";
  elements.clearTech.hidden = !state.technology;
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
  const renderer = state.view === "list" ? projectListItem : projectCard;
  if (state.group !== "category") return projects.map((project) => ({ key: `project:${project.id}`, html: renderer(project) }));
  const entries = [];
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
  elements.resultCount.textContent = projects.length;
  elements.resultCount.closest(".result-label").hidden = projects.length === state.projects.length;
  elements.grid.classList.toggle("list-view", state.view === "list");
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
  const activeChips = [
    state.category ? { kind: "category", label: categoryLabel(state.category), hint: "Kategorie-Filter entfernen" } : null,
    state.technology ? { kind: "technology", label: state.technology, hint: "Technologie-Filter entfernen" } : null
  ].filter(Boolean);
  elements.activeFilter.hidden = activeChips.length === 0;
  elements.activeFilter.innerHTML = activeChips
    .map((chip) => `<span class="active-filter-chip">${escapeHtml(chip.label)} <button data-clear-filter="${chip.kind}" aria-label="${chip.hint}">×</button></span>`).join("");
  renderStats();
  renderCategoryFilters();
  renderTechFilters();
  renderServices();
  renderGitPage();
  renderWorkspaceNavigation();
  document.querySelectorAll("[data-view]").forEach((button) => { button.classList.toggle("active", button.dataset.view === state.view); button.setAttribute("aria-pressed", String(button.dataset.view === state.view)); });
  document.querySelectorAll("[data-mobile-filter]").forEach((button) => { const active = button.dataset.mobileFilter === state.filter; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); });
  if (elements.projectDialog.open && state.activeProjectId) renderProjectDialog();
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
    applyTrashCapability();
    setWorkspaceRoot(data.root);
    elements.workspaceBrowse.hidden = !data.capabilities.folderPicker;
    elements.sort.value = state.sort;
    render(false);
    loadActiveGitSurface();
    setTimeout(connectEvents, 1000);
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
    state.selectedGitFiles.clear();
    state.gitDiffs.clear();
    state.gitHistories.clear();
    for (const projectId of state.gitSuggestedMessages) state.gitCommitMessages.delete(projectId);
    state.gitSuggestedMessages.clear();
    state.gitSuggestionLoading.clear();
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
    state.activeGitFiles.clear();
    state.selectedGitFiles.clear();
    state.gitDiffs.clear();
    state.gitHistories.clear();
    state.gitCommitMessages.clear();
    state.gitSuggestedMessages.clear();
    state.gitSuggestionLoading.clear();
    state.activeGitCommits.clear();
    state.gitCommitDetails.clear();
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

// Die Texte des Verwerfen-Dialogs hängen davon ab, ob das System einen Papierkorb anbietet.
function applyTrashCapability() {
  const trash = state.capabilities?.trash;
  if (!elements.discardDescription || !elements.discardWarning) return;
  if (trash?.available) {
    elements.discardDescription.textContent = `Die ausgewählten Dateien werden auf ihren letzten Commit-Stand zurückgesetzt. Neue Dateien werden in den ${trash.name} verschoben.`;
    elements.discardWarning.textContent = `Das Zurücksetzen geänderter Dateien lässt sich nicht rückgängig machen. Neue Dateien kannst du aus dem ${trash.name} wiederherstellen.`;
  } else {
    elements.discardDescription.textContent = "Die ausgewählten Dateien werden auf ihren letzten Commit-Stand zurückgesetzt. Neue Dateien werden endgültig gelöscht, weil dieses System keinen Papierkorb anbietet.";
    elements.discardWarning.textContent = "Dieser Schritt lässt sich nicht rückgängig machen – weder für geänderte noch für neue Dateien.";
  }
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

function selectedGitFilePaths(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  return project?.git ? [...selectedGitFileSet(project)] : [];
}

function openGitDiscardDialog(projectId, files) {
  if (!files.length) return;
  state.pendingGitDiscard = { projectId, files };
  elements.discardCount.textContent = `${files.length} ${files.length === 1 ? "Datei ausgewählt" : "Dateien ausgewählt"}`;
  const shown = files.slice(0, 6);
  elements.discardFiles.innerHTML = shown.map((file) => `<code title="${escapeHtml(file)}">${escapeHtml(file)}</code>`).join("")
    + (files.length > shown.length ? `<span>+${files.length - shown.length} weitere</span>` : "");
  elements.discardDialog.showModal();
}

async function loadGitBranches(projectId) {
  if (state.gitBranchLoading.has(projectId)) return;
  state.gitBranchLoading.add(projectId);
  renderGitSurfaces();
  try {
    state.gitBranches.set(projectId, await api(`/api/projects/${projectId}/git/branches`));
  } catch (error) {
    state.gitBranches.set(projectId, { error: error.message });
  } finally {
    state.gitBranchLoading.delete(projectId);
    renderGitSurfaces();
  }
}

function toggleGitBranchMenu(projectId) {
  state.gitBranchMenu = state.gitBranchMenu === projectId ? null : projectId;
  renderGitSurfaces();
  if (state.gitBranchMenu) loadGitBranches(projectId);
}

function runGitSelectionAction(projectId, action) {
  const files = selectedGitFilePaths(projectId);
  if (!files.length) return;
  if (action === "discard-files") openGitDiscardDialog(projectId, files);
  else runGitProjectAction(projectId, action, { files });
}

async function runGitProjectAction(projectId, action, payload = {}) {
  const projectIndex = state.projects.findIndex((item) => item.id === projectId);
  if (projectIndex < 0 || state.pendingGitAction) return false;
  const undoSubject = action === "undo-commit" ? state.projects[projectIndex].git?.lastCommit?.subject : null;
  state.pendingGitAction = `${projectId}:${action}`;
  if (elements.projectDialog.open) renderProjectDialog();
  if (state.page === "git") renderGitPage();
  try {
    const data = await api(`/api/projects/${projectId}/git/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.projects[projectIndex] = data.project;
    if (action === "commit") {
      state.gitCommitMessages.delete(projectId);
      state.gitSuggestedMessages.delete(projectId);
      state.activeGitCommits.delete(projectId);
    }
    if (["refresh", "stage", "unstage", "stage-files", "unstage-files", "stage-all", "unstage-all", "discard-files"].includes(action) && state.gitSuggestedMessages.has(projectId)) {
      state.gitCommitMessages.delete(projectId);
      state.gitSuggestedMessages.delete(projectId);
    }
    if (action === "discard-files") state.selectedGitFiles.delete(projectId);
    if (action === "undo-commit" && undoSubject) {
      state.gitCommitMessages.set(projectId, undoSubject);
      state.gitSuggestedMessages.delete(projectId);
    }
    if (["checkout", "create-branch", "undo-commit"].includes(action)) {
      state.gitBranches.delete(projectId);
      state.activeGitCommits.delete(projectId);
      state.selectedGitFiles.delete(projectId);
      state.activeGitFiles.delete(projectId);
    }
    for (const key of state.gitDiffs.keys()) if (key.startsWith(`${projectId}\u0000`)) state.gitDiffs.delete(key);
    state.gitHistories.delete(projectId);
    toast(data.message);
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  } finally {
    state.pendingGitAction = null;
    render(false);
    if (elements.projectDialog.open || (state.page === "git" && state.activeGitProjectId === projectId)) loadGitSurfaceForProject(projectId, true);
  }
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
  events.addEventListener("log", (event) => { const data = JSON.parse(event.data); if (state.activeLogId === data.launcherId) appendLog(data.entry); });
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
  if (state.gitBranchMenu && !event.target.closest(".git-status-branch")) {
    state.gitBranchMenu = null;
    renderGitSurfaces();
  }
  const branchToggle = event.target.closest("[data-git-branch-menu]");
  if (branchToggle) { toggleGitBranchMenu(branchToggle.dataset.gitBranchMenu); return; }
  const checkoutOption = event.target.closest("[data-git-checkout]");
  if (checkoutOption) {
    state.gitBranchMenu = null;
    runGitProjectAction(checkoutOption.dataset.projectId, "checkout", { branch: checkoutOption.dataset.gitCheckout });
    return;
  }
  const repository = event.target.closest("[data-git-repository]");
  if (repository) {
    state.activeGitProjectId = repository.dataset.gitRepository;
    localStorage.setItem("devhub_git_project", state.activeGitProjectId);
    renderGitPage();
    loadGitSurfaceForProject(state.activeGitProjectId);
    return;
  }
  const mode = event.target.closest("[data-git-mode]");
  if (mode) {
    state.gitMode = mode.dataset.gitMode === "history" ? "history" : "changes";
    localStorage.setItem("devhub_git_mode", state.gitMode);
    renderGitSurfaces();
    loadGitSurfaceForProject(mode.dataset.projectId);
    return;
  }
  const historyRetry = event.target.closest("[data-git-history-retry]");
  if (historyRetry) { loadGitHistory(historyRetry.dataset.gitHistoryRetry, false, true); return; }
  const historyMore = event.target.closest("[data-git-history-more]");
  if (historyMore) { loadGitHistory(historyMore.dataset.gitHistoryMore, true); return; }
  const historyCommit = event.target.closest("[data-git-commit]");
  if (historyCommit) { loadGitCommit(historyCommit.dataset.projectId, historyCommit.dataset.gitCommit); return; }
  const gitWorkspace = event.target.closest("[data-open-git-workspace]");
  if (gitWorkspace) { openGitWorkspace(gitWorkspace.dataset.openGitWorkspace); return; }
  const details = event.target.closest("[data-open-details]");
  if (details) { openProjectDetails(details.dataset.openDetails); return; }
  const favorite = event.target.closest("[data-favorite]");
  if (favorite) { const id = favorite.dataset.favorite; state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id); localStorage.setItem("devhub_favorites", JSON.stringify([...state.favorites])); render(); return; }
  const selectAll = event.target.closest("[data-git-select-all]");
  if (selectAll) { selectAllGitFiles(selectAll.dataset.gitSelectAll, selectAll.checked); return; }
  const selectFile = event.target.closest("[data-git-select-file]");
  if (selectFile) { selectGitFile(selectFile.dataset.projectId, selectFile.dataset.gitSelectFile, true); return; }
  const selectionAction = event.target.closest("[data-git-selection-action]");
  if (selectionAction) { runGitSelectionAction(selectionAction.dataset.projectId, selectionAction.dataset.gitSelectionAction); return; }
  const suggestMessage = event.target.closest("[data-git-suggest-message]");
  if (suggestMessage) { loadGitCommitSuggestion(suggestMessage.dataset.gitSuggestMessage, true); return; }
  const gitAction = event.target.closest("[data-git-action]");
  if (gitAction) {
    const action = gitAction.dataset.gitAction;
    const payload = action === "commit" ? { message: state.gitCommitMessages.get(gitAction.dataset.projectId) || "" }
      : gitAction.dataset.file ? { file: gitAction.dataset.file } : {};
    runGitProjectAction(gitAction.dataset.projectId, action, payload);
    return;
  }
  const reloadDiff = event.target.closest("[data-reload-diff]");
  if (reloadDiff) { loadGitDiff(reloadDiff.dataset.projectId, reloadDiff.dataset.file, true); return; }
  const gitFile = event.target.closest("[data-git-file]");
  if (gitFile) { selectGitFile(gitFile.dataset.projectId, gitFile.dataset.gitFile, event.ctrlKey || event.metaKey); return; }
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
  const opened = event.target.closest("[data-open-id]"); if (opened) { markRecent(opened.dataset.openId); renderStats(); return; }
  if (event.target.closest("a, button, input, select, textarea")) return;
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
    openProjectDetails(card.dataset.project);
  }
});
elements.projectDialogContent.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-project]")) { elements.projectDialog.close(); return; }
  handleProjectInteraction(event);
});
function handleGitComposerInput(event) {
  const input = event.target.closest("[data-commit-message]");
  if (!input) return;
  const projectId = input.dataset.commitMessage;
  const project = state.projects.find((item) => item.id === projectId);
  state.gitCommitMessages.set(projectId, input.value);
  state.gitSuggestedMessages.delete(projectId);
  const composer = input.closest(".commit-composer");
  composer?.classList.remove("suggested");
  const note = composer?.querySelector(".commit-composer-note");
  if (note) note.textContent = "Der Commit enthält nur vorgemerkte Dateien.";
  const status = composer?.querySelector(".commit-suggestion-status");
  if (status && project?.git) status.textContent = `${project.git.staged} vorgemerkt`;
  const commitButton = input.closest(".git-detail")?.querySelector('[data-git-action="commit"]');
  if (commitButton && project?.git) commitButton.disabled = !project.git.staged || input.value.trim().length < 3 || Boolean(state.pendingGitAction);
}

function handleGitKeyboard(event) {
  const fileList = event.target.closest(".git-file-list");
  if (fileList && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    const row = fileList.querySelector("[data-git-file]");
    if (row) { event.preventDefault(); selectAllGitFiles(row.dataset.projectId, true); }
    return;
  }
  if (fileList && event.key === "Escape") {
    const row = fileList.querySelector("[data-git-file]");
    if (row) { event.preventDefault(); selectAllGitFiles(row.dataset.projectId, false); }
    return;
  }
  const commit = event.target.closest("[data-git-commit]");
  if (commit && event.target === commit && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault(); loadGitCommit(commit.dataset.projectId, commit.dataset.gitCommit); return;
  }
  const file = event.target.closest("[data-git-file]");
  if (file && event.target === file && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault(); selectGitFile(file.dataset.projectId, file.dataset.gitFile, event.ctrlKey || event.metaKey); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && event.target.matches("[data-commit-message]")) {
    const button = event.target.closest(".git-detail")?.querySelector('[data-git-action="commit"]');
    if (button && !button.disabled) { event.preventDefault(); button.click(); }
  }
}

function handleGitBranchCreate(event) {
  const form = event.target.closest("[data-git-create-branch]");
  if (!form) return;
  event.preventDefault();
  const name = (form.querySelector("input[name=branch]")?.value || "").trim();
  if (!name) return;
  state.gitBranchMenu = null;
  runGitProjectAction(form.dataset.gitCreateBranch, "create-branch", { branch: name });
}

elements.projectDialogContent.addEventListener("input", handleGitComposerInput);
elements.projectDialogContent.addEventListener("keydown", handleGitKeyboard);
elements.projectDialogContent.addEventListener("submit", handleGitBranchCreate);
elements.gitPage.addEventListener("input", handleGitComposerInput);
elements.gitPage.addEventListener("keydown", handleGitKeyboard);
elements.gitPage.addEventListener("submit", handleGitBranchCreate);
elements.projectDialog.addEventListener("click", (event) => { if (event.target === elements.projectDialog) elements.projectDialog.close(); });
elements.projectDialog.addEventListener("close", () => { state.activeProjectId = null; });

document.querySelector("#view-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]"); if (!button) return;
  if (button.dataset.filter) setViewFilter(button.dataset.filter);
  else setWorkspacePage(button.dataset.page);
});
document.querySelector("#mobile-workspace-tabs").addEventListener("click", (event) => { const button = event.target.closest("[data-page]"); if (button) setWorkspacePage(button.dataset.page); });
document.querySelector("#mobile-view-filters").addEventListener("click", (event) => { const button = event.target.closest("[data-mobile-filter]"); if (button) setViewFilter(button.dataset.mobileFilter); });
elements.mobileTech.addEventListener("change", () => { state.technology = elements.mobileTech.value || null; render(false); });
elements.techFilters.addEventListener("click", (event) => { const button = event.target.closest("[data-tech]"); if (!button) return; state.technology = state.technology === button.dataset.tech ? null : button.dataset.tech; render(false); });
elements.clearTech.addEventListener("click", () => { state.technology = null; render(false); });
elements.categoryFilters.addEventListener("click", (event) => { const button = event.target.closest("[data-category]"); if (button) setCategoryFilter(state.category === button.dataset.category ? null : button.dataset.category); });
elements.mobileCategory.addEventListener("change", () => setCategoryFilter(elements.mobileCategory.value || null));
elements.clearCategory.addEventListener("click", () => setCategoryFilter(null));
elements.activeFilter.addEventListener("click", (event) => {
  const button = event.target.closest("[data-clear-filter]");
  if (!button) return;
  if (button.dataset.clearFilter === "category") setCategoryFilter(null);
  else { state.technology = null; render(false); }
});
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
});
elements.svcPanel.addEventListener("click", (event) => {
  const details = event.target.closest("[data-open-details]");
  if (details) { setServicePanel(false); openProjectDetails(details.dataset.openDetails); return; }
  const opened = event.target.closest("[data-open-id]");
  if (opened) markRecent(opened.dataset.openId);
});
elements.attention.addEventListener("click", (event) => {
  const log = event.target.closest("[data-log]");
  if (log) openLogs(log.dataset.log);
});
document.querySelector("#mobile-search").addEventListener("click", () => { elements.search.scrollIntoView({ block: "center" }); elements.search.focus(); });
document.querySelector("#close-log").addEventListener("click", () => elements.logDialog.close());
elements.discardCancel.addEventListener("click", () => elements.discardDialog.close());
elements.discardConfirm.addEventListener("click", async () => {
  const pending = state.pendingGitDiscard;
  if (!pending || elements.discardConfirm.disabled) return;
  elements.discardConfirm.disabled = true;
  elements.discardConfirm.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Wird verworfen …';
  const success = await runGitProjectAction(pending.projectId, "discard-files", { files: pending.files });
  if (success && elements.discardDialog.open) elements.discardDialog.close();
  else {
    elements.discardConfirm.disabled = false;
    elements.discardConfirm.textContent = "Änderungen verwerfen";
  }
});
elements.discardDialog.addEventListener("click", (event) => { if (event.target === elements.discardDialog) elements.discardDialog.close(); });
elements.discardDialog.addEventListener("close", () => {
  state.pendingGitDiscard = null;
  elements.discardConfirm.disabled = false;
  elements.discardConfirm.textContent = "Änderungen verwerfen";
});
document.querySelector("#clear-log").addEventListener("click", () => { elements.logOutput.innerHTML = '<span class="log-placeholder">Ansicht geleert. Neue Ausgaben erscheinen weiterhin live.</span>'; });
elements.restartLog.addEventListener("click", () => { if (state.activeLogId) runLauncher(state.activeLogId, "restart"); });
elements.logDialog.addEventListener("close", () => { state.activeLogId = null; }); elements.logDialog.addEventListener("click", (event) => { if (event.target === elements.logDialog) elements.logDialog.close(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.svcPanel.hidden) { setServicePanel(false); elements.svcPill.focus(); return; }
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
