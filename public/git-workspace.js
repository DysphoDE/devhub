// The Git workspace owns its view state; project discovery and system actions stay in app.js.
// Layout: a three-part header (repository · branch · one sync action), a guidance strip that names the next step,
// two primary tabs (changes · history) and a repository menu for everything that is used rarely.
export function createGitWorkspace({ root, state, api, renderApp, renderPatch, escapeHtml: esc, toast, projectAction, rescan }) {
  const rail = document.querySelector("#sidebar-git-repositories");
  const sessions = new Map();
  const cache = new Map();
  const pendingReads = new Map();
  const activity = [];
  let busy = null;
  let notice = null;
  let repoFilter = "all";
  let searchTimer;
  let menu = null;
  let menuQuery = "";
  let view = localStorage.getItem("devhub_git_view") === "overview" ? "overview" : "repo";
  let overviewFilter = "all";
  let dismissedGuides = new Set();
  let github = null;
  let githubLoading = false;
  let githubQuery = "";
  try { dismissedGuides = new Set(JSON.parse(localStorage.getItem("devhub_git_guides") || "[]")); } catch { /* ignore */ }
  const icon = name => `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;
  const selected = () => state.projects.find(p => p.id === state.activeGitProjectId);
  const session = id => {
    if (!sessions.has(id)) {
      let draft = {};
      try { draft = JSON.parse(sessionStorage.getItem(`devhub_git_draft_${id}`) || "{}"); } catch { /* invalid stored draft */ }
      sessions.set(id, { tab: "changes", file: null, scope: "working", fileQuery: "", branchQuery: "", historyQuery: "", historyAll: false, historyFile: "", commit: null, wrap: false, advanced: false, excluded: new Set(), collapsed: new Set(), ...draft, summary: draft.summary || "", description: draft.description || "", amend: false });
    }
    return sessions.get(id);
  };
  const saveDraft = id => { const s = session(id); sessionStorage.setItem(`devhub_git_draft_${id}`, JSON.stringify({ summary: s.summary, description: s.description })); };
  const key = (id, resource) => `${id}:${resource}`;
  const data = (id, resource) => cache.get(key(id, resource));
  const base = id => `/api/projects/${id}/git/`;
  const conflict = f => f.indexStatus === "U" || f.worktreeStatus === "U" || ["AA", "DD"].includes(f.indexStatus + f.worktreeStatus);
  const staged = f => !conflict(f) && ![".", "?"].includes(f.indexStatus);
  const working = f => conflict(f) || f.worktreeStatus !== ".";
  const includedFiles = p => p.git.files.filter(f => !session(p.id).excluded.has(f.path));
  const count = (p, filter) => p.git.files.filter(filter).length;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const formatDate = date => date ? new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(date)) : "";
  const ago = value => {
    if (!value) return null;
    const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
    if (minutes < 1) return "gerade eben";
    if (minutes < 60) return `vor ${plural(minutes, "Minute", "Minuten")}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `vor ${plural(hours, "Stunde", "Stunden")}`;
    const days = Math.round(hours / 24);
    if (days === 1) return "gestern";
    if (days < 30) return `vor ${days} Tagen`;
    return `am ${formatDate(value)}`;
  };
  const initials = name => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join("") || "?";
  const statusLabel = status => ({ M: "Geändert", A: "Neu", D: "Gelöscht", R: "Umbenannt", U: "Konflikt", C: "Kopiert", T: "Typ geändert", "?": "Neu" })[status] || status;
  const button = (label, action, attrs = "", disabled = false, style = "") => `<button type="button" class="gw-button ${style}" data-gw="${action}" ${attrs} ${disabled || busy ? "disabled" : ""}>${label}</button>`;
  const empty = (glyph, title, text, actions = "") => `<div class="gw-empty"><span class="gw-empty-icon">${icon(glyph)}</span><h3>${title}</h3><p>${text}</p>${actions}</div>`;
  const field = (label, name, value = "", options = "") => `<label class="gw-field"><span>${label}</span><input name="${name}" value="${esc(value)}" ${options}></label>`;
  const resourceError = value => value?.error ? `<div class="gw-resource-error" role="alert">${icon("triangle-exclamation")}<span>${esc(value.error)}</span>${button("Erneut laden", "refresh")}</div>` : "";
  const operationName = op => ({ merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert" })[op] || "Git-Vorgang";

  async function read(id, resource, url, force = false) {
    const k = key(id, resource);
    if (!force && (cache.has(k) || pendingReads.has(k))) return;
    const ticket = {};
    pendingReads.set(k, ticket);
    try {
      const result = await api(base(id) + url);
      if (pendingReads.get(k) === ticket) cache.set(k, result);
    } catch (error) {
      if (pendingReads.get(k) === ticket) cache.set(k, { error: error.message });
    } finally {
      if (pendingReads.get(k) === ticket) pendingReads.delete(k);
      if (state.activeGitProjectId === id && state.page === "git") render();
    }
  }
  function invalidate(id) {
    for (const k of cache.keys()) if (k.startsWith(`${id}:`)) cache.delete(k);
    for (const k of pendingReads.keys()) if (k.startsWith(`${id}:`)) pendingReads.delete(k);
  }
  function ensure(id, force = false) {
    const p = state.projects.find(p => p.id === id);
    if (!p?.git) return;
    if (force) invalidate(id);
    const s = session(id);
    read(id, "workspace", "workspace");
    if (s.tab === "changes") {
      if (p.git.files.length) read(id, "stats", "stats");
      else read(id, "history::false", "history?query=&all=false");
      const available = p.git.files.filter(s.advanced ? (s.scope === "staged" ? staged : working) : () => true);
      if (!available.some(f => f.path === s.file)) s.file = available[0]?.path || null;
      if (s.file) read(id, `diff:${s.advanced ? "index" : "all"}:${s.file}`, `diff?file=${encodeURIComponent(s.file)}&combined=${!s.advanced}`);
    }
    if (s.tab === "history") {
      read(id, `history:${s.historyQuery}:${s.historyAll}`, `history?query=${encodeURIComponent(s.historyQuery)}&all=${s.historyAll}`);
      if (s.commit) read(id, `commit:${s.commit}:${s.historyFile}`, `commits/${s.commit}${s.historyFile ? `?file=${encodeURIComponent(s.historyFile)}` : ""}`);
    }
    if (s.tab === "stashes" && s.stash) {
      const stash = data(id, "workspace")?.stashes?.find(item => item.hash === s.stash);
      if (stash) read(id, `stash:${stash.hash}`, `stash-diff?stash=${encodeURIComponent(stash.ref)}&hash=${stash.hash}`);
    }
  }

  // One state machine decides what the sync segment, the guidance strip and the empty states say.
  function syncState(p, w) {
    const g = p.git;
    if (w?.operation) return "operation";
    if (count(p, conflict)) return "conflict";
    if (!g.branch) return "detached";
    if (!g.remoteName) return "noremote";
    if (!g.lastCommit) return "nocommit";
    if (!g.upstream) return "publish";
    if (g.ahead && g.behind) return "diverged";
    if (g.behind) return "behind";
    if (g.ahead) return "ahead";
    return "clean";
  }
  function syncInfo(p, w) {
    const g = p.git; const key = syncState(p, w); const conflicts = count(p, conflict); const remote = g.remoteName || "origin";
    const fetched = g.lastFetchAt ? `Zuletzt geholt ${ago(g.lastFetchAt)}` : "Noch nie vom Remote geholt";
    const op = operationName(w?.operation);
    const table = {
      operation: { tone: "danger", glyph: "triangle-exclamation", title: conflicts ? "Konflikte lösen" : `${op} fortsetzen`, hint: conflicts ? `${op} angehalten · ${plural(conflicts, "Datei", "Dateien")} betroffen` : `${op} läuft · keine offenen Konflikte`, action: conflicts ? { label: "Abbrechen …", gw: "confirm-abort", style: "gw-danger-soft" } : { label: "Fortsetzen", gw: "continue", style: "gw-primary" }, dismissible: false,
        guide: conflicts ? `<strong>${op} angehalten: ${plural(conflicts, "Datei hat", "Dateien haben")} Konflikte.</strong> Wähle links eine Datei mit <b class="gw-status status-U">!</b> und übernimm eine Version oder löse sie im Editor. „Abbrechen“ stellt den Stand von vor dem ${op} wieder her, nichts geht verloren.` : `<strong>Alle Konflikte sind gelöst.</strong> Mit „Fortsetzen“ schließt Git den ${op} ab.` },
      conflict: { tone: "danger", glyph: "triangle-exclamation", title: "Konflikte lösen", hint: `${plural(conflicts, "Datei", "Dateien")} mit Konfliktmarkierungen`, action: null, dismissible: false,
        guide: `<strong>${plural(conflicts, "Datei hat", "Dateien haben")} Konflikte.</strong> Übernimm pro Datei eine Version oder bearbeite sie im Editor und markiere sie danach als gelöst.` },
      detached: { tone: "warn", glyph: "code-branch", title: "Kein Branch aktiv", hint: "Detached HEAD · Commits landen auf keinem Branch", action: { label: "Branch wählen", gw: "menu", attrs: 'data-value="branch"' }, dismissible: false,
        guide: `<strong>Du arbeitest auf keinem Branch.</strong> Wechsle auf einen Branch oder erstelle einen neuen, damit deine Commits nicht verloren gehen.` },
      noremote: { tone: "neutral", glyph: "cloud", title: "Remote hinzufügen", hint: "Dieses Repository existiert nur auf diesem Rechner", action: { label: "Remote hinzufügen", gw: "remote-add-dialog", style: "gw-primary" }, dismissible: true,
        guide: `<strong>Nur lokal gesichert.</strong> Lege ein Remote an, um das Repository zu sichern oder zu teilen. Eine GitHub-, GitLab- oder SSH-URL reicht.` },
      nocommit: { tone: "neutral", glyph: "code-commit", title: "Erster Commit", hint: "Noch keine Commits in diesem Repository", action: null, dismissible: true,
        guide: `<strong>Dieses Repository hat noch keinen Commit.</strong> Wähle unten Dateien aus und schreibe eine Zusammenfassung, dann steht der erste Stand.` },
      publish: { tone: "info", glyph: "cloud-arrow-up", title: `Auf ${remote} veröffentlichen`, hint: `Branch ${g.branch} ist noch nicht auf ${remote}`, action: { label: "Veröffentlichen", gw: "push", style: "gw-primary" }, dismissible: true,
        guide: `<strong>„${esc(g.branch)}“ gibt es bisher nur hier.</strong> Veröffentlichen legt den Branch auf ${esc(remote)} an und verbindet ihn, danach reicht ein Push.` },
      diverged: { tone: "danger", glyph: "code-compare", title: "Pull, dann Push", hint: `${g.ahead} voraus · ${g.behind} zurück · ${fetched}`, chip: `${icon("arrow-up")}${g.ahead} ${icon("arrow-down")}${g.behind}`, action: { label: "Pull …", gw: "pull-dialog", style: "gw-primary" }, dismissible: false,
        guide: `<strong>„${esc(g.branch)}“ und ${esc(g.upstream)} sind auseinandergelaufen.</strong> Du hast ${plural(g.ahead, "Commit", "Commits")}, die das Remote nicht kennt, das Remote hat ${g.behind}, die dir fehlen. Hole zuerst, dann pushe. Rebase hält den Verlauf gerade, Merge behält beide Stränge.`,
        actions: [["Pull mit Merge", "pull-method", 'data-value="merge"', ""], ["Pull mit Rebase", "pull-method", 'data-value="rebase"', "gw-primary"]] },
      behind: { tone: "warn", glyph: "arrow-down", title: `Pull ${remote}`, hint: `${plural(g.behind, "neuer Commit", "neue Commits")} von ${g.upstream} · ${fetched}`, chip: `${icon("arrow-down")}${g.behind}`, action: { label: "Pull", gw: "pull", style: "gw-primary" }, dismissible: true,
        guide: `<strong>${esc(g.upstream)} hat ${plural(g.behind, "Commit", "Commits")}, ${g.behind === 1 ? "der" : "die"} dir ${g.behind === 1 ? "fehlt" : "fehlen"}.</strong> Du hast keine eigenen Commits voraus, ein Pull ist gefahrlos und erzeugt keinen Merge-Commit.`,
        actions: [["Was kommt rein?", "compare", `data-branch="${esc(g.upstream)}"`, ""]] },
      ahead: { tone: "info", glyph: "arrow-up", title: `Push ${remote}`, hint: `${plural(g.ahead, "lokaler Commit", "lokale Commits")} hochladen · ${fetched}`, chip: `${icon("arrow-up")}${g.ahead}`, action: { label: "Push", gw: "push", style: "gw-primary" }, dismissible: true,
        guide: `<strong>${plural(g.ahead, "Commit liegt", "Commits liegen")} nur auf diesem Rechner.</strong> Solange du nicht pushst, sieht ${g.ahead === 1 ? "ihn" : "sie"} niemand und ein Festplattenschaden nimmt ${g.ahead === 1 ? "ihn" : "sie"} mit.` },
      clean: { tone: "ok", glyph: "arrows-rotate", title: `Fetch ${remote}`, hint: fetched, action: { label: "Fetch", gw: "fetch" }, dismissible: true,
        guide: `<strong>Alles synchron.</strong> „${esc(g.branch)}“ und ${esc(g.upstream)} zeigen auf denselben Commit.${g.dirty ? ` ${plural(g.changedFiles, "Datei wartet", "Dateien warten")} auf einen Commit.` : ""}` }
    };
    return { key, ...table[key] };
  }

  function repositoryRail(repositories) {
    const q = state.gitQuery.toLocaleLowerCase();
    const filtered = repositories.filter(p => `${p.name} ${p.relativePath} ${p.git.branch}`.toLocaleLowerCase().includes(q) && (repoFilter === "all" || (repoFilter === "changed" ? p.git.dirty : p.git.ahead || p.git.behind)));
    const dirty = repositories.filter(p => p.git.dirty).length;
    return `<aside class="gw-repositories" aria-label="Repositories"><header><span>REPOSITORIES <b>${repositories.length}</b></span>${button(icon("plus"), "add", 'aria-label="Repository hinzufügen" title="Repository klonen oder anlegen"', false, "gw-icon-button")}</header>
      <label class="gw-search">${icon("magnifying-glass")}<input type="search" data-gw-input="repoQuery" data-focus-key="gw-repo-search" aria-label="Repositories durchsuchen" placeholder="Repository suchen …" value="${esc(state.gitQuery)}"></label>
      <div class="gw-segments" aria-label="Repositories filtern">${[["all", "Alle"], ["changed", "Geändert"], ["sync", "Sync"]].map(([value, label]) => button(label, "filter", `data-value="${value}" aria-pressed="${repoFilter === value}"`, false, repoFilter === value ? "active" : "")).join("")}</div>
      <div class="gw-repo-list" data-gw-scroll="repositories">
        <button class="gw-repo gw-repo-overview ${view === "overview" ? "active" : ""}" data-gw="overview" aria-pressed="${view === "overview"}"><span class="gw-repo-icon">${icon("table-cells-large")}</span><span><strong>Übersicht</strong><small>${plural(repositories.length, "Repository", "Repositories")}</small></span><span class="gw-repo-count ${dirty ? "dirty" : "clean"}">${dirty || icon("check")}</span></button>
        ${filtered.map(p => `<button class="gw-repo ${view === "repo" && p.id === state.activeGitProjectId ? "active" : ""}" data-gw="repository" data-id="${p.id}" title="${esc(p.name)}" aria-pressed="${view === "repo" && p.id === state.activeGitProjectId}"><span class="gw-repo-icon">${icon("book-bookmark")}</span><span><strong>${esc(p.name)}</strong><small>${icon("code-branch")} ${esc(p.git.branch || "Detached HEAD")}${p.git.ahead ? ` <em class="ahead">↑${p.git.ahead}</em>` : ""}${p.git.behind ? ` <em class="behind">↓${p.git.behind}</em>` : ""}</small></span><span class="gw-repo-count ${p.git.files.some(conflict) ? "conflict" : p.git.dirty ? "dirty" : "clean"}">${p.git.files.some(conflict) ? icon("triangle-exclamation") : p.git.dirty ? p.git.changedFiles : icon("check")}</span></button>`).join("") || `<p class="gw-list-empty">Keine passenden Repositories.</p>`}</div>
      <footer><span class="gw-live-dot"></span><span>Lokaler Workspace</span><small>${dirty} geändert</small></footer></aside>`;
  }

  // Header: repository · branch · the one sync action that fits the current state.
  function header(p, w) {
    const g = p.git; const info = syncInfo(p, w);
    const syncing = busy && ["fetch", "pull", "push", "continue"].includes(busy.action);
    const segment = (value, glyph, label, strong, code, title, popover) => `<div class="gw-seg-wrap"><button type="button" class="gw-seg gw-seg-menu ${menu === value ? "open" : ""}" data-gw="menu" data-value="${value}" aria-haspopup="dialog" aria-expanded="${menu === value}" title="${title}"><span class="gw-seg-icon">${icon(glyph)}</span><span class="gw-seg-copy"><small>${label}</small>${strong}${code}</span>${icon("chevron-down")}</button>${menu === value ? popover() : ""}</div>`;
    return `<header class="gw-header">
      ${segment("repo", "book-bookmark", "Repository", `<strong>${esc(p.name)}</strong>`, `<code title="${esc(p.relativePath)}">${esc(p.relativePath)}</code>`, "Repository wechseln", () => repoPopover(p))}
      ${segment("branch", "code-branch", "Branch", `<strong class="gw-mono">${esc(g.branch || "Detached HEAD")}</strong>`, `<code>${g.upstream ? `verfolgt ${esc(g.upstream)}` : g.remoteName ? "noch kein Upstream" : "nur lokal"}</code>`, "Branch wechseln oder erstellen", () => branchPopover(p, w))}
      <div class="gw-seg gw-seg-sync tone-${info.tone}"><span class="gw-seg-icon">${icon(syncing ? "spinner fa-spin" : info.glyph)}</span><span class="gw-seg-copy"><small>${info.hint}</small><strong>${esc(info.title)}</strong></span>${info.chip ? `<span class="gw-chip tone-${info.tone}">${info.chip}</span>` : ""}${info.action ? button(esc(info.action.label), info.action.gw, info.action.attrs || "", info.action.disabled, `gw-seg-action ${info.action.style || ""}`) : ""}</div>
      <div class="gw-header-tools">${button(icon("code"), "editor", 'aria-label="Im Editor öffnen" title="Im Editor öffnen"', !state.capabilities?.editor.available, "gw-icon-button")}${button(icon("terminal"), "terminal", 'aria-label="Terminal öffnen" title="Terminal öffnen"', !state.capabilities?.terminal.available, "gw-icon-button")}${button(icon(busy?.action === "refresh" ? "spinner fa-spin" : "rotate"), "refresh", 'aria-label="Git-Status aktualisieren" title="Aktualisieren · ⌘/Ctrl R"', false, "gw-icon-button")}</div></header>`;
  }
  function repoPopover(p) {
    const repositories = state.projects.filter(x => x.git).sort((a, b) => Number(Boolean(b.git.dirty)) - Number(Boolean(a.git.dirty)) || a.name.localeCompare(b.name, "de"));
    const q = menuQuery.toLocaleLowerCase();
    const rows = repositories.filter(x => `${x.name} ${x.relativePath}`.toLocaleLowerCase().includes(q));
    return `<div class="gw-popover gw-popover-repo" role="dialog" aria-label="Repository wechseln">
      <label class="gw-search">${icon("magnifying-glass")}<input type="search" data-gw-input="menuQuery" data-focus-key="gw-menu-search" aria-label="Repository suchen" placeholder="Repository suchen …" value="${esc(menuQuery)}"></label>
      <div class="gw-popover-list" data-gw-scroll="repo-menu">${rows.map(x => `<button type="button" class="gw-menu-row gw-menu-main ${x.id === p.id ? "current" : ""}" data-gw="repository" data-id="${x.id}">${icon(x.id === p.id ? "check" : "book-bookmark")}<span><strong>${esc(x.name)}</strong><small>${esc(x.git.branch || "Detached HEAD")} · ${x.git.dirty ? plural(x.git.changedFiles, "Änderung", "Änderungen") : "sauber"}${x.git.ahead ? ` · ↑${x.git.ahead}` : ""}${x.git.behind ? ` · ↓${x.git.behind}` : ""}</small></span></button>`).join("") || '<p class="gw-list-empty">Kein passendes Repository.</p>'}</div>
      <footer>${button(icon("table-cells-large") + " Alle Repositories", "overview", "", false, "gw-link")}${button(icon("plus") + " Klonen oder anlegen …", "add", "", false, "gw-link")}</footer></div>`;
  }
  function branchPopover(p, w) {
    const s = session(p.id); const g = p.git;
    const q = s.branchQuery.trim(); const ql = q.toLocaleLowerCase();
    const all = w?.branches || [];
    const locals = all.filter(b => !b.remote);
    const remotes = all.filter(b => b.remote && !locals.some(l => b.name.endsWith(`/${l.name}`)));
    const matches = list => list.filter(b => b.name.toLocaleLowerCase().includes(ql));
    const exact = all.some(b => b.name === q || b.name.endsWith(`/${q}`));
    const row = b => `<div class="gw-menu-row ${b.current ? "current" : ""}"><button type="button" class="gw-menu-main" data-gw="${b.remote ? "checkout-remote" : "checkout"}" data-branch="${esc(b.name)}" ${b.current ? "disabled" : ""} title="${b.remote ? "Lokal auschecken" : b.current ? "Aktueller Branch" : "Zu diesem Branch wechseln"}">${icon(b.current ? "check" : b.remote ? "cloud" : "code-branch")}<span><strong class="gw-mono">${esc(b.name)}</strong><small>${b.current ? "aktuell" : b.remote ? "nur auf dem Remote" : b.upstream ? `verfolgt ${esc(b.upstream)}` : "nur lokal"}${b.lastCommitDate ? ` · ${ago(b.lastCommitDate)}` : ""}</small></span></button>${!b.current && g.branch ? button("Vergleichen", "compare", `data-branch="${esc(b.name)}" title="Änderungen gegenüber ${esc(g.branch)} zeigen"`, false, "gw-link") : ""}</div>`;
    const creatable = q && !exact && g.lastCommit;
    return `<div class="gw-popover gw-popover-branch" role="dialog" aria-label="Branches">
      <label class="gw-search">${icon("magnifying-glass")}<input type="search" data-gw-input="branchQuery" data-focus-key="gw-branch-search" aria-label="Branch suchen oder erstellen" placeholder="Branch suchen oder neu anlegen …" value="${esc(s.branchQuery)}" autocomplete="off"></label>
      <div class="gw-popover-list" data-gw-scroll="branch-menu">${resourceError(w)}
        ${creatable ? `<button type="button" class="gw-menu-row gw-menu-create gw-menu-main" data-gw="create-branch-now" data-branch="${esc(q)}">${icon("plus")}<span><strong>Branch „${esc(q)}“ erstellen</strong><small>von ${esc(g.branch || "HEAD")} · wechselt direkt dorthin</small></span><kbd>↵</kbd></button>` : ""}
        ${!w ? '<p class="gw-list-empty">Branches werden geladen …</p>' : ""}
        ${matches(locals).length ? `<p class="gw-menu-label">Lokal</p>${matches(locals).map(row).join("")}` : ""}
        ${matches(remotes).length ? `<p class="gw-menu-label">Nur auf dem Remote</p>${matches(remotes).map(row).join("")}` : ""}
        ${w && !creatable && !matches(locals).length && !matches(remotes).length ? '<p class="gw-list-empty">Kein passender Branch.</p>' : ""}</div>
      <footer>${button(icon("diagram-project") + " Alle Branches verwalten", "tab", 'data-value="branches"', false, "gw-link")}${button(icon("plus") + " Neuer Branch …", "create-branch-dialog", "", !g.lastCommit, "gw-link")}</footer></div>`;
  }
  function morePopover(p, w) {
    const canStash = p.git.dirty && !!p.git.lastCommit && !count(p, conflict);
    const item = (glyph, label, action, attrs = "", meta = "", disabled = false) => `<button type="button" class="gw-menu-row gw-menu-main" data-gw="${action}" ${attrs} ${disabled || busy ? "disabled" : ""}>${icon(glyph)}<span><strong>${label}</strong></span>${meta ? `<small>${meta}</small>` : ""}</button>`;
    return `<div class="gw-popover gw-popover-more" role="dialog" aria-label="Repository-Menü">
      <p class="gw-menu-label">Verwalten</p>
      ${item("diagram-project", "Branches …", "tab", 'data-value="branches"', `${w?.branches?.filter(b => !b.remote).length ?? ""}`)}
      ${item("box-archive", "Stashes", "tab", 'data-value="stashes"', `${w?.stashes?.length || ""}`)}
      ${item("tag", "Tags", "tab", 'data-value="tags"', `${w?.tags?.length || ""}`)}
      ${item("sliders", "Remotes & Identität", "tab", 'data-value="settings"', w?.remotes?.[0]?.name || "")}
      <p class="gw-menu-label">Aktionen</p>
      ${item("box-archive", "Änderungen im Stash sichern …", "stash-save-dialog", "", "", !canStash)}
      ${item("arrows-rotate", "Fetch", "fetch", "", "", !p.git.remoteName)}
      ${item("arrow-down", "Pull", "pull", "", "", !p.git.upstream || !p.git.behind || !!w?.operation)}
      ${item("arrow-up", p.git.upstream ? "Push" : "Veröffentlichen", "push", "", "", !p.git.remoteName || !p.git.lastCommit || !p.git.branch || (!!p.git.upstream && !p.git.ahead) || !!w?.operation)}
      ${item("rotate-left", "Letzten Commit zurücknehmen …", "undo-dialog", "", "", !p.git.lastCommit || !p.git.branch || (!!p.git.upstream && !p.git.ahead) || !!w?.operation)}
      <p class="gw-menu-label">Öffnen</p>
      ${item("code", "Im Editor", "editor", "", "", !state.capabilities?.editor.available)}
      ${item("terminal", "Im Terminal", "terminal", "", "", !state.capabilities?.terminal.available)}
      ${item("folder-open", "Ordner zeigen", "folder")}
      <p class="gw-menu-label">Workspace</p>
      ${item("table-cells-large", "Alle Repositories", "overview")}
      ${item("plus", "Repository klonen oder anlegen …", "add")}</div>`;
  }

  function guide(p, w) {
    const info = syncInfo(p, w);
    if (info.dismissible && dismissedGuides.has(info.key)) return "";
    if (info.key === "clean") return "";
    return `<div class="gw-guide tone-${info.tone}" role="status">${icon(info.glyph)}<p>${info.guide}</p><div class="gw-guide-actions">${(info.actions || []).map(([label, action, attrs, style]) => button(label, action, attrs, false, `gw-small ${style}`)).join("")}${info.dismissible ? button(icon("xmark"), "dismiss-guide", `data-value="${info.key}" aria-label="Hinweis nicht mehr zeigen" title="Für diesen Zustand nicht mehr zeigen"`, false, "gw-icon-button") : ""}</div></div>`;
  }
  function navigation(p, w) {
    const s = session(p.id);
    const secondary = { branches: ["diagram-project", "Branches"], stashes: ["box-archive", "Stashes"], tags: ["tag", "Tags"], settings: ["sliders", "Repository"] }[s.tab];
    const tab = (value, glyph, label, total) => button(`${icon(glyph)}<span>${label}</span>${total ? `<b>${total}</b>` : ""}`, "tab", `data-value="${value}" aria-pressed="${s.tab === value}"`, false, s.tab === value ? "active" : "");
    return `<nav class="gw-tabs" aria-label="Git-Arbeitsbereich">${tab("changes", "pen-to-square", "Änderungen", p.git.changedFiles)}${tab("history", "clock-rotate-left", "Verlauf")}${secondary ? `<span class="gw-tab-secondary">${tab(s.tab, secondary[0], secondary[1])}${button(icon("xmark"), "tab", 'data-value="changes" aria-label="Zurück zu den Änderungen"', false, "gw-icon-button")}</span>` : ""}
      <span class="gw-tabs-spacer"></span>
      <span class="gw-more-wrap">${button(icon("ellipsis") + " Repository " + icon("chevron-down"), "menu", `data-value="more" aria-haspopup="menu" aria-expanded="${menu === "more"}"`, false, `gw-more ${menu === "more" ? "open" : ""}`)}${menu === "more" ? morePopover(p, w) : ""}</span></nav>`;
  }

  function commitStatus(p) {
    const s = session(p.id); const w = data(p.id, "workspace");
    const total = s.advanced ? count(p, staged) : includedFiles(p).length;
    const conflicts = count(p, conflict);
    if (["commit", "amend", "commit-files", "amend-files"].includes(busy?.action)) return { ready: false, total, label: "Commit läuft …" };
    if (w?.operation) return { ready: false, total, label: `Erst ${operationName(w.operation)} abschließen` };
    if (conflicts) return { ready: false, total, label: "Erst Konflikte lösen" };
    if (s.summary.trim().length < 3) return { ready: false, total, label: s.summary.trim() ? "Zusammenfassung zu kurz" : "Zusammenfassung fehlt" };
    if (!total && !(s.advanced && s.amend)) return { ready: false, total, label: s.advanced ? "Nichts vorgemerkt" : "Keine Datei ausgewählt" };
    if (s.amend) return { ready: true, total, label: "Letzten Commit aktualisieren" };
    return { ready: true, total, label: `Commit ${plural(total, "Datei", "Dateien")} auf ${p.git.branch || "HEAD"}` };
  }
  const meterTone = summary => summary.length > 72 ? "over" : summary.length > 50 ? "long" : "ok";
  function composer(p) {
    const s = session(p.id);
    const w = data(p.id, "workspace");
    const status = commitStatus(p);
    const excluded = s.advanced ? 0 : p.git.files.length - includedFiles(p).length;
    return `<form class="gw-composer" data-gw-form="commit"><div class="gw-composer-heading"><span>${icon("code-commit")} ${s.amend ? "Letzten Commit bearbeiten" : "Neuer Commit"}</span><small>${s.advanced ? `${status.total} im Index` : `${status.total} von ${p.git.files.length} ausgewählt`}</small></div>
      <div class="gw-composer-row"><span class="gw-avatar" title="${esc(w?.identity?.name || "Commit-Identität")}">${esc(initials(w?.identity?.name))}</span><div class="gw-composer-fields">
      <div class="gw-summary-field"><input name="summary" data-gw-input="summary" data-focus-key="gw-summary" aria-label="Commit-Zusammenfassung" placeholder="Zusammenfassung der Änderung" value="${esc(s.summary)}" maxlength="200" autocomplete="off">${button(icon("wand-magic-sparkles"), "suggest", 'aria-label="Commit-Nachricht vorschlagen" title="Zusammenfassung aus den Änderungen vorschlagen"', !status.total, "gw-icon-button")}</div>
      <div class="gw-summary-meter ${meterTone(s.summary)}" ${s.summary.length ? "" : "hidden"} aria-hidden="true"><i data-width="${Math.min(100, s.summary.length / 72 * 100)}"></i><span>${s.summary.length} / 72</span></div>
      <textarea name="description" data-gw-input="description" data-focus-key="gw-description" aria-label="Commit-Beschreibung" placeholder="Beschreibung (optional)" maxlength="10000" rows="2">${esc(s.description)}</textarea></div></div>
      <div class="gw-composer-options"><label><input type="checkbox" data-gw-input="amend" ${s.amend ? "checked" : ""} ${!p.git.lastCommit || !p.git.branch || (p.git.upstream && !p.git.ahead) || busy || w?.operation ? "disabled" : ""}> Letzten Commit ändern</label>${excluded ? `<span>${plural(excluded, "Datei", "Dateien")} ausgeschlossen</span>` : ""}</div>
      <button type="submit" class="gw-button gw-primary gw-commit-submit" ${!status.ready || busy ? "disabled" : ""}>${icon(["commit", "amend", "commit-files", "amend-files"].includes(busy?.action) ? "spinner fa-spin" : "check")}<span>${esc(status.label)}</span><kbd>⌘↵</kbd></button>
      <small class="gw-identity">${w?.identity?.name ? `als ${esc(w.identity.name)} · ${button("ändern", "tab", 'data-value="settings"', false, "gw-link")}` : `${icon("circle-user")} Commit-Identität fehlt ${button("Einrichten", "tab", 'data-value="settings"', false, "gw-link")}`}</small></form>`;
  }
  function refreshComposer(p) {
    const s = session(p.id); const form = root.querySelector(".gw-composer"); if (!form) return;
    const status = commitStatus(p); const submit = form.querySelector(".gw-commit-submit");
    if (submit) { submit.disabled = !status.ready || !!busy; submit.querySelector("span").textContent = status.label; }
    const meter = form.querySelector(".gw-summary-meter");
    if (meter) { meter.hidden = !s.summary.length; meter.className = `gw-summary-meter ${meterTone(s.summary)}`; meter.querySelector("i").style.width = `${Math.min(100, s.summary.length / 72 * 100)}%`; meter.querySelector("span").textContent = `${s.summary.length} / 72`; }
  }
  function operationPanel(p, w) {
    const conflicts = count(p, conflict); const op = operationName(w?.operation);
    return `<div class="gw-operation-panel"><header>${icon("triangle-exclamation")}<div><strong>${w?.operation ? `${op} läuft` : "Konflikte lösen"}</strong><span>${conflicts ? `${plural(conflicts, "Datei", "Dateien")} mit Konflikten` : "Keine offenen Konflikte"}</span></div></header>
      <p>${conflicts ? "Wähle links eine Datei mit Konflikt. Übernimm eine Version oder löse sie im Editor und markiere sie als gelöst." : w?.operation ? `Alle Konflikte gelöst. „Fortsetzen“ schließt den ${op} ab.` : "Alle Konflikte sind vorgemerkt."}</p>
      ${w?.operation ? button(icon("check") + `<span>Fortsetzen${conflicts ? ` · noch ${plural(conflicts, "Konflikt", "Konflikte")}` : ""}</span>`, "continue", "", conflicts > 0, "gw-primary gw-commit-submit") : ""}
      ${w?.operation ? button(`${op} abbrechen …`, "confirm-abort", "", false, "gw-danger-soft gw-block") : ""}
      ${w?.operation ? `<small>Abbrechen stellt den Stand von vor dem ${op} wieder her. Deine bisherigen Commits bleiben erhalten.</small>` : ""}</div>`;
  }

  function fileRow(p, f, status, extra = "") {
    const s = session(p.id);
    const stats = data(p.id, "stats")?.[f.path];
    const name = f.path.split("/").pop();
    return `<div class="gw-file ${s.file === f.path ? "active" : ""} ${s.excluded.has(f.path) && !s.advanced ? "excluded" : ""} ${status === "U" ? "conflict" : ""}">${s.advanced ? "" : `<input type="checkbox" data-gw-input="includeFile" data-focus-key="gw-check-${esc(f.path)}" data-path="${esc(f.path)}" aria-label="${esc(f.path)} in Commit aufnehmen" ${s.excluded.has(f.path) ? "" : "checked"} ${busy ? "disabled" : ""}>`}
      <button type="button" data-gw="file" data-path="${esc(f.path)}" aria-pressed="${s.file === f.path}" title="${esc(f.path)}"><b class="gw-status status-${esc(status)}" title="${esc(statusLabel(status))}">${status === "U" ? "!" : status === "?" ? "A" : esc(status)}</b><span class="gw-file-name"><strong>${esc(name)}</strong>${f.originalPath ? `<small>← ${esc(f.originalPath)}</small>` : ""}</span>${stats ? `<span class="gw-file-stats">${stats.binary ? "<em>binär</em>" : `${stats.additions ? `<b>+${stats.additions}</b>` : ""}${stats.deletions ? `<s>−${stats.deletions}</s>` : ""}`}</span>` : ""}</button>
      <span class="gw-file-actions">${extra}</span></div>`;
  }
  function fileGroups(p, files, status, extra) {
    const s = session(p.id);
    const groups = new Map();
    for (const f of files) { const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""; if (!groups.has(dir)) groups.set(dir, []); groups.get(dir).push(f); }
    const dirs = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, "de")));
    if (dirs.length === 1 && dirs[0] === "") return files.map(f => fileRow(p, f, status(f), extra(f))).join("");
    return dirs.map(dir => `<div class="gw-file-group ${s.collapsed.has(dir) ? "collapsed" : ""}"><button type="button" class="gw-file-group-head" data-gw="fold" data-dir="${esc(dir)}" aria-expanded="${!s.collapsed.has(dir)}">${icon(s.collapsed.has(dir) ? "chevron-right" : "chevron-down")}<span>${dir ? esc(dir) : "Projektordner"}</span><b>${groups.get(dir).length}</b></button>${s.collapsed.has(dir) ? "" : groups.get(dir).map(f => fileRow(p, f, status(f), extra(f))).join("")}</div>`).join("");
  }
  function calmView(p, w) {
    const info = syncInfo(p, w);
    const g = p.git;
    const history = data(p.id, "history::false");
    const commits = history?.commits?.slice(0, 6) || [];
    const editor = state.capabilities?.editor.available ? button(icon("code") + " Im Editor öffnen", "editor") : "";
    const states = {
      clean: ["check", "Alles committet und hochgeladen", `„${esc(g.branch || "HEAD")}“ und ${esc(g.upstream || "das Remote")} zeigen auf denselben Commit. Sobald du eine Datei änderst, erscheint sie hier mit dem Commit-Formular.`, editor],
      ahead: ["arrow-up", `${plural(g.ahead, "Commit wartet", "Commits warten")} auf den Push`, "Der Arbeitsbaum ist sauber. Lade die lokalen Commits hoch, damit dein Stand gesichert ist.", button(icon("arrow-up") + " Jetzt pushen", "push", "", false, "gw-primary")],
      behind: ["arrow-down", `${plural(g.behind, "neuer Commit", "neue Commits")} auf ${esc(g.upstream || "dem Remote")}`, "Ein Pull übernimmt sie per Fast-forward, ohne Merge-Commit.", button("Was kommt rein?", "compare", `data-branch="${esc(g.upstream || "")}"`) + button(icon("arrow-down") + " Pull", "pull", "", false, "gw-primary")],
      diverged: ["code-compare", "Erst holen, dann pushen", "Nach dem Pull zeigt DevHub, ob Konflikte entstanden sind.", button("Pull …", "pull-dialog", "", false, "gw-primary")],
      publish: ["cloud-arrow-up", `„${esc(g.branch || "")}“ gibt es nur hier`, `Veröffentlichen legt den Branch auf ${esc(g.remoteName || "dem Remote")} an.`, button(icon("cloud-arrow-up") + " Veröffentlichen", "push", "", false, "gw-primary")],
      noremote: ["cloud", "Noch nirgends gesichert", g.lastCommit ? `Letzter Commit ${ago(g.lastCommit.date)}, nur auf diesem Rechner.` : "Dieses Repository existiert nur lokal.", button(icon("cloud") + " Remote hinzufügen", "remote-add-dialog", "", false, "gw-primary")],
      nocommit: ["code-commit", "Bereit für den ersten Commit", "Sobald Dateien im Projekt liegen, erscheinen sie hier.", editor],
      detached: ["code-branch", "Kein Branch aktiv", "Wähle einen Branch, damit Commits einen Platz haben.", button(icon("code-branch") + " Branch wählen", "menu", 'data-value="branch"')]
    };
    const [glyph, title, text, actions] = states[info.key] || states.clean;
    const tone = info.key === "clean" ? "ok" : info.key === "ahead" || info.key === "publish" ? "accent" : info.key === "behind" || info.key === "detached" ? "warn" : info.key === "diverged" ? "danger" : "neutral";
    const unpushed = g.upstream && g.branch ? g.ahead : 0;
    const list = history?.error ? resourceError(history)
      : !history ? '<p class="gw-list-empty">Commits werden geladen …</p>'
      : commits.length ? commits.map((c, index) => `<button type="button" class="gw-calm-commit" data-gw="calm-commit" data-hash="${c.hash}"><code>${esc(c.shortHash)}</code><span>${esc(c.subject)}${index < unpushed ? ' <em class="gw-ref">noch nicht gepusht</em>' : ""}</span><small>${ago(c.date)}</small></button>`).join("")
      : '<p class="gw-list-empty">Noch keine Commits.</p>';
    return `<div class="gw-calm"><section class="gw-calm-main"><span class="gw-calm-icon tone-${tone}">${icon(glyph)}</span><h3>${title}</h3><p>${text}</p>${actions ? `<div class="gw-calm-actions">${actions}</div>` : ""}</section>
      <section class="gw-calm-history"><header><span>Letzte Commits</span>${button("Ganzer Verlauf", "tab", 'data-value="history"', false, "gw-link")}</header><div class="gw-calm-commits">${list}</div></section></div>`;
  }
  function changeView(p) {
    const s = session(p.id);
    const w = data(p.id, "workspace");
    if (!p.git.files.length && !w?.operation) return calmView(p, w);
    if (s.advanced) return indexView(p);
    const files = p.git.files;
    const visible = files.filter(f => f.path.toLocaleLowerCase().includes(s.fileQuery.toLocaleLowerCase()));
    const chosen = includedFiles(p).length;
    if (!files.some(f => f.path === s.file)) s.file = files[0]?.path || null;
    const status = f => conflict(f) ? "U" : f.worktreeStatus === "?" ? "A" : f.worktreeStatus !== "." ? f.worktreeStatus : f.indexStatus;
    const extra = f => button(icon("rotate-left"), "discard", `data-path="${esc(f.path)}" aria-label="Änderungen an ${esc(f.path)} verwerfen" title="Änderungen verwerfen …"`, false, "gw-icon-button gw-danger-link") + button(icon("ban"), "file-menu", `data-path="${esc(f.path)}" aria-label="${esc(f.path)} ignorieren" title="Datei oder Ordner ignorieren …"`, false, "gw-icon-button");
    const inOperation = w?.operation || count(p, conflict);
    return `<div class="gw-changes"><section class="gw-change-list"><header class="gw-list-head"><label class="gw-select-all"><input type="checkbox" data-gw-input="selectAll" data-focus-key="gw-check-all" aria-label="Alle Dateien für den Commit auswählen" ${chosen === files.length && files.length ? "checked" : ""} ${!files.length || busy || inOperation ? "disabled" : ""}><strong>${plural(files.length, "Datei", "Dateien")}</strong>${files.length ? `<small>${chosen} ausgewählt</small>` : ""}</label><span>${button(icon("layer-group"), "advanced-mode", 'aria-label="Einzelne Abschnitte vormerken" title="Index-Modus: einzelne Diff-Abschnitte vormerken"', false, "gw-icon-button")}</span></header>
      ${files.length > 6 ? `<label class="gw-search">${icon("magnifying-glass")}<input type="search" data-gw-input="fileQuery" data-focus-key="gw-file-search" aria-label="Dateien filtern" placeholder="Dateien filtern …" value="${esc(s.fileQuery)}"></label>` : ""}
      <div class="gw-files" data-gw-scroll="files" aria-label="Dateien für den Commit">${visible.length ? fileGroups(p, visible, status, extra) : `<div class="gw-list-empty">${icon(files.length ? "magnifying-glass" : "check")}<strong>${files.length ? "Keine passenden Dateien" : "Keine Änderungen"}</strong><span>${files.length ? "Anderen Suchbegriff versuchen." : "Öffne das Projekt im Editor, dann erscheinen deine Änderungen hier."}</span></div>`}${p.git.filesTruncated ? '<p class="gw-list-empty">Die ersten 500 Dateien werden angezeigt. Die Auswahl gilt für diese Dateien.</p>' : ""}</div>
      ${inOperation ? operationPanel(p, w) : composer(p)}</section>${diffView(p)}</div>`;
  }
  function indexView(p) {
    const s = session(p.id);
    const w = data(p.id, "workspace");
    const files = p.git.files.filter(s.scope === "staged" ? staged : working);
    if (!files.some(f => f.path === s.file)) s.file = files[0]?.path || null;
    const visible = files.filter(f => f.path.toLocaleLowerCase().includes(s.fileQuery.toLocaleLowerCase()));
    const status = f => conflict(f) ? "U" : s.scope === "staged" ? f.indexStatus : f.worktreeStatus;
    const extra = f => button(icon(s.scope === "staged" ? "minus" : "plus"), s.scope === "staged" ? "unstage-file" : "stage-file", `data-path="${esc(f.path)}" title="${s.scope === "staged" ? "Vormerkung lösen" : "Datei vormerken"}" aria-label="${s.scope === "staged" ? "Vormerkung lösen" : "Datei vormerken"}: ${esc(f.path)}"`, false, "gw-icon-button gw-visible");
    const inOperation = w?.operation || count(p, conflict);
    return `<div class="gw-changes"><section class="gw-change-list"><div class="gw-advanced-note"><span>${icon("layer-group")} Index-Modus · Abschnitte einzeln vormerken</span>${button("Zur Dateiauswahl", "simple-mode", "", false, "gw-link")}</div>
      <div class="gw-change-switch" aria-label="Änderungen filtern">${button(`Arbeitsbaum <b>${count(p, working)}</b>`, "scope", 'data-value="working"', false, s.scope === "working" ? "active" : "")}${button(`Vorgemerkt <b>${count(p, staged)}</b>`, "scope", 'data-value="staged"', false, s.scope === "staged" ? "active" : "")}</div>
      <div class="gw-file-list-actions"><span>${plural(files.length, "Datei", "Dateien")}</span>${button(s.scope === "working" ? "Alle vormerken" : "Alle lösen", s.scope === "working" ? "stage-all" : "unstage-all", "", !files.length, "gw-link")}</div>
      <div class="gw-files" data-gw-scroll="files" aria-label="Geänderte Dateien">${visible.length ? fileGroups(p, visible, status, extra) : `<div class="gw-list-empty">${icon(files.length ? "magnifying-glass" : "check")}<strong>${files.length ? "Keine passenden Dateien" : s.scope === "staged" ? "Noch nichts vorgemerkt" : "Keine lokalen Änderungen"}</strong><span>${s.scope === "staged" ? "Mit + Dateien oder Abschnitte für den nächsten Commit vormerken." : "Hier erscheinen deine Änderungen."}</span></div>`}${p.git.filesTruncated ? '<p class="gw-list-empty">Die ersten 500 Dateien werden angezeigt. „Alle vormerken“ erfasst auch weitere Dateien.</p>' : ""}</div>
      ${inOperation ? operationPanel(p, w) : composer(p)}</section>${diffView(p)}</div>`;
  }
  function patchView(patch, wrap = false) { return `<div class="gw-patch ${wrap ? "wrap" : ""}">${renderPatch(patch)}</div>`; }
  function conflictBar(p, f, w) {
    const rebase = w?.operation === "rebase";
    return `<div class="gw-conflict-bar" role="status">${icon("triangle-exclamation")}<span><strong>Konflikt.</strong> ${rebase ? "Der Ziel-Branch und dein Commit ändern dieselben Zeilen." : "Beide Seiten ändern dieselben Zeilen."}</span>
      ${button(rebase ? "Ziel-Branch behalten" : `Meine Version behalten`, "resolve-dialog", `data-path="${esc(f.path)}" data-side="ours" title="${rebase ? "Version des Branch, auf den rebased wird (git checkout --ours)" : `Version von ${esc(p.git.branch || "HEAD")} (git checkout --ours)`}"`, false, "gw-small")}
      ${button(rebase ? "Meinen Commit übernehmen" : "Eingehende Version übernehmen", "resolve-dialog", `data-path="${esc(f.path)}" data-side="theirs" title="${rebase ? "Version aus deinem Commit (git checkout --theirs)" : "Version des integrierten Branch (git checkout --theirs)"}"`, false, "gw-small")}
      ${button(icon("code") + " Im Editor lösen", "editor", "", !state.capabilities?.editor.available, "gw-small")}${button("Als gelöst markieren", "stage-file", `data-path="${esc(f.path)}" title="Datei ohne Konfliktmarkierungen vormerken"`, false, "gw-small gw-primary")}</div>`;
  }
  function diffView(p) {
    const s = session(p.id);
    const w = data(p.id, "workspace");
    const f = p.git.files.find(f => f.path === s.file);
    if (!f) {
      const info = syncInfo(p, w);
      const emptyByState = {
        clean: ["check", "Alles synchron", `Arbeitsbaum sauber, ${esc(p.git.branch || "HEAD")} entspricht ${esc(p.git.upstream || "dem Remote")}.`, button(icon("clock-rotate-left") + " Verlauf ansehen", "tab", 'data-value="history"')],
        ahead: ["arrow-up", `${plural(p.git.ahead, "Commit wartet", "Commits warten")} auf den Push`, `Zuletzt: „${esc(p.git.lastCommit?.subject || "")}“`, button(icon("arrow-up") + " Jetzt pushen", "push", "", false, "gw-primary")],
        behind: ["arrow-down", `${plural(p.git.behind, "neuer Commit", "neue Commits")} auf ${esc(p.git.upstream || "dem Remote")}`, "Ein Pull übernimmt sie per Fast-forward, ohne Merge-Commit.", button("Was kommt rein?", "compare", `data-branch="${esc(p.git.upstream || "")}"`) + button(icon("arrow-down") + " Pull", "pull", "", false, "gw-primary")],
        diverged: ["code-compare", "Erst holen, dann pushen", "Nach dem Pull zeigt DevHub, ob Konflikte entstanden sind.", button("Pull …", "pull-dialog", "", false, "gw-primary")],
        publish: ["cloud-arrow-up", `„${esc(p.git.branch || "")}“ gibt es nur hier`, `Veröffentlichen legt den Branch auf ${esc(p.git.remoteName || "dem Remote")} an.`, button(icon("cloud-arrow-up") + " Veröffentlichen", "push", "", false, "gw-primary")],
        noremote: ["cloud", "Noch nirgends gesichert", p.git.lastCommit ? `Letzter Commit ${ago(p.git.lastCommit.date)}, nur auf diesem Rechner.` : "Dieses Repository existiert nur lokal.", button(icon("cloud") + " Remote hinzufügen", "remote-add-dialog", "", false, "gw-primary")],
        nocommit: ["code-commit", "Bereit für den ersten Commit", "Sobald Dateien im Projekt liegen, erscheinen sie links.", ""],
        detached: ["code-branch", "Kein Branch aktiv", "Wähle einen Branch, damit Commits einen Platz haben.", button(icon("code-branch") + " Branch wählen", "menu", 'data-value="branch"')],
        operation: ["triangle-exclamation", `${operationName(w?.operation)} läuft`, "Links stehen die betroffenen Dateien.", ""],
        conflict: ["triangle-exclamation", "Konflikte offen", "Links stehen die betroffenen Dateien.", ""]
      };
      const [glyph, title, text, actions] = s.advanced && s.scope === "staged" ? ["layer-group", "Bereit für deinen nächsten Commit", "Merke Dateien oder einzelne Abschnitte im Arbeitsbaum vor. Hier prüfst du genau das, was dein Commit enthalten wird.", ""] : emptyByState[info.key] || emptyByState.clean;
      return `<section class="gw-diff">${empty(glyph, title, text, actions)}</section>`;
    }
    const result = data(p.id, `diff:${s.advanced ? "index" : "all"}:${f.path}`);
    const section = result?.sections?.find(section => section.scope === (s.advanced ? s.scope : "working"));
    const patch = section?.patch || "";
    const additions = patch.split("\n").filter(l => /^\+(?!\+\+)/.test(l)).length;
    const deletions = patch.split("\n").filter(l => /^-(?!--)/.test(l)).length;
    const status = conflict(f) ? "U" : f.worktreeStatus === "?" ? "A" : f.worktreeStatus !== "." ? f.worktreeStatus : f.indexStatus;
    const title = `<header class="gw-diff-header"><div><b class="gw-status status-${esc(status)}">${status === "U" ? "!" : status === "?" ? "A" : esc(status)}</b><strong title="${esc(f.path)}">${esc(f.path)}</strong><span class="gw-diff-stats"><b>+${additions}</b><b>−${deletions}</b></span></div><div>${button(icon("text-width"), "wrap", `aria-label="Zeilenumbruch umschalten" title="Lange Zeilen umbrechen" aria-pressed="${s.wrap}"`, false, `gw-icon-button ${s.wrap ? "active" : ""}`)}${button(icon("copy"), "copy-file", 'aria-label="Dateipfad kopieren" title="Dateipfad kopieren"', false, "gw-icon-button")}${button(icon("code"), "editor", 'aria-label="Im Editor öffnen" title="Im Editor öffnen"', !state.capabilities?.editor.available, "gw-icon-button")}${button(icon("ban") + " Ignorieren …", "file-menu", `data-path="${esc(f.path)}"`, false, "gw-link")}${button(icon("rotate-left") + " Verwerfen …", "discard", `data-path="${esc(f.path)}"`, false, "gw-danger-link")}</div></header>`;
    let content;
    if (result?.error) content = resourceError(result);
    else if (!result) content = empty("spinner fa-spin", "Diff wird geladen", "Änderungen werden eingelesen …");
    else if (/^Binary files |^GIT binary patch/m.test(patch)) content = empty("file-image", "Binärdatei geändert", "Für diese Datei ist kein Textvergleich verfügbar. Du kannst sie als Ganzes committen oder im Editor öffnen.", button("Im Editor öffnen", "editor"));
    else if (!patch) content = empty("file-lines", "Kein Text-Diff vorhanden", "Die Änderung betrifft Dateimetadaten, einen Submodul-Verweis oder eine leere Datei.");
    else {
      const start = patch.indexOf("\n@@ ");
      const hunks = start < 0 ? [] : patch.slice(start + 1).split(/(?=^@@ )/m);
      const canHunk = s.advanced && !section.truncated && !/^(old|new) mode /m.test(patch) && !f.originalPath && !conflict(f) && ["M", "."].includes(f.indexStatus) && ["M", "."].includes(f.worktreeStatus) && hunks.length;
      content = canHunk ? hunks.map((hunk, index) => `<section class="gw-hunk"><header><span>Abschnitt ${index + 1} von ${hunks.length}</span>${button(icon(s.scope === "staged" ? "minus" : "plus") + (s.scope === "staged" ? " Abschnitt lösen" : " Abschnitt vormerken"), "hunk", `data-index="${index}"`, false, "gw-link")}</header>${patchView(hunk, s.wrap)}</section>`).join("") : patchView(patch, s.wrap);
    }
    const footer = conflict(f) ? "" : `<footer class="gw-diff-footer"><span>${s.advanced ? (s.scope === "staged" ? "Index · Inhalt des nächsten Commits" : "Arbeitsbaum") : s.excluded.has(f.path) ? "Vom nächsten Commit ausgeschlossen" : "Im nächsten Commit enthalten"}</span>${s.advanced ? button(s.scope === "staged" ? "Datei aus Index lösen" : "Datei in Index aufnehmen", s.scope === "staged" ? "unstage-file" : "stage-file", `data-path="${esc(f.path)}"`, false, "gw-link") : button(s.excluded.has(f.path) ? "In Commit aufnehmen" : "Von Commit ausschließen", "toggle-include", `data-path="${esc(f.path)}"`, false, "gw-link")}</footer>`;
    return `<section class="gw-diff">${title}${conflict(f) ? conflictBar(p, f, w) : ""}<div class="gw-diff-content" data-gw-scroll="diff">${content}${section?.truncated ? '<p class="gw-limit">Großer Diff gekürzt. Für den vollständigen Inhalt den Editor öffnen.</p>' : ""}</div>${footer}</section>`;
  }

  function historyView(p) {
    const s = session(p.id);
    const history = data(p.id, `history:${s.historyQuery}:${s.historyAll}`);
    if (!s.commit && history?.commits?.length) { s.commit = history.commits[0].hash; queueMicrotask(() => ensure(p.id)); }
    const detail = s.commit ? data(p.id, `commit:${s.commit}:${s.historyFile}`) : null;
    const current = history?.commits?.find(c => c.hash === s.commit);
    const detailPatch = detail?.patch;
    return `<div class="gw-history"><aside class="gw-history-list"><label class="gw-search">${icon("magnifying-glass")}<input type="search" data-gw-input="historyQuery" data-focus-key="gw-history-search" aria-label="Commits durchsuchen" placeholder="Nachricht suchen …" value="${esc(s.historyQuery)}"></label><label class="gw-history-all"><input type="checkbox" data-gw-input="historyAll" ${s.historyAll ? "checked" : ""}> Alle Branches anzeigen</label><div class="gw-commits" data-gw-scroll="commits">${resourceError(history)}
      ${p.git.dirty && !s.historyQuery ? `<button type="button" class="gw-history-row gw-history-pending" data-gw="tab" data-value="changes"><span class="gw-graph-node pending">${icon("pen-to-square")}</span><span><strong>${plural(p.git.changedFiles, "Änderung", "Änderungen")}, noch nicht committet</strong><small>Zu den Änderungen wechseln</small></span></button>` : ""}
      ${history?.commits?.map((c, index) => `<button type="button" data-gw="commit-detail" data-hash="${c.hash}" class="gw-history-row ${s.commit === c.hash ? "active" : ""}" aria-pressed="${s.commit === c.hash}"><span class="gw-graph-node ${c.parents.length > 1 ? "merge" : ""}"><span class="gw-avatar" title="${esc(c.author)}">${esc(initials(c.author))}</span></span><span><strong>${esc(c.subject)}</strong><small>${esc(c.author)} · ${ago(c.date)} · <code>${esc(c.shortHash)}</code>${index === 0 && !s.historyAll && p.git.branch ? ` <em class="gw-ref">${esc(p.git.branch)}</em>` : ""}${c.parents.length > 1 ? ' <em class="gw-ref merge">Merge</em>' : ""}</small></span></button>`).join("") || (!history ? '<p class="gw-list-empty">Verlauf wird geladen …</p>' : '<p class="gw-list-empty">Keine Commits gefunden.</p>')}</div>${history?.hasMore ? button("Weitere Commits laden", "history-more", "", pendingReads.has(key(p.id, "history-more")), "gw-history-more") : ""}</aside>
      <section class="gw-history-detail">${detail?.error ? resourceError(detail) : detail ? `<header class="gw-commit-detail-header"><div class="gw-commit-caption"><span class="gw-avatar">${esc(initials(detail.author))}</span><span>${esc(detail.author)} · ${formatDate(detail.date)}</span><button type="button" class="gw-hash" data-gw="copy-hash" title="Vollständigen Commit-Hash kopieren">${esc(detail.shortHash)} ${icon("copy")}</button>${detail.parents.length > 1 ? '<span class="gw-badge">Merge</span>' : ""}</div><h3>${esc(detail.subject)}</h3>${detail.body ? `<pre class="gw-commit-body">${esc(detail.body)}</pre>` : ""}<div class="gw-inline-actions">${button(icon("rotate-left") + " Revert …", "revert-dialog", `data-hash="${detail.hash}"`, p.git.dirty || detail.parents.length > 1)}${button(icon("code-commit") + " Cherry-pick …", "cherry-pick-dialog", `data-hash="${detail.hash}"`, p.git.dirty || detail.parents.length > 1)}${button(icon("tag") + " Tag erstellen …", "create-tag-dialog", `data-hash="${detail.hash}"`)}</div></header>
      <label class="gw-commit-file-select"><span>${icon("file-lines")} ${plural(detail.files.length, "Datei", "Dateien")}</span><select data-gw-input="historyFile" aria-label="Datei im Commit auswählen"><option value="">Alle ${detail.files.length} Dateien</option>${detail.files.map(f => `<option value="${esc(f.path)}" ${s.historyFile === f.path ? "selected" : ""}>${esc(f.status)} · ${esc(f.path)}</option>`).join("")}</select></label><div class="gw-diff-content" data-gw-scroll="history-diff">${detailPatch ? patchView(detailPatch, s.wrap) : empty("file-lines", "Kein Text-Diff", "Für diese Auswahl ist kein Textvergleich verfügbar.")}${detail.truncated ? '<p class="gw-limit">Großer Commit-Diff wurde gekürzt.</p>' : ""}</div>` : empty(current ? "spinner fa-spin" : "clock-rotate-left", current ? "Commit wird geladen" : "Deine Projektgeschichte", "Wähle einen Commit, um Nachricht, Dateien und Änderungen zu prüfen.")}</section></div>`;
  }
  function branchView(p, w) {
    const s = session(p.id);
    const branches = (w?.branches || []).filter(b => b.name.toLocaleLowerCase().includes(s.branchQuery.toLocaleLowerCase()));
    const row = b => `<article class="gw-branch-row"><span class="gw-branch-glyph ${b.current ? "current" : ""}">${icon(b.remote ? "cloud" : "code-branch")}</span><div class="gw-row-copy"><strong>${esc(b.name)} ${b.current ? '<span class="gw-badge">Aktuell</span>' : ""}</strong><small>${b.upstream ? `Verfolgt ${esc(b.upstream)} · ` : ""}${formatDate(b.lastCommitDate)}</small></div><div class="gw-row-actions">${!b.current ? button(b.remote ? "Lokal auschecken" : "Wechseln", b.remote ? "checkout-remote" : "checkout", `data-branch="${esc(b.name)}"`) + button("Vergleichen", "compare", `data-branch="${esc(b.name)}"`) : ""}${!b.current && p.git.branch ? button("Integrieren …", "integrate-dialog", `data-branch="${esc(b.name)}"`, p.git.dirty || !!w?.operation) : ""}${!b.remote ? button(icon("pen"), "rename-branch-dialog", `data-branch="${esc(b.name)}" aria-label="Branch ${esc(b.name)} umbenennen" title="Branch umbenennen"`, false, "gw-icon-button") : ""}${!b.current && !b.remote ? button(icon("trash-can"), "delete-branch-dialog", `data-branch="${esc(b.name)}" aria-label="Branch ${esc(b.name)} löschen" title="Zusammengeführten Branch löschen"`, false, "gw-icon-button gw-danger-link") : ""}</div></article>`;
    return `<section class="gw-management"><header class="gw-section-heading"><div><h3>Branches</h3><p>Arbeitsstände wechseln, vergleichen und zusammenführen. Zum schnellen Wechseln reicht das Branch-Menü im Kopf.</p></div>${button(icon("plus") + " Neuer Branch", "create-branch-dialog", "", false, "gw-primary")}</header><label class="gw-search gw-management-search">${icon("magnifying-glass")}<input type="search" data-gw-input="branchQuery" data-focus-key="gw-branch-search" aria-label="Branches durchsuchen" placeholder="Branch suchen …" value="${esc(s.branchQuery)}"></label>${resourceError(w)}
      ${s.comparison ? `<section class="gw-card gw-comparison"><header><div><h4>Änderungen aus ${esc(s.comparison)}</h4><p>Vergleich seit dem gemeinsamen Ausgangscommit mit ${esc(p.git.branch || "HEAD")}.</p></div>${button("Schließen", "close-comparison")}</header>${resourceError(data(p.id, `compare:${s.comparison}`))}${data(p.id, `compare:${s.comparison}`)?.patch ? patchView(data(p.id, `compare:${s.comparison}`).patch) : '<p class="gw-card-note">Keine Textänderungen oder Vergleich wird geladen …</p>'}</section>` : ""}
      ${[false, true].map(remote => `<section class="gw-card"><header><h4>${remote ? "Remote-Branches" : "Lokale Branches"}</h4><span>${branches.filter(b => !!b.remote === remote).length}</span></header>${branches.filter(b => !!b.remote === remote).map(row).join("") || `<p class="gw-card-note">${remote ? "Keine Remote-Branches. Mit Fetch den aktuellen Stand abrufen." : "Keine passenden lokalen Branches."}</p>`}</section>`).join("")}</section>`;
  }
  function stashView(p, w) {
    const s = session(p.id);
    const current = w?.stashes?.find(stash => stash.hash === s.stash);
    const patch = current ? data(p.id, `stash:${current.hash}`) : null;
    return `<section class="gw-management"><header class="gw-section-heading"><div><h3>Stashes</h3><p>Änderungen zwischenspeichern und später weiterarbeiten.</p></div>${button(icon("plus") + " Änderungen sichern", "stash-save-dialog", "", !p.git.dirty || !p.git.lastCommit || !!count(p, conflict), "gw-primary")}</header>${resourceError(w)}${w?.stashes?.length ? `<div class="gw-card">${w.stashes.map(stash => `<article class="gw-stash-row"><span class="gw-branch-glyph">${icon("box-archive")}</span><div class="gw-row-copy"><strong>${esc(stash.subject)}</strong><small>${esc(stash.ref)} · ${formatDate(stash.date)}</small></div><div class="gw-row-actions">${button("Ansehen", "stash-detail", `data-hash="${stash.hash}"`)}${button("Anwenden …", "stash-apply-dialog", `data-hash="${stash.hash}"`, p.git.dirty)}${button(icon("trash-can"), "stash-drop-dialog", `data-hash="${stash.hash}" aria-label="Stash löschen: ${esc(stash.subject)}" title="Stash löschen"`, false, "gw-icon-button gw-danger-link")}</div></article>`).join("")}</div>` : empty("box-archive", "Platz für deinen Zwischenstand", "Sichere offene Änderungen inklusive neuer Dateien, um mit einem sauberen Arbeitsbaum auf einem anderen Branch weiterzuarbeiten.")}${current ? `<section class="gw-card gw-comparison"><header><h4>${esc(current.subject)}</h4></header>${resourceError(patch)}${patch?.patch ? patchView(patch.patch) : '<p class="gw-card-note">Diff wird geladen oder enthält keine Textänderungen.</p>'}${patch?.truncated ? '<p class="gw-limit">Großer Stash-Diff gekürzt.</p>' : ""}</section>` : ""}</section>`;
  }
  function tagsView(p, w) {
    return `<section class="gw-management"><header class="gw-section-heading"><div><h3>Tags & Releases</h3><p>Versionen markieren und einzelne Tags veröffentlichen.</p></div>${button(icon("plus") + " Neues Tag", "create-tag-dialog", "", !p.git.lastCommit, "gw-primary")}</header>${resourceError(w)}${w?.tags?.length ? `<section class="gw-card">${w.tags.map(tag => `<article class="gw-tag-row"><span class="gw-branch-glyph">${icon("tag")}</span><div class="gw-row-copy"><strong>${esc(tag.name)}</strong><small>${esc(tag.subject)} · ${formatDate(tag.date)}</small></div><div class="gw-row-actions">${button(icon("arrow-up") + " Veröffentlichen …", "push-tag-dialog", `data-name="${esc(tag.name)}"`, !w.remotes.length)}${button(icon("trash-can"), "delete-tag-dialog", `data-name="${esc(tag.name)}" aria-label="Lokales Tag ${esc(tag.name)} löschen" title="Lokales Tag löschen"`, false, "gw-icon-button gw-danger-link")}</div></article>`).join("")}</section>` : empty("tags", "Meilensteine festhalten", "Erstelle ein Tag auf dem aktuellen Commit oder wähle einen Commit im Verlauf.")}</section>`;
  }
  function settingsView(p, w) {
    return `<section class="gw-management"><header class="gw-section-heading"><div><h3>Repository</h3><p>Remotes, Commit-Identität und Werkzeuge für ${esc(p.name)}.</p></div>${button(icon("folder-open") + " Ordner öffnen", "folder")}</header>${resourceError(w)}<div class="gw-settings-grid"><section class="gw-card"><header><h4>${icon("cloud")} Remotes</h4>${button(icon("plus") + " Hinzufügen", "remote-add-dialog")}</header>${w?.remotes?.map(remote => `<article class="gw-remote-row"><div class="gw-row-copy"><strong>${esc(remote.name)}</strong><code title="${esc(remote.url)}">${esc(remote.url)}</code></div><div class="gw-row-actions">${button(icon("pen"), "remote-edit-dialog", `data-name="${esc(remote.name)}" aria-label="Remote ${esc(remote.name)} bearbeiten"`, false, "gw-icon-button")}${button(icon("trash-can"), "remote-remove-dialog", `data-name="${esc(remote.name)}" aria-label="Remote ${esc(remote.name)} entfernen"`, false, "gw-icon-button gw-danger-link")}</div></article>`).join("") || '<p class="gw-card-note">Noch kein Remote eingerichtet. Verbinde ein Repository, um Commits zu synchronisieren.</p>'}</section>
      <section class="gw-card"><header><h4>${icon("circle-user")} Commit-Identität</h4><span>Nur dieses Repository</span></header><form class="gw-settings-form" data-gw-form="identity">${field("Name", "name", w?.identity?.name, 'required maxlength="200" autocomplete="name"')}${field("E-Mail-Adresse", "email", w?.identity?.email, 'type="email" required maxlength="200" autocomplete="email"')}<p>Diese Identität erscheint in neu erstellten Commits.</p><button class="gw-button" ${busy || !w || w.error ? "disabled" : ""}>Identität speichern</button></form></section>
      <section class="gw-card"><header><h4>${icon("rotate-left")} Letzter Commit</h4></header><div class="gw-settings-form"><strong>${esc(p.git.lastCommit?.subject || "Noch keine Commits")}</strong><p>Den letzten lokalen Commit zurücknehmen. Seine Änderungen bleiben im Index vorgemerkt.</p>${button("Letzten Commit zurücknehmen …", "undo-dialog", "", !p.git.lastCommit || !p.git.branch || (!!p.git.upstream && !p.git.ahead) || !!w?.operation)}</div></section>
      <section class="gw-card"><header><h4>${icon("list-check")} Aktivität dieser Sitzung</h4></header><div class="gw-activity">${activity.filter(a => a.id === p.id).slice(0, 12).map(a => `<div class="${a.error ? "error" : ""}">${icon(a.error ? "circle-exclamation" : "circle-check")}<span>${esc(a.message)}</span><time>${a.time}</time></div>`).join("") || '<p class="gw-card-note">Git-Aktionen und ihre Ergebnisse erscheinen hier.</p>'}</div></section></div></section>`;
  }

  // Overview: every repository of the workspace in one table with its state and the one action that is due.
  function overviewView(repositories) {
    const conflicts = p => p.git.files.some(conflict);
    const kind = p => conflicts(p) ? "conflict" : !p.git.remoteName ? "noremote" : !p.git.upstream && p.git.lastCommit ? "publish" : p.git.ahead && p.git.behind ? "diverged" : p.git.behind ? "behind" : p.git.ahead ? "ahead" : "clean";
    const filters = { all: () => true, changed: p => p.git.dirty, ahead: p => p.git.ahead > 0 || kind(p) === "publish", behind: p => p.git.behind > 0, noremote: p => !p.git.remoteName };
    const rows = repositories.filter(filters[overviewFilter] || filters.all);
    const tiles = [["all", "Repositories", repositories.length, "neutral"], ["changed", "Mit Änderungen", repositories.filter(filters.changed).length, "warn"], ["ahead", "Ungepusht", repositories.filter(filters.ahead).length, "info"], ["behind", "Hinterher", repositories.filter(filters.behind).length, "danger"], ["noremote", "Ohne Remote", repositories.filter(filters.noremote).length, "neutral"]];
    const pushable = repositories.filter(p => p.git.remoteName && p.git.branch && p.git.lastCommit && (p.git.ahead || !p.git.upstream) && !p.git.behind);
    const latestFetch = repositories.map(p => p.git.lastFetchAt).filter(Boolean).sort().pop();
    const chip = p => ({ conflict: `<span class="gw-chip tone-danger">${icon("triangle-exclamation")} Konflikt</span>`, noremote: '<span class="gw-chip tone-neutral">kein Remote</span>', publish: '<span class="gw-chip tone-info">unveröffentlicht</span>', diverged: `<span class="gw-chip tone-danger">${icon("arrow-up")}${p.git.ahead} ${icon("arrow-down")}${p.git.behind}</span>`, behind: `<span class="gw-chip tone-warn">${icon("arrow-down")} ${p.git.behind}</span>`, ahead: `<span class="gw-chip tone-info">${icon("arrow-up")} ${p.git.ahead}</span>`, clean: '<span class="gw-chip tone-ok">synchron</span>' })[kind(p)];
    const quick = p => {
      const k = kind(p);
      if (k === "conflict" || k === "diverged" || k === "noremote") return button(k === "noremote" ? "Remote …" : "Öffnen", "repository", `data-id="${p.id}"`);
      if (p.git.dirty) return button(icon("code-commit") + " Committen", "repository", `data-id="${p.id}"`);
      if (k === "ahead" || k === "publish") return button(icon("arrow-up") + (k === "publish" ? " Veröffentlichen" : " Push"), "ov-action", `data-id="${p.id}" data-action="push"`, false, "gw-primary");
      if (k === "behind") return button(icon("arrow-down") + " Pull", "ov-action", `data-id="${p.id}" data-action="pull"`);
      return button(icon("arrows-rotate") + " Fetch", "ov-action", `data-id="${p.id}" data-action="fetch"`, !p.git.remoteName, "gw-quiet");
    };
    const stale = p => p.git.lastCommit && Date.now() - new Date(p.git.lastCommit.date).getTime() > 30 * 86400000;
    return `<header class="gw-header gw-header-overview"><div class="gw-seg gw-seg-static"><span class="gw-seg-icon">${icon("table-cells-large")}</span><span class="gw-seg-copy"><small>Arbeitsbereich</small><strong>Alle Repositories</strong><code>${plural(repositories.length, "Repository", "Repositories")}${latestFetch ? ` · zuletzt geholt ${ago(latestFetch)}` : ""}</code></span></div>
      <div class="gw-header-tools gw-header-tools-wide">${button(icon(busy?.action === "fetch" ? "spinner fa-spin" : "arrows-rotate") + " Alle holen", "fetch-all", 'title="Fetch für jedes Repository mit Remote"', !repositories.some(p => p.git.remoteName))}${button(icon("arrow-up") + ` ${plural(pushable.length, "Repo", "Repos")} pushen`, "push-all", 'title="Alle Repositories mit lokalen Commits pushen"', !pushable.length, "gw-primary")}</div></header>
      ${notice ? `<div class="gw-notice ${notice.error ? "error" : "success"}" role="${notice.error ? "alert" : "status"}">${icon(notice.error ? "circle-exclamation" : "circle-check")}<span>${notice.id ? `<b>${esc(state.projects.find(x => x.id === notice.id)?.name || "")}</b> · ` : ""}${esc(notice.message)}</span>${button(icon("xmark"), "dismiss-notice", 'aria-label="Meldung schließen"', false, "gw-icon-button")}</div>` : ""}
      <div class="gw-view" data-gw-scroll="view"><section class="gw-overview">
        <div class="gw-kpis">${tiles.map(([value, label, total, tone]) => button(`<small>${label}</small><strong>${total}</strong>`, "ov-filter", `data-value="${value}" aria-pressed="${overviewFilter === value}"`, false, `gw-kpi tone-${tone} ${overviewFilter === value ? "active" : ""}`)).join("")}</div>
        <div class="gw-table" role="table" aria-label="Repositories"><div class="gw-table-head" role="row"><span>Repository</span><span>Branch</span><span>Änderungen</span><span>Sync</span><span>Letzter Commit</span><span></span></div>
        ${rows.map(p => `<div class="gw-table-row ${stale(p) ? "stale" : ""}" role="row"><button type="button" class="gw-table-name" data-gw="repository" data-id="${p.id}"><strong>${esc(p.name)}</strong><code>${esc(p.relativePath)}</code></button><span class="gw-mono">${esc(p.git.branch || "detached")}</span><span>${p.git.dirty ? `<span class="gw-chip tone-warn">${plural(p.git.changedFiles, "Datei", "Dateien")}</span>` : '<span class="gw-muted">–</span>'}</span><span>${chip(p)}</span><span class="gw-table-commit">${p.git.lastCommit ? `<span title="${esc(p.git.lastCommit.subject)}">${esc(p.git.lastCommit.subject)}</span><small>${ago(p.git.lastCommit.date)}</small>` : '<span class="gw-muted">Noch kein Commit</span>'}</span><span class="gw-table-action">${quick(p)}</span></div>`).join("") || `<p class="gw-list-empty">Kein Repository passt zu diesem Filter.</p>`}</div>
        ${state.projects.some(p => !p.git) ? `<p class="gw-overview-foot">${plural(state.projects.filter(p => !p.git).length, "Projekt", "Projekte")} ohne Git. ${button("Git anlegen oder klonen …", "add", "", false, "gw-link")}</p>` : ""}
      </section></div>`;
  }

  function render() {
    if (state.page !== "git") return;
    document.querySelector("#workspace-primary-action").disabled = Boolean(busy);
    const repositories = state.projects.filter(p => p.git).sort((a, b) => Number(Boolean(b.git.dirty)) - Number(Boolean(a.git.dirty)) || a.name.localeCompare(b.name, "de"));
    if (!repositories.some(p => p.id === state.activeGitProjectId)) state.activeGitProjectId = repositories[0]?.id || null;
    const p = selected();
    const s = p ? session(p.id) : null;
    if (p && s.gitFingerprint !== JSON.stringify(p.git)) {
      s.gitFingerprint = JSON.stringify(p.git);
      invalidate(p.id);
      queueMicrotask(() => ensure(p.id));
    }
    const w = p ? data(p.id, "workspace") : null;
    const currentElement = (root.contains(document.activeElement) || rail.contains(document.activeElement)) ? document.activeElement : null;
    const focusKey = currentElement?.dataset?.focusKey;
    const selection = currentElement && typeof currentElement.selectionStart === "number" ? [currentElement.selectionStart, currentElement.selectionEnd] : null;
    const scrolls = [...root.querySelectorAll("[data-gw-scroll]"), ...rail.querySelectorAll("[data-gw-scroll]")].map(el => [el.dataset.gwScroll, el.scrollTop, el.scrollLeft]);
    const railHtml = repositoryRail(repositories);
    if (rail.__gwHtml !== railHtml) { rail.__gwHtml = railHtml; rail.innerHTML = railHtml; }
    const showOverview = view === "overview" && repositories.length > 0;
    const body = !repositories.length ? empty("code-branch", "Dein Git-Arbeitsbereich", "Klone ein Repository oder aktiviere Git in einem vorhandenen Projekt.", button("Repository hinzufügen", "add", "", false, "gw-primary"))
      : showOverview ? overviewView(repositories)
      : header(p, w) + guide(p, w) + navigation(p, w) + (notice?.id === p.id ? `<div class="gw-notice ${notice.error ? "error" : "success"}" role="${notice.error ? "alert" : "status"}">${icon(notice.error ? "circle-exclamation" : "circle-check")}<span>${esc(notice.message)}</span>${button(icon("xmark"), "dismiss-notice", 'aria-label="Meldung schließen"', false, "gw-icon-button")}</div>` : "") + `<div class="gw-view" data-gw-scroll="view">${s.tab === "changes" ? changeView(p) : s.tab === "history" ? historyView(p) : s.tab === "branches" ? branchView(p, w) : s.tab === "stashes" ? stashView(p, w) : s.tab === "tags" ? tagsView(p, w) : settingsView(p, w)}</div>`;
    const statusbar = `<footer class="gw-statusbar"><span>${busy ? icon("spinner fa-spin") + " Git-Aktion läuft …" : icon("circle-check") + " Bereit"}</span>${p && !showOverview ? `<span class="gw-mono">${esc(p.git.upstream || (p.git.remoteName ? "Noch kein Upstream" : "Lokales Repository"))}</span><span>${icon("arrow-up")} ${p.git.ahead} <i class="gw-footer-divider"></i>${icon("arrow-down")} ${p.git.behind}</span>` : ""}</footer>`;
    const html = `<div class="gw-shell ${menu ? "menu-open" : ""}"><main class="gw-main" aria-label="Git-Repository">${body}${statusbar}</main></div>`;
    if (root.__gwHtml !== html) {
      root.__gwHtml = html;
      root.innerHTML = html;
      root.querySelectorAll("[data-width]").forEach(el => { el.style.width = `${el.dataset.width}%`; });
      for (const [id, top, left] of scrolls) { const el = document.querySelector(`[data-gw-scroll="${id}"]`); if (el) { el.scrollTop = top; el.scrollLeft = left; } }
      if (focusKey) { const el = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`); el?.focus({ preventScroll: true }); if (selection && el?.setSelectionRange) { try { el.setSelectionRange(...selection); } catch { /* search fields */ } } }
    }
    if (focusKey === "gw-repo-search") { const input = rail.querySelector("input"); input?.focus({ preventScroll: true }); if (selection) { try { input.setSelectionRange(...selection); } catch {} } }
    if (p && !data(p.id, "workspace") && !pendingReads.has(key(p.id, "workspace"))) queueMicrotask(() => ensure(p.id));
  }

  async function run(action, payload = {}, id = selected()?.id) {
    if (busy || (!id && !["clone", "github-clone"].includes(action))) return false;
    busy = { id, action }; notice = null; render();
    let success = false;
    try {
      const result = await api(action === "clone" ? "/api/git/clone" : action === "github-clone" ? "/api/git/github/clone" : base(id) + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (result.project) { const i = state.projects.findIndex(p => p.id === result.project.id); if (i >= 0) state.projects[i] = result.project; }
      if (result.projects) state.projects = result.projects;
      if (["commit", "amend", "commit-files", "amend-files"].includes(action)) { Object.assign(session(id), { summary: "", description: "", amend: false, commit: null }); saveDraft(id); }
      if (["checkout", "checkout-remote", "create-branch"].includes(action)) Object.assign(session(id), { commit: null, file: null, comparison: null, amend: false, branchQuery: "" });
      if (action === "init") { state.activeGitProjectId = id; }
      if (action === "clone" || action === "github-clone") { const p = state.projects.find(p => p.relativePath === payload.name); if (p) { state.activeGitProjectId = p.id; view = "repo"; localStorage.setItem("devhub_git_project", p.id); } }
      notice = { id: id || state.activeGitProjectId, message: result.message, error: false };
      success = true;
    } catch (error) {
      notice = { id: id || state.activeGitProjectId, message: error.message, error: true };
      // Failed merges/rebases may have created conflicts; refresh before presenting recovery actions.
      if (id && action !== "init") {
        try { const result = await api(base(id) + "refresh", { method: "POST" }); const i = state.projects.findIndex(p => p.id === id); if (i >= 0) state.projects[i] = result.project; } catch { /* retain original action error */ }
      }
    } finally {
      if (notice) activity.unshift({ ...notice, time: new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) });
      if (activity.length > 100) activity.length = 100;
      busy = null;
      if (id) invalidate(id);
      renderApp();
      ensure(state.activeGitProjectId);
    }
    return success;
  }
  async function runEach(action, ids, label) {
    let done = 0; let failed = 0;
    for (const id of ids) { (await run(action, {}, id)) ? done += 1 : failed += 1; }
    notice = { id: null, message: `${label}: ${plural(done, "Repository", "Repositories")} erledigt${failed ? `, ${failed} fehlgeschlagen` : ""}.`, error: failed > 0 };
    render();
  }

  const dialog = document.createElement("dialog");
  dialog.className = "gw-dialog";
  document.body.append(dialog);
  let dialogAction = null;
  let dialogOrigin = null;
  function modal(title, description, body, submit, execute, danger = false) {
    dialogOrigin = document.activeElement;
    dialogAction = execute;
    dialog.innerHTML = `<form><header><span class="gw-modal-glyph ${danger ? "danger" : ""}">${icon(danger ? "triangle-exclamation" : "code-branch")}</span><div><h2 id="gw-dialog-title">${esc(title)}</h2><p>${esc(description)}</p></div><button type="button" class="gw-button gw-icon-button" data-dialog-close aria-label="Dialog schließen">${icon("xmark")}</button></header><div class="gw-dialog-body">${body}<p class="gw-dialog-error" role="alert" hidden></p></div><footer><button type="button" class="gw-button" data-dialog-close>Abbrechen</button><button type="submit" class="gw-button ${danger ? "gw-danger" : "gw-primary"}">${esc(submit)}</button></footer></form>`;
    dialog.setAttribute("aria-labelledby", "gw-dialog-title");
    if (!dialog.open) dialog.showModal();
    const input = dialog.querySelector("input:not([type=radio]):not([type=checkbox])"); if (input) input.focus();
  }
  dialog.addEventListener("click", event => { if (event.target === dialog || event.target.closest("[data-dialog-close]")) { if (!busy) dialog.close(); } });
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { dialogAction = null; if (dialogOrigin?.isConnected) dialogOrigin.focus(); });
  dialog.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !dialogAction) return;
    const payload = Object.fromEntries(new FormData(event.target));
    const controls = [...dialog.querySelectorAll("button, input, select, textarea")];
    controls.forEach(el => { el.disabled = true; });
    try {
      if (await dialogAction(payload)) { dialog.close(); return; }
      const error = dialog.querySelector(".gw-dialog-error"); error.hidden = false; error.textContent = notice?.message || "Die Aktion konnte nicht ausgeführt werden.";
    } catch (error) { const el = dialog.querySelector(".gw-dialog-error"); el.hidden = false; el.textContent = error.message; }
    finally { controls.forEach(el => { el.disabled = false; }); }
  });
  const confirm = (title, description, action, payload, label = "Bestätigen", danger = false, extra = "") => {
    const id = selected()?.id;
    modal(title, description, extra, label, form => run(action, { ...payload, ...form }, id), danger);
  };
  // The GitHub list comes from the locally signed-in GitHub CLI; cloning runs through gh so private repositories work without extra setup.
  const inWorkspace = repo => state.projects.find(p => p.git?.remoteUrl && p.git.remoteUrl.replace(/\.git$/, "").toLowerCase().endsWith(`github.com/${repo.nameWithOwner.toLowerCase()}`));
  function githubList() {
    if (githubLoading && !github) return `<p class="gw-github-note">${icon("spinner fa-spin")} GitHub-Repositories werden geladen …</p>`;
    if (!github) return "";
    if (!github.available) return `<p class="gw-github-note">${icon("circle-info")} ${esc(github.hint || "GitHub ist nicht verfügbar.")}</p>`;
    const q = githubQuery.trim().toLocaleLowerCase();
    const rows = github.repositories.filter(r => `${r.nameWithOwner} ${r.description}`.toLocaleLowerCase().includes(q));
    if (!rows.length) return `<p class="gw-github-note">${github.repositories.length ? "Kein Repository passt zur Suche." : "Dieses Konto hat noch keine Repositories."}</p>`;
    return rows.slice(0, 60).map(r => { const existing = inWorkspace(r); return `<button type="button" class="gw-menu-row gw-menu-main ${existing ? "current" : ""}" data-gw="github-clone" data-repo="${esc(r.nameWithOwner)}" data-name="${esc(r.name)}" ${existing ? 'title="Liegt bereits im Workspace"' : ""}>${icon(r.isPrivate ? "lock" : "book")}<span><strong>${esc(r.nameWithOwner)}</strong><small>${r.description ? esc(r.description) + " · " : ""}${r.isFork ? "Fork · " : ""}${r.pushedAt ? `Push ${ago(r.pushedAt)}` : ""}</small></span>${existing ? `<span class="gw-chip tone-ok">im Workspace</span>` : `<small>${esc(r.defaultBranch || "")}</small>`}</button>`; }).join("") + (rows.length > 60 ? `<p class="gw-github-note">${rows.length - 60} weitere. Suche eingrenzen.</p>` : "");
  }
  function refreshGithubList() {
    const list = dialog.querySelector(".gw-github-list"); if (list) list.innerHTML = githubList();
    const account = dialog.querySelector(".gw-github-account"); if (account) account.textContent = github?.available ? `als ${github.account}` : githubLoading ? "lädt …" : "";
  }
  async function loadGithub(force = false) {
    if (githubLoading || (github && !force)) return;
    githubLoading = true; if (force) github = null; refreshGithubList();
    try { github = await api("/api/git/github/repositories"); }
    catch (error) { github = { available: false, account: null, repositories: [], hint: error.message }; }
    finally { githubLoading = false; refreshGithubList(); }
  }
  function addRepository() {
    const options = state.projects.filter(p => !p.git);
    modal("Repository hinzufügen", "Aus deinem GitHub-Konto, per URL oder als neues Git in einem vorhandenen Projekt.", `<section class="gw-github"><header>${icon("cloud-arrow-down")}<strong>Von GitHub klonen</strong><small class="gw-github-account"></small>${button(icon("rotate"), "github-refresh", 'aria-label="GitHub-Liste neu laden" title="Liste neu laden"', false, "gw-icon-button")}</header><label class="gw-search">${icon("magnifying-glass")}<input type="search" data-gh-search aria-label="GitHub-Repositories durchsuchen" placeholder="GitHub-Repository suchen …" value="${esc(githubQuery)}"></label><div class="gw-github-list">${githubList()}</div></section>
      <div class="gw-dialog-divider">Oder per URL klonen</div>` + field("Repository-URL", "url", "", 'placeholder="https://github.com/name/repository.git" required') + field("Neuer Ordnername", "name", "", 'placeholder="mein-projekt" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"') + (options.length ? `<div class="gw-dialog-divider">Oder Git in einem vorhandenen Projekt aktivieren</div><div class="gw-init-list">${options.map(p => button(esc(p.name) + " · Git anlegen", "init-dialog", `data-id="${p.id}"`)).join("")}</div>` : ""), "Per URL klonen", payload => run("clone", payload));
    dialog.querySelector("[data-gh-search]")?.focus();
    loadGithub();
  }
  dialog.addEventListener("input", event => { if (event.target.matches("[data-gh-search]")) { githubQuery = event.target.value; refreshGithubList(); } });
  function openMenu(value) {
    menu = menu === value ? null : value; menuQuery = "";
    const p = selected(); if (p && menu === "branch") session(p.id).branchQuery = "";
    render();
    root.querySelector(".gw-popover input")?.focus();
  }
  async function interact(target) {
    const action = target.dataset.gw;
    const p = selected();
    const s = p ? session(p.id) : null;
    const w = p ? data(p.id, "workspace") : null;
    if (action === "menu") { openMenu(target.dataset.value); return; }
    if (action === "add") { addRepository(); return; }
    if (action === "github-refresh") { loadGithub(true); return; }
    if (action === "github-clone") {
      const repo = target.dataset.repo; const existing = github?.repositories?.find(r => r.nameWithOwner === repo);
      if (existing && inWorkspace(existing)) { toast("Dieses Repository liegt schon im Workspace."); return; }
      modal("Von GitHub klonen", `${repo} wird mit der Anmeldung der GitHub CLI in den Workspace geklont.`, field("Ordnername im Workspace", "name", target.dataset.name, 'required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" maxlength="100"') + `<code class="gw-confirm-target">${esc(existing?.url || `https://github.com/${repo}`)}</code>`, "Klonen", form => run("github-clone", { repo, name: form.name })); return;
    }
    if (action === "init-dialog") {
      const project = state.projects.find(p => p.id === target.dataset.id);
      modal("Git-Repository anlegen", `Git im Projekt „${project.name}“ initialisieren. Dateien werden anschließend als neue Änderungen angezeigt.`, "", "Git anlegen", () => run("init", {}, project.id)); return;
    }
    if (action === "filter") { repoFilter = target.dataset.value; render(); return; }
    if (action === "overview") { view = "overview"; localStorage.setItem("devhub_git_view", view); render(); return; }
    if (action === "ov-filter") { overviewFilter = target.dataset.value; render(); return; }
    if (action === "ov-action") { await run(target.dataset.action, {}, target.dataset.id); return; }
    if (action === "fetch-all") { await runEach("fetch", state.projects.filter(x => x.git?.remoteName).map(x => x.id), "Fetch"); return; }
    if (action === "push-all") {
      const targets = state.projects.filter(x => x.git?.remoteName && x.git.branch && x.git.lastCommit && (x.git.ahead || !x.git.upstream) && !x.git.behind);
      modal("Repositories pushen", `${plural(targets.length, "Repository wird", "Repositories werden")} nacheinander zum Remote übertragen.`, `<ul class="gw-dialog-list">${targets.map(x => `<li><strong>${esc(x.name)}</strong><small>${esc(x.git.branch)} · ${x.git.upstream ? plural(x.git.ahead, "Commit", "Commits") : "veröffentlichen"}</small></li>`).join("")}</ul>`, "Alle pushen", async () => { dialog.close(); await runEach("push", targets.map(x => x.id), "Push"); return true; }); return;
    }
    if (action === "repository") { state.activeGitProjectId = target.dataset.id; view = "repo"; localStorage.setItem("devhub_git_view", view); localStorage.setItem("devhub_git_project", state.activeGitProjectId); render(); ensure(state.activeGitProjectId); return; }
    if (action === "dismiss-notice") { notice = null; render(); return; }
    if (!p) return;
    if (action === "dismiss-guide") { dismissedGuides.add(target.dataset.value); localStorage.setItem("devhub_git_guides", JSON.stringify([...dismissedGuides])); render(); return; }
    if (action === "tab") { s.tab = target.dataset.value; if (s.tab !== "branches") s.branchQuery = ""; render(); ensure(p.id); return; }
    if (action === "fold") { const dir = target.dataset.dir; s.collapsed.has(dir) ? s.collapsed.delete(dir) : s.collapsed.add(dir); render(); return; }
    if (action === "advanced-mode" || action === "simple-mode") { s.advanced = action === "advanced-mode"; s.scope = "working"; s.file = null; render(); ensure(p.id); return; }
    if (action === "toggle-include") { const path = target.dataset.path; s.excluded.has(path) ? s.excluded.delete(path) : s.excluded.add(path); render(); return; }
    if (action === "scope") { s.scope = target.dataset.value; s.file = null; render(); ensure(p.id); return; }
    if (action === "file") { s.file = target.dataset.path; render(); ensure(p.id); return; }
    if (action === "wrap") { s.wrap = !s.wrap; render(); return; }
    if (["editor", "terminal", "folder"].includes(action)) { projectAction(p.id, action); return; }
    if (action === "copy-file" || action === "copy-hash") { await navigator.clipboard.writeText(action === "copy-file" ? s.file : s.commit); toast("Kopiert."); return; }
    if (action === "commit-detail") { s.commit = target.dataset.hash; s.historyFile = ""; render(); ensure(p.id); return; }
    if (action === "calm-commit") { Object.assign(s, { tab: "history", commit: target.dataset.hash, historyFile: "", historyQuery: "", historyAll: false }); render(); ensure(p.id); return; }
    if (action === "stage-file" || action === "unstage-file") { await run(action === "stage-file" ? "stage-files" : "unstage-files", { files: [target.dataset.path] }); return; }
    if (action === "hunk") {
      const section = data(p.id, `diff:${s.advanced ? "index" : "all"}:${s.file}`)?.sections?.find(section => section.scope === s.scope);
      if (section) await run(s.scope === "staged" ? "unstage-hunk" : "stage-hunk", { file: s.file, fingerprint: section.fingerprint, hunk: Number(target.dataset.index) }); return;
    }
    if (["refresh", "fetch", "pull", "push", "stage-all", "unstage-all", "continue"].includes(action)) { await run(action); return; }
    if (action === "pull-method") { await run("pull", { method: target.dataset.value }); return; }
    if (action === "pull-dialog") {
      modal("Remote-Stand übernehmen", `„${p.git.branch}“ ist ${p.git.ahead} ${p.git.ahead === 1 ? "Commit" : "Commits"} voraus und ${p.git.behind} zurück. Wie sollen beide Stränge zusammenkommen?`, `<label class="gw-choice"><input type="radio" name="method" value="rebase" checked><span><strong>Rebase</strong><small>Deine ${plural(p.git.ahead, "Commit wird", "Commits werden")} auf den Remote-Stand gesetzt. Gerader Verlauf, kein Merge-Commit. Empfohlen, solange du die Commits noch nicht geteilt hast.</small></span></label><label class="gw-choice"><input type="radio" name="method" value="merge"><span><strong>Merge</strong><small>Beide Stränge bleiben erhalten und werden mit einem Merge-Commit verbunden.</small></span></label>${p.git.dirty ? '<p class="gw-warning">Du hast offene Änderungen. Committe oder sichere sie zuerst im Stash, sonst lehnt Git den Vorgang ab.</p>' : ""}`, "Pull ausführen", form => run("pull", { method: form.method }, p.id)); return;
    }
    if (["checkout", "checkout-remote"].includes(action)) { await run(action, { branch: target.dataset.branch }); return; }
    if (action === "create-branch-now") { await run("create-branch", { branch: target.dataset.branch }); return; }
    if (action === "suggest") {
      const original = s.summary; target.disabled = true;
      try { const result = await api(base(p.id) + (s.advanced ? "commit-message" : "suggest-files"), s.advanced ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: includedFiles(p).map(f => f.path) }) }); if (s.summary === original) { s.summary = result.message; saveDraft(p.id); render(); } } finally { target.disabled = false; } return;
    }
    if (action === "file-menu") {
      const file = target.dataset.path;
      const parts = file.split("/"); const folders = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
      modal("Zu .gitignore hinzufügen", "Dateien oder Ordner von zukünftigen Änderungen ausschließen.", `<label class="gw-field"><span>Ignorieren</span><select name="folder"><option value="">Datei: ${esc(file)}</option>${folders.reverse().map(folder => `<option value="${esc(folder)}">Ordner: ${esc(folder)}/</option>`).join("")}</select></label><label class="gw-choice"><input type="checkbox" name="untrack"><span><strong>Bereits versionierte Dateien aus Git entfernen</strong><small>Lokale Dateien bleiben erhalten. Ohne diese Option wirkt .gitignore nur auf noch nicht versionierte Dateien.</small></span></label>`, "Ignorieren", form => run("ignore", { file, folder: form.folder, untrack: form.untrack === "on" }, p.id)); return;
    }
    if (action === "discard") {
      const path = target.dataset.path;
      const trash = state.capabilities?.trash;
      const support = trash?.available !== false;
      confirm("Änderungen verwerfen?", "Die Datei wird auf den letzten Commit zurückgesetzt. Auch ihre Vormerkung wird entfernt.", "discard-files", { files: [path] }, "Änderungen verwerfen", true, `<code class="gw-confirm-target">${esc(path)}</code><p class="gw-warning">Änderungen an versionierten Dateien gehen verloren. Neue Dateien werden ${support ? "in den Papierkorb verschoben" : "endgültig gelöscht"}.</p>`); return;
    }
    if (action === "resolve-dialog") {
      const path = target.dataset.path; const side = target.dataset.side; const rebase = w?.operation === "rebase";
      const label = side === "ours" ? (rebase ? "Stand des Ziel-Branch behalten" : `Meine Version (${p.git.branch || "HEAD"}) behalten`) : (rebase ? "Meinen Commit übernehmen" : "Eingehende Version übernehmen");
      confirm(label + "?", "Die Datei wird komplett auf diese Version gesetzt und als gelöst vorgemerkt. Die andere Seite dieser Datei geht für diesen Vorgang verloren.", "resolve-file", { file: path, side }, label, false, `<code class="gw-confirm-target">${esc(path)}</code><p class="gw-warning">Brauchst du Teile aus beiden Versionen, löse den Konflikt stattdessen im Editor.</p>`); return;
    }
    if (action === "create-branch-dialog") { confirm("Neuer Branch", `Erstellt einen Branch vom aktuellen Stand (${p.git.branch || "HEAD"}) und wechselt zu ihm.`, "create-branch", {}, "Branch erstellen", false, field("Branch-Name", "branch", s.branchQuery.trim(), 'required placeholder="feature/meine-aenderung" maxlength="100"')); return; }
    if (action === "rename-branch-dialog") { confirm("Branch umbenennen", `Lokalen Branch „${target.dataset.branch}“ umbenennen.`, "rename-branch", { branch: target.dataset.branch }, "Umbenennen", false, field("Neuer Name", "name", target.dataset.branch, 'required maxlength="100"')); return; }
    if (action === "delete-branch-dialog") { confirm("Branch löschen?", `„${target.dataset.branch}“ lokal löschen. Git schützt Branches mit noch nicht integrierten Commits.`, "delete-branch", { branch: target.dataset.branch }, "Branch löschen", true); return; }
    if (action === "integrate-dialog") {
      const branch = target.dataset.branch;
      modal("Branch integrieren", `Änderungen aus „${branch}“ in „${p.git.branch}“ übernehmen.`, `<label class="gw-choice"><input type="radio" name="method" value="merge" checked><span><strong>Merge</strong><small>Verläufe zusammenführen. Bestehende Commits bleiben erhalten.</small></span></label><label class="gw-choice"><input type="radio" name="method" value="rebase"><span><strong>Rebase</strong><small>Eigene Commits auf den Quellbranch setzen. Nur für unveröffentlichte Arbeit verwenden.</small></span></label>`, "Integrieren", form => run(form.method, { branch }, p.id)); return;
    }
    if (action === "compare") { s.comparison = target.dataset.branch; s.tab = "branches"; render(); await read(p.id, `compare:${s.comparison}`, `compare?branch=${encodeURIComponent(s.comparison)}`, true); render(); return; }
    if (action === "close-comparison") { s.comparison = null; render(); return; }
    if (action === "confirm-abort") { confirm("Vorgang abbrechen?", `Den laufenden ${operationName(w?.operation)} abbrechen. Der Stand von vor dem Vorgang wird wiederhergestellt, bisherige Konfliktauflösungen gehen verloren.`, "abort", {}, "Vorgang abbrechen", true); return; }
    if (action === "stash-save-dialog") { confirm("Änderungen zwischenspeichern", "Sichert versionierte Änderungen und neue Dateien. Ignorierte Dateien bleiben unberührt.", "stash-save", {}, "Im Stash sichern", false, field("Beschreibung", "message", "", 'placeholder="Woran arbeitest du gerade?" maxlength="200"')); return; }
    if (action.startsWith("stash-")) {
      const stash = w?.stashes?.find(stash => stash.hash === target.dataset.hash); if (!stash) return;
      if (action === "stash-detail") { s.stash = stash.hash; render(); ensure(p.id); return; }
      if (action === "stash-drop-dialog") { confirm("Stash löschen?", "Dieser gespeicherte Zwischenstand wird aus der Stash-Liste entfernt und kann in DevHub nicht wiederhergestellt werden.", "stash-drop", { stash: stash.ref, hash: stash.hash }, "Stash löschen", true, `<code class="gw-confirm-target">${esc(stash.subject)}</code>`); return; }
      modal("Stash anwenden", stash.subject, `<label class="gw-choice"><input type="radio" name="method" value="stash-apply" checked><span><strong>Anwenden & behalten</strong><small>Änderungen wiederherstellen und die Sicherung behalten.</small></span></label><label class="gw-choice"><input type="radio" name="method" value="stash-pop"><span><strong>Anwenden & entfernen</strong><small>Die Sicherung wird nach erfolgreicher Anwendung entfernt.</small></span></label>`, "Stash anwenden", form => run(form.method, { stash: stash.ref, hash: stash.hash }, p.id)); return;
    }
    if (action === "create-tag-dialog") { confirm("Tag erstellen", `Annotiertes Tag auf ${target.dataset.hash?.slice(0, 7) || "dem aktuellen Commit"} anlegen.`, "create-tag", { ...(target.dataset.hash ? { hash: target.dataset.hash } : {}) }, "Tag erstellen", false, field("Tag-Name", "name", "", 'required placeholder="v1.0.0" maxlength="100"') + field("Beschreibung", "message", "", 'placeholder="Release-Beschreibung" maxlength="2000"')); return; }
    if (action === "delete-tag-dialog") { confirm("Lokales Tag löschen?", `„${target.dataset.name}“ lokal entfernen. Ein bereits veröffentlichtes Remote-Tag bleibt bestehen.`, "delete-tag", { name: target.dataset.name }, "Tag löschen", true); return; }
    if (action === "push-tag-dialog") { confirm("Tag veröffentlichen", `„${target.dataset.name}“ zum gewählten Remote übertragen.`, "push-tag", { name: target.dataset.name }, "Veröffentlichen", false, `<label class="gw-field"><span>Remote</span><select name="remote">${w.remotes.map(r => `<option>${esc(r.name)}</option>`).join("")}</select></label>`); return; }
    if (action === "remote-add-dialog" || action === "remote-edit-dialog") {
      const remote = w?.remotes?.find(r => r.name === target.dataset.name);
      confirm(remote ? "Remote bearbeiten" : "Remote hinzufügen", "HTTPS, SSH und absolute lokale Repository-Pfade werden unterstützt.", remote ? "remote-set-url" : "remote-add", {}, "Speichern", false, field("Remote-Name", "remote", remote?.name || "origin", `required maxlength="100" ${remote ? "readonly" : ""}`) + field("Repository-URL", "url", remote?.url || "", 'required placeholder="https://github.com/name/repository.git" maxlength="2000"')); return;
    }
    if (action === "remote-remove-dialog") { confirm("Remote entfernen?", `Die lokale Verbindung zu „${target.dataset.name}“ und ihre Tracking-Referenzen entfernen. Das Repository auf dem Server bleibt bestehen.`, "remote-remove", { remote: target.dataset.name }, "Remote entfernen", true); return; }
    if (action === "undo-dialog") { confirm("Letzten Commit zurücknehmen?", "Der Commit wird lokal zurückgenommen. Seine Änderungen bleiben für einen neuen Commit vorgemerkt. Veröffentlichte Commits werden geschützt.", "undo-commit", {}, "Commit zurücknehmen", false, `<code class="gw-confirm-target">${esc(p.git.lastCommit.subject)}</code>`); return; }
    if (action === "revert-dialog" || action === "cherry-pick-dialog") { const revert = action === "revert-dialog"; confirm(revert ? "Commit rückgängig machen" : "Commit übernehmen", revert ? "Erstellt einen neuen Commit, der die Änderungen des gewählten Commits rückgängig macht. Der bestehende Verlauf bleibt erhalten." : `Übernimmt die Änderungen dieses Commits als neuen Commit auf „${p.git.branch || "HEAD"}“.`, revert ? "revert" : "cherry-pick", { hash: target.dataset.hash }, revert ? "Revert erstellen" : "Cherry-pick ausführen", false, `<code class="gw-confirm-target">${esc(target.dataset.hash)}</code>`); return; }
    if (action === "history-more") {
      const resource = `history:${s.historyQuery}:${s.historyAll}`;
      const previous = data(p.id, resource);
      if (!previous?.hasMore || pendingReads.has(key(p.id, "history-more"))) return;
      pendingReads.set(key(p.id, "history-more"), true); render();
      try { const next = await api(base(p.id) + `history?offset=${previous.commits.length}&query=${encodeURIComponent(s.historyQuery)}&all=${s.historyAll}`); if (data(p.id, resource) === previous) cache.set(key(p.id, resource), { commits: [...previous.commits, ...next.commits], hasMore: next.hasMore }); }
      finally { pendingReads.delete(key(p.id, "history-more")); render(); } return;
    }
  }
  for (const surface of [root, rail]) surface.addEventListener("click", event => {
    const target = event.target.closest("[data-gw]");
    if (target && !target.disabled) {
      event.stopPropagation();
      if (target.dataset.gw !== "menu" && menu) menu = null;
      interact(target).catch(error => toast(error.message, "error"));
    } else if (menu && !event.target.closest(".gw-popover")) { menu = null; render(); }
  });
  document.addEventListener("click", event => { if (menu && !root.contains(event.target) && !dialog.contains(event.target)) { menu = null; render(); } });
  dialog.addEventListener("click", event => { const target = event.target.closest("[data-gw]"); if (target && !target.disabled) interact(target).catch(error => toast(error.message, "error")); });
  for (const surface of [root, rail]) surface.addEventListener("input", event => {
    const kind = event.target.dataset.gwInput;
    const p = selected(); if (!kind) return;
    if (kind === "repoQuery") { state.gitQuery = event.target.value; render(); return; }
    if (kind === "menuQuery") { menuQuery = event.target.value; render(); return; }
    if (!p) return;
    const s = session(p.id);
    if (kind === "includeFile") { event.target.checked ? s.excluded.delete(event.target.dataset.path) : s.excluded.add(event.target.dataset.path); render(); return; }
    if (kind === "selectAll") { s.excluded = new Set(event.target.checked ? [] : p.git.files.map(f => f.path)); render(); return; }
    if (["summary", "description"].includes(kind)) { s[kind] = event.target.value; saveDraft(p.id); refreshComposer(p); return; }
    if (["amend", "historyAll"].includes(kind)) {
      s[kind] = event.target.checked;
      if (kind === "amend" && s.amend && !s.summary) { s.summary = p.git.lastCommit?.subject || ""; saveDraft(p.id); }
      if (kind === "historyAll") s.commit = null;
      render(); ensure(p.id); return;
    }
    s[kind] = event.target.value;
    if (kind === "historyQuery") { clearTimeout(searchTimer); searchTimer = setTimeout(() => { s.commit = null; render(); ensure(p.id); }, 250); }
    else { render(); ensure(p.id); }
  });
  root.addEventListener("submit", event => {
    const form = event.target.closest("[data-gw-form]"); if (!form) return;
    event.preventDefault(); event.stopPropagation();
    const p = selected(); if (!p) return;
    if (form.dataset.gwForm === "commit") { const s = session(p.id); if (!form.querySelector('[type="submit"]').disabled) run(s.advanced ? (s.amend ? "amend" : "commit") : (s.amend ? "amend-files" : "commit-files"), { message: s.summary, description: s.description, ...(!s.advanced ? { files: includedFiles(p).map(f => f.path) } : {}) }); }
    else if (form.dataset.gwForm === "identity") run("identity", Object.fromEntries(new FormData(form)));
  });
  root.addEventListener("keydown", event => {
    if (event.key === "Escape" && menu) { event.preventDefault(); menu = null; render(); root.querySelector('[data-gw="menu"][data-value="branch"]')?.focus(); return; }
    if (event.key === "Enter" && event.target.dataset?.gwInput === "branchQuery" && menu === "branch") { event.preventDefault(); const first = root.querySelector(".gw-popover-branch .gw-menu-main:not(:disabled)"); if (first) { menu = null; interact(first).catch(error => toast(error.message, "error")); } return; }
    if (event.key === "Enter" && event.target.dataset?.gwInput === "menuQuery" && menu === "repo") { event.preventDefault(); const first = root.querySelector(".gw-popover-repo .gw-menu-row:not(.current)") || root.querySelector(".gw-popover-repo .gw-menu-row"); if (first) { menu = null; interact(first).catch(error => toast(error.message, "error")); } return; }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && event.target.closest(".gw-composer")) { event.preventDefault(); root.querySelector(".gw-commit-submit")?.click(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") { event.preventDefault(); if (!busy) run("refresh"); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && selected() && view === "repo") { event.preventDefault(); openMenu("branch"); }
    const file = event.target.closest('.gw-file > button[data-gw="file"]');
    if (file && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); const files = [...root.querySelectorAll('.gw-file > button[data-gw="file"]')]; const next = files[files.indexOf(file) + (event.key === "ArrowDown" ? 1 : -1)]; if (next) { const path = next.dataset.path; interact(next).then(() => root.querySelector(`.gw-file > button[data-path="${CSS.escape(path)}"]`)?.focus()); } }
  });
  return {
    render, load: ensure,
    openAddRepository: () => { if (!busy) addRepository(); },
    // Für die Befehlspalette und die Projektliste: GitHub-Repositories des angemeldeten Kontos und der Klon-Dialog.
    githubRepositories: async () => { await loadGithub(); return github; },
    isInWorkspace: repo => Boolean(inWorkspace(repo)),
    openGithubClone: (repo, name) => { if (!busy) interact({ dataset: { gw: "github-clone", repo, name } }).catch(error => toast(error.message, "error")); }
  };
}
