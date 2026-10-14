import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fetchAllRepositories, onGitProgress, parseGitProgress, readGitCommit, readGitDiff, readGitHistory, readRefsFromDisk, refsMatchRemote, runGitAction, suggestGitCommitMessage, type GitTransferProgress, type RemoteRefs } from "../src/git-actions.js";
import { readGitInfo, scanWorkspace } from "../src/scanner.js";
import type { AppConfig } from "../src/types.js";

const execFileAsync = promisify(execFile);

function testConfig(root: string): AppConfig {
  return {
    host: "127.0.0.1", publicHost: "devhub", publicUrl: null, autostartMode: "dev", port: 7331,
    scanRoot: root, categoryDepth: 3, maxDepth: 5, maxEntriesPerProject: 5000,
    ignore: ["node_modules", ".git", "dist", "build"], stack: "none",
    laragonRoot: path.join(root, "no-laragon"), herdRoot: path.join(root, "no-herd"), editor: "auto", terminal: "auto"
  };
}

async function git(repository: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repository, ...args], { windowsHide: true });
}

test("committet bereits vorgemerkte Löschungen zusammen mit neuen Dateien", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-git-"));
  try {
    const projectPath = path.join(root, "git-project");
    await mkdir(projectPath);
    await git(projectPath, "init", "-b", "main");
    await git(projectPath, "config", "core.autocrlf", "false");
    await git(projectPath, "config", "user.name", "DevHub Test");
    await git(projectPath, "config", "user.email", "devhub@example.test");
    await writeFile(path.join(projectPath, "old.txt"), "old\n");
    await git(projectPath, "add", "old.txt");
    await git(projectPath, "commit", "-m", "Initial commit");
    await git(projectPath, "rm", "-q", "old.txt");
    await writeFile(path.join(projectPath, "new.txt"), "new\n");

    const [project] = await scanWorkspace(testConfig(root), path.join(root, "devhub-node"));
    await runGitAction(project, "stage-files", { files: ["old.txt"] });
    await runGitAction(project, "commit-files", { files: ["old.txt", "new.txt"], message: "Replace old file" });
    project.git = await readGitInfo(projectPath, projectPath);
    assert.equal(project.git?.lastCommit?.subject, "Replace old file");
    assert.equal(project.git?.files.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listet Git-Dateien und committet nur vorgemerkte Änderungen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-git-"));
  try {
    const projectPath = path.join(root, "git-project");
    await mkdir(projectPath);
    await git(projectPath, "init", "-b", "main");
    await git(projectPath, "config", "core.autocrlf", "false");
    await git(projectPath, "config", "user.name", "DevHub Test");
    await git(projectPath, "config", "user.email", "devhub@example.test");
    await writeFile(path.join(projectPath, "tracked.txt"), "initial\n");
    await git(projectPath, "add", "tracked.txt");
    await git(projectPath, "commit", "-m", "Initial commit");
    await writeFile(path.join(projectPath, "tracked.txt"), "changed\n");
    await writeFile(path.join(projectPath, "new file.txt"), "new\n");

    const [project] = await scanWorkspace(testConfig(root), path.join(root, "devhub-node"));
    assert.ok(project.git);
    assert.equal(project.git.unstaged, 1);
    assert.equal(project.git.untracked, 1);
    assert.deepEqual(project.git.files.map((file) => file.path).sort(), ["new file.txt", "tracked.txt"]);
    const workingDiff = await readGitDiff(project, "tracked.txt");
    assert.equal(workingDiff[0].scope, "working");
    assert.match(workingDiff[0].patch, /-initial/);
    assert.match(workingDiff[0].patch, /\+changed/);
    const newFileDiff = await readGitDiff(project, "new file.txt");
    assert.match(newFileDiff[0].patch, /\+new/);

    await runGitAction(project, "stage-files", { files: ["tracked.txt", "new file.txt"] });
    project.git = await readGitInfo(projectPath, projectPath);
    assert.equal(project.git?.staged, 2);
    assert.equal(await suggestGitCommitMessage(project), "Update new file.txt and tracked.txt");
    await runGitAction(project, "unstage-files", { files: ["new file.txt"] });
    project.git = await readGitInfo(projectPath, projectPath);
    assert.equal(project.git?.staged, 1);
    assert.equal(project.git?.untracked, 1);
    assert.equal(await suggestGitCommitMessage(project), "Update tracked.txt");
    const stagedDiff = await readGitDiff(project, "tracked.txt");
    assert.equal(stagedDiff[0].scope, "staged");

    await runGitAction(project, "commit", { message: "Update tracked file" });
    project.git = await readGitInfo(projectPath, projectPath);
    assert.equal(project.git?.lastCommit?.subject, "Update tracked file");
    assert.equal(project.git?.staged, 0);
    assert.equal(project.git?.untracked, 1);
    const history = await readGitHistory(project, 0, 20);
    assert.equal(history.commits.length, 2);
    assert.equal(history.commits[0].subject, "Update tracked file");
    assert.equal(history.hasMore, false);
    const commit = await readGitCommit(project, history.commits[0].hash);
    assert.equal(commit.subject, "Update tracked file");
    assert.ok(commit.files.some((file) => file.path === "tracked.txt"));
    assert.match(commit.patch, /\+changed/);

    await writeFile(path.join(projectPath, "tracked.txt"), "staged discard\n");
    await git(projectPath, "add", "tracked.txt");
    await writeFile(path.join(projectPath, "tracked.txt"), "discard this too\n");
    await writeFile(path.join(projectPath, "temporary.txt"), "temporary\n");
    project.git = await readGitInfo(projectPath, projectPath);
    await runGitAction(project, "discard-files", { files: ["tracked.txt", "temporary.txt"] });
    assert.equal((await readFile(path.join(projectPath, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n"), "changed\n");
    await assert.rejects(readFile(path.join(projectPath, "temporary.txt"), "utf8"));
    project.git = await readGitInfo(projectPath, projectPath);
    assert.deepEqual(project.git?.files.map((file) => file.path), ["new file.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ruft Remote-Änderungen ab und übernimmt sie nur per Fast-forward", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-git-sync-"));
  try {
    const projectPath = path.join(root, "local-project");
    const remotePath = path.join(root, "remote.git");
    const writerPath = path.join(root, "_remote-writer");
    await mkdir(projectPath);
    await execFileAsync("git", ["init", "--bare", remotePath], { windowsHide: true });
    await git(projectPath, "init", "-b", "main");
    await git(projectPath, "config", "user.name", "DevHub Test");
    await git(projectPath, "config", "user.email", "devhub@example.test");
    await writeFile(path.join(projectPath, "tracked.txt"), "initial\n");
    await git(projectPath, "add", "tracked.txt");
    await git(projectPath, "commit", "-m", "Initial commit");
    await git(projectPath, "remote", "add", "origin", remotePath);
    await git(projectPath, "push", "-u", "origin", "main");

    await execFileAsync("git", ["clone", remotePath, writerPath], { windowsHide: true });
    await git(writerPath, "config", "user.name", "Remote Test");
    await git(writerPath, "config", "user.email", "remote@example.test");
    await git(writerPath, "checkout", "main");
    await writeFile(path.join(writerPath, "remote.txt"), "remote change\n");
    await git(writerPath, "add", "remote.txt");
    await git(writerPath, "commit", "-m", "Remote update");
    await git(writerPath, "push", "origin", "main");

    const projects = await scanWorkspace(testConfig(root), path.join(root, "devhub-node"));
    const project = projects.find((candidate) => candidate.relativePath === "local-project");
    assert.ok(project?.git);
    const events: Array<[string, GitTransferProgress | null]> = [];
    const unsubscribe = onGitProgress((key, progress) => events.push([key, progress]));
    try {
      await runGitAction(project, "fetch", {});
    } finally {
      unsubscribe();
    }
    const repository = path.resolve(project.absolutePath, project.git.repositoryRoot);
    assert.ok(events.length >= 2);
    assert.ok(events.every(([key]) => key === repository));
    assert.ok(events.slice(0, -1).every(([, progress]) => progress?.phase));
    assert.equal(events.at(-1)?.[1], null);
    project.git = await readGitInfo(projectPath, projectPath);
    assert.equal(project.git?.behind, 1);
    await runGitAction(project, "pull", {});
    project.git = await readGitInfo(projectPath, projectPath);
    assert.equal(project.git?.behind, 0);
    assert.equal(project.git?.lastCommit?.subject, "Remote update");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("liest Fortschrittszeilen von git --progress", () => {
  assert.deepEqual(parseGitProgress("Receiving objects:  45% (183/407), 42.00 MiB | 5.00 MiB/s"), { phase: "Empfange", percent: 45, amount: "42.00 MiB", rate: "5.00 MiB/s" });
  assert.deepEqual(parseGitProgress("remote: Compressing objects: 100% (266/266), done.        "), { phase: "Remote komprimiert", percent: 100, amount: null, rate: null });
  assert.deepEqual(parseGitProgress("remote: Enumerating objects: 422, done."), { phase: "Remote bereitet vor", percent: null, amount: null, rate: null });
  assert.deepEqual(parseGitProgress("Writing objects:  12% (3/25), 1.20 MiB | 600.00 KiB/s"), { phase: "Sende", percent: 12, amount: "1.20 MiB", rate: "600.00 KiB/s" });
  assert.deepEqual(parseGitProgress("Unpacking objects: 100% (3/3), 254 bytes | 254.00 KiB/s, done."), { phase: "Empfange", percent: 100, amount: "254 bytes", rate: "254.00 KiB/s" });
  assert.equal(parseGitProgress("remote: Total 422 (delta 268), reused 262 (delta 150), pack-reused 0"), null);
  assert.equal(parseGitProgress("Cloning into 'quizzly'..."), null);
  assert.equal(parseGitProgress("fatal: Authentication failed for 'https://github.com/owner/repo.git/'"), null);
});

test("holt alle Repositories einmal und parallel, überspringt belegte und meldet Fehler", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-git-"));
  try {
    const remotes = path.join(root, "remotes");
    const workspace = path.join(root, "workspace");
    const seed = path.join(root, "seed");
    await mkdir(remotes);
    await mkdir(workspace);
    await mkdir(seed);
    await git(seed, "init", "-b", "main");
    await git(seed, "config", "user.name", "DevHub Test");
    await git(seed, "config", "user.email", "devhub@example.test");
    await writeFile(path.join(seed, "readme.txt"), "one\n");
    await git(seed, "add", "readme.txt");
    await git(seed, "commit", "-m", "Initial commit");
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      await execFileAsync("git", ["clone", "-q", "--bare", seed, path.join(remotes, `${name}.git`)]);
      await execFileAsync("git", ["clone", "-q", path.join(remotes, `${name}.git`), path.join(workspace, name)]);
    }
    await git(path.join(workspace, "gamma"), "remote", "set-url", "origin", path.join(remotes, "missing.git"));
    await writeFile(path.join(seed, "readme.txt"), "two\n");
    await git(seed, "commit", "-am", "Remote change");
    await git(seed, "push", "-q", path.join(remotes, "alpha.git"), "main");

    const projects = await scanWorkspace(testConfig(workspace), path.join(root, "devhub-node"));
    const alpha = projects.find((project) => project.relativePath === "alpha")!;
    // Zweites Projekt im selben Repository, wie Frontend und Backend eines Monorepos.
    projects.push({ ...alpha, id: "alpha-frontend", name: "Alpha Frontend" });
    const delta = path.join(workspace, "delta");

    const claimed: string[] = [];
    const settled = new Map<string, string[]>();
    let running = 0;
    let maxRunning = 0;
    const result = await fetchAllRepositories(projects, {
      claim: (repository) => {
        if (repository === delta) return false;
        claimed.push(repository);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        return true;
      },
      settle: async (repository, members) => {
        running -= 1;
        settled.set(path.basename(repository), members.map((member) => member.id === "alpha-frontend" ? member.name : member.relativePath).sort());
      }
    });

    assert.equal(result.fetched, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.failed.map((item) => item.name), ["Gamma"]);
    assert.equal(claimed.length, 3);
    assert.ok(maxRunning > 1, "Fetches sollen gleichzeitig laufen");
    assert.deepEqual(settled.get("alpha"), ["Alpha Frontend", "alpha"]);
    assert.ok(settled.has("gamma"), "auch nach einem Fehler wird das Repository freigegeben");
    assert.ok(!settled.has("delta"));
    const remoteHead = (await execFileAsync("git", ["-C", path.join(workspace, "alpha"), "log", "-1", "--format=%s", "origin/main"])).stdout.trim();
    assert.equal(remoteHead, "Remote change");
    const alphaEntry = result.snapshot.entries.find((entry) => entry.name === alpha.name)!;
    assert.equal(alphaEntry.state, "updated");
    assert.deepEqual(alphaEntry.ids.sort(), [alpha.id, "alpha-frontend"].sort());
    assert.deepEqual(alphaEntry.changes, [{ name: "main", kind: "branch", change: "updated", commits: 1 }]);
    assert.equal(result.snapshot.entries.find((entry) => entry.name === "Beta")?.state, "current");
    assert.equal(result.snapshot.phase, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vergleicht lokale Refs mit dem Remote-Stand", () => {
  const local = new Map([["refs/remotes/origin/HEAD", "a"], ["refs/remotes/origin/main", "a"], ["refs/remotes/origin/dev", "b"], ["refs/tags/v1", "t"], ["refs/tags/lokal", "x"]]);
  assert.ok(refsMatchRemote(local, "origin", { heads: { main: "a", dev: "b" }, tags: { v1: "t" } }));
  assert.ok(!refsMatchRemote(local, "origin", { heads: { main: "c", dev: "b" }, tags: {} }), "Branch bewegt");
  assert.ok(!refsMatchRemote(local, "origin", { heads: { main: "a" }, tags: {} }), "Branch auf dem Remote gelöscht");
  assert.ok(!refsMatchRemote(local, "origin", { heads: { main: "a", dev: "b", neu: "d" }, tags: {} }), "neuer Branch");
  assert.ok(!refsMatchRemote(local, "origin", { heads: { main: "a", dev: "b" }, tags: { v2: "u" } }), "neues Tag");
});

test("überspringt den Fetch, wenn der bekannte Remote-Stand schon lokal ist, und meldet neue Branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-git-"));
  try {
    const remote = path.join(root, "remote.git");
    const workspace = path.join(root, "workspace");
    const seed = path.join(root, "seed");
    await mkdir(workspace);
    await mkdir(seed);
    await git(seed, "init", "-b", "main");
    await git(seed, "config", "user.name", "DevHub Test");
    await git(seed, "config", "user.email", "devhub@example.test");
    await writeFile(path.join(seed, "readme.txt"), "one\n");
    await git(seed, "add", "readme.txt");
    await git(seed, "commit", "-m", "Initial commit");
    await execFileAsync("git", ["clone", "-q", "--bare", seed, remote]);
    await execFileAsync("git", ["clone", "-q", remote, path.join(workspace, "alpha")]);
    const alpha = path.join(workspace, "alpha");
    const head = (await execFileAsync("git", ["-C", alpha, "rev-parse", "origin/main"])).stdout.trim();
    const projects = await scanWorkspace(testConfig(workspace), path.join(root, "devhub-node"));
    const options = (lookup: Map<string, RemoteRefs>, changedFlags: boolean[]) => ({
      claim: () => true,
      settle: async (_repository: string, _members: unknown, changed: boolean) => { changedFlags.push(changed); },
      lookup: async () => lookup
    });

    const flags: boolean[] = [];
    const quiet = await fetchAllRepositories(projects, options(new Map([[alpha, { heads: { main: head }, tags: {} }]]), flags));
    assert.equal(quiet.fetched, 0);
    assert.equal(quiet.current, 1);
    assert.equal(quiet.snapshot.entries[0].verified, true);
    assert.deepEqual(flags, [false]);

    await git(seed, "push", "-q", remote, "main:feature/neu");
    await git(seed, "tag", "v1");
    await git(seed, "push", "-q", remote, "v1");
    // Der veraltete Stand aus der API stimmt nicht mehr: jetzt wird wirklich geholt.
    const loud = await fetchAllRepositories(projects, options(new Map([[alpha, { heads: { main: head, "feature/neu": head }, tags: {} }]]), flags));
    assert.equal(loud.fetched, 1);
    assert.equal(loud.updated, 1);
    assert.deepEqual(loud.snapshot.entries[0].changes, [
      { name: "feature/neu", kind: "branch", change: "new", commits: null },
      { name: "v1", kind: "tag", change: "new", commits: null }
    ]);
    assert.deepEqual(flags, [false, true]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("liest Refs aus .git genauso wie git for-each-ref", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-git-"));
  try {
    const seed = path.join(root, "seed");
    const clone = path.join(root, "clone");
    await mkdir(seed);
    await git(seed, "init", "-b", "main");
    await git(seed, "config", "user.name", "DevHub Test");
    await git(seed, "config", "user.email", "devhub@example.test");
    await writeFile(path.join(seed, "readme.txt"), "one\n");
    await git(seed, "add", "readme.txt");
    await git(seed, "commit", "-m", "Initial commit");
    await git(seed, "branch", "feature/a");
    await git(seed, "tag", "-a", "v1", "-m", "Release");
    await git(seed, "tag", "leicht");
    await execFileAsync("git", ["clone", "-q", seed, clone]);
    // Ein Teil gepackt, ein Teil lose: Danach kommt ein neuer Commit, dessen Ref als Datei neben packed-refs liegt.
    await git(clone, "pack-refs", "--all");
    await writeFile(path.join(seed, "readme.txt"), "two\n");
    await git(seed, "commit", "-am", "Second");
    await git(clone, "fetch", "-q", "origin");
    const expected = (await execFileAsync("git", ["-C", clone, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin/", "refs/tags/"])).stdout.trim().split(/\r?\n/)
      .filter((line) => !line.startsWith("refs/remotes/origin/HEAD ")).sort();
    const actual = await readRefsFromDisk(clone, ["refs/remotes/origin/", "refs/tags/"]);
    assert.ok(actual);
    assert.deepEqual([...actual].map(([name, oid]) => `${name} ${oid}`).sort(), expected);
    assert.equal(await readRefsFromDisk(path.join(root, "kein-repo"), ["refs/tags/"]), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
