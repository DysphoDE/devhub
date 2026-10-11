// Lokale Branches, die nicht mehr gebraucht werden: bereits im Standard-Branch enthalten ("gemergt")
// oder ihr Remote-Branch wurde gelöscht ("gone", etwa nach einem Squash-Merge auf GitHub).
// Standard- und Dauer-Branches wie main oder develop gelten nie als alt.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const protectedBranches = new Set(["main", "master", "develop", "development", "trunk", "staging", "production"]);

export interface LocalBranchState {
  name: string;
  current: boolean;
  /** Im Standard-Branch enthalten, löschen ist ohne Verlust möglich. */
  merged: boolean;
  /** Der verfolgte Remote-Branch existiert nicht mehr. */
  gone: boolean;
}

async function run(repository: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync("git", ["-C", repository, ...args], { timeout: 5000, windowsHide: true, maxBuffer: 2_000_000 })).stdout;
  } catch {
    return "";
  }
}

/** Liest `for-each-ref refs/heads` im Format name␟HEAD␟upstream:track und markiert gemergte Branches. */
export function parseBranchStates(refs: string, merged: string): LocalBranchState[] {
  const mergedNames = new Set(merged.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return refs.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name = "", head = "", track = ""] = line.split("\x1f");
    return { name, current: head === "*", merged: mergedNames.has(name), gone: track.includes("gone") };
  }).filter((branch) => branch.name);
}

/** Der Branch, gegen den "gemergt" geprüft wird: Standard-Branch des Remotes, sonst main, master, develop oder trunk. */
export function chooseBaseBranch(remoteHead: string, localNames: string[]): string | null {
  const fromRemote = remoteHead.trim().replace(/^[^/]+\//, "");
  if (fromRemote && localNames.includes(fromRemote)) return fromRemote;
  return ["main", "master", "develop", "trunk"].find((name) => localNames.includes(name)) ?? null;
}

export function cleanupCandidates(base: string | null, branches: LocalBranchState[]): LocalBranchState[] {
  return branches.filter((branch) => !branch.current && branch.name !== base && !protectedBranches.has(branch.name) && (branch.merged || branch.gone));
}

export async function readLocalBranchStates(repository: string): Promise<{ base: string | null; branches: LocalBranchState[] }> {
  const [remoteHead, refs] = await Promise.all([
    run(repository, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]),
    run(repository, ["for-each-ref", "refs/heads", "--format=%(refname:short)%1f%(HEAD)%1f%(upstream:track)"])
  ]);
  const unmerged = parseBranchStates(refs, "");
  const base = chooseBaseBranch(remoteHead, unmerged.map((branch) => branch.name));
  const merged = base ? await run(repository, ["for-each-ref", `--merged=refs/heads/${base}`, "refs/heads", "--format=%(refname:short)"]) : "";
  return { base, branches: parseBranchStates(refs, merged) };
}

/** Namen der lokalen Branches, die aufgeräumt werden können. */
export async function readStaleBranches(repository: string): Promise<string[]> {
  const { base, branches } = await readLocalBranchStates(repository);
  return cleanupCandidates(base, branches).map((branch) => branch.name);
}
