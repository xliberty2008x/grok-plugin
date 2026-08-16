import assert from "node:assert/strict";
import test from "node:test";

import { assertPublicSpawnOptions } from "../plugins/grok/scripts/lib/worker-spawn-options.mjs";

test("default spawn options keep the explicit-envelope path", () => {
  assert.deepEqual(assertPublicSpawnOptions({}), {
    contextMode: null,
    inheritTurns: null,
    contextDigest: null,
    name: null,
    parentId: null
  });
});

test("recent context requires a digest and turn bound", () => {
  assert.throws(
    () => assertPublicSpawnOptions({ contextMode: "recent" }),
    (error) => error.code === "E_USAGE"
  );
  const options = assertPublicSpawnOptions({
    contextMode: "recent",
    inheritTurns: 8,
    contextDigest: "a".repeat(64)
  });
  assert.equal(options.contextMode, "recent");
  assert.equal(options.inheritTurns, 8);
  assert.equal(options.contextDigest, "a".repeat(64));
});

test("explicit model or effort fails closed without a receipt advertisement", () => {
  assert.throws(
    () => assertPublicSpawnOptions({ model: "grok-4.6" }),
    (error) => error.code === "E_CAPABILITY" && /model/i.test(error.message)
  );
  assert.throws(
    () => assertPublicSpawnOptions({ effort: "high" }),
    (error) => error.code === "E_CAPABILITY" && /effort/i.test(error.message)
  );
});
