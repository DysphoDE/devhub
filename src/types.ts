export type LauncherKind = "package-script" | "batch" | "command" | "powershell" | "shell" | "static-server" | "php-server";
export type RuntimeStatus = "stopped" | "starting" | "running" | "stopping" | "error";
export type AutostartMode = "dev" | "production";
export type StackProvider = "laragon" | "herd" | "valet" | "none";
export type StackSelection = "auto" | StackProvider;

export interface AppConfig {
  host: string;
  publicHost: string;
  publicUrl: string | null;
  autostartMode: AutostartMode;
  port: number;
  scanRoot: string;
  categoryDepth: number;
  maxDepth: number;
  maxEntriesPerProject: number;
  ignore: string[];
  stack: StackSelection;
  laragonRoot: string;
  herdRoot: string;
  editor: string;
  terminal: string;
}

export interface LauncherDefinition {
  id: string;
  projectId: string;
  name: string;
  kind: LauncherKind;
  relativeCwd: string;
  command: string;
  cwd: string;
  executable: string;
  args: string[];
  dynamicPort: boolean;
  preferred: boolean;
  /** Port, den der Befehl selbst festlegt (etwa `php -S 127.0.0.1:8787` oder `vite --port 5174`). */
  port: number | null;
  /** Starter, der dieses Skript bereits mitstartet, etwa ein `dev`, das per concurrently mehrere Teile startet. */
  parentId: string | null;
  /** Teilskripte, die dieser Starter gemeinsam startet. Leer bei einfachen Startern. */
  parts: LauncherPart[];
}

export interface LauncherPart {
  script: string;
  launcherId: string | null;
  port: number | null;
}

export interface GitInfo {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  changedFiles: number;
  remoteName: string | null;
  remoteUrl: string | null;
  upstream: string | null;
  lastFetchAt: string | null;
  repositoryRoot: string;
  files: Array<{
    path: string;
    originalPath: string | null;
    indexStatus: string;
    worktreeStatus: string;
  }>;
  filesTruncated: boolean;
  lastCommit: {
    hash: string;
    subject: string;
    author: string;
    date: string;
  } | null;
}

export interface ProjectDefinition {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  absolutePath: string;
  category: string | null;
  categoryPath: string | null;
  thumbnailPath: string | null;
  modifiedAt: string;
  technologies: string[];
  kind: string;
  defaultUrl: string | null;
  webRoot: string | null;
  git: GitInfo | null;
  fileCount: number;
  launchers: LauncherDefinition[];
  /** true für die DevHub-Installation, die gerade läuft. Sie bietet sich nicht selbst zum Starten an. */
  isSelf: boolean;
  /** true, wenn die Beschreibung nur aus erkannten Technologien abgeleitet ist. */
  descriptionAuto: boolean;
}

export interface LogEntry {
  timestamp: string;
  stream: "system" | "stdout" | "stderr";
  text: string;
}

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  url: string | null;
  message: string | null;
}

export interface PublicLauncher extends Omit<LauncherDefinition, "cwd" | "executable" | "args"> {
  runtime: RuntimeSnapshot;
}

export interface PublicProject extends Omit<ProjectDefinition, "absolutePath" | "thumbnailPath" | "webRoot" | "launchers"> {
  thumbnailUrl: string | null;
  launchers: PublicLauncher[];
}

export interface SystemCapabilities {
  platform: NodeJS.Platform;
  platformName: string;
  editor: { available: boolean; name: string | null };
  terminal: { available: boolean; name: string | null };
  folder: boolean;
  folderPicker: boolean;
  trash: { available: boolean; name: string | null };
}

/** Eine lokale Domain, die der Stack (Laragon, Herd, Valet) ausliefert. */
export interface StackSite {
  documentRoot: string;
  serverName: string;
  url: string;
}

export interface StackWebInfo {
  /** Globales DocumentRoot, unter dem Ordner direkt per Pfad erreichbar sind (Laragon/Apache). */
  documentRoot: string | null;
  sites: StackSite[];
}

export type StackActionId = "open" | "start" | "stop" | "reload";

export interface StackActionDescriptor {
  id: StackActionId;
  label: string;
  description: string;
}

export interface StackStatus {
  provider: StackProvider;
  name: string;
  installed: boolean;
  root: string | null;
  appRunning: boolean;
  webServerName: string;
  webServer: string | null;
  database: string | null;
  mail: boolean;
  documentRoot: string | null;
  sites: number;
  tld: string | null;
  actions: StackActionDescriptor[];
}
