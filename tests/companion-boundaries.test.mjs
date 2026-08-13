import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseSourceStructure,
  physicalLineCount
} from "../scripts/lib/source-structure-policy.mjs";
import { isBrokerDispatch } from "../plugins/grok/scripts/lib/companion-recovery.mjs";
import { usage } from "../plugins/grok/scripts/lib/companion-shared.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = path.join(ROOT, "plugins/grok/scripts/grok-companion.mjs");
const LIB = path.join(ROOT, "plugins/grok/scripts/lib");
const DOMAIN_FILES = Object.freeze(
  fs.readdirSync(LIB)
    .filter((file) => /^companion-.*\.mjs$/u.test(file))
    .sort()
);

function runModuleScript(source) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000
  });
}

function companionEdges(file) {
  const source = fs.readFileSync(path.join(LIB, file), "utf8");
  return parseSourceStructure(source, file).specifiers
    .filter((specifier) => /^\.\/companion-.*\.mjs$/u.test(specifier))
    .map((specifier) => specifier.slice(2));
}

function visitCycles(graph) {
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  const visit = (file, stack) => {
    if (visiting.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file]);
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) || []) visit(dependency, [...stack, file]);
    visiting.delete(file);
    visited.add(file);
  };

  for (const file of graph.keys()) visit(file, []);
  return cycles;
}

test("grok-companion keeps its executable contract and has no public exports", () => {
  const source = fs.readFileSync(ENTRY, "utf8");
  assert.ok(physicalLineCount(source) <= 300, "grok-companion.mjs exceeded 300 lines");
  assert.match(source, /^#!\/usr\/bin\/env node/u);
  assert.match(source, /\bmain\(\)\.catch\(/u);
  assert.doesNotMatch(source, /\bexport\b/u);

  const help = spawnSync(process.execPath, [ENTRY, "help"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(help.error, undefined);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.equal(help.stdout, `${usage()}\n`);

  const namespaceProbe = runModuleScript([
    `process.argv = [process.execPath, ${JSON.stringify(ENTRY)}, "help"];`,
    `const namespace = await import(${JSON.stringify(pathToFileURL(ENTRY).href)});`,
    "process.stdout.write(`\\nexports:${JSON.stringify(Object.keys(namespace).sort())}\\n`);"
  ].join("\n"));
  assert.equal(namespaceProbe.error, undefined);
  assert.equal(namespaceProbe.status, 0, namespaceProbe.stderr);
  assert.equal(namespaceProbe.stderr, "");
  assert.equal(namespaceProbe.stdout, `${usage()}\n\nexports:[]\n`);
});

test("companion domains stay bounded, acyclic, and independent of the executable", () => {
  assert.ok(DOMAIN_FILES.length >= 13, "companion domains were not discovered");
  for (const file of DOMAIN_FILES) {
    const source = fs.readFileSync(path.join(LIB, file), "utf8");
    const parsed = parseSourceStructure(source, file);
    assert.ok(physicalLineCount(source) <= 1500, `${file} exceeded 1500 lines`);
    for (const span of parsed.functions) {
      assert.ok(span.lines <= 250, `${file} ${span.key} exceeded 250 lines`);
    }
    assert.doesNotMatch(
      source,
      /\bfrom\s+["'][^"']*grok-companion\.mjs["']/u,
      `${file} imports the executable entrypoint`
    );
  }

  const graph = new Map(DOMAIN_FILES.map((file) => [file, companionEdges(file)]));
  assert.deepEqual(visitCycles(graph), []);
});

test("importing companion domains is inert", () => {
  const imports = DOMAIN_FILES.map(
    (file) => `await import(${JSON.stringify(pathToFileURL(path.join(LIB, file)).href)});`
  );
  const probe = runModuleScript([...imports, 'process.stdout.write("imports:ok\\n");'].join("\n"));
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stderr, "");
  assert.equal(probe.stdout, "imports:ok\n");
});

test("legacy recovery excludes every supported broker dispatch generation", () => {
  for (const schemaVersion of [1, 2]) {
    assert.equal(isBrokerDispatch({
      request: { spawn: { dispatch: { schemaVersion } } }
    }), true);
  }
  for (const candidate of [
    null,
    {},
    { request: { spawn: { dispatch: { schemaVersion: 3 } } } }
  ]) {
    assert.equal(isBrokerDispatch(candidate), false);
  }
});
