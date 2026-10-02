import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProcessManager } from "../src/process-manager.js";
import type { LauncherDefinition } from "../src/types.js";

test("startet einen Prozess, erkennt seine URL und beendet ihn", async () => {
  const manager = new ProcessManager();
  const launcher: LauncherDefinition = {
    id: "test-launcher",
    projectId: "test-project",
    name: "dev",
    kind: "package-script",
    relativeCwd: ".",
    command: "node test-server.js",
    cwd: process.cwd(),
    executable: process.execPath,
    args: ["-e", "console.log('ready at http://localhost:43123/'); setInterval(() => {}, 1000)"],
    dynamicPort: false,
    preferred: true,
    port: null,
    parentId: null,
    parts: []
  };

  const running = await manager.start(launcher);
  assert.equal(running.status, "running");
  assert.ok(running.pid);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(manager.getSnapshot(launcher.id).url, "http://localhost:43123/");
  assert.ok(manager.getLogs(launcher.id).some((entry) => entry.text.includes("ready at")));

  await manager.stop(launcher.id);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(["stopped", "stopping"].includes(manager.getSnapshot(launcher.id).status));
  await manager.stopAll();
});

test("startet Batchdateien aus Windows-Pfaden mit Leerzeichen", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devhub batch "));
  const batchPath = path.join(directory, "start.bat");
  const manager = new ProcessManager();

  try {
    await writeFile(batchPath, "@echo off\r\necho DEVHUB_BATCH_OK\r\n", "utf8");
    const launcher: LauncherDefinition = {
      id: "batch-launcher",
      projectId: "batch-project",
      name: "start.bat",
      kind: "batch",
      relativeCwd: ".",
      command: '"start.bat"',
      cwd: directory,
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `call "${batchPath}"`],
      dynamicPort: false,
      preferred: true,
      port: null,
      parentId: null,
      parts: []
    };

    await manager.start(launcher);
    for (let attempt = 0; attempt < 50 && manager.getSnapshot(launcher.id).pid; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(manager.getSnapshot(launcher.id).exitCode, 0);
    assert.ok(manager.getLogs(launcher.id).some((entry) => entry.text.includes("DEVHUB_BATCH_OK")));
  } finally {
    await manager.stopAll();
    await rm(directory, { recursive: true, force: true });
  }
});
