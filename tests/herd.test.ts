import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultHerdRoot, herdStack, waitForHerdServices } from "../src/herd.js";
import { scanWorkspace } from "../src/scanner.js";
import { resetStackCache, resolveStack } from "../src/stack-registry.js";
import type { AppConfig } from "../src/types.js";

function testConfig(root: string, herdRoot: string): AppConfig {
  return {
    host: "127.0.0.1", publicHost: "devhub", publicUrl: null, autostartMode: "dev", port: 7331, scanRoot: root,
    categoryDepth: 1, maxDepth: 5, maxEntriesPerProject: 5000, ignore: ["node_modules", ".git"],
    stack: "auto", laragonRoot: path.join(root, "no-laragon"), herdRoot, editor: "auto", terminal: "auto"
  };
}

// Baut eine Herd-Installation nach: Datenordner mit config/valet/config.json, Sites/ und Certificates/.
async function createHerd(root: string, parkedPath: string): Promise<string> {
  const herdRoot = path.join(root, "Herd");
  const valetHome = path.join(herdRoot, "config", "valet");
  await mkdir(path.join(valetHome, "Sites"), { recursive: true });
  await mkdir(path.join(valetHome, "Certificates"), { recursive: true });
  await writeFile(path.join(valetHome, "config.json"), JSON.stringify({ tld: "test", loopback: "127.0.0.1", paths: [parkedPath] }));
  return herdRoot;
}

test("liefert Standardordner je Plattform", () => {
  assert.equal(defaultHerdRoot("darwin", "/Users/jan"), "/Users/jan/Library/Application Support/Herd");
  assert.equal(defaultHerdRoot("win32", "C:\\Users\\jan"), path.join("C:\\Users\\jan", ".config", "herd"));
});

test("wartet auf die Herd-Dienste, bevor ein Befehl die App erreicht", async () => {
  const snapshots = [["herd"], ["herd", "nginx"], ["herd", "nginx", "php-fpm"]];
  const sleeps: number[] = [];
  const ready = await waitForHerdServices(async () => new Set(snapshots.shift() ?? []), {
    intervalMs: 10, settleMs: 50, sleep: async (ms) => { sleeps.push(ms); }
  });
  assert.equal(ready, true);
  assert.deepEqual(sleeps, [10, 10, 50]);

  const timedOut = await waitForHerdServices(async () => new Set(["herd"]), { timeoutMs: 30, intervalMs: 10, sleep: async () => {} });
  assert.equal(timedOut, false);
});

test("leitet Herd-Domains aus geparkten Ordnern, Links und Zertifikaten ab", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-herd-"));
  try {
    const workspace = path.join(root, "Herd-Workspace");
    await mkdir(path.join(workspace, "shop", "public"), { recursive: true });
    await writeFile(path.join(workspace, "shop", "public", "index.php"), "<?php echo 'shop';");
    await writeFile(path.join(workspace, "shop", "composer.json"), JSON.stringify({ require: { "laravel/framework": "^12" } }));
    await mkdir(path.join(workspace, "landing"), { recursive: true });
    await writeFile(path.join(workspace, "landing", "index.html"), "<!doctype html><title>Landing</title>");
    await mkdir(path.join(workspace, "spa", "src"), { recursive: true });
    await writeFile(path.join(workspace, "spa", "index.html"), '<script type="module" src="/src/main.ts"></script>');
    await writeFile(path.join(workspace, "spa", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const herdRoot = await createHerd(root, workspace);
    await writeFile(path.join(herdRoot, "config", "valet", "Certificates", "shop.test.crt"), "cert");

    const linked = path.join(root, "elsewhere", "kunde");
    await mkdir(linked, { recursive: true });
    await writeFile(path.join(linked, "index.php"), "<?php echo 'kunde';");
    let linkCreated = true;
    try {
      await symlink(linked, path.join(herdRoot, "config", "valet", "Sites", "kunde"), "dir");
    } catch {
      linkCreated = false; // Windows ohne Entwicklermodus erlaubt keine Symlinks.
    }

    const config = testConfig(workspace, herdRoot);
    resetStackCache();
    assert.equal((await resolveStack(config)).provider, "herd");
    const info = await herdStack.readWebInfo(config);
    const byName = new Map(info.sites.map((site) => [site.serverName, site]));
    assert.equal(info.documentRoot, null);
    assert.equal(byName.get("shop.test")?.url, "https://shop.test/");
    assert.equal(byName.get("shop.test")?.documentRoot, path.join(workspace, "shop", "public"));
    assert.equal(byName.get("landing.test")?.url, "http://landing.test/");
    // macOS liefert Temp-Pfade über /private/var; verglichen wird der aufgelöste Zielordner.
    if (linkCreated) assert.equal(byName.get("kunde.test")?.documentRoot, await realpath(linked));

    const projects = await scanWorkspace(config, path.join(root, "devhub"));
    const projectsByPath = new Map(projects.map((project) => [project.relativePath, project]));
    assert.equal(projectsByPath.get("shop")?.defaultUrl, "https://shop.test/");
    assert.equal(projectsByPath.get("landing")?.defaultUrl, "http://landing.test/");
    // Vite-Projekte brauchen ihren Dev-Server – die rohe index.html wäre über Herd unbrauchbar.
    assert.equal(projectsByPath.get("spa")?.defaultUrl, null);

    const status = await herdStack.getStatus(config);
    assert.equal(status.installed, true);
    assert.equal(status.name, "Herd");
    assert.equal(status.tld, "test");
    assert.ok(status.sites >= 2);
    assert.deepEqual(status.actions.map((action) => action.id).filter((id) => id !== "open"), ["start", "stop", "reload"]);
  } finally {
    resetStackCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("fällt ohne Stack auf ein leeres Modell zurück", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devhub-nostack-"));
  try {
    const config = { ...testConfig(root, path.join(root, "missing-herd")), stack: "auto" as const };
    resetStackCache();
    const stack = await resolveStack(config);
    assert.equal(stack.provider, "none");
    const status = await stack.getStatus(config);
    assert.equal(status.installed, false);
    assert.deepEqual(status.actions, []);
    await assert.rejects(() => stack.runAction(config, "start"), /kein lokaler Stack/);
  } finally {
    resetStackCache();
    await rm(root, { recursive: true, force: true });
  }
});
