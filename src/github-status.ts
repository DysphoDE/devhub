// Offene Pull Requests und der letzte CI-Lauf je GitHub-Repository, gelesen über die angemeldete GitHub CLI.
// Die Abfragen gehen übers Netz, deshalb werden sie zwei Minuten zwischengespeichert und nur auf Anfrage geladen.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cacheMs = 120_000;
const cache = new Map<string, { at: number; value: Promise<GitHubRepoStatus> }>();

export type CiState = "success" | "failure" | "running" | "cancelled";

export interface GitHubPullRequest {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  branch: string;
}

export interface GitHubRepoStatus {
  repo: string;
  pullRequestsUrl: string;
  pullRequests: GitHubPullRequest[];
  ci: { state: CiState; workflow: string; url: string; branch: string; updatedAt: string } | null;
  error: string | null;
}

/** owner/name aus einer GitHub-Web-Adresse, sonst null. */
export function githubRepository(remoteUrl: string | null): string | null {
  const match = remoteUrl?.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Fasst status und conclusion eines GitHub-Actions-Laufs zu einem Zustand zusammen. */
export function ciState(status: string, conclusion: string): CiState {
  if (status !== "completed") return "running";
  if (conclusion === "success" || conclusion === "skipped" || conclusion === "neutral") return "success";
  if (conclusion === "cancelled") return "cancelled";
  return "failure";
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 20_000, windowsHide: true, maxBuffer: 5_000_000,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" }
  });
  return stdout;
}

async function load(repo: string, branch: string | null): Promise<GitHubRepoStatus> {
  const status: GitHubRepoStatus = { repo, pullRequestsUrl: `https://github.com/${repo}/pulls`, pullRequests: [], ci: null, error: null };
  const [pulls, runs] = await Promise.allSettled([
    gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "20", "--json", "number,title,url,isDraft,headRefName"]),
    gh(["run", "list", "--repo", repo, "--limit", "1", "--json", "status,conclusion,url,workflowName,headBranch,updatedAt", ...(branch ? ["--branch", branch] : [])])
  ]);
  if (pulls.status === "fulfilled") {
    status.pullRequests = (JSON.parse(pulls.value || "[]") as Array<{ number: number; title: string; url: string; isDraft: boolean; headRefName: string }>)
      .map((pull) => ({ number: pull.number, title: pull.title, url: pull.url, draft: pull.isDraft, branch: pull.headRefName }));
  } else {
    status.error = "Pull Requests konnten nicht gelesen werden.";
  }
  if (runs.status === "fulfilled") {
    const [run] = JSON.parse(runs.value || "[]") as Array<{ status: string; conclusion: string; url: string; workflowName: string; headBranch: string; updatedAt: string }>;
    if (run) status.ci = { state: ciState(run.status, run.conclusion), workflow: run.workflowName, url: run.url, branch: run.headBranch, updatedAt: run.updatedAt };
  }
  return status;
}

export function readGitHubStatus(repo: string, branch: string | null, force = false): Promise<GitHubRepoStatus> {
  const key = `${repo}#${branch ?? ""}`;
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < cacheMs) return cached.value;
  const value = load(repo, branch);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** Prüft einmal, ob gh installiert und angemeldet ist. */
export async function githubCliReady(): Promise<{ ready: boolean; hint: string | null }> {
  try {
    await gh(["auth", "status"]);
    return { ready: true, hint: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ready: false, hint: code === "ENOENT" ? "Die GitHub CLI (gh) ist nicht installiert." : "Die GitHub CLI ist nicht angemeldet. Mit „gh auth login“ anmelden." };
  }
}
