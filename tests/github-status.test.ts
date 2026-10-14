import assert from "node:assert/strict";
import test from "node:test";
import { ciState, githubFetchEnv, githubRepository } from "../src/github-status.js";

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

test("passes the GitHub token to git through GIT_CONFIG_* instead of the command line", () => {
  const previous = process.env.GIT_CONFIG_COUNT;
  try {
    delete process.env.GIT_CONFIG_COUNT;
    const env = githubFetchEnv("abc");
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
    assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("x-access-token:abc").toString("base64")}`);
    // Bereits gesetzte Einträge bleiben erhalten, der neue kommt dahinter.
    process.env.GIT_CONFIG_COUNT = "2";
    assert.equal(githubFetchEnv("abc").GIT_CONFIG_KEY_2, "http.https://github.com/.extraheader");
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = previous;
  }
});
