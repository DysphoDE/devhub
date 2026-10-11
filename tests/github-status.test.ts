import assert from "node:assert/strict";
import test from "node:test";
import { ciState, githubRepository } from "../src/github-status.js";

test("reads owner/name only from GitHub addresses", () => {
  assert.equal(githubRepository("https://github.com/DysphoDE/devhub"), "DysphoDE/devhub");
  assert.equal(githubRepository("https://github.com/DysphoDE/devhub.git"), "DysphoDE/devhub");
  assert.equal(githubRepository("https://gitlab.com/team/app"), null);
  assert.equal(githubRepository(null), null);
});

test("summarises GitHub Actions runs", () => {
  assert.equal(ciState("in_progress", ""), "running");
  assert.equal(ciState("queued", ""), "running");
  assert.equal(ciState("completed", "success"), "success");
  assert.equal(ciState("completed", "skipped"), "success");
  assert.equal(ciState("completed", "cancelled"), "cancelled");
  assert.equal(ciState("completed", "failure"), "failure");
  assert.equal(ciState("completed", "timed_out"), "failure");
});
