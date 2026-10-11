import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { composerDependencyCheck, composerNeedsInstall, markInstalled, nodeDependencyCheck } from "../src/dependencies.js";

async function withDirectory(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-deps-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
async function age(target: string, seconds: number) { await utimes(target, ago(seconds), ago(seconds)); }

test("reports missing node_modules and an outdated lockfile until the next install", () => withDirectory(async (root) => {
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vite: "^5.0.0" } }));
  await writeFile(path.join(root, "package-lock.json"), "{}");
  assert.deepEqual(await nodeDependencyCheck(root, root, "npm"), { installRoot: root, state: "missing" });

  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", ".package-lock.json"), "{}");
  await age(path.join(root, "package-lock.json"), 60);
  assert.equal(await nodeDependencyCheck(root, root, "npm"), null);

  await age(path.join(root, "node_modules", ".package-lock.json"), 120);
  await age(path.join(root, "node_modules"), 120);
  assert.deepEqual(await nodeDependencyCheck(root, root, "npm"), { installRoot: root, state: "outdated" });

  await markInstalled(root, "npm");
  assert.equal(await nodeDependencyCheck(root, root, "npm"), null);
}));

test("accepts node_modules hoisted to the workspace root and installs there", () => withDirectory(async (root) => {
  const app = path.join(root, "packages", "app");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(root, "pnpm-lock.yaml"), "");
  assert.deepEqual(await nodeDependencyCheck(app, root, "pnpm"), { installRoot: root, state: "missing" });
  await mkdir(path.join(root, "node_modules"));
  await age(path.join(root, "pnpm-lock.yaml"), 60);
  assert.equal(await nodeDependencyCheck(app, root, "pnpm"), null);
}));

test("checks composer vendor and ignores platform-only requirements", () => withDirectory(async (root) => {
  assert.equal(composerNeedsInstall({ php: "^8.2", "ext-json": "*" }), false);
  assert.equal(composerNeedsInstall({ php: "^8.2" }, { "phpunit/phpunit": "^11" }), true);
  await writeFile(path.join(root, "composer.lock"), "{}");
  assert.deepEqual(await composerDependencyCheck(root), { installRoot: root, state: "missing" });
  await mkdir(path.join(root, "vendor", "composer"), { recursive: true });
  await writeFile(path.join(root, "vendor", "composer", "installed.json"), "{}");
  await age(path.join(root, "composer.lock"), 60);
  assert.equal(await composerDependencyCheck(root), null);
}));
