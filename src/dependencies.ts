// Erkennt, ob die Abhängigkeiten eines Projekts installiert sind.
//
// "missing": node_modules bzw. vendor fehlt ganz, ein Starter würde sofort scheitern.
// "outdated": das Lockfile ist neuer als die Installation, etwa nach einem Pull mit neuen Paketen.
// Als Zeitpunkt der Installation gilt der jüngste Wert aus dem Installationsordner und der Datei,
// die der Paketmanager dort bei jeder Installation schreibt. Nach einer Installation über DevHub
// setzt markInstalled den Ordner auf "jetzt", damit auch ein Lauf ohne Änderungen zählt.

import { stat, utimes } from "node:fs/promises";
import path from "node:path";
import { isWindows } from "./platform.js";
import type { DependencyManager, InstallerDefinition } from "./types.js";

export type NodeManager = Exclude<DependencyManager, "composer">;
export type DependencyState = InstallerDefinition["state"];

const lockfiles: Record<DependencyManager, string[]> = {
  npm: ["package-lock.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
  composer: ["composer.lock"]
};

// Dateien, die der Paketmanager bei jeder Installation im Installationsordner neu schreibt.
const installMarkers: Record<DependencyManager, string[]> = {
  npm: [".package-lock.json"],
  pnpm: [".modules.yaml"],
  yarn: [".yarn-state.yml", ".yarn-integrity"],
  bun: [],
  composer: ["composer/installed.json"]
};

// Kleiner Spielraum, damit ein im selben Moment geschriebenes Lockfile nicht als neuer gilt.
const toleranceMs = 2000;

async function modifiedAt(filePath: string): Promise<number | null> {
  try { return (await stat(filePath)).mtimeMs; } catch { return null; }
}

async function isDirectory(directory: string): Promise<boolean> {
  try { return (await stat(directory)).isDirectory(); } catch { return false; }
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Ordner mit dem Lockfile des Paketmanagers, von packageDirectory aufwärts bis zum Projektordner. */
async function lockDirectory(packageDirectory: string, projectPath: string, manager: DependencyManager): Promise<string | null> {
  let current = packageDirectory;
  while (within(current, projectPath)) {
    for (const name of lockfiles[manager]) if (await modifiedAt(path.join(current, name)) !== null) return current;
    if (path.resolve(current) === path.resolve(projectPath)) break;
    current = path.dirname(current);
  }
  return null;
}

async function lockModifiedAt(directory: string, manager: DependencyManager): Promise<number | null> {
  const times = await Promise.all(lockfiles[manager].map((name) => modifiedAt(path.join(directory, name))));
  const known = times.filter((time): time is number => time !== null);
  return known.length ? Math.max(...known) : null;
}

async function installedAt(installDirectory: string, manager: DependencyManager): Promise<number> {
  const times = await Promise.all([installDirectory, ...installMarkers[manager].map((name) => path.join(installDirectory, name))].map(modifiedAt));
  return Math.max(0, ...times.filter((time): time is number => time !== null));
}

export interface DependencyCheck {
  /** Ordner, in dem installiert wird: der mit dem Lockfile, sonst der des Manifests. */
  installRoot: string;
  state: DependencyState;
}

/**
 * Prüft ein Node-Paket. Workspaces legen node_modules oft nur im Wurzelordner an,
 * deshalb zählt ein node_modules im Paketordner oder darüber (bis zum Projektordner).
 */
export async function nodeDependencyCheck(packageDirectory: string, projectPath: string, manager: NodeManager): Promise<DependencyCheck | null> {
  const lockRoot = await lockDirectory(packageDirectory, projectPath, manager);
  const installRoot = lockRoot ?? packageDirectory;
  let modules: string | null = null;
  let current = packageDirectory;
  while (within(current, projectPath)) {
    if (await isDirectory(path.join(current, "node_modules"))) { modules = path.join(current, "node_modules"); break; }
    if (path.resolve(current) === path.resolve(projectPath)) break;
    current = path.dirname(current);
  }
  if (!modules) return { installRoot, state: "missing" };
  if (!lockRoot) return null;
  const lock = await lockModifiedAt(lockRoot, manager);
  if (lock === null) return null;
  const installed = Math.max(await installedAt(modules, manager), await installedAt(path.join(installRoot, "node_modules"), manager));
  return lock > installed + toleranceMs ? { installRoot, state: "outdated" } : null;
}

export async function composerDependencyCheck(composerDirectory: string): Promise<DependencyCheck | null> {
  const vendor = path.join(composerDirectory, "vendor");
  if (!await isDirectory(vendor)) return { installRoot: composerDirectory, state: "missing" };
  const lock = await lockModifiedAt(composerDirectory, "composer");
  if (lock === null) return null;
  return lock > await installedAt(vendor, "composer") + toleranceMs ? { installRoot: composerDirectory, state: "outdated" } : null;
}

/** Hat ein composer.json Pakete, die installiert werden müssen? php und ext-* sind Plattformangaben. */
export function composerNeedsInstall(require: Record<string, string> = {}, requireDev: Record<string, string> = {}): boolean {
  return [...Object.keys(require), ...Object.keys(requireDev)].some((name) => name !== "php" && !name.startsWith("ext-") && !name.startsWith("lib-"));
}

export function installCommand(manager: DependencyManager): { executable: string; args: string[]; display: string } {
  const display = `${manager} install`;
  if (isWindows) {
    const program = manager === "composer" ? "composer" : `${manager}.cmd`;
    return { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `${program} install`], display };
  }
  return { executable: manager, args: ["install"], display };
}

/** Ordner, dessen Zeitstempel nach einer erfolgreichen Installation als Installationszeitpunkt gilt. */
export function installDirectory(installRoot: string, manager: DependencyManager): string {
  return path.join(installRoot, manager === "composer" ? "vendor" : "node_modules");
}

export async function markInstalled(installRoot: string, manager: DependencyManager): Promise<void> {
  const now = new Date();
  await utimes(installDirectory(installRoot, manager), now, now).catch(() => undefined);
}
