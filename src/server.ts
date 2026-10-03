import { randomBytes } from "node:crypto";
import { createReadStream, watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, getAppDirectory, saveScanRoot } from "./config.js";
import { advancedGitActions, fetchAllRepositories, readGitWorkspace, readGitStash, readGitStats, readGitComparison, initializeGitRepository, cloneGitRepository, cloneGitHubRepository, listGitHubRepositories, readGitBranches, readGitCommit, readGitDiff, readGitHistory, runGitAction, suggestGitCommitMessage, type GitAction, type GitActionPayload } from "./git-actions.js";
import { ProcessManager } from "./process-manager.js";
import { readGitInfo, scanWorkspace } from "./scanner.js";
import { isStackAction } from "./stack.js";
import { darkThemeStylesheet } from "./theme.js";
import { resolveStack } from "./stack-registry.js";
import { chooseWorkspaceDirectory, getSystemCapabilities, runProjectAction } from "./system-actions.js";
import type { ProjectDefinition, PublicProject } from "./types.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(sourceDirectory, "../public");
const fontAwesomeDirectory = path.resolve(sourceDirectory, "../node_modules/@fortawesome/fontawesome-free");
const config = await loadConfig();
const processManager = new ProcessManager();
const capabilities = await getSystemCapabilities(config);
const publicUrl = config.publicUrl ?? `http://${config.publicHost}:${config.port}`;

async function stackStatus() {
  return (await resolveStack(config)).getStatus(config);
}
const csrfToken = randomBytes(24).toString("base64url");
let projects: ProjectDefinition[] = [];
let scanning = false;
let scanPromise: Promise<void> | null = null;
const eventClients = new Set<ServerResponse>();

function isLoopback(address?: string): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// Schutz vor DNS-Rebinding: Anfragen müssen mit einem bekannten Hostnamen adressiert sein,
// sonst könnte eine fremde Domain, die auf 127.0.0.1 auflöst, die API aus dem Browser lesen.
const allowedHostNames = new Set(["localhost", "127.0.0.1", "::1", config.host.toLowerCase(), config.publicHost.toLowerCase(), new URL(publicUrl).hostname.toLowerCase()]);

function isAllowedHost(hostHeader?: string): boolean {
  if (!hostHeader) return false;
  const withoutPort = hostHeader.toLowerCase().replace(/:\d+$/, "");
  return allowedHostNames.has(withoutPort) || allowedHostNames.has(withoutPort.replace(/^\[|\]$/g, ""));
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function publicProject(project: ProjectDefinition): PublicProject {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    relativePath: project.relativePath,
    category: project.category,
    categoryPath: project.categoryPath,
    modifiedAt: project.modifiedAt,
    technologies: project.technologies,
    kind: project.kind,
    defaultUrl: project.defaultUrl,
    git: project.git,
    fileCount: project.fileCount,
    isSelf: project.isSelf,
    descriptionAuto: project.descriptionAuto,
    thumbnailUrl: project.thumbnailPath ? `/api/projects/${project.id}/thumbnail` : null,
    launchers: project.launchers.map(({ cwd: _cwd, executable: _executable, args: _args, ...launcher }) => ({
      ...launcher,
      runtime: processManager.getSnapshot(launcher.id)
    }))
  };
}

function publicProjects(): PublicProject[] {
  return projects.map(publicProject);
}

function findLauncher(id: string) {
  for (const project of projects) {
    const launcher = project.launchers.find((candidate) => candidate.id === id);
    if (launcher) return launcher;
  }
  return null;
}

function broadcast(type: string, payload: unknown): void {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of eventClients) client.write(message);
}

processManager.onChange((launcherId, runtime) => broadcast("runtime", { launcherId, runtime }));
processManager.onLog((launcherId, entry) => broadcast("log", { launcherId, entry }));

let lastProjectsPayload = "";

function broadcastProjects(): void {
  const payload = JSON.stringify({ projects: publicProjects() });
  if (payload === lastProjectsPayload) return;
  lastProjectsPayload = payload;
  const message = `event: projects\ndata: ${payload}\n\n`;
  for (const client of eventClients) client.write(message);
}

async function refreshProjects(): Promise<void> {
  if (scanPromise) return scanPromise;
  scanning = true;
  scanPromise = (async () => {
    try {
      projects = await scanWorkspace(config, getAppDirectory());
      broadcastProjects();
    } finally {
      scanning = false;
      scanPromise = null;
      if (rescanQueued) {
        rescanQueued = false;
        scheduleWorkspaceRefresh();
      }
    }
  })();
  return scanPromise;
}

let workspaceWatcher: FSWatcher | null = null;
let watchDebounce: NodeJS.Timeout | null = null;
let rescanQueued = false;
const watcherIgnored = new Set(config.ignore.map((name) => name.toLowerCase()));
const gitRelevantEntry = /^(HEAD|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|COMMIT_EDITMSG|packed-refs|index|refs)$/i;

function isRelevantChange(relativePath: string | null): boolean {
  if (!relativePath) return true;
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (!segments.length) return true;
  const leaf = segments[segments.length - 1];
  if (leaf.endsWith(".lock") || leaf.endsWith(".tmp") || leaf.endsWith("~")) return false;
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === ".git");
  if (gitIndex !== -1) {
    const inner = segments[gitIndex + 1];
    return inner === undefined || gitRelevantEntry.test(inner);
  }
  return !segments.some((segment) => watcherIgnored.has(segment.toLowerCase()));
}

let lastWorkspaceScanEnd = 0;

function scheduleWorkspaceRefresh(): void {
  if (scanPromise) {
    rescanQueued = true;
    return;
  }
  if (watchDebounce) return;
  const delay = Math.max(1500, lastWorkspaceScanEnd + 5000 - Date.now());
  watchDebounce = setTimeout(() => {
    watchDebounce = null;
    refreshProjects().catch((error) => {
      console.warn(`Automatischer Workspace-Scan fehlgeschlagen: ${error instanceof Error ? error.message : error}`);
    }).finally(() => {
      lastWorkspaceScanEnd = Date.now();
    });
  }, delay);
  watchDebounce.unref?.();
}

function startWorkspaceWatcher(): void {
  workspaceWatcher?.close();
  workspaceWatcher = null;
  try {
    workspaceWatcher = watch(config.scanRoot, { recursive: true, persistent: false }, (_eventType, filename) => {
      const relativePath = typeof filename === "string" ? filename : null;
      if (isRelevantChange(relativePath) && !isOwnGitWrite(relativePath)) scheduleWorkspaceRefresh();
    });
    workspaceWatcher.on("error", (error) => {
      console.warn(`Workspace-Überwachung unterbrochen: ${error instanceof Error ? error.message : error}`);
      workspaceWatcher?.close();
      workspaceWatcher = null;
    });
  } catch (error) {
    console.warn(`Workspace-Überwachung nicht verfügbar: ${error instanceof Error ? error.message : error}`);
  }
}

function requireToken(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.headers["x-devhub-token"] !== csrfToken) {
    sendJson(response, 403, { error: "Ungültiges Sicherheitstoken. Bitte die Seite neu laden." });
    return false;
  }
  return true;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("Anfrage ist zu groß.");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Ungültige Anfrage.");
  return parsed as Record<string, unknown>;
}

async function refreshProjectGit(project: ProjectDefinition): Promise<void> {
  if (!project.git) return;
  const repository = path.resolve(project.absolutePath, project.git.repositoryRoot);
  project.git = await readGitInfo(repository, project.absolutePath);
}

function serveStatic(requestPath: string, response: ServerResponse): void {
  const fontAwesomePrefix = "/vendor/fontawesome/";
  const isFontAwesomeAsset = requestPath.startsWith(fontAwesomePrefix);
  const requested = isFontAwesomeAsset
    ? requestPath.slice(fontAwesomePrefix.length)
    : requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const rootDirectory = isFontAwesomeAsset ? fontAwesomeDirectory : publicDirectory;
  const allowedFontAwesomeAsset = /^(?:css\/(?:fontawesome|solid|regular)\.min\.css|webfonts\/fa-(?:solid-900|regular-400)\.woff2)$/;
  const resolved = path.resolve(rootDirectory, requested);
  if ((isFontAwesomeAsset && !allowedFontAwesomeAsset.test(requested)) || (!resolved.startsWith(rootDirectory + path.sep) && resolved !== path.join(rootDirectory, "index.html"))) {
    sendJson(response, 404, { error: "Nicht gefunden" });
    return;
  }
  const extensions: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2"
  };
  stat(resolved).then((fileStats) => {
    if (!fileStats.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": extensions[path.extname(resolved)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    createReadStream(resolved).pipe(response);
  }).catch(() => sendJson(response, 404, { error: "Nicht gefunden" }));
}

const busyRepositories = new Set<string>();
const quietGitUntil = new Map<string, number>();
let cloningRepository = false;

function releaseRepository(repository: string): void {
  busyRepositories.delete(repository);
  // FSEvents meldet die Schreibzugriffe von Git teils erst nach dem Ende der Aktion.
  quietGitUntil.set(repository, Date.now() + 3000);
}

// Git-Aktionen aktualisieren ihr Projekt selbst. Ihre Schreibzugriffe in .git (FETCH_HEAD, Refs)
// sollen keinen zusätzlichen Scan des ganzen Workspaces auslösen.
function isOwnGitWrite(relativePath: string | null): boolean {
  if (!relativePath) return false;
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === ".git");
  if (gitIndex === -1) return false;
  const repository = path.resolve(config.scanRoot, ...segments.slice(0, gitIndex));
  return busyRepositories.has(repository) || (quietGitUntil.get(repository) ?? 0) > Date.now();
}

const server = createServer(async (request, response) => {
  if (!isLoopback(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: "DevHub ist nur lokal erreichbar." });
    return;
  }
  if (!isAllowedHost(request.headers.host)) {
    sendJson(response, 403, { error: "Ungültiger Host-Header." });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (request.method === "GET" && pathname === "/api/bootstrap") {
      sendJson(response, 200, {
        token: csrfToken,
        root: config.scanRoot,
        publicUrl,
        projects: publicProjects(),
        capabilities,
        stack: await stackStatus(),
        scanning
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      response.write("event: connected\ndata: {}\n\n");
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }

    if (request.method === "GET" && pathname === "/api/stack/status") {
      sendJson(response, 200, { stack: await stackStatus() });
      return;
    }

    const thumbnailMatch = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/thumbnail$/);
    if (request.method === "GET" && thumbnailMatch) {
      const project = projects.find((candidate) => candidate.id === thumbnailMatch[1]);
      if (!project?.thumbnailPath) {
        sendJson(response, 404, { error: "Kein Vorschaubild vorhanden." });
        return;
      }
      const mimeTypes: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"
      };
      const thumbnailStats = await stat(project.thumbnailPath).catch(() => null);
      if (!thumbnailStats?.isFile()) {
        sendJson(response, 404, { error: "Kein Vorschaubild vorhanden." });
        return;
      }
      const lastModified = new Date(Math.floor(thumbnailStats.mtimeMs / 1000) * 1000).toUTCString();
      const cacheHeaders = { "Cache-Control": "private, max-age=60", "Last-Modified": lastModified };
      if (request.headers["if-modified-since"] === lastModified) {
        response.writeHead(304, cacheHeaders);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": mimeTypes[path.extname(project.thumbnailPath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": thumbnailStats.size,
        ...cacheHeaders
      });
      createReadStream(project.thumbnailPath).pipe(response);
      return;
    }

    const logsMatch = pathname.match(/^\/api\/launchers\/([a-f0-9]+)\/logs$/);
    if (request.method === "GET" && logsMatch) {
      if (!findLauncher(logsMatch[1])) {
        sendJson(response, 404, { error: "Starter nicht gefunden." });
        return;
      }
      sendJson(response, 200, { logs: processManager.getLogs(logsMatch[1]) });
      return;
    }

    if (request.method === "POST" && pathname === "/api/rescan") {
      if (!requireToken(request, response)) return;
      await refreshProjects();
      sendJson(response, 200, { projects: publicProjects() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/workspace/pick") {
      if (!requireToken(request, response)) return;
      const root = await chooseWorkspaceDirectory(config.scanRoot);
      sendJson(response, 200, { root });
      return;
    }

    if (request.method === "PUT" && pathname === "/api/settings/workspace") {
      if (!requireToken(request, response)) return;
      const payload = await readJsonBody(request);
      if (typeof payload.root !== "string") {
        sendJson(response, 400, { error: "Ein Workspace-Pfad ist erforderlich." });
        return;
      }
      if (scanPromise) await scanPromise;
      let root: string;
      try {
        root = await saveScanRoot(config, payload.root);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Der Workspace konnte nicht gespeichert werden." });
        return;
      }
      await processManager.stopAll();
      await refreshProjects();
      startWorkspaceWatcher();
      const publicPayload = { root, projects: publicProjects() };
      broadcast("workspace", publicPayload);
      sendJson(response, 200, publicPayload);
      return;
    }

    const projectActionMatch = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/(folder|editor|terminal)$/);
    if (request.method === "POST" && projectActionMatch) {
      if (!requireToken(request, response)) return;
      const project = projects.find((candidate) => candidate.id === projectActionMatch[1]);
      if (!project) {
        sendJson(response, 404, { error: "Projekt nicht gefunden. Bitte Projekte neu einlesen." });
        return;
      }
      const message = await runProjectAction(config, project.absolutePath, projectActionMatch[2] as "folder" | "editor" | "terminal");
      sendJson(response, 200, { message });
      return;
    }

    const gitMessageMatch = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/git\/commit-message$/);
    if (request.method === "GET" && gitMessageMatch) {
      const project = projects.find((candidate) => candidate.id === gitMessageMatch[1]);
      if (!project?.git) {
        sendJson(response, 404, { error: "Git-Repository nicht gefunden. Bitte Projekte neu einlesen." });
        return;
      }
      sendJson(response, 200, { message: await suggestGitCommitMessage(project) });
      return;
    }

    const gitBranchesMatch = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/git\/branches$/);
    if (request.method === "GET" && gitBranchesMatch) {
      const project = projects.find((candidate) => candidate.id === gitBranchesMatch[1]);
      if (!project?.git) {
        sendJson(response, 404, { error: "Git-Repository nicht gefunden. Bitte Projekte neu einlesen." });
        return;
      }
      sendJson(response, 200, { branches: await readGitBranches(project) });
      return;
    }

    if (request.method === "GET" && pathname === "/api/git/github/repositories") {
      sendJson(response, 200, await listGitHubRepositories());
      return;
    }

    if (request.method === "POST" && pathname === "/api/git/github/clone") {
      if (!requireToken(request, response)) return;
      if (cloningRepository) throw new Error("Es läuft bereits ein Klonvorgang.");
      cloningRepository = true;
      try {
        await cloneGitHubRepository(config.scanRoot, await readJsonBody(request));
        await refreshProjects();
        sendJson(response, 200, { message: "Repository von GitHub geklont.", projects: publicProjects() });
      } finally { cloningRepository = false; }
      return;
    }

    if (request.method === "POST" && pathname === "/api/git/clone") {
      if (!requireToken(request, response)) return;
      if (cloningRepository) throw new Error("Es läuft bereits ein Klonvorgang.");
      cloningRepository = true;
      try {
        await cloneGitRepository(config.scanRoot, await readJsonBody(request));
        await refreshProjects();
        sendJson(response, 200, { message: "Repository geklont.", projects: publicProjects() });
      } finally { cloningRepository = false; }
      return;
    }

    const gitWorkspaceMatch = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/git\/(workspace|stash-diff|compare|stats)$/);
    if (request.method === "GET" && gitWorkspaceMatch) {
      const project = projects.find(candidate => candidate.id === gitWorkspaceMatch[1]);
      if (!project?.git) throw new Error("Git-Repository nicht gefunden.");
      const data = gitWorkspaceMatch[2] === "workspace" ? await readGitWorkspace(project)
        : gitWorkspaceMatch[2] === "stats" ? await readGitStats(project)
        : gitWorkspaceMatch[2] === "compare" ? await readGitComparison(project, url.searchParams.get("branch"))
        : await readGitStash(project, { stash: url.searchParams.get("stash"), hash: url.searchParams.get("hash") });
      sendJson(response, 200, data);
      return;
    }

    const gitActionMatch = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/git\/([a-z-]+)$/);
    const actions: readonly string[] = ["init", "refresh", "stage", "unstage", "stage-files", "unstage-files", "discard-files", "stage-all", "unstage-all", "commit", "fetch", "pull", "push", "checkout", "create-branch", "undo-commit", ...advancedGitActions];
    if (request.method === "POST" && gitActionMatch && actions.includes(gitActionMatch[2])) {
      if (!requireToken(request, response)) return;
      const project = projects.find(candidate => candidate.id === gitActionMatch[1]);
      if (!project) throw new Error("Projekt nicht gefunden. Bitte Projekte neu einlesen.");
      const repository = path.resolve(project.absolutePath, project.git?.repositoryRoot || ".");
      if (busyRepositories.has(repository)) throw new Error("Für dieses Repository läuft bereits eine Git-Aktion.");
      busyRepositories.add(repository);
      let message: string;
      try {
        const payload = await readJsonBody(request) as GitActionPayload;
        if (gitActionMatch[2] === "init") {
          await initializeGitRepository(project);
          project.git = await readGitInfo(project.absolutePath, project.absolutePath);
          message = "Git-Repository angelegt.";
        } else {
          await refreshProjectGit(project);
          message = await runGitAction(project, gitActionMatch[2] as GitAction, payload);
        }
      } finally {
        // Auch ein fehlgeschlagener Merge kann einen neuen Konfliktzustand hinterlassen.
        if (gitActionMatch[2] !== "init") await refreshProjectGit(project);
        broadcastProjects();
        releaseRepository(repository);
      }
      sendJson(response, 200, { message, project: publicProject(project) });
      return;
    }

    if (request.method === "POST" && pathname === "/api/git/fetch-all") {
      if (!requireToken(request, response)) return;
      const result = await fetchAllRepositories(projects, {
        claim: (repository) => {
          if (busyRepositories.has(repository)) return false;
          busyRepositories.add(repository);
          return true;
        },
        settle: async (repository, members) => {
          await Promise.all(members.map(refreshProjectGit));
          releaseRepository(repository);
        }
      });
      broadcastProjects();
      const parts = [`Fetch: ${result.fetched === 1 ? "1 Repository" : `${result.fetched} Repositories`} abgerufen`];
      if (result.skipped) parts.push(`${result.skipped} übersprungen, weil dort bereits eine Git-Aktion läuft`);
      if (result.failed.length) parts.push(`${result.failed.length} fehlgeschlagen (${result.failed.map(item => `${item.name}: ${item.error}`).join("; ")})`);
      sendJson(response, 200, { message: `${parts.join(", ")}.`, failed: result.failed.length, projects: publicProjects() });
      return;
    }

    const gitDiffMatch = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/git\/diff$/);
    if (request.method === "GET" && gitDiffMatch) {
      const project = projects.find((candidate) => candidate.id === gitDiffMatch[1]);
      if (!project?.git) {
        sendJson(response, 404, { error: "Git-Repository nicht gefunden. Bitte Projekte neu einlesen." });
        return;
      }
      const file = url.searchParams.get("file");
      sendJson(response, 200, { file, sections: await readGitDiff(project, file, url.searchParams.get("combined") === "true") });
      return;
    }

    const gitHistoryMatch = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/git\/history$/);
    if (request.method === "GET" && gitHistoryMatch) {
      const project = projects.find((candidate) => candidate.id === gitHistoryMatch[1]);
      if (!project?.git) {
        sendJson(response, 404, { error: "Git-Repository nicht gefunden. Bitte Projekte neu einlesen." });
        return;
      }
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 60);
      sendJson(response, 200, await readGitHistory(project, offset, limit, url.searchParams.get("query") || "", url.searchParams.get("all") === "true"));
      return;
    }

    const gitCommitMatch = pathname.match(/^\/api\/projects\/([a-f0-9]+)\/git\/commits\/([0-9a-f]{7,40})$/i);
    if (request.method === "GET" && gitCommitMatch) {
      const project = projects.find((candidate) => candidate.id === gitCommitMatch[1]);
      if (!project?.git) {
        sendJson(response, 404, { error: "Git-Repository nicht gefunden. Bitte Projekte neu einlesen." });
        return;
      }
      sendJson(response, 200, await readGitCommit(project, gitCommitMatch[2], url.searchParams.get("file")));
      return;
    }

    const stackActionMatch = pathname.match(/^\/api\/stack\/([a-z-]+)$/);
    if (request.method === "POST" && stackActionMatch && isStackAction(stackActionMatch[1])) {
      if (!requireToken(request, response)) return;
      const stack = await resolveStack(config);
      const status = await stack.getStatus(config);
      if (!status.actions.some((action) => action.id === stackActionMatch[1])) {
        sendJson(response, 400, { error: `Die Aktion „${stackActionMatch[1]}“ steht für ${status.name} nicht zur Verfügung.` });
        return;
      }
      const message = await stack.runAction(config, stackActionMatch[1]);
      sendJson(response, 200, { message, stack: await stack.getStatus(config) });
      return;
    }

    const actionMatch = pathname.match(/^\/api\/launchers\/([a-f0-9]+)\/(start|stop|restart)$/);
    if (request.method === "POST" && actionMatch) {
      if (!requireToken(request, response)) return;
      const launcher = findLauncher(actionMatch[1]);
      if (!launcher) {
        sendJson(response, 404, { error: "Starter nicht gefunden. Bitte Projekte neu einlesen." });
        return;
      }
      const runtime = actionMatch[2] === "start"
        ? await processManager.start(launcher)
        : actionMatch[2] === "restart"
          ? await processManager.restart(launcher)
          : await processManager.stop(launcher.id);
      sendJson(response, 200, { runtime });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "API-Endpunkt nicht gefunden." });
      return;
    }
    if (request.method === "GET" && pathname === "/theme-dark.css") {
      response.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(await darkThemeStylesheet(publicDirectory));
      return;
    }
    serveStatic(pathname, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Fehler";
    sendJson(response, 500, { error: message });
  }
});

await refreshProjects();
startWorkspaceWatcher();
setInterval(() => {
  for (const client of eventClients) client.write(":heartbeat\n\n");
  if (!workspaceWatcher) scheduleWorkspaceRefresh();
}, 25_000).unref();
server.listen(config.port, config.host, () => {
  console.log(`DevHub läuft auf ${publicUrl}`);
  console.log(`Lokale Bindung: http://${config.host}:${config.port}`);
  console.log(`Projektwurzel: ${config.scanRoot}`);
});

async function shutdown(): Promise<void> {
  console.log("\nDevHub wird beendet …");
  workspaceWatcher?.close();
  if (watchDebounce) clearTimeout(watchDebounce);
  await processManager.stopAll();
  // Offene Event-Streams würden server.close() sonst bis zum Timeout blockieren.
  for (const client of eventClients) client.end();
  eventClients.clear();
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
