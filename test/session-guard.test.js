// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionGuard } from "../public/session-guard.js";

test("session guard rejects a token after a namespace or auth-revision transition", () => {
  const guard = createSessionGuard();
  assert.deepEqual(guard.begin(), { epoch: 0, userKey: "guest", authRevision: 0 });
  const token = guard.transition("u1", 7);
  assert.equal(guard.isCurrent(token, "u1", 7), true);
  guard.transition("u2", 7);
  assert.equal(guard.isCurrent(token, "u1", 7), false);
  assert.equal(guard.isCurrent(guard.begin(), "u2", 7), true);
  assert.equal(guard.isCurrent(guard.begin(), "u2", 8), false);
});

test("session guard: capture uses the current epoch and is invalid before transition", () => {
  const guard = createSessionGuard();
  const captured = guard.capture("u1", 1);
  assert.deepEqual(captured, { epoch: 0, userKey: "u1", authRevision: 1 });
  assert.equal(guard.isCurrent(captured, "u1", 1), false);
  guard.transition("u1", 1);
  assert.equal(guard.isCurrent(guard.capture("u1", 1), "u1", 1), true);
});

test("session guard: late begin cannot roll the current session back", () => {
  const guard = createSessionGuard();
  guard.transition("u2", 2);
  const late = guard.begin("u1", 1);
  assert.equal(guard.snapshot().userKey, "u2");
  assert.equal(guard.snapshot().authRevision, 2);
  assert.equal(guard.isCurrent(late, "u1", 1), false);
  assert.equal(guard.isCurrent(guard.begin(), "u2", 2), true);
});
