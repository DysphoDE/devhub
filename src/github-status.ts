// Offene Pull Requests und der letzte CI-Lauf je GitHub-Repository, gelesen mit dem Token der angemeldeten GitHub CLI.
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

// Die REST-API wird direkt angefragt statt über gh pr list und gh run list: Zwei gh-Prozesse pro Repository
// kosten unter Windows bei 40 Repositories rund 20 Sekunden Rechenzeit, die Anfragen hier wenige Sekunden.
async function githubApi<T>(token: string, pathname: string): Promise<T> {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "devhub" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`GitHub antwortet mit ${response.status}.`);
  return response.json() as Promise<T>;
}

async function load(repo: string, branch: string | null): Promise<GitHubRepoStatus> {
  const status: GitHubRepoStatus = { repo, pullRequestsUrl: `https://github.com/${repo}/pulls`, pullRequests: [], ci: null, error: null };
  const token = await githubToken();
  if (!token) return { ...status, error: "Die GitHub CLI ist nicht angemeldet." };
  const [pulls, runs] = await Promise.allSettled([
    githubApi<Array<{ number: number; title: string; html_url: string; draft: boolean; head: { ref: string } }>>(token, `/repos/${repo}/pulls?state=open&per_page=20`),
    githubApi<{ workflow_runs: Array<{ status: string; conclusion: string | null; html_url: string; name: string; head_branch: string; updated_at: string }> }>(token, `/repos/${repo}/actions/runs?per_page=1${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`)
  ]);
  if (pulls.status === "fulfilled") {
    status.pullRequests = pulls.value.map((pull) => ({ number: pull.number, title: pull.title, url: pull.html_url, draft: pull.draft, branch: pull.head.ref }));
  } else {
    status.error = "Pull Requests konnten nicht gelesen werden.";
  }
  if (runs.status === "fulfilled") {
    const [run] = runs.value.workflow_runs;
    if (run) status.ci = { state: ciState(run.status, run.conclusion ?? ""), workflow: run.name, url: run.html_url, branch: run.head_branch, updatedAt: run.updated_at };
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

// Das Token der GitHub CLI; gh fragt dafür den Schlüsselbund, deshalb wird es fünf Minuten gehalten.
let tokenCache: { at: number; value: Promise<string | null> } | null = null;
export function githubToken(): Promise<string | null> {
  if (!tokenCache || Date.now() - tokenCache.at > 300_000) {
    tokenCache = { at: Date.now(), value: gh(["auth", "token"]).then((value) => value.trim() || null, () => null) };
  }
  return tokenCache.value;
}

export interface GitHubRefs {
  heads: Record<string, string>;
  tags: Record<string, string>;
}

type RefConnection = { totalCount: number; nodes: Array<{ name: string; target: { oid: string } | null }> } | null;

/**
 * Branches und Tags mehrerer Repositories (owner/name) über die GraphQL-API, in kleinen parallelen Abfragen:
 * Eine große Abfrage arbeitet GitHub nacheinander ab, Viererpakete sind deutlich schneller. Repositories mit
 * mehr als 100 Branches oder Tags fehlen im Ergebnis und werden dann normal geholt.
 */
export async function readGitHubRefs(repositories: string[], token: string): Promise<Map<string, GitHubRefs>> {
  const unique = [...new Set(repositories.map((repo) => repo.toLowerCase()))];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += 4) chunks.push(unique.slice(index, index + 4));
  const refs = (prefix: string) => `refs(refPrefix:${JSON.stringify(prefix)},first:100){totalCount nodes{name target{oid}}}`;
  const result = new Map<string, GitHubRefs>();
  await Promise.all(chunks.map(async (chunk) => {
    const query = chunk.map((repo, index) => {
      const [owner, name] = repo.split("/");
      return `r${index}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){heads:${refs("refs/heads/")} tags:${refs("refs/tags/")}}`;
    }).join(" ");
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "devhub" },
      body: JSON.stringify({ query: `query{${query}}` }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return;
    // Fehlt der Zugriff auf ein Repository, ist nur dessen Eintrag null; der Rest bleibt verwertbar.
    const { data } = await response.json() as { data?: Record<string, { heads: RefConnection; tags: RefConnection } | null> };
    chunk.forEach((repo, index) => {
      const entry = data?.[`r${index}`];
      const complete = (connection: RefConnection) => connection && connection.totalCount <= connection.nodes.length && connection.nodes.every((node) => node.target?.oid);
      if (!entry || !complete(entry.heads) || !complete(entry.tags)) return;
      const map = (connection: RefConnection) => Object.fromEntries(connection!.nodes.map((node) => [node.name, node.target!.oid]));
      result.set(repo, { heads: map(entry.heads), tags: map(entry.tags) });
    });
  }).map((chunk) => chunk.catch(() => undefined)));
  return result;
}

/**
 * Umgebung für git fetch gegen github.com mit dem Token der GitHub CLI. Der Git Credential Manager braucht unter
 * Windows pro Fetch rund 1,5 Sekunden für Start und Speichern; der Header macht ihn überflüssig. Die Werte stehen in
 * GIT_CONFIG_* statt auf der Kommandozeile, damit das Token nicht in der Prozessliste auftaucht.
 */
export function githubFetchEnv(token: string): NodeJS.ProcessEnv {
  const offset = Number(process.env.GIT_CONFIG_COUNT) || 0;
  return {
    GIT_CONFIG_COUNT: String(offset + 1),
    [`GIT_CONFIG_KEY_${offset}`]: "http.https://github.com/.extraheader",
    [`GIT_CONFIG_VALUE_${offset}`]: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
  };
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
