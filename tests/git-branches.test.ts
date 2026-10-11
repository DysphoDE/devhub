import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runGitAction } from "../src/git-actions.js";
import { chooseBaseBranch, cleanupCandidates, parseBranchStates, readLocalBranchStates } from "../src/git-branches.js";
import { readGitInfo } from "../src/scanner.js";
import type { ProjectDefinition } from "../src/types.js";

const exec = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", root, ...args], { env })).stdout.trim();
}

test("parses branch states and picks the base branch", () => {
  const states = parseBranchStates(["main\x1f*\x1f", "feature/done\x1f\x1f", "feature/squashed\x1f\x1f[gone]", "develop\x1f\x1f"].join("\n"), "main\nfeature/done\ndevelop\n");
  assert.deepEqual(states.map((branch) => [branch.name, branch.current, branch.merged, branch.gone]), [
    ["main", true, true, false], ["feature/done", false, true, false], ["feature/squashed", false, false, true], ["develop", false, true, false]
  ]);
  assert.deepEqual(cleanupCandidates("main", states).map((branch) => branch.name), ["feature/done", "feature/squashed"]);
  assert.equal(chooseBaseBranch("origin/trunk\n", ["main", "trunk"]), "trunk");
  assert.equal(chooseBaseBranch("", ["feature", "master"]), "master");
  assert.equal(chooseBaseBranch("", ["feature"]), null);
});

test("finds merged and gone branches and deletes only those", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-branches-"));
  try {
    const remote = path.join(root, "remote.git");
    const repository = path.join(root, "project");
    await mkdir(repository);
    await exec("git", ["init", "--bare", "-b", "main", remote], { env });
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.name", "Test");
    await git(repository, "config", "user.email", "test@example.test");
    await writeFile(path.join(repository, "a.txt"), "a\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "Start");
    await git(repository, "remote", "add", "origin", remote);
    await git(repository, "push", "-u", "origin", "main");

    await git(repository, "branch", "feature/done");
    await git(repository, "switch", "-c", "feature/open");
    await writeFile(path.join(repository, "b.txt"), "b\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "Offen");
    await git(repository, "switch", "-c", "feature/squashed");
    await git(repository, "push", "-u", "origin", "feature/squashed");
    await git(repository, "push", "origin", "--delete", "feature/squashed");
    await git(repository, "fetch", "--prune");
    await git(repository, "switch", "main");

    const { base, branches } = await readLocalBranchStates(repository);
    assert.equal(base, "main");
    assert.deepEqual(cleanupCandidates(base, branches).map((branch) => branch.name).sort(), ["feature/done", "feature/squashed"]);

    const project = { id: "abc", name: "Test", absolutePath: repository, relativePath: "project", git: await readGitInfo(repository, repository) } as ProjectDefinition;
    assert.deepEqual([...project.git!.staleBranches].sort(), ["feature/done", "feature/squashed"]);
    await assert.rejects(runGitAction(project, "delete-branches", { branches: ["feature/open"] }), /kann nicht aufgeräumt werden/);
    await runGitAction(project, "delete-branches", { branches: ["feature/done", "feature/squashed"] });
    assert.deepEqual((await git(repository, "branch", "--format=%(refname:short)")).split("\n").sort(), ["feature/open", "main"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
