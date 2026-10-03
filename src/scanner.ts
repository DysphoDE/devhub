import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isWindows } from "./platform.js";
import { resolveStack } from "./stack-registry.js";
import type { AppConfig, GitInfo, LauncherDefinition, LauncherKind, ProjectDefinition, StackWebInfo } from "./types.js";

const execFileAsync = promisify(execFile);
const packageScriptPattern = /^(dev|start|serve|preview)(:|$)/i;
// Startdateien je Plattform: Batch und CMD laufen nur unter Windows, Shell-Skripte nur auf Unix-Systemen.
const starterFiles = new Map<string, LauncherKind>([
  ["start.bat", "batch"],
  ["start.cmd", "command"],
  ["start.ps1", "powershell"],
  ["start.sh", "shell"]
]);
const platformStarterKinds = new Set<LauncherKind>(isWindows ? ["batch", "command", "powershell"] : ["powershell", "shell"]);
const thumbnailNames = new Set(["thumbnail.jpg", "thumbnail.jpeg", "thumbnail.png", "thumbnail.webp", "thumbnail.gif"]);
// Manifeste und Konfigurationen, die einen Ordner zweifelsfrei zu einem Projekt machen.
const projectManifestFiles = new Set([
  "package.json", "composer.json", "project.ini", "requirements.txt", "pyproject.toml", "cargo.toml",
  "go.mod", "gemfile", "dockerfile", "docker-compose.yml", "compose.yml", "manifest.json", "makefile",
  "start.bat", "start.cmd", "start.ps1", "start.sh", ".env", ".env.example", "tsconfig.json"
]);
// Endungen, die echten Quellcode bedeuten. Bewusst ohne .html/.css/.md: Ein Ordner voller
// exportierter Dokumente (F:\clients\<kunde>\uebergabe) ist kein Projekt, sondern Ablage.
const sourceCodeExtensions = new Set([
  ".php", ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".vue", ".svelte", ".astro", ".py", ".lua",
  ".toc", ".cs", ".csproj", ".sln", ".java", ".rb", ".go", ".rs", ".bat", ".cmd", ".ps1", ".sh"
]);
// Ordner, die zu einem Projekt gehören statt eines zu sein. Sie machen ihren Elternordner nie zur
// Kategorie – sonst würde aus foo/src/main.js ein Projekt namens "Src".
const structuralFolderNames = new Set([
  "src", "source", "sources", "app", "apps", "lib", "libs", "public", "public_html", "htdocs", "web",
  "www", "assets", "static", "docs", "doc", "documentation", "test", "tests", "spec", "specs",
  "scripts", "bin", "config", "conf", "settings", "includes", "inc", "styles", "css", "js",
  "javascript", "img", "images", "icons", "fonts", "media", "uploads", "logs", "migrations",
  "database", "db", "sql", "partials", "layouts", "templates", "components", "views"
]);
// Ordnernamen, die nichts über das Projekt aussagen – dann beschreibt der Elternordner es besser
// (clients/harriet-budjarek/website → "Harriet Budjarek" statt "Website").
const genericFolderNames = new Set(["website", "web", "site", "www", "app", "frontend", "client", "main", "source", "src", "projekt", "project"]);
const genericHeadings = /^(readme|getting started|welcome|documentation|installation|development|home|react\s*\+\s*vite|vite\s*\+.*|astro starter kit.*)$/i;

interface PackageData {
  name?: string;
  displayName?: string;
  description?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ComposerData {
  name?: string;
  description?: string;
  require?: Record<string, string>;
  "require-dev"?: Record<string, string>;
}

interface MetadataCandidate {
  name?: string;
  description?: string;
}

interface WorkspaceWebInfo {
  documentRoot: string | null;
  hosts: Array<{ documentRoot: string; serverName: string; url: string; servable: boolean }>;
}

interface DiscoveredProject {
  absolutePath: string;
  categorySegments: string[];
}

interface ScanEvidence {
  packagePaths: string[];
  composerPaths: string[];
  readmePaths: string[];
  htmlEntries: string[];
  phpEntries: string[];
  starterPaths: Array<{ path: string; kind: LauncherKind }>;
  thumbnailPath: string | null;
  gitRoot: string | null;
  names: Set<string>;
  fileCount: number;
  maxModifiedMs: number;
  truncated: boolean;
}

function stableId(value: string): string {
  return createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 16);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function depthFrom(base: string, candidate: string): number {
  const relative = path.relative(base, candidate);
  return relative ? relative.split(path.sep).length : 0;
}

function pathStartsWith(candidate: string, parent: string): boolean {
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  const normalizedParent = path.resolve(parent).toLowerCase();
  if (normalizedCandidate === normalizedParent) return true;
  // Laufwerkswurzeln behalten ihren Trenner ("F:\"), ein zweiter würde nie passen.
  const prefix = normalizedParent.endsWith(path.sep) ? normalizedParent : normalizedParent + path.sep;
  return normalizedCandidate.startsWith(prefix);
}

function humanize(value: string): string {
  const acronyms = new Map([["php", "PHP"], ["html", "HTML"], ["api", "API"], ["pdf", "PDF"], ["ui", "UI"], ["url", "URL"], ["sql", "SQL"], ["tuc", "TUC"], ["lra", "LRA"]]);
  return value
    .replace(/^@[^/]+\//, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => acronyms.get(word.toLocaleLowerCase("de")) ?? (word ? word[0].toLocaleUpperCase("de") + word.slice(1) : word))
    .join(" ");
}

function normalizedWords(value: string): string[] {
  return value.toLocaleLowerCase("de").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9äöüß]+/gi, " ").split(/\s+/).filter((word) => word.length >= 4);
}

function chooseInferredName(folderName: string, candidates: Array<string | undefined>, rawFolderName: string): string {
  const usable = candidates.map((value) => value?.trim()).filter((value): value is string => typeof value === "string" && value.length > 0 && !genericHeadings.test(value));
  const folderWords = new Set(normalizedWords(folderName));
  const folderLooksTechnical = /[_]/.test(rawFolderName) || rawFolderName === rawFolderName.toLocaleLowerCase("de");
  const matching = usable.find((candidate) => normalizedWords(candidate).some((word) => folderWords.has(word)));
  return matching ?? (folderLooksTechnical ? usable[0] : undefined) ?? folderName;
}

function truncate(value: string, length = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= length ? normalized : `${normalized.slice(0, length - 1).trim()}…`;
}

function parseProjectIni(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#") || line.startsWith("[")) continue;
    const match = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1].toLowerCase()] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return result;
}

async function readText(filePath: string, maxBytes = 220_000): Promise<string> {
  try {
    const contents = await readFile(filePath);
    return contents.subarray(0, maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function parseReadme(contents: string): MetadataCandidate {
  const withoutCode = contents.replace(/```[\s\S]*?```/g, " ");
  const lines = withoutCode.split(/\r?\n/);
  const heading = lines
    .map((line) => line.match(/^#\s+(.+?)\s*#*$/)?.[1]?.trim())
    .find((value) => value && !genericHeadings.test(value) && !value.includes("[!"));
  const paragraphs = withoutCode
    .replace(/<[^>]+>/g, " ")
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph
      .replace(/^#{1,6}\s+.*$/gm, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^[-*+]\s+/gm, "")
      .replace(/[`*_>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim())
    .filter((paragraph) => paragraph.length >= 35 && !/^(install|usage|requirements|features|license)\b/i.test(paragraph));
  return { name: heading ? truncate(heading, 80) : undefined, description: paragraphs[0] ? truncate(paragraphs[0]) : undefined };
}

// HTML-Titel enthalten Entities wie &amp;; der Projektname soll den Klartext tragen.
function decodeHtmlEntities(value: string | undefined): string | undefined {
  if (!value) return value;
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") { const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match; }
    return named[entity.toLowerCase()] ?? match;
  });
}

function parseHtml(contents: string): MetadataCandidate {
  const title = decodeHtmlEntities(contents.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  const description = contents.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1]
    ?? contents.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)?.[1];
  return {
    name: title ? truncate(title, 80) : undefined,
    description: description ? truncate(description) : undefined
  };
}

async function readProjectIni(projectPath: string): Promise<Record<string, string>> {
  return parseProjectIni(await readText(path.join(projectPath, "project.ini"), 64_000));
}

const bundlerConfigPattern = /^(?:vite|next|nuxt|astro|svelte|webpack|rollup|remix|vue|craco|quasar)\.config\.[cm]?[jt]s$/;

// Ein Virtual Host allein beweist nichts: Apache kann nur ausliefern, was fertig im DocumentRoot
// liegt. PHP immer, HTML nur wenn es der fertige Stand ist – die rohe index.html eines Vite- oder
// Next-Projekts ist im Browser unbrauchbar, ein leeres public/ erst recht. Ein package.json neben
// fertigem HTML ist dagegen harmlos (Tailwind-Build o. ä.), erst zusammen mit src/ wird es Quelle.
async function isServableDocumentRoot(documentRoot: string): Promise<boolean> {
  const entries = await readDirectoryEntries(documentRoot);
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase()));
  if (files.has("index.php")) return true;
  if (!files.has("index.html") && !files.has("index.htm")) return false;
  if ([...files].some((name) => bundlerConfigPattern.test(name))) return false;
  const hasSourceDirectory = entries.some((entry) => entry.isDirectory() && entry.name.toLowerCase() === "src");
  return !(files.has("package.json") && hasSourceDirectory);
}

// Der Stack (Laragon, Herd, Valet) kennt seine lokalen Domains; der Scanner prüft nur noch,
// ob deren DocumentRoot tatsächlich etwas ausliefert.
async function readWorkspaceWebInfo(config: AppConfig): Promise<WorkspaceWebInfo> {
  let info: StackWebInfo = { documentRoot: null, sites: [] };
  try {
    info = await (await resolveStack(config)).readWebInfo(config);
  } catch {
    // Der Stack ist optional; ohne ihn gibt es keine lokalen Domains.
  }
  const hosts = await Promise.all(info.sites.map(async (site) => ({
    documentRoot: site.documentRoot, serverName: site.serverName, url: site.url, servable: await isServableDocumentRoot(site.documentRoot)
  })));
  return { documentRoot: info.documentRoot, hosts };
}

async function detectPackageManager(packageDirectory: string, projectPath: string, packageManagerField?: string): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  const declared = packageManagerField?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  let current = packageDirectory;
  while (pathStartsWith(current, projectPath)) {
    const candidates: Array<[string, "npm" | "pnpm" | "yarn" | "bun"]> = [
      ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]
    ];
    for (const [filename, manager] of candidates) {
      try {
        if ((await stat(path.join(current, filename))).isFile()) return manager;
      } catch { /* continue */ }
    }
    if (path.resolve(current) === path.resolve(projectPath)) break;
    current = path.dirname(current);
  }
  return "npm";
}

function packageCommand(manager: "npm" | "pnpm" | "yarn" | "bun", script: string): { executable: string; args: string[]; display: string } {
  const managerArgs = manager === "yarn" ? [script] : ["run", script];
  const display = [manager, ...managerArgs].join(" ");
  if (isWindows) {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", [`${manager}.cmd`, ...managerArgs].join(" ")],
      display
    };
  }
  return { executable: manager, args: managerArgs, display };
}

function fileCommand(kind: LauncherKind, filePath: string): { executable: string; args: string[]; display: string } {
  const quotedName = `"${path.basename(filePath)}"`;
  if (kind === "powershell") {
    return {
      executable: isWindows ? "powershell.exe" : "pwsh",
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath],
      display: `powershell -File ${quotedName}`
    };
  }
  if (kind === "shell") {
    // Über die Shell gestartet, damit ein fehlendes Ausführungsrecht nicht im Weg steht.
    return { executable: "/bin/sh", args: [filePath], display: `sh ${quotedName}` };
  }
  if (isWindows) {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `call "${filePath}"`],
      display: quotedName
    };
  }
  return { executable: filePath, args: [], display: quotedName };
}

/** Liest einen fest eingetragenen Port aus einem Befehl, sofern er eindeutig dasteht. */
export function portFromCommand(command: string): number | null {
  const patterns = [/(?:--port[= ]|\s-p\s+)(\d{2,5})\b/, /\bPORT=(\d{2,5})\b/, /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/];
  for (const pattern of patterns) {
    const port = Number(command.match(pattern)?.[1]);
    if (port >= 1 && port <= 65535) return port;
  }
  return null;
}

/**
 * Findet die Skripte, die ein Sammelskript per concurrently, npm-run-all, run-p oder run-s startet.
 * Unterstützt `npm:name`, `npm run name` sowie Platzhalter wie `npm:dev:*`.
 */
export function composedScripts(command: string, available: string[], self: string): string[] {
  if (!/\b(?:concurrently|npm-run-all|run-p|run-s)\b/.test(command)) return [];
  const references: string[] = [];
  for (const match of command.matchAll(/\bnpm:([\w:.*-]+)/g)) references.push(match[1]);
  for (const match of command.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g)) if (match[1] !== "run") references.push(match[1]);
  const runner = command.match(/\b(?:npm-run-all|run-p|run-s)\b((?:\s+[^\s&|;]+)+)/);
  if (runner) for (const argument of runner[1].trim().split(/\s+/)) if (!argument.startsWith("-")) references.push(argument.replace(/^["']|["']$/g, ""));
  const resolved: string[] = [];
  for (const reference of references) {
    const matcher = reference.includes("*") ? new RegExp(`^${reference.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`) : null;
    for (const name of available) {
      if (name === self || resolved.includes(name)) continue;
      if (matcher ? matcher.test(name) : name === reference) resolved.push(name);
    }
  }
  return resolved;
}

async function packageLaunchers(packagePath: string, projectId: string, projectPath: string): Promise<LauncherDefinition[]> {
  const packageJson = await readJson<PackageData>(packagePath);
  if (!packageJson) return [];
  const allScripts = packageJson.scripts ?? {};
  const scripts = Object.keys(allScripts)
    .filter((name) => packageScriptPattern.test(name) && /^[a-zA-Z0-9:_-]+$/.test(name) && !/^(pre|post)/i.test(name))
    .sort((a, b) => {
      const priority = ["dev", "start", "serve", "preview"];
      return (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)) || a.localeCompare(b);
    });
  const cwd = path.dirname(packagePath);
  const manager = await detectPackageManager(cwd, projectPath, packageJson.packageManager);
  const relativeCwd = toPosix(path.relative(projectPath, cwd)) || ".";
  const idFor = (script: string) => stableId(`${projectId}:${relativeCwd}:package:${script}`);
  const launchers: LauncherDefinition[] = scripts.map((script, index) => {
    const command = packageCommand(manager, script);
    return {
      id: idFor(script), projectId,
      name: relativeCwd === "." ? script : `${path.basename(cwd)} · ${script}`,
      kind: "package-script", relativeCwd, command: command.display, cwd,
      executable: command.executable, args: command.args, dynamicPort: false,
      preferred: script === "dev" || (index === 0 && !scripts.includes("dev")),
      port: portFromCommand(allScripts[script] ?? ""), parentId: null, parts: []
    };
  });
  // Sammelskripte zuerst, damit ein Teil dem bevorzugten Starter zugeordnet wird.
  for (const launcher of [...launchers].sort((a, b) => Number(b.preferred) - Number(a.preferred))) {
    const script = scripts[launchers.indexOf(launcher)];
    const parts = composedScripts(allScripts[script] ?? "", Object.keys(allScripts), script);
    if (!parts.length || launcher.parentId) continue;
    launcher.parts = parts.map((part) => {
      const child = scripts.includes(part) ? launchers[scripts.indexOf(part)] : null;
      if (child && !child.parentId && !child.parts.length) child.parentId = launcher.id;
      return { script: part, launcherId: child?.id ?? null, port: portFromCommand(allScripts[part] ?? "") };
    });
  }
  return launchers;
}

async function readDirectoryEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isProjectCandidate(entry: Dirent, ignored: Set<string>): boolean {
  if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
  if (entry.name.startsWith(".") || entry.name.startsWith("_") || entry.name.startsWith("$")) return false;
  return !ignored.has(entry.name.toLowerCase());
}

function isSourceFile(entry: Dirent): boolean {
  if (!entry.isFile()) return false;
  const lowerName = entry.name.toLowerCase();
  return projectManifestFiles.has(lowerName)
    || sourceCodeExtensions.has(path.extname(lowerName))
    || /\.config\.(?:js|mjs|cjs|ts)$/.test(lowerName);
}

// Der Ordner selbst trägt die Spuren eines Projekts: ein Manifest, ein Repository, Quellcode oder
// eine Startseite. Lose .html-Exporte oder ein Stylesheet reichen bewusst nicht.
function hasDirectProjectEvidence(entries: Dirent[]): boolean {
  return entries.some((entry) => {
    if (entry.isDirectory()) return entry.name.toLowerCase() === ".git";
    return isSourceFile(entry) || /^index\.(?:html?|php)$/i.test(entry.name);
  });
}

// Letzte Instanz für Ordner ohne eigene Spuren und ohne Unterprojekte: Liegt irgendwo darunter
// überhaupt Code? Sonst ist es eine Ablage (Bilder, PDFs, Dokumentation) und kein Projekt.
async function containsSourceCode(directory: string, entries: Dirent[], ignored: Set<string>, depth = 3): Promise<boolean> {
  if (entries.some(isSourceFile)) return true;
  if (depth <= 0) return false;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".") || ignored.has(entry.name.toLowerCase())) continue;
    const child = path.join(directory, entry.name);
    if (await containsSourceCode(child, await readDirectoryEntries(child), ignored, depth - 1)) return true;
  }
  return false;
}

// Dreistufige Einordnung je Ordner, damit auch F:\clients\<kunde>\website gefunden wird:
//   1. eigene Projektspuren  → Projekt (Unterordner gehören dazu, siehe Monorepo)
//   2. bündelt Projektordner → Kategorie, eine Ebene tiefer weitersuchen
//   3. Code irgendwo darunter → Projekt, sonst wird der Ordner ignoriert
async function discoverProjects(
  directory: string,
  entries: Dirent[],
  categorySegments: string[],
  remainingCategoryDepth: number,
  ignored: Set<string>
): Promise<DiscoveredProject[]> {
  const discovered: DiscoveredProject[] = [];
  for (const entry of entries) {
    if (!isProjectCandidate(entry, ignored) || structuralFolderNames.has(entry.name.toLowerCase())) continue;
    const absolutePath = path.join(directory, entry.name);
    const childEntries = await readDirectoryEntries(absolutePath);

    if (hasDirectProjectEvidence(childEntries)) {
      discovered.push({ absolutePath, categorySegments });
      continue;
    }

    if (remainingCategoryDepth > 0) {
      const nested = await discoverProjects(
        absolutePath,
        childEntries,
        [...categorySegments, entry.name],
        remainingCategoryDepth - 1,
        ignored
      );
      if (nested.length) {
        discovered.push(...nested);
        continue;
      }
    }

    if (await containsSourceCode(absolutePath, childEntries, ignored)) {
      discovered.push({ absolutePath, categorySegments });
    }
  }
  return discovered;
}

async function scanEvidence(projectPath: string, config: AppConfig, ownAppPath: string): Promise<ScanEvidence> {
  const evidence: ScanEvidence = {
    packagePaths: [], composerPaths: [], readmePaths: [], htmlEntries: [], phpEntries: [], starterPaths: [],
    thumbnailPath: null, gitRoot: null, names: new Set(), fileCount: 0, maxModifiedMs: 0, truncated: false
  };
  const ignored = new Set(config.ignore.map((name) => name.toLowerCase()));
  const queue: Array<{ directory: string; depth: number }> = [{ directory: projectPath, depth: 0 }];

  while (queue.length && evidence.fileCount < config.maxEntriesPerProject) {
    const current = queue.shift()!;
    let entries;
    try { entries = await readdir(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const absolutePath = path.join(current.directory, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (path.resolve(absolutePath) === path.resolve(ownAppPath) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (lowerName === ".git" && !evidence.gitRoot) evidence.gitRoot = current.directory;
        if (current.depth < config.maxDepth && !ignored.has(lowerName) && !entry.name.startsWith(".")) {
          queue.push({ directory: absolutePath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      evidence.fileCount++;
      evidence.names.add(lowerName);
      if (lowerName === "package.json") evidence.packagePaths.push(absolutePath);
      if (lowerName === "composer.json") evidence.composerPaths.push(absolutePath);
      if (/^readme(?:\.[a-z0-9_-]+)?$/i.test(entry.name) && current.depth <= 2) evidence.readmePaths.push(absolutePath);
      if ((lowerName.endsWith(".html") || lowerName.endsWith(".htm")) && current.depth <= 2) evidence.htmlEntries.push(absolutePath);
      if (lowerName === "index.php") evidence.phpEntries.push(absolutePath);
      const starterKind = starterFiles.get(lowerName);
      if (starterKind && platformStarterKinds.has(starterKind)) evidence.starterPaths.push({ path: absolutePath, kind: starterKind });
      if (!evidence.thumbnailPath && thumbnailNames.has(lowerName) && current.depth <= 1) evidence.thumbnailPath = absolutePath;
      if (evidence.fileCount >= config.maxEntriesPerProject) { evidence.truncated = true; break; }
    }
  }
  try { evidence.maxModifiedMs = (await stat(projectPath)).mtimeMs; } catch { evidence.maxModifiedMs = Date.now(); }
  return evidence;
}

function addPackageTechnologies(technologies: Set<string>, packageJson: PackageData, names: Set<string>): void {
  technologies.add("Node.js");
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const has = (name: string) => Object.hasOwn(dependencies, name);
  if (has("next")) technologies.add("Next.js");
  else if (has("react")) technologies.add("React");
  if (has("vue")) technologies.add("Vue");
  if (has("svelte") || has("@sveltejs/kit")) technologies.add("Svelte");
  if (has("astro")) technologies.add("Astro");
  if (has("nuxt")) technologies.add("Nuxt");
  if (has("vite") || [...names].some((name) => name.startsWith("vite.config."))) technologies.add("Vite");
  if (has("electron")) technologies.add("Electron");
  if (has("tailwindcss")) technologies.add("Tailwind");
}

function addComposerTechnologies(technologies: Set<string>, composer: ComposerData): void {
  technologies.add("PHP");
  technologies.add("Composer");
  const dependencies = { ...composer.require, ...composer["require-dev"] };
  if (Object.keys(dependencies).some((name) => name.startsWith("laravel/"))) technologies.add("Laravel");
  if (Object.keys(dependencies).some((name) => name.startsWith("symfony/"))) technologies.add("Symfony");
}

function autoDescription(technologies: string[], fileCount: number, truncated: boolean): string {
  const primary = technologies.includes("WordPress") ? "WordPress-Projekt"
    : technologies.includes("Laravel") ? "Laravel-Anwendung"
    : technologies.includes("Next.js") ? "Next.js-Anwendung"
    : technologies.includes("PHP") ? "PHP-Projekt"
    : technologies.includes("HTML") ? "Statische Website"
    : technologies.includes("Node.js") ? "Node.js-Projekt"
    : "Lokaler Projektordner";
  const extra = technologies.filter((technology) => !primary.toLowerCase().includes(technology.toLowerCase())).slice(0, 2);
  return `${primary}${extra.length ? ` mit ${extra.join(" und ")}` : ""} · ${fileCount}${truncated ? "+" : ""} Dateien erkannt`;
}

function gitRemoteWebUrl(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;
  const ssh = value.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/\.git$/, "")}`;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\.git$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function readGitInfo(repositoryPath: string | null, projectPath: string): Promise<GitInfo | null> {
  if (!repositoryPath) return null;
  try {
    const options = { timeout: 5000, windowsHide: true, maxBuffer: 2_000_000 };
    const [statusResult, logResult, remoteResult, fetchHeadResult] = await Promise.all([
      execFileAsync("git", ["-C", repositoryPath, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], options),
      execFileAsync("git", ["-C", repositoryPath, "log", "-1", "--format=%h%x1f%s%x1f%an%x1f%aI"], options).catch(() => ({ stdout: "", stderr: "" })),
      execFileAsync("git", ["-C", repositoryPath, "remote", "get-url", "origin"], options).catch(() => ({ stdout: "", stderr: "" })),
      execFileAsync("git", ["-C", repositoryPath, "rev-parse", "--git-path", "FETCH_HEAD"], options).catch(() => ({ stdout: "", stderr: "" }))
    ]);
    // Der letzte Fetch-Zeitpunkt sagt der Oberfläche, wie frisch "voraus/zurück" ist.
    const fetchHeadPath = fetchHeadResult.stdout.trim();
    const lastFetchAt = fetchHeadPath ? await stat(path.resolve(repositoryPath, fetchHeadPath)).then(info => info.mtime.toISOString(), () => null) : null;
    const records = statusResult.stdout.split("\0").filter(Boolean);
    const branch = records.find((line) => line.startsWith("# branch.head "))?.slice(14).trim() || null;
    const upstream = records.find((line) => line.startsWith("# branch.upstream "))?.slice(18).trim() || null;
    const ab = records.find((line) => line.startsWith("# branch.ab "))?.match(/\+(\d+)\s+-(\d+)/);
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    const files: GitInfo["files"] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.startsWith("? ")) {
        untracked += 1;
        files.push({ path: record.slice(2), originalPath: null, indexStatus: "?", worktreeStatus: "?" });
        continue;
      }
      if (!/^[12u] /.test(record)) continue;
      const parts = record.split(" ");
      const state = parts[1] || "..";
      const pathIndex = record.startsWith("1 ") ? 8 : record.startsWith("2 ") ? 9 : 10;
      const filePath = parts.slice(pathIndex).join(" ");
      const originalPath = record.startsWith("2 ") ? records[++index] || null : null;
      if (state[0] && state[0] !== ".") staged += 1;
      if (state[1] && state[1] !== ".") unstaged += 1;
      files.push({ path: filePath, originalPath, indexStatus: state[0] || ".", worktreeStatus: state[1] || "." });
    }
    const commitParts = logResult.stdout.trim().split("\x1f");
    const lastCommit = commitParts.length === 4 ? {
      hash: commitParts[0], subject: commitParts[1], author: commitParts[2], date: commitParts[3]
    } : null;
    const remoteNames = (await execFileAsync("git", ["-C", repositoryPath, "remote"], options)).stdout.trim().split(/\r?\n/).filter(Boolean);
    const remoteName = upstream ? remoteNames.filter(name => upstream.startsWith(name + "/")).sort((a, b) => b.length - a.length)[0] || null
      : remoteNames.includes("origin") ? "origin" : remoteNames[0] || null;
    const remoteUrl = remoteName && remoteName !== "origin" ? (await execFileAsync("git", ["-C", repositoryPath, "remote", "get-url", remoteName], options)).stdout : remoteResult.stdout;
    return {
      branch: branch === "(detached)" ? null : branch,
      dirty: staged + unstaged + untracked > 0,
      ahead: Number(ab?.[1] || 0),
      behind: Number(ab?.[2] || 0),
      staged,
      unstaged,
      untracked,
      changedFiles: files.length,
      remoteName,
      remoteUrl: gitRemoteWebUrl(remoteUrl),
      upstream,
      lastFetchAt,
      repositoryRoot: toPosix(path.relative(projectPath, repositoryPath)) || ".",
      files: files.slice(0, 500),
      filesTruncated: files.length > 500,
      lastCommit
    };
  } catch {
    const head = await readText(path.join(repositoryPath, ".git", "HEAD"), 1024);
    return head ? {
      branch: head.match(/^ref:\s+refs\/heads\/(.+)$/)?.[1]?.trim() ?? null,
      dirty: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, changedFiles: 0,
      remoteName: null, remoteUrl: null, upstream: null, lastFetchAt: null, repositoryRoot: toPosix(path.relative(projectPath, repositoryPath)) || ".",
      files: [], filesTruncated: false, lastCommit: null
    } : null;
  }
}

// Ohne passenden Virtual Host reicht der Pfad unterhalb des Apache-DocumentRoot: Ein Projekt in
// F:\fun\dein-eis-guide ist bei DocumentRoot F:\ direkt unter http://localhost/fun/dein-eis-guide/ erreichbar.
function urlForProject(projectPath: string, servableRoot: string | null, metadataUrl: string | undefined, webInfo: WorkspaceWebInfo): string | null {
  if (metadataUrl && /^https?:\/\//i.test(metadataUrl)) return metadataUrl;
  // Nur Virtual Hosts, deren DocumentRoot tatsächlich etwas ausliefert – sonst führt der grüne
  // Button auf ein Verzeichnis-Listing oder eine kaputte Rohfassung.
  const host = webInfo.hosts.find((candidate) => candidate.servable && pathStartsWith(candidate.documentRoot, projectPath));
  if (host) return host.url;
  if (!servableRoot || !webInfo.documentRoot || !pathStartsWith(servableRoot, webInfo.documentRoot)) return null;
  const relative = path.relative(webInfo.documentRoot, servableRoot).split(path.sep).map(encodeURIComponent).join("/");
  return relative ? `http://localhost/${relative}/` : "http://localhost/";
}

function sortByDepth(projectPath: string, paths: string[]): string[] {
  return [...paths].sort((a, b) => depthFrom(projectPath, a) - depthFrom(projectPath, b) || a.localeCompare(b));
}

async function scanProject(discovered: DiscoveredProject, config: AppConfig, ownAppPath: string, webInfo: WorkspaceWebInfo): Promise<ProjectDefinition> {
  const projectPath = discovered.absolutePath;
  const relativePath = toPosix(path.relative(config.scanRoot, projectPath));
  const projectId = stableId(relativePath);
  const isOwnApp = path.relative(projectPath, ownAppPath) === "";
  const evidence = await scanEvidence(projectPath, config, ownAppPath);
  evidence.packagePaths = sortByDepth(projectPath, evidence.packagePaths);
  evidence.composerPaths = sortByDepth(projectPath, evidence.composerPaths);
  evidence.readmePaths = sortByDepth(projectPath, evidence.readmePaths);
  evidence.htmlEntries = sortByDepth(projectPath, evidence.htmlEntries);
  evidence.htmlEntries.sort((a, b) => Number(!/^index\.html?$/i.test(path.basename(a))) - Number(!/^index\.html?$/i.test(path.basename(b))) || depthFrom(projectPath, a) - depthFrom(projectPath, b));
  evidence.phpEntries = sortByDepth(projectPath, evidence.phpEntries);

  const [metadata, packages, composers, readme, html] = await Promise.all([
    readProjectIni(projectPath),
    Promise.all(evidence.packagePaths.map((file) => readJson<PackageData>(file))),
    Promise.all(evidence.composerPaths.map((file) => readJson<ComposerData>(file))),
    evidence.readmePaths[0] ? readText(evidence.readmePaths[0]) : "",
    (evidence.htmlEntries[0] ?? evidence.phpEntries[0]) ? readText(evidence.htmlEntries[0] ?? evidence.phpEntries[0]) : ""
  ]);
  const validPackages = packages.filter((value): value is PackageData => Boolean(value));
  const validComposers = composers.filter((value): value is ComposerData => Boolean(value));
  const readmeMeta = parseReadme(readme);
  const htmlMeta = parseHtml(html);
  const primaryPackage = validPackages[0];
  const primaryComposer = validComposers[0];

  const technologies = new Set<string>();
  for (const packageJson of validPackages) addPackageTechnologies(technologies, packageJson, evidence.names);
  for (const composer of validComposers) addComposerTechnologies(technologies, composer);
  if (evidence.phpEntries.length || [...evidence.names].some((name) => name.endsWith(".php"))) technologies.add("PHP");
  if (evidence.htmlEntries.length || [...evidence.names].some((name) => name.endsWith(".html") || name.endsWith(".htm"))) technologies.add("HTML");
  if (evidence.names.has("wp-config.php") || evidence.names.has("wp-load.php")) technologies.add("WordPress");
  if (evidence.names.has("artisan")) { technologies.add("Laravel"); technologies.add("PHP"); }
  if (evidence.names.has("symfony.lock")) { technologies.add("Symfony"); technologies.add("PHP"); }
  if (evidence.names.has("dockerfile") || evidence.names.has("docker-compose.yml") || evidence.names.has("compose.yml")) technologies.add("Docker");
  if (evidence.names.has("pyproject.toml") || evidence.names.has("requirements.txt") || [...evidence.names].some((name) => name.endsWith(".py"))) technologies.add("Python");
  if (evidence.names.has("manifest.json") && evidence.names.has("background.js")) technologies.add("Browser Extension");
  if (evidence.names.has("interface.toc") || [...evidence.names].some((name) => name.endsWith(".toc"))) technologies.add("WoW Addon");

  const technologyOrder = ["Laravel", "WordPress", "Symfony", "Next.js", "React", "Vue", "Svelte", "Astro", "Nuxt", "PHP", "HTML", "Node.js", "Python", "Docker", "Composer", "Vite", "Tailwind", "Electron", "Browser Extension", "WoW Addon"];
  const sortedTechnologies = [...technologies].sort((a, b) => technologyOrder.indexOf(a) - technologyOrder.indexOf(b));
  const packageName = primaryPackage?.displayName || (primaryPackage?.name ? humanize(primaryPackage.name) : undefined);
  const composerName = primaryComposer?.name ? humanize(primaryComposer.name.split("/").pop() ?? primaryComposer.name) : undefined;
  // "website" beschreibt kein Projekt – bei clients/harriet-budjarek/website zählt der Kundenordner.
  const rawFolderName = path.basename(projectPath);
  const namingSegment = genericFolderNames.has(rawFolderName.toLocaleLowerCase("de")) && discovered.categorySegments.length
    ? discovered.categorySegments[discovered.categorySegments.length - 1]
    : rawFolderName;
  const folderName = humanize(namingSegment);
  const inferredName = metadata.title || primaryPackage?.displayName || chooseInferredName(folderName, [
    depthFrom(projectPath, evidence.readmePaths[0] ?? projectPath) <= 1 ? readmeMeta.name : undefined,
    htmlMeta.name,
    packageName,
    composerName
  ], namingSegment);
  const writtenDescription = metadata.description || primaryPackage?.description || primaryComposer?.description || htmlMeta.description || readmeMeta.description;
  const inferredDescription = writtenDescription || autoDescription(sortedTechnologies, evidence.fileCount, evidence.truncated);

  const launchers = (await Promise.all(evidence.packagePaths.map((packagePath) => packageLaunchers(packagePath, projectId, projectPath)))).flat();
  for (const starter of evidence.starterPaths) {
    const cwd = path.dirname(starter.path);
    const relativeCwd = toPosix(path.relative(projectPath, cwd)) || ".";
    const command = fileCommand(starter.kind, starter.path);
    launchers.push({
      id: stableId(`${projectId}:${relativeCwd}:${path.basename(starter.path).toLowerCase()}`), projectId,
      name: relativeCwd === "." ? path.basename(starter.path) : `${path.basename(cwd)} · ${path.basename(starter.path)}`,
      kind: starter.kind, relativeCwd, command: command.display, cwd, executable: command.executable,
      args: command.args, dynamicPort: false, preferred: launchers.length === 0, port: null, parentId: null, parts: []
    });
  }

  const publicPhpEntry = evidence.phpEntries.find((entry) => path.basename(path.dirname(entry)).toLowerCase() === "public");
  const preferredPhpEntry = publicPhpEntry ?? evidence.phpEntries[0];
  const preferredHtmlEntry = evidence.htmlEntries.find((entry) => depthFrom(projectPath, entry) <= 1) ?? evidence.htmlEntries[0];
  const webRoot = preferredPhpEntry ? path.dirname(preferredPhpEntry) : preferredHtmlEntry ? path.dirname(preferredHtmlEntry) : null;
  // Für die Apache-Adresse zählt der Einstieg, den ein Besucher erwartet: public/ (Laravel) zuerst,
  // sonst der flachste index – ein tiefes Unterwerkzeug wie public/admin/index.php darf die
  // Startseite nicht verdrängen, auch wenn PHP sonst Vorrang vor HTML hat.
  const indexEntries = [...evidence.phpEntries, ...evidence.htmlEntries]
    .filter((entry) => /^index\.(?:php|html?)$/i.test(path.basename(entry)))
    .sort((a, b) => depthFrom(projectPath, a) - depthFrom(projectPath, b)
      || Number(path.extname(a).toLowerCase() !== ".php") - Number(path.extname(b).toLowerCase() !== ".php"));
  const apacheRoot = publicPhpEntry ? path.dirname(publicPhpEntry) : indexEntries[0] ? path.dirname(indexEntries[0]) : webRoot;
  // Apache liefert nur aus, was ohne Buildschritt im Ordner liegt: PHP immer, statisches HTML nur
  // ohne Node-Manifest – bei Vite oder Next ist die rohe index.html im Browser unbrauchbar.
  const apacheServableRoot = apacheRoot && (preferredPhpEntry || !validPackages.length) ? apacheRoot : null;
  const hasPreferredLauncher = launchers.some((launcher) => launcher.preferred);
  if (preferredPhpEntry && webRoot) {
    launchers.push({
      id: stableId(`${projectId}:php-preview:${webRoot}`), projectId, name: "PHP-Vorschau", kind: "php-server",
      relativeCwd: toPosix(path.relative(projectPath, webRoot)) || ".", command: "php -S 127.0.0.1:{port}",
      cwd: webRoot, executable: isWindows ? "php.exe" : "php", args: ["-S", "127.0.0.1:{port}", "-t", webRoot], dynamicPort: true,
      preferred: !hasPreferredLauncher, port: null, parentId: null, parts: []
    });
  } else if (preferredHtmlEntry && webRoot && !validPackages.length) {
    const staticServer = path.join(ownAppPath, "runtime", "static-server.mjs");
    const entryFile = path.basename(preferredHtmlEntry);
    launchers.push({
      id: stableId(`${projectId}:static-preview:${webRoot}`), projectId, name: "HTML-Vorschau", kind: "static-server",
      relativeCwd: toPosix(path.relative(projectPath, webRoot)) || ".", command: "DevHub Static Server · {port}",
      cwd: webRoot, executable: process.execPath, args: [staticServer, "--root", webRoot, "--port", "{port}", "--entry", entryFile], dynamicPort: true,
      preferred: !hasPreferredLauncher, port: null, parentId: null, parts: []
    });
  }

  const uniqueLaunchers = Array.from(new Map(launchers.map((launcher) => [launcher.id, launcher])).values())
    .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name, "de"));
  return {
    id: projectId,
    name: truncate(inferredName, 80),
    description: truncate(inferredDescription),
    relativePath,
    absolutePath: projectPath,
    category: discovered.categorySegments.length ? discovered.categorySegments.map(humanize).join(" / ") : null,
    categoryPath: discovered.categorySegments.length ? discovered.categorySegments.join("/") : null,
    thumbnailPath: evidence.thumbnailPath,
    modifiedAt: new Date(evidence.maxModifiedMs || Date.now()).toISOString(),
    technologies: sortedTechnologies.length ? sortedTechnologies : ["Projektordner"],
    kind: sortedTechnologies[0] ?? "Projektordner",
    // DevHub selbst ist ein Node-Server: Die Domain des Stacks würde nur seine rohen Dateien zeigen.
    defaultUrl: isOwnApp ? null : urlForProject(projectPath, apacheServableRoot, metadata.url, webInfo),
    webRoot,
    git: await readGitInfo(evidence.gitRoot, projectPath),
    fileCount: evidence.fileCount,
    launchers: isOwnApp ? [] : uniqueLaunchers,
    isSelf: isOwnApp,
    descriptionAuto: !writtenDescription
  };
}

export async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function scanWorkspace(config: AppConfig, ownAppPath: string): Promise<ProjectDefinition[]> {
  const ignored = new Set(config.ignore.map((name) => name.toLowerCase()));
  const rootEntries = await readdir(config.scanRoot, { withFileTypes: true });
  const discovered = await discoverProjects(config.scanRoot, rootEntries, [], config.categoryDepth, ignored);
  const webInfo = await readWorkspaceWebInfo(config);
  const projects = await mapLimit(discovered, 6, (entry) => scanProject(entry, config, ownAppPath, webInfo));
  return projects.sort((a, b) => a.name.localeCompare(b.name, "de"));
}
