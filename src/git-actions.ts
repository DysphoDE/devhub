import { execFile } from "node:child_process";
import path from "node:path";
import { access, appendFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { moveToTrash, trashSupport } from "./platform.js";
import type { ProjectDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

export const advancedGitActions = ["suggest-files", "commit-files", "amend-files", "ignore", "amend", "rename-branch", "delete-branch", "checkout-remote", "merge", "rebase", "continue", "abort", "stash-save", "stash-apply", "stash-pop", "stash-drop", "create-tag", "delete-tag", "push-tag", "remote-add", "remote-remove", "remote-set-url", "identity", "revert", "cherry-pick", "stage-hunk", "unstage-hunk", "resolve-file"] as const;
export type GitAction = typeof advancedGitActions[number] | "refresh" | "stage" | "unstage" | "stage-files" | "unstage-files" | "discard-files" | "stage-all" | "unstage-all" | "commit" | "fetch" | "pull" | "push" | "checkout" | "create-branch" | "undo-commit";

export interface GitActionPayload {
  file?: unknown;
  files?: unknown;
  message?: unknown;
  branch?: unknown;
  name?: unknown;
  description?: unknown;
  email?: unknown;
  remote?: unknown;
  url?: unknown;
  hash?: unknown;
  stash?: unknown;
  hunk?: unknown;
  fingerprint?: unknown;
  folder?: unknown;
  untrack?: unknown;
  method?: unknown;
  side?: unknown;
  repo?: unknown;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote?: boolean;
  upstream: string | null;
  lastCommitDate: string | null;
}

export interface GitDiffSection {
  scope: "staged" | "working";
  label: string;
  patch: string;
  truncated: boolean;
  fingerprint?: string;
}

export interface GitHistoryCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
  parents: string[];
}

export interface GitHistoryPage {
  commits: GitHistoryCommit[];
  hasMore: boolean;
}

export interface GitCommitDetail extends GitHistoryCommit {
  body: string;
  files: Array<{ status: string; path: string; originalPath: string | null }>;
  patch: string;
  truncated: boolean;
}

function repositoryPath(project: ProjectDefinition): string {
  if (!project.git) throw new Error("Für dieses Projekt wurde kein Git-Repository erkannt.");
  const repository = path.resolve(project.absolutePath, project.git.repositoryRoot);
  const relative = path.relative(project.absolutePath, repository);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Das Git-Repository liegt außerhalb des Projektordners.");
  return repository;
}

function knownFile(project: ProjectDefinition, value: unknown): string {
  if (typeof value !== "string" || !project.git?.files.some((file) => file.path === value)) {
    throw new Error("Die Datei gehört nicht mehr zum aktuellen Git-Status. Bitte aktualisieren.");
  }
  return value;
}

function knownFiles(project: ProjectDefinition, value: unknown): GitInfoFile[] {
  if (!Array.isArray(value) || !value.length || value.length > 500) {
    throw new Error("Wähle mindestens eine und höchstens 500 Dateien aus.");
  }
  const unique = [...new Set(value.map((file) => knownFile(project, file)))];
  return unique.map((file) => project.git!.files.find((candidate) => candidate.path === file)!);
}

type GitInfoFile = NonNullable<ProjectDefinition["git"]>["files"][number];

function filePaths(files: GitInfoFile[], includeOriginal = false): string[] {
  return [...new Set(files.flatMap((file) => includeOriginal && file.originalPath ? [file.path, file.originalPath] : [file.path]))];
}

// git add fails for paths that are neither on disk nor in the index (e.g. an already staged deletion).
async function addPaths(repository: string, paths: string[]): Promise<void> {
  const indexed = new Set((await git(repository, ["ls-files", "-z", "--", ...paths])).split("\0"));
  const present = await Promise.all(paths.map((file) => lstat(path.join(repository, file)).then(() => true, () => false)));
  const stageable = paths.filter((file, index) => present[index] || indexed.has(file));
  if (stageable.length) await git(repository, ["add", "-A", "--", ...stageable]);
}

function friendlyGitError(error: unknown): Error {
  const raw = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : error instanceof Error ? error.message : String(error);
  const text = raw.trim();
  if (/nothing to commit|no changes added to commit/i.test(text)) return new Error("Es sind keine vorgemerkten Änderungen für einen Commit vorhanden.");
  if (/please tell me who you are|unable to auto-detect email/i.test(text)) return new Error("Git-Benutzername und E-Mail fehlen. Konfiguriere sie zuerst im Terminal.");
  if (/authentication failed|could not read username|terminal prompts disabled/i.test(text)) return new Error("Remote-Anmeldung fehlgeschlagen. Melde dich einmal im Terminal beim Remote an.");
  if (/non-fast-forward|fetch first|rejected/i.test(text)) return new Error("Der Push wurde abgelehnt. Rufe den Remote-Stand ab und integriere die Änderungen per Pull, Merge oder Rebase.");
  if (/would be overwritten by merge|please commit your changes or stash them/i.test(text)) return new Error("Lokale Änderungen verhindern den Pull. Committe oder sichere sie zuerst.");
  if (/not possible to fast-forward|divergent branches/i.test(text)) return new Error("Der Branch kann nicht automatisch vorgespult werden. Führe unter Branches einen Merge oder Rebase mit dem Upstream durch.");
  if (/would be overwritten by (checkout|switch)/i.test(text)) return new Error("Lokale Änderungen stehen dem Branch-Wechsel im Weg. Committe oder verwirf sie zuerst.");
  if (/branch named '.+' already exists/i.test(text)) return new Error("Ein Branch mit diesem Namen existiert bereits.");
  return new Error(text.split(/\r?\n/).filter(Boolean).slice(-2).join(" ") || "Git-Aktion fehlgeschlagen.");
}

async function git(repository: string, args: string[], timeout = 15_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...(["commit", "add", "restore", "reset", "rm", "clean", "diff", "show", "diff-tree", "ls-files"].includes(args[0]) ? ["--literal-pathspecs"] : []), "-C", repository, ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 1_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" }
    });
    return stdout.trim();
  } catch (error) {
    throw friendlyGitError(error);
  }
}

async function gitDiff(repository: string, args: string[], allowDifferenceExit = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...(["commit", "add", "restore", "reset", "rm", "clean", "diff", "show", "diff-tree", "ls-files"].includes(args[0]) ? ["--literal-pathspecs"] : []), "-C", repository, ...args], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 5_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" }
    });
    return stdout;
  } catch (error) {
    if (allowDifferenceExit && error && typeof error === "object" && "code" in error && error.code === 1 && "stdout" in error) {
      return String(error.stdout);
    }
    throw friendlyGitError(error);
  }
}

function requestedBranchName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("Ein Branch-Name ist erforderlich.");
  if (name.length > 100) throw new Error("Der Branch-Name darf höchstens 100 Zeichen lang sein.");
  if (/^[-/.]|[/.]$|\.lock$|\.\.|@\{|\/\/|[\s~^:?*\[\\\x00-\x1f\x7f]/.test(name)) {
    throw new Error("Der Branch-Name enthält ungültige Zeichen.");
  }
  return name;
}

export async function readGitBranches(project: ProjectDefinition): Promise<GitBranchInfo[]> {
  const repository = repositoryPath(project);
  const output = await git(repository, [
    "for-each-ref", "refs/heads", "refs/remotes", "--sort=-committerdate",
    "--format=%(refname)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:iso-strict)"
  ]);
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [name, head, upstream, date] = line.split("\x1f");
    return name && !name.endsWith("/HEAD") ? [{ name: name.replace(/^refs\/(heads|remotes)\//, ""), remote: name.startsWith("refs/remotes/"), current: head === "*", upstream: upstream || null, lastCommitDate: date || null }] : [];
  });
}

// Untracked Dateien landen im Papierkorb des Systems statt endgültig gelöscht zu werden (git clean).
// Nur wo es keinen Papierkorb gibt (Linux ohne gio), wird endgültig gelöscht – die UI sagt das vorher an.
async function moveUntrackedToRecycleBin(repository: string, relativePaths: string[]): Promise<string> {
  if (!relativePaths.length) return "";
  const absolutePaths = relativePaths.map((relative) => {
    const resolved = path.resolve(repository, relative);
    if (resolved !== repository && !resolved.startsWith(repository + path.sep)) {
      throw new Error("Eine zu verwerfende Datei liegt außerhalb des Repositorys.");
    }
    return resolved;
  });
  const trash = await trashSupport();
  if (!trash.available) {
    await git(repository, ["clean", "-f", "-d", "--", ...relativePaths]);
    return " Neue Dateien wurden endgültig gelöscht.";
  }
  try {
    await moveToTrash(absolutePaths);
  } catch (error) {
    throw new Error(`Neue Dateien konnten nicht in den Papierkorb verschoben werden. ${error instanceof Error ? error.message : ""}`.trim());
  }
  return " Neue Dateien wurden in den Papierkorb verschoben.";
}

function limitedPatch(patch: string): { patch: string; truncated: boolean } {
  const limit = 750_000;
  return patch.length > limit ? { patch: patch.slice(0, limit), truncated: true } : { patch, truncated: false };
}

export async function readGitDiff(project: ProjectDefinition, requestedFile: unknown, combined = false): Promise<GitDiffSection[]> {
  const repository = repositoryPath(project);
  const file = knownFile(project, requestedFile);
  const change = project.git!.files.find((candidate) => candidate.path === file)!;
  const sections: GitDiffSection[] = [];
  const common = ["--no-ext-diff", "--no-color", "--unified=3"];
  const paths = filePaths([change], true);

  if (combined) {
    const newFile = change.worktreeStatus === "?" || change.indexStatus === "A" || !project.git!.lastCommit;
    const patch = newFile
      ? await gitDiff(repository, ["diff", "--no-index", ...common, "--", "/dev/null", file], true)
      : await gitDiff(repository, ["diff", ...common, "HEAD", "--", ...paths]);
    return [{ scope: "working", label: "Änderungen für den Commit", ...limitedPatch(patch) }];
  }
  if (change.indexStatus !== "." && change.indexStatus !== "?") {
    const result = limitedPatch(await gitDiff(repository, ["diff", "--cached", ...common, "--", ...paths]));
    sections.push({ scope: "staged", label: "Vorgemerkte Änderungen", ...result });
  }
  if (change.worktreeStatus !== "." && change.worktreeStatus !== "?") {
    const result = limitedPatch(await gitDiff(repository, ["diff", ...common, "--", ...paths]));
    sections.push({ scope: "working", label: "Lokale Änderungen", ...result });
  }
  if (change.worktreeStatus === "?") {
    const result = limitedPatch(await gitDiff(repository, ["diff", "--no-index", ...common, "--", "/dev/null", file], true));
    sections.push({ scope: "working", label: "Neue Datei", ...result });
  }
  return sections.map(section => ({ ...section, fingerprint: createHash("sha256").update(section.patch).digest("hex") }));
}

function parseHistoryCommit(record: string): GitHistoryCommit | null {
  const fields = record.replace(/^\s+|\s+$/g, "").split("\x1f");
  if (fields.length < 6 || !/^[0-9a-f]{40}$/i.test(fields[0])) return null;
  return {
    hash: fields[0], shortHash: fields[1], author: fields[2], date: fields[3], subject: fields[4],
    parents: fields[5].trim() ? fields[5].trim().split(/\s+/) : []
  };
}

export async function readGitHistory(project: ProjectDefinition, requestedOffset = 0, requestedLimit = 60, query = "", allBranches = false): Promise<GitHistoryPage> {
  const repository = repositoryPath(project);
  if (!project.git?.lastCommit) return { commits: [], hasMore: false };
  const offset = Math.max(0, Math.floor(Number(requestedOffset) || 0));
  const limit = Math.min(100, Math.max(20, Math.floor(Number(requestedLimit) || 60)));
  const output = await git(repository, [
    "log", ...(allBranches ? ["--branches", "--remotes", "--tags", "HEAD"] : []), ...(query ? ["--regexp-ignore-case", "--fixed-strings", `--grep=${textValue(query)}`] : []), `--skip=${offset}`, `--max-count=${limit + 1}`,
    "--date=iso-strict", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%P%x1e", "--"
  ], 30_000);
  const commits = output.split("\x1e").map(parseHistoryCommit).filter((commit): commit is GitHistoryCommit => Boolean(commit));
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

export async function readGitCommit(project: ProjectDefinition, requestedHash: unknown, requestedFile?: unknown): Promise<GitCommitDetail> {
  const repository = repositoryPath(project);
  const hash = typeof requestedHash === "string" && /^[0-9a-f]{7,40}$/i.test(requestedHash) ? requestedHash : "";
  if (!hash) throw new Error("Der Commit-Hash ist ungültig.");
  const verifiedHash = await git(repository, ["rev-parse", "--verify", `${hash}^{commit}`]);
  const metadata = await git(repository, ["show", "-s", "--date=iso-strict", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%P", verifiedHash]);
  const commit = parseHistoryCommit(metadata);
  if (!commit) throw new Error("Commit-Metadaten konnten nicht gelesen werden.");
  const fileOutput = await gitDiff(repository, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-z", "-r", "-M", ...(commit.parents.length ? [commit.parents[0], verifiedHash] : [verifiedHash])]);
  const entries = fileOutput.split("\0");
  const files: GitCommitDetail["files"] = [];
  for (let i = 0; i < entries.length && entries[i];) {
    const status = entries[i++];
    const firstPath = entries[i++];
    const renamed = /^[RC]/.test(status);
    files.push({ status: status[0], path: renamed ? entries[i++] : firstPath, originalPath: renamed ? firstPath : null });
  }
  const selectedFile = requestedFile ? files.find(file => file.path === requestedFile) : null;
  if (requestedFile && !selectedFile) throw new Error("Diese Datei gehört nicht zum gewählten Commit.");
  const result = limitedPatch(await gitDiff(repository, ["show", "--first-parent", "--format=", "--no-ext-diff", "--no-color", "--unified=3", verifiedHash, "--", ...(selectedFile ? [selectedFile.path, ...(selectedFile.originalPath ? [selectedFile.originalPath] : [])] : [])]));
  const body = await git(repository, ["show", "-s", "--format=%b", verifiedHash]);
  return { ...commit, body, files, ...result };
}

function commitTarget(files: GitInfoFile[]): string {
  const paths = files.map((file) => file.path.toLocaleLowerCase("en"));
  const every = (pattern: RegExp) => paths.every((file) => pattern.test(file));
  const some = (pattern: RegExp) => paths.some((file) => pattern.test(file));
  if (every(/(^|\/)(readme(?:\.|$)|docs?\/)|\.(md|mdx|rst)$/)) return "documentation";
  if (every(/(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^.]+$/)) return "tests";
  if (every(/(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|composer(?:\.lock|\.json)|requirements[^/]*\.txt|pyproject\.toml)$/)) return "dependencies";
  if (some(/(^|\/)git(?:[-_/]|\.)|git-actions|\.gitignore$/)) return "Git workflow";
  if (every(/\.(css|scss|sass|less)$/)) return "styles";
  if (every(/(^|\/)(public|client|frontend|ui)\//)) return "application interface";
  if (every(/(^|\/)(src|server|backend)\//)) return "application logic";
  if (every(/(^|\/)(\.github|config|configs)\/|(^|\/)[^.]*config\.[^/]+$/)) return "project configuration";
  if (files.length === 2) return files.map((file) => path.posix.basename(file.path)).join(" and ");
  return `${files.length} files`;
}

export async function suggestGitCommitMessage(project: ProjectDefinition, requestedFiles?: unknown): Promise<string> {
  const repository = repositoryPath(project);
  const output = await git(repository, ["diff", "--cached", "--name-status", "-M"]);
  const files: GitInfoFile[] = requestedFiles ? knownFiles(project, requestedFiles) : output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [rawStatus = "M", firstPath = "", secondPath] = line.split("\t");
    return {
      path: secondPath || firstPath,
      originalPath: secondPath ? firstPath : null,
      indexStatus: rawStatus[0] || "M",
      worktreeStatus: "."
    };
  });
  if (!files.length) throw new Error("Merke zuerst mindestens eine Datei vor.");
  if (files.length === 1) {
    const file = files[0];
    if (file.indexStatus === "R" && file.originalPath) {
      return `Rename ${path.posix.basename(file.originalPath)} to ${path.posix.basename(file.path)}`.slice(0, 200);
    }
    const verb = file.indexStatus === "A" ? "Add" : file.indexStatus === "D" ? "Remove" : "Update";
    return `${verb} ${commitTarget(files) === "documentation" ? "documentation" : path.posix.basename(file.path)}`;
  }
  const statuses = new Set(files.map((file) => file.indexStatus));
  const verb = statuses.size === 1 && statuses.has("A") ? "Add" : statuses.size === 1 && statuses.has("D") ? "Remove" : "Update";
  return `${verb} ${commitTarget(files)}`.slice(0, 200);
}

export async function runGitAction(project: ProjectDefinition, action: GitAction, payload: GitActionPayload): Promise<string> {
  const repository = repositoryPath(project);
  const info = project.git!;

  if ((advancedGitActions as readonly string[]).includes(action)) return runAdvancedGitAction(project, action, payload);

  if (action === "refresh") return "Git-Status aktualisiert.";
  if (action === "stage") {
    const file = knownFiles(project, [payload.file]);
    await addPaths(repository, filePaths(file, true));
    return "Datei vorgemerkt.";
  }
  if (action === "unstage") {
    return runGitAction(project, "unstage-files", { files: [payload.file] });
  }

  if (action === "stage-files") {
    const files = knownFiles(project, payload.files);
    await addPaths(repository, filePaths(files, true));
    return `${files.length} ${files.length === 1 ? "Datei wurde" : "Dateien wurden"} vorgemerkt.`;
  }
  if (action === "unstage-files") {
    const files = knownFiles(project, payload.files).filter((file) => file.indexStatus !== "." && file.indexStatus !== "?");
    if (!files.length) return "In der Auswahl waren keine vorgemerkten Dateien.";
    const paths = filePaths(files, true);
    if (info.lastCommit) await git(repository, ["restore", "--staged", "--", ...paths]);
    else await git(repository, ["rm", "--cached", "-r", "--", ...paths]);
    return `${files.length} ${files.length === 1 ? "Vormerkung wurde" : "Vormerkungen wurden"} entfernt.`;
  }
  if (action === "discard-files") {
    const files = knownFiles(project, payload.files);
    const staged = files.filter((file) => file.indexStatus !== "." && file.indexStatus !== "?");
    if (staged.length) {
      const paths = filePaths(staged, true);
      if (info.lastCommit) await git(repository, ["reset", "-q", "HEAD", "--", ...paths]);
      else await git(repository, ["rm", "--cached", "-r", "--", ...paths]);
    }

    const restorePaths: string[] = [];
    const cleanPaths: string[] = [];
    for (const file of files) {
      if (!info.lastCommit) {
        cleanPaths.push(file.path);
      } else if (file.originalPath) {
        restorePaths.push(file.originalPath);
        cleanPaths.push(file.path);
      } else if (file.worktreeStatus === "?" || file.indexStatus === "A" || file.indexStatus === "C") {
        cleanPaths.push(file.path);
      } else {
        restorePaths.push(file.path);
      }
    }
    if (restorePaths.length) await git(repository, ["restore", "--source=HEAD", "--worktree", "--", ...new Set(restorePaths)]);
    const recycleNote = await moveUntrackedToRecycleBin(repository, [...new Set(cleanPaths)]);
    return `${files.length} ${files.length === 1 ? "Änderung wurde" : "Änderungen wurden"} verworfen.${recycleNote}`;
  }
  if (action === "stage-all") {
    await git(repository, ["add", "-A"]);
    return "Alle Änderungen vorgemerkt.";
  }
  if (action === "unstage-all") {
    if (!info.staged) return "Es waren keine Dateien vorgemerkt.";
    if (info.lastCommit) await git(repository, ["reset"]);
    else await git(repository, ["rm", "--cached", "-r", "."]);
    return "Alle Vormerkungen entfernt.";
  }
  if (action === "commit") {
    const message = typeof payload.message === "string" ? payload.message.trim().replace(/\s+/g, " ") : "";
    if (message.length < 3) throw new Error("Die Commit-Nachricht muss mindestens drei Zeichen enthalten.");
    if (message.length > 200) throw new Error("Die Commit-Nachricht darf höchstens 200 Zeichen lang sein.");
    if (!info.staged) throw new Error("Merke zuerst mindestens eine Datei für den Commit vor.");
    const description = textValue(payload.description, 10000);
    await git(repository, ["commit", "-m", message, ...(description ? ["-m", description] : [])], 30_000);
    return "Commit wurde erstellt.";
  }
  if (action === "fetch") {
    if (!info.remoteName || !/^[\w.-]+$/.test(info.remoteName)) throw new Error("Kein verwendbares Git-Remote erkannt.");
    await git(repository, ["fetch", info.remoteName, "--prune"], 60_000);
    return "Remote-Stand wurde abgerufen.";
  }
  if (action === "pull") {
    if (!info.branch) throw new Error("Ein Pull ist im detached-HEAD-Zustand nicht verfügbar.");
    if (!info.upstream) throw new Error("Für diesen Branch ist noch kein Upstream eingerichtet.");
    // Fast-forward bleibt der sichere Standard. Bei auseinandergelaufenen Branches wählt die Oberfläche Merge oder Rebase explizit.
    const method = payload.method === "merge" ? "merge" : payload.method === "rebase" ? "rebase" : "ff-only";
    if (method !== "ff-only" && info.dirty) throw new Error("Committe oder sichere deine Änderungen, bevor du Merge oder Rebase startest.");
    await git(repository, ["pull", method === "ff-only" ? "--ff-only" : method === "merge" ? "--no-rebase" : "--rebase", ...(method === "merge" ? ["--no-edit"] : [])], 60_000);
    return method === "ff-only" ? "Remote-Commits wurden übernommen." : method === "merge" ? "Remote-Commits per Merge übernommen." : "Eigene Commits per Rebase auf den Remote-Stand gesetzt.";
  }
  if (action === "checkout") {
    const branch = requestedBranchName(payload.branch);
    if (branch === info.branch) return `Der Branch „${branch}“ ist bereits aktiv.`;
    try {
      await git(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    } catch {
      throw new Error(`Der Branch „${branch}“ existiert lokal nicht.`);
    }
    await git(repository, ["switch", branch], 30_000);
    return `Branch „${branch}“ ist jetzt aktiv.`;
  }
  if (action === "create-branch") {
    const branch = requestedBranchName(payload.branch);
    try {
      await git(repository, ["check-ref-format", "--branch", branch]);
    } catch {
      throw new Error("Der Branch-Name ist ungültig.");
    }
    await git(repository, ["switch", "-c", branch], 30_000);
    return `Branch „${branch}“ wurde erstellt und ist jetzt aktiv.`;
  }
  if (action === "undo-commit") {
    await requireUnpublished(project);
    if (!info.lastCommit) throw new Error("Es gibt keinen Commit, der zurückgenommen werden könnte.");
    if (!info.branch) throw new Error("Im detached-HEAD-Zustand kann kein Commit zurückgenommen werden.");
    if (info.upstream && info.ahead === 0) throw new Error("Der letzte Commit wurde bereits zum Remote übertragen und kann lokal nicht mehr zurückgenommen werden.");
    const revision = await git(repository, ["rev-list", "--parents", "-n", "1", "HEAD"]);
    const parents = revision.split(/\s+/).filter(Boolean).slice(1);
    if (parents.length > 1) throw new Error("Merge-Commits können hier nicht zurückgenommen werden. Nutze dafür das Terminal.");
    if (parents.length === 0) await git(repository, ["update-ref", "-d", "HEAD"]);
    else await git(repository, ["reset", "--soft", "HEAD^"]);
    return `Commit „${info.lastCommit.subject}“ wurde zurückgenommen. Die Änderungen sind wieder vorgemerkt.`;
  }
  if (action === "push") {
    if (!info.branch) throw new Error("Ein Push ist im detached-HEAD-Zustand nicht verfügbar.");
    if (!info.remoteName || !/^[\w.-]+$/.test(info.remoteName)) throw new Error("Kein verwendbares Git-Remote erkannt.");
    if (info.upstream) await git(repository, ["push"], 60_000);
    else await git(repository, ["push", "--set-upstream", info.remoteName, info.branch], 60_000);
    return "Commits wurden zum Remote übertragen.";
  }
  throw new Error("Unbekannte Git-Aktion.");
}

export interface GitWorkspaceInfo {
  branches: GitBranchInfo[];
  stashes: Array<{ ref: string; hash: string; subject: string; date: string }>;
  tags: Array<{ name: string; hash: string; date: string; subject: string }>;
  remotes: Array<{ name: string; url: string }>;
  identity: { name: string; email: string };
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
}

function textValue(value: unknown, limit = 200): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new Error(`Ungültige Eingabe (maximal ${limit} Zeichen).`);
  return value.trim();
}

async function operationInProgress(repository: string): Promise<GitWorkspaceInfo["operation"]> {
  for (const [file, operation] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]] as const) {
    const location = await git(repository, ["rev-parse", "--git-path", file]);
    if (await access(path.resolve(repository, location)).then(() => true, () => false)) return operation;
  }
  return null;
}

export async function readGitWorkspace(project: ProjectDefinition): Promise<GitWorkspaceInfo> {
  const repository = repositoryPath(project);
  const [branches, stashOutput, tagOutput, remoteOutput, name, email, operation] = await Promise.all([
    readGitBranches(project),
    git(repository, ["stash", "list", "--format=%gd%x1f%H%x1f%gs%x1f%cI"]),
    git(repository, ["for-each-ref", "refs/tags", "--sort=-creatordate", "--format=%(refname:strip=2)%1f%(objectname)%1f%(creatordate:iso-strict)%1f%(subject)"]),
    git(repository, ["remote"]),
    git(repository, ["config", "--get", "user.name"]).catch(() => ""),
    git(repository, ["config", "--get", "user.email"]).catch(() => ""),
    operationInProgress(repository)
  ]);
  const remotes = await Promise.all(remoteOutput.split("\n").filter(Boolean).map(async name => ({ name, url: await git(repository, ["remote", "get-url", name]) })));
  return {
    branches, operation, remotes, identity: { name, email },
    stashes: stashOutput.split("\n").filter(Boolean).map(line => { const [ref, hash, subject, date] = line.split("\x1f"); return { ref, hash, subject, date }; }),
    tags: tagOutput.split("\n").filter(Boolean).map(line => { const [name, hash, date, subject] = line.split("\x1f"); return { name, hash, date, subject }; })
  };
}

async function verifiedCommit(repository: string, value: unknown): Promise<string> {
  const hash = textValue(value, 64);
  if (!/^[a-f0-9]{7,64}$/i.test(hash)) throw new Error("Wähle einen gültigen Commit aus.");
  return git(repository, ["rev-parse", "--verify", `${hash}^{commit}`]);
}

async function knownBranch(project: ProjectDefinition, value: unknown): Promise<GitBranchInfo> {
  const name = requestedBranchName(value);
  const branch = (await readGitBranches(project)).find(branch => branch.name === name);
  if (!branch) throw new Error("Dieser Branch ist nicht mehr vorhanden. Bitte aktualisieren.");
  return branch;
}

async function knownStash(project: ProjectDefinition, payload: GitActionPayload): Promise<string> {
  const ref = textValue(payload.stash);
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error("Ungültige Stash-Referenz.");
  const actual = await git(repositoryPath(project), ["rev-parse", "--verify", ref]);
  if (actual !== payload.hash) throw new Error("Die Stash-Liste hat sich geändert. Bitte aktualisieren und erneut auswählen.");
  return ref;
}

// Zeilenzahlen pro Datei für die Dateiliste. Versionierte Dateien über numstat, neue Dateien über die Dateigröße.
export async function readGitStats(project: ProjectDefinition): Promise<Record<string, { additions: number; deletions: number; binary: boolean }>> {
  const repository = repositoryPath(project);
  const info = project.git!;
  const stats: Record<string, { additions: number; deletions: number; binary: boolean }> = {};
  if (info.lastCommit) {
    const output = await gitDiff(repository, ["diff", "--numstat", "-z", "--no-ext-diff", "HEAD", "--"]);
    const tokens = output.split("\0");
    for (let index = 0; index < tokens.length; index += 1) {
      const match = tokens[index].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
      if (!match) continue;
      let file = match[3];
      if (!file) { file = tokens[index + 2] || ""; index += 2; }
      if (file) stats[file] = { additions: match[1] === "-" ? 0 : Number(match[1]), deletions: match[2] === "-" ? 0 : Number(match[2]), binary: match[1] === "-" };
    }
  }
  const untracked = info.files.filter(file => file.worktreeStatus === "?" && !stats[file.path]).slice(0, 200);
  await Promise.all(untracked.map(async file => {
    try {
      const details = await lstat(path.join(repository, file.path));
      if (!details.isFile() || details.size > 2_000_000) { stats[file.path] = { additions: 0, deletions: 0, binary: details.size > 2_000_000 }; return; }
      const content = await readFile(path.join(repository, file.path));
      const binary = content.subarray(0, 8000).includes(0);
      const lines = binary ? 0 : content.length === 0 ? 0 : content.toString("utf8").split("\n").length - (content[content.length - 1] === 10 ? 1 : 0);
      stats[file.path] = { additions: lines, deletions: 0, binary };
    } catch { /* Datei zwischenzeitlich entfernt */ }
  }));
  return stats;
}

export async function readGitStash(project: ProjectDefinition, payload: GitActionPayload): Promise<{ patch: string; truncated: boolean }> {
  const ref = await knownStash(project, payload);
  return limitedPatch(await gitDiff(repositoryPath(project), ["stash", "show", "--include-untracked", "-p", "--no-ext-diff", "--no-color", ref]));
}

export async function readGitComparison(project: ProjectDefinition, value: unknown): Promise<{ patch: string; truncated: boolean }> {
  const branch = await knownBranch(project, value);
  const ref = `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`;
  return limitedPatch(await gitDiff(repositoryPath(project), ["diff", "--no-ext-diff", "--no-color", "--stat", "--patch", `HEAD...${ref}`, "--"]));
}

function remoteUrl(value: unknown): string {
  const url = textValue(value, 2000);
  if (!url || url.startsWith("-") || /[\x00-\x20]/.test(url) || /^(ext|file):/i.test(url)) throw new Error("Gib eine HTTPS- oder SSH-URL bzw. einen lokalen Repository-Pfad ohne Leerzeichen ein.");
  if (!/^(https?:\/\/|ssh:\/\/|[^/@:]+@[^/:]+:|\/|[A-Za-z]:[\\/])/.test(url)) throw new Error("Verwende eine HTTPS- oder SSH-URL oder einen absoluten lokalen Pfad.");
  return url;
}

async function requireClean(project: ProjectDefinition): Promise<void> {
  if (await git(repositoryPath(project), ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Committe deine Änderungen oder sichere sie zuerst in einem Stash.");
  if (await operationInProgress(repositoryPath(project))) throw new Error("Schließe zuerst den laufenden Git-Vorgang ab oder brich ihn ab.");
}

async function requireUnpublished(project: ProjectDefinition): Promise<void> {
  const repository = repositoryPath(project);
  if (!project.git?.lastCommit || !project.git.branch) throw new Error("Dafür muss ein Branch mit einem Commit aktiv sein.");
  const published = await git(repository, ["for-each-ref", "--contains=HEAD", "--format=%(refname)", "refs/remotes"]);
  if (published) throw new Error("Dieser Commit ist bereits auf einem Remote-Branch enthalten. Erstelle stattdessen einen neuen Commit oder einen Revert.");
  if (await operationInProgress(repository)) throw new Error("Schließe zuerst den laufenden Git-Vorgang ab.");
}

async function runAdvancedGitAction(project: ProjectDefinition, action: GitAction, payload: GitActionPayload): Promise<string> {
  const repository = repositoryPath(project);
  if (action === "suggest-files") return suggestGitCommitMessage(project, payload.files);
  if (action === "commit-files" || action === "amend-files") {
    const files = knownFiles(project, payload.files);
    const message = textValue(payload.message);
    const description = textValue(payload.description, 10000);
    if (message.length < 3) throw new Error("Die Commit-Nachricht muss mindestens drei Zeichen enthalten.");
    if (await operationInProgress(repository)) throw new Error("Schließe zuerst den laufenden Git-Vorgang ab.");
    if (await git(repository, ["ls-files", "--unmerged"])) throw new Error("Löse zuerst alle Dateikonflikte auf.");
    if (action === "amend-files") await requireUnpublished(project);
    const paths = filePaths(files, true);
    await addPaths(repository, paths);
    // --only commits the selected working files and preserves excluded entries in the index.
    await git(repository, ["commit", "--only", ...(action === "amend-files" ? ["--amend"] : []), "-m", message, ...(description ? ["-m", description] : []), "--", ...paths], 30_000);
    return `${files.length} ${files.length === 1 ? "Datei" : "Dateien"} committet.`;
  }
  if (action === "ignore") {
    const file = knownFile(project, payload.file);
    const folder = textValue(payload.folder, 2000);
    if (folder && (!file.startsWith(folder + "/") || folder.split("/").some(part => !part || part === "." || part === ".."))) throw new Error("Wähle einen übergeordneten Ordner dieser Datei.");
    const target = folder || file;
    if (target === ".gitignore" || target.split("/").includes(".git") || /[\r\n]/.test(target)) throw new Error("Dieser Pfad kann nicht ignoriert werden.");
    const ignorePath = path.join(repository, ".gitignore");
    const info = await lstat(ignorePath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info && !info.isFile()) throw new Error("Die .gitignore muss eine reguläre Datei sein.");
    const current = info ? await readFile(ignorePath, "utf8") : "";
    const rule = "/" + target.replace(/[\\*?\[\]#! ]/g, character => "\\" + character) + (folder ? "/" : "");
    if (!current.split(/\r?\n/).includes(rule)) await appendFile(ignorePath, (current && !current.endsWith("\n") ? "\n" : "") + rule + "\n");
    if (payload.untrack === true) await git(repository, ["rm", "--cached", "-r", "--ignore-unmatch", "--", target]);
    return `„${target}${folder ? "/" : ""}“ zur .gitignore hinzugefügt.${payload.untrack === true ? " Lokale Dateien bleiben erhalten." : ""}`;
  }
  if (action === "stage-hunk" || action === "unstage-hunk") {
    const scope = action === "stage-hunk" ? "working" : "staged";
    const change = project.git!.files.find(file => file.path === payload.file);
    if (!change || change.originalPath || !["M", "."].includes(change.indexStatus) || !["M", "."].includes(change.worktreeStatus)) throw new Error("Abschnittsweise Vormerkung ist nur für geänderte Textdateien verfügbar.");
    const section = (await readGitDiff(project, payload.file)).find(section => section.scope === scope);
    if (!section || section.truncated || /^(old|new) mode /m.test(section.patch) || section.fingerprint !== payload.fingerprint) throw new Error("Der Diff hat sich geändert. Bitte neu laden und den Abschnitt erneut auswählen.");
    const start = section.patch.indexOf("\n@@ ");
    const hunks = start < 0 ? [] : section.patch.slice(start + 1).split(/(?=^@@ )/m);
    const index = Number(payload.hunk);
    if (!Number.isInteger(index) || index < 0 || index >= hunks.length) throw new Error("Ungültiger Diff-Abschnitt.");
    const directory = await mkdtemp(path.join(tmpdir(), "devhub-hunk-"));
    try {
      const patchFile = path.join(directory, "change.patch");
      await writeFile(patchFile, section.patch.slice(0, start + 1) + hunks[index]);
      await git(repository, ["apply", "--cached", ...(scope === "staged" ? ["--reverse"] : []), "--", patchFile]);
    } finally { await rm(directory, { recursive: true, force: true }); }
    return scope === "working" ? "Abschnitt vorgemerkt." : "Vormerkung des Abschnitts entfernt.";
  }
  if (action === "amend") {
    await requireUnpublished(project);
    const message = textValue(payload.message);
    if (message.length < 3) throw new Error("Die Commit-Nachricht muss mindestens drei Zeichen enthalten.");
    const description = textValue(payload.description, 10000);
    await git(repository, ["commit", "--amend", "-m", message, ...(description ? ["-m", description] : [])], 30_000);
    return "Letzter Commit wurde aktualisiert.";
  }
  if (action === "rename-branch") {
    const branch = await knownBranch(project, payload.branch);
    if (branch.remote) throw new Error("Nur lokale Branches können umbenannt werden.");
    const name = requestedBranchName(payload.name);
    await git(repository, ["check-ref-format", "--branch", name]);
    await git(repository, ["branch", "-m", branch.name, name]);
    return `Branch wurde in „${name}“ umbenannt.`;
  }
  if (action === "delete-branch") {
    const branch = await knownBranch(project, payload.branch);
    if (branch.current || branch.remote) throw new Error("Nur inaktive lokale Branches können gelöscht werden.");
    await git(repository, ["branch", "-d", branch.name]);
    return `Branch „${branch.name}“ gelöscht.`;
  }
  if (action === "checkout-remote") {
    const branch = await knownBranch(project, payload.branch);
    if (!branch.remote) throw new Error("Wähle einen Remote-Branch.");
    await git(repository, ["switch", "--track", `refs/remotes/${branch.name}`], 30_000);
    return `Lokaler Tracking-Branch für „${branch.name}“ erstellt.`;
  }
  if (action === "merge" || action === "rebase") {
    await requireClean(project);
    if (!project.git!.branch) throw new Error("Wechsle zuerst auf einen lokalen Branch.");
    const branch = await knownBranch(project, payload.branch);
    if (branch.current) throw new Error("Wähle einen anderen Branch als Quelle.");
    const target = `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`;
    if (action === "rebase") {
      const [commits, unpublished] = await Promise.all([
        git(repository, ["rev-list", `${target}..HEAD`]),
        git(repository, ["rev-list", `${target}..HEAD`, "--not", "--remotes"])
      ]);
      if (commits !== unpublished) throw new Error("Dieser Rebase würde bereits veröffentlichte Commits umschreiben. Verwende stattdessen Merge.");
    }
    await git(repository, [action, ...(action === "merge" ? ["--no-edit"] : []), target], 60_000);
    return action === "merge" ? "Branches zusammengeführt." : "Rebase abgeschlossen.";
  }
  if (action === "resolve-file") {
    const file = knownFile(project, payload.file);
    const side = payload.side === "ours" ? "ours" : payload.side === "theirs" ? "theirs" : null;
    if (!side) throw new Error("Wähle, welche Version übernommen werden soll.");
    if (!await git(repository, ["ls-files", "--unmerged", "--", file])) throw new Error("Diese Datei hat keinen offenen Konflikt.");
    await git(repository, ["checkout", `--${side}`, "--", file]);
    await git(repository, ["add", "--", file]);
    return `Konflikt in „${file}“ aufgelöst.`;
  }
  if (action === "continue" || action === "abort") {
    const operation = await operationInProgress(repository);
    if (!operation) throw new Error("Es läuft kein Merge, Rebase, Cherry-pick oder Revert.");
    await git(repository, [operation, `--${action}`], 60_000);
    return action === "continue" ? "Git-Vorgang fortgesetzt." : "Git-Vorgang abgebrochen.";
  }
  if (action === "stash-save") {
    if (!project.git!.dirty) throw new Error("Es sind keine Änderungen zum Sichern vorhanden.");
    if (!project.git!.lastCommit) throw new Error("Erstelle zuerst den ersten Commit, bevor du einen Stash anlegst.");
    await git(repository, ["stash", "push", "--include-untracked", "-m", textValue(payload.message) || "Zwischenstand aus DevHub"], 30_000);
    return "Änderungen inklusive neuer Dateien im Stash gesichert.";
  }
  if (["stash-apply", "stash-pop", "stash-drop"].includes(action)) {
    const ref = await knownStash(project, payload);
    if (action !== "stash-drop") await requireClean(project);
    await git(repository, ["stash", action.slice(6), ref], 30_000);
    return action === "stash-drop" ? "Stash gelöscht." : action === "stash-pop" ? "Stash angewendet und aus der Liste entfernt." : "Stash angewendet; die Sicherung bleibt erhalten.";
  }
  if (["create-tag", "delete-tag", "push-tag"].includes(action)) {
    const name = requestedBranchName(payload.name);
    await git(repository, ["check-ref-format", `refs/tags/${name}`]);
    if (action === "create-tag") {
      const target = payload.hash ? await verifiedCommit(repository, payload.hash) : "HEAD";
      await git(repository, ["tag", "-a", name, "-m", textValue(payload.message, 2000) || name, target]);
      return `Tag „${name}“ erstellt.`;
    }
    await git(repository, ["rev-parse", "--verify", `refs/tags/${name}`]);
    if (action === "delete-tag") await git(repository, ["tag", "-d", name]);
    else {
      const remote = textValue(payload.remote);
      if (!(await readGitWorkspace(project)).remotes.some(item => item.name === remote)) throw new Error("Wähle ein vorhandenes Remote.");
      await git(repository, ["push", remote, `refs/tags/${name}`], 60_000);
    }
    return action === "delete-tag" ? `Lokales Tag „${name}“ gelöscht.` : `Tag „${name}“ veröffentlicht.`;
  }
  if (["remote-add", "remote-remove", "remote-set-url"].includes(action)) {
    const name = textValue(payload.remote);
    if (!/^[a-zA-Z0-9][\w.-]{0,99}$/.test(name)) throw new Error("Remote-Namen dürfen Buchstaben, Zahlen, Punkte, _ und - enthalten.");
    if (action === "remote-add") await git(repository, ["remote", "add", name, remoteUrl(payload.url)]);
    else if (action === "remote-remove") await git(repository, ["remote", "remove", name]);
    else await git(repository, ["remote", "set-url", name, remoteUrl(payload.url)]);
    return "Remote-Konfiguration aktualisiert.";
  }
  if (action === "identity") {
    const name = textValue(payload.name);
    const email = textValue(payload.email);
    if (!name || /[\r\n<>]/.test(name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(email)) throw new Error("Gib einen Namen und eine gültige E-Mail-Adresse ein.");
    await git(repository, ["config", "--local", "user.name", name]);
    await git(repository, ["config", "--local", "user.email", email]);
    return "Commit-Identität für dieses Repository gespeichert.";
  }
  if (action === "revert" || action === "cherry-pick") {
    await requireClean(project);
    const hash = await verifiedCommit(repository, payload.hash);
    const parents = (await git(repository, ["rev-list", "--parents", "-n", "1", hash])).split(/\s+/);
    if (parents.length > 2) throw new Error("Bei Merge-Commits muss ein Haupt-Elterncommit gewählt werden. Nutze dafür das Terminal.");
    await git(repository, [action, "--no-edit", hash], 60_000);
    return action === "revert" ? "Änderungen durch einen neuen Revert-Commit rückgängig gemacht." : "Commit auf den aktuellen Branch übernommen.";
  }
  throw new Error("Unbekannte Git-Aktion.");
}

export async function initializeGitRepository(project: ProjectDefinition): Promise<void> {
  if (project.git) throw new Error("Dieses Projekt besitzt bereits ein Git-Repository.");
  await git(project.absolutePath, ["init", "-b", "main"]);
}

async function cloneDestination(root: string, value: unknown): Promise<string> {
  const name = textValue(value, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === "." || name === "..") throw new Error("Wähle einen einfachen Ordnernamen ohne Pfadangaben.");
  const destination = path.join(root, name);
  if (await access(destination).then(() => true, () => false)) throw new Error("Ein Ordner mit diesem Namen existiert bereits.");
  return destination;
}

export async function cloneGitRepository(root: string, payload: GitActionPayload): Promise<void> {
  const destination = await cloneDestination(root, payload.name);
  await git(root, ["clone", "--", remoteUrl(payload.url), destination], 120_000);
}

// GitHub CLI: Repositories des angemeldeten Kontos auflisten und mit dessen Anmeldung klonen.
export interface GitHubRepository { name: string; nameWithOwner: string; description: string; url: string; isPrivate: boolean; isFork: boolean; pushedAt: string | null; defaultBranch: string | null; }
export interface GitHubOverview { available: boolean; account: string | null; repositories: GitHubRepository[]; hint: string | null; }

async function gh(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { timeout, windowsHide: true, maxBuffer: 20_000_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" } });
  return stdout;
}

export async function listGitHubRepositories(): Promise<GitHubOverview> {
  let account: string;
  try {
    account = (await gh(["api", "user", "--jq", ".login"])).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { available: false, account: null, repositories: [], hint: code === "ENOENT" ? "Die GitHub CLI (gh) ist nicht installiert. Installiere sie mit „brew install gh“ und melde dich mit „gh auth login“ an." : "Nicht bei GitHub angemeldet. Führe im Terminal „gh auth login“ aus und lade die Liste danach neu." };
  }
  const fields = "name,nameWithOwner,description,url,isPrivate,isFork,pushedAt,defaultBranchRef";
  const organisations = (await gh(["api", "user/orgs", "--jq", ".[].login"]).catch(() => "")).split(/\r?\n/).map(line => line.trim()).filter(line => /^[\w.-]+$/.test(line)).slice(0, 10);
  const outputs = await Promise.all([
    gh(["repo", "list", "--limit", "200", "--json", fields], 60_000),
    ...organisations.map(org => gh(["repo", "list", org, "--limit", "100", "--json", fields], 60_000).catch(() => "[]"))
  ]);
  const seen = new Set<string>();
  const repositories: GitHubRepository[] = [];
  for (const output of outputs) {
    let parsed: unknown = [];
    try { parsed = JSON.parse(output || "[]"); } catch { parsed = []; }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const nameWithOwner = typeof entry.nameWithOwner === "string" ? entry.nameWithOwner : "";
      if (!nameWithOwner || seen.has(nameWithOwner)) continue;
      seen.add(nameWithOwner);
      const defaultBranch = entry.defaultBranchRef && typeof entry.defaultBranchRef === "object" ? (entry.defaultBranchRef as { name?: unknown }).name : null;
      repositories.push({
        name: typeof entry.name === "string" ? entry.name : nameWithOwner.split("/")[1],
        nameWithOwner,
        description: typeof entry.description === "string" ? entry.description : "",
        url: typeof entry.url === "string" ? entry.url : `https://github.com/${nameWithOwner}`,
        isPrivate: entry.isPrivate === true,
        isFork: entry.isFork === true,
        pushedAt: typeof entry.pushedAt === "string" ? entry.pushedAt : null,
        defaultBranch: typeof defaultBranch === "string" ? defaultBranch : null
      });
    }
  }
  repositories.sort((a, b) => (b.pushedAt || "").localeCompare(a.pushedAt || ""));
  return { available: true, account, repositories, hint: null };
}

export async function cloneGitHubRepository(root: string, payload: GitActionPayload): Promise<void> {
  const repo = textValue(payload.repo, 200);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.includes("..")) throw new Error("Wähle ein Repository im Format konto/name.");
  const destination = await cloneDestination(root, payload.name);
  try {
    await gh(["repo", "clone", repo, destination], 180_000);
  } catch (error) {
    throw friendlyGitError(error);
  }
}
