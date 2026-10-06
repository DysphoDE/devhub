import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { commandPath, fileExists, findMacApp, isMac, isWindows, openMacApp, runningProcessNames, spawnDetached } from "./platform.js";
import type { LocalStack } from "./stack.js";
import type { AppConfig, StackActionDescriptor, StackActionId, StackProvider, StackSite, StackStatus, StackWebInfo } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Herd (macOS, Windows) und Laravel Valet (macOS, Linux) teilen dieselbe Konfiguration:
 * eine config.json mit TLD und "geparkten" Ordnern, deren Unterordner automatisch als
 * http://<ordner>.<tld> erreichbar sind, dazu Sites/ für verlinkte Ordner und Certificates/
 * für HTTPS-Domains. Ein Webserver-Neustart läuft über die CLI ("herd restart", "valet restart").
 */
interface ValetConfig {
  tld?: string;
  loopback?: string;
  paths?: string[];
}

interface ValetHome {
  provider: Exclude<StackProvider, "laragon" | "none">;
  name: string;
  /** Ordner mit config.json, Sites/ und Certificates/. */
  home: string;
  /** Wurzel der Installation (bei Herd der Ordner über config/valet). */
  root: string;
}

/** Standardordner der Herd-Installation je Plattform. */
export function defaultHerdRoot(platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  return platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Herd")
    : path.join(home, ".config", "herd");
}

async function isDirectory(candidate: string): Promise<boolean> {
  try { return (await stat(candidate)).isDirectory(); } catch { return false; }
}

/**
 * Findet die Valet-Konfiguration: bevorzugt die konfigurierte Herd-Wurzel (mit oder ohne
 * config/valet darunter), sonst eine klassische Valet-Installation unter ~/.config/valet.
 */
async function locateHome(config: AppConfig): Promise<ValetHome | null> {
  const herdRoot = config.herdRoot;
  for (const [home, root] of [[path.join(herdRoot, "config", "valet"), herdRoot], [herdRoot, herdRoot]] as const) {
    if (await fileExists(path.join(home, "config.json"))) return { provider: "herd", name: "Herd", home, root };
  }
  if (config.stack === "herd") return null;
  const valetHome = path.join(os.homedir(), ".config", "valet");
  if (await fileExists(path.join(valetHome, "config.json"))) return { provider: "valet", name: "Valet", home: valetHome, root: valetHome };
  return null;
}

async function readConfig(home: ValetHome): Promise<ValetConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(home.home, "config.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as ValetConfig : {};
  } catch {
    return {};
  }
}

async function securedSites(home: ValetHome): Promise<Set<string>> {
  try {
    const entries = await readdir(path.join(home.home, "Certificates"));
    return new Set(entries.filter((name) => name.endsWith(".crt")).map((name) => name.slice(0, -4).toLowerCase()));
  } catch {
    return new Set();
  }
}

// Valet-Treiber liefern public/ aus, wenn es existiert – Laravel, Symfony, Statamic – und sonst den Ordner selbst.
async function documentRootFor(directory: string): Promise<string> {
  const publicDirectory = path.join(directory, "public");
  if (await isDirectory(publicDirectory)) return publicDirectory;
  return directory;
}

async function siteDirectories(parent: string): Promise<Array<{ name: string; target: string }>> {
  const result: Array<{ name: string; target: string }> = [];
  let entries;
  try { entries = await readdir(parent, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const candidate = path.join(parent, entry.name);
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() && !info.isSymbolicLink()) continue;
      const target = info.isSymbolicLink() ? await realpath(candidate) : candidate;
      if (!await isDirectory(target)) continue;
      result.push({ name: entry.name, target });
    } catch {
      // Defekte Links oder fehlende Rechte überspringen.
    }
  }
  return result;
}

async function collectSites(home: ValetHome): Promise<{ sites: StackSite[]; tld: string }> {
  const valetConfig = await readConfig(home);
  const tld = (valetConfig.tld || "test").replace(/^\./, "");
  const secured = await securedSites(home);
  const parents = new Set<string>([...(valetConfig.paths ?? []), path.join(home.home, "Sites")]);
  const byName = new Map<string, StackSite>();
  for (const parent of parents) {
    for (const directory of await siteDirectories(parent)) {
      const serverName = `${directory.name}.${tld}`.toLowerCase();
      if (byName.has(serverName)) continue;
      const protocol = secured.has(serverName) ? "https" : "http";
      byName.set(serverName, { documentRoot: await documentRootFor(directory.target), serverName, url: `${protocol}://${serverName}/` });
    }
  }
  return { sites: [...byName.values()], tld };
}

function actionsFor(home: ValetHome): StackActionDescriptor[] {
  return [
    { id: "start", label: "Nginx starten", description: `Startet die ${home.name}-Dienste (Nginx, PHP-FPM, DNS).` },
    { id: "stop", label: "Nginx stoppen", description: `Beendet die ${home.name}-Dienste.` },
    ...(isMac ? [{ id: "open" as const, label: `${home.name} öffnen`, description: `Öffnet die ${home.name}-App.` }] : []),
    { id: "reload", label: "Dienste neu starten", description: `Startet die ${home.name}-Dienste neu und lädt geparkte Ordner ein.` }
  ];
}

async function getStatus(config: AppConfig): Promise<StackStatus> {
  const home = await locateHome(config);
  if (!home) {
    return {
      provider: "herd", name: "Herd", installed: false, root: null, appRunning: false, webServerName: "Nginx",
      webServer: null, database: null, mail: false, documentRoot: null, sites: 0, tld: null, actions: []
    };
  }
  const [names, collected] = await Promise.all([runningProcessNames(), collectSites(home)]);
  const has = (...candidates: string[]) => candidates.some((name) => names.has(name) || names.has(`${name}.exe`));
  return {
    provider: home.provider,
    name: home.name,
    installed: true,
    root: home.root,
    appRunning: home.provider === "herd" ? has("herd") : has("nginx"),
    webServerName: "Nginx",
    webServer: has("nginx", "nginx-arm64", "nginx-x86_64") ? "Nginx" : names.has("httpd") ? "Apache" : null,
    database: has("mysqld") ? "MySQL" : has("mariadbd") ? "MariaDB" : has("postgres") ? "PostgreSQL" : null,
    mail: has("mailpit"),
    documentRoot: null,
    sites: collected.sites.length,
    tld: collected.tld,
    actions: actionsFor(home)
  };
}

async function readWebInfo(config: AppConfig): Promise<StackWebInfo> {
  const home = await locateHome(config);
  if (!home) return { documentRoot: null, sites: [] };
  return { documentRoot: null, sites: (await collectSites(home)).sites };
}

async function resolveCli(home: ValetHome): Promise<string> {
  const name = home.provider === "herd" ? "herd" : "valet";
  const bundled = path.join(home.root, "bin", isWindows ? `${name}.bat` : name);
  if (await fileExists(bundled)) return bundled;
  const onPath = await commandPath(name);
  if (onPath) return onPath;
  throw new Error(`Die ${home.name}-Kommandozeile wurde nicht gefunden. Öffne ${home.name} einmal, damit sie eingerichtet wird.`);
}

async function runCli(home: ValetHome, args: string[]): Promise<string> {
  const cli = await resolveCli(home);
  const { stdout } = await execFileAsync(cli, args, { timeout: 60_000, windowsHide: true, maxBuffer: 1_000_000 });
  return stdout.trim();
}

async function openApp(home: ValetHome): Promise<string> {
  if (isMac && await findMacApp(home.name)) {
    await openMacApp(home.name);
    return `${home.name} wurde geöffnet.`;
  }
  if (isWindows && home.provider === "herd") {
    const executable = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Herd", "Herd.exe");
    if (await fileExists(executable)) {
      await spawnDetached(executable, [], { visible: true });
      return "Herd wurde geöffnet.";
    }
  }
  throw new Error(`Die ${home.name}-App wurde nicht gefunden.`);
}

const HERD_SERVICES = ["herd", "nginx", "php-fpm"];

/**
 * Wartet, bis die Herd-App und ihre Dienste laufen, und gibt ihr danach noch einen Moment,
 * ihren eigenen Start abzuschließen. Liefert false, wenn sie innerhalb der Frist nicht auftauchen.
 */
export async function waitForHerdServices(
  readNames: () => Promise<Set<string>> = runningProcessNames,
  { timeoutMs = 20_000, intervalMs = 500, settleMs = 2_000, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = {}
): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    const names = await readNames();
    if (HERD_SERVICES.every((name) => names.has(name))) {
      await sleep(settleMs);
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

/**
 * "herd start|stop|restart" schickt nur ein AppleScript an die App. Läuft sie nicht, öffnet macOS
 * sie dafür – und Herd startet beim Öffnen seine Dienste selbst. Trifft der Befehl gleichzeitig ein,
 * startet Herd alles doppelt; die überzähligen Prozesse sterben weg, und Herd hing danach mit
 * Dauerlast auf mehreren Kernen an deren Pipes. Daher die App vorher selbst öffnen und abwarten.
 * Liefert true, wenn die Dienste dabei frisch gestartet wurden.
 */
async function launchHerdIfNeeded(home: ValetHome): Promise<boolean> {
  if (!isMac || home.provider !== "herd") return false;
  if ((await runningProcessNames()).has("herd")) return false;
  await openApp(home);
  return waitForHerdServices();
}

async function runAction(config: AppConfig, action: StackActionId): Promise<string> {
  const home = await locateHome(config);
  if (!home) throw new Error("Herd oder Valet wurde nicht gefunden.");
  if (action === "open") return openApp(home);
  const freshlyStarted = await launchHerdIfNeeded(home);
  if (freshlyStarted && (action === "start" || action === "reload")) return `${home.name} wurde geöffnet und hat seine Dienste gestartet.`;
  if (action === "start") { await runCli(home, ["start"]); return `${home.name}-Dienste werden gestartet.`; }
  if (action === "stop") { await runCli(home, ["stop"]); return `${home.name}-Dienste werden gestoppt.`; }
  await runCli(home, ["restart"]);
  return `${home.name}-Dienste wurden neu gestartet.`;
}

export const herdStack: LocalStack = {
  provider: "herd",
  name: "Herd",
  isInstalled: async (config) => Boolean(await locateHome(config)),
  getStatus,
  readWebInfo,
  runAction
};
