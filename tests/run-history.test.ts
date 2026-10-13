import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RunHistory, runFromSnapshot } from "../src/run-history.js";
import type { RuntimeSnapshot } from "../src/types.js";

const snapshot = (values: Partial<RuntimeSnapshot>): RuntimeSnapshot => ({
  status: "stopped", pid: null, startedAt: "2026-10-13T10:00:00.000Z", stoppedAt: "2026-10-13T10:00:14.000Z", exitCode: 0, url: null, message: null, ...values
});

test("leitet das Ergebnis eines beendeten Laufs ab", () => {
  assert.equal(runFromSnapshot(snapshot({}))?.outcome, "success");
  assert.equal(runFromSnapshot(snapshot({ status: "error", exitCode: 1 }))?.outcome, "failed");
  assert.equal(runFromSnapshot(snapshot({ exitCode: null }))?.outcome, "cancelled", "über DevHub gestoppt");
  assert.equal(runFromSnapshot(snapshot({ status: "running", stoppedAt: null })), null);
  assert.equal(runFromSnapshot(snapshot({ stoppedAt: null })), null, "nie gelaufen");
});

test("speichert den letzten Lauf und liest ihn nach einem Neustart wieder", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devhub-runs-"));
  try {
    const file = path.join(directory, ".devhub", "runs.json");
    const history = new RunHistory(file);
    await history.load();
    const run = runFromSnapshot(snapshot({}))!;
    assert.equal(history.record("build", run), true);
    assert.equal(history.record("build", run), false, "derselbe Lauf zählt nur einmal");
    await history.flush();
    assert.ok(JSON.parse(await readFile(file, "utf8")).build);

    const restarted = new RunHistory(file);
    await restarted.load();
    assert.deepEqual(restarted.get("build"), run);
    assert.equal(restarted.get("test"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
