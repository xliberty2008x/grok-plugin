import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  main as sourceStructureCliMain,
  publicSourceStructureResult
} from "../scripts/check-source-structure.mjs";
import {
  collectFunctionSpans,
  evaluateSourceStructure,
  loadSourceStructurePolicy,
  normalizePortableRelative,
  parseSourceStructure,
  physicalLineCount,
  SOURCE_STRUCTURE_EXTENSIONS,
  SOURCE_STRUCTURE_INITIAL_DIGEST,
  SOURCE_STRUCTURE_MAX_PHYSICAL_LINE_BYTES,
  SOURCE_STRUCTURE_MAX_SOURCE_BYTES,
  SOURCE_STRUCTURE_POLICY_DIGEST,
  SOURCE_STRUCTURE_ROOTS,
  sourceStructureInitialDigest,
  sourceStructurePolicyDigest,
  validateSourceStructurePolicy
} from "../scripts/lib/source-structure-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVISION = "7301afbbbf29afc3690c9d1d4458b8c394bed2bc";

function policy(overrides = {}) {
  const config = {
    schemaVersion: 1,
    mode: "observe",
    extensions: [...SOURCE_STRUCTURE_EXTENSIONS],
    roots: [...SOURCE_STRUCTURE_ROOTS],
    maxPhysicalLineBytes: SOURCE_STRUCTURE_MAX_PHYSICAL_LINE_BYTES,
    maxSourceBytes: SOURCE_STRUCTURE_MAX_SOURCE_BYTES,
    facadePaths: [],
    budgets: {
      product: { fileLines: 1500, functionLines: 250 },
      tooling: { fileLines: 2000, functionLines: 350 },
      tests: { fileLines: 2000, functionLines: 400 },
      facade: { fileLines: 300, functionLines: 250 }
    },
    baseline: { date: "2026-08-01", revision: REVISION, initialDigest: "", policyDigest: "" },
    dispositions: {},
    initialDebt: {},
    legacyDebt: {},
    initialCycles: [],
    capCycleComponents: [],
    initialOrdinalFragments: [],
    capOrdinalFragments: [],
    ...overrides
  };
  config.baseline = {
    date: "2026-08-01",
    revision: REVISION,
    initialDigest: "",
    policyDigest: "",
    ...(overrides.baseline || {})
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "initialDebt")) {
    config.initialDebt = Object.fromEntries(Object.entries(config.legacyDebt).map(([file, entry]) => [file, {
      category: entry.category,
      functions: entry.functions.map((span) => ({ initialLines: span.initialLines, key: span.key })),
      initialLines: entry.initialLines
    }]));
  }
  config.baseline.initialDigest = sourceStructureInitialDigest(config);
  config.baseline.policyDigest = sourceStructurePolicyDigest(config);
  return config;
}

function refreshPolicyDigest(config) {
  config.baseline.policyDigest = sourceStructurePolicyDigest(config);
  return config;
}

function withRepository(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-structure-policy-"));
  for (const directory of SOURCE_STRUCTURE_ROOTS) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

function write(root, relative, source) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

function sourceLines(count) {
  if (count < 1) return "";
  return ["export const value = 1;", ...Array.from({ length: count - 1 }, () => "// line")].join("\n");
}

function functionLines(count, name = "longFunction") {
  return [
    `export function ${name}() {`,
    ...Array.from({ length: count - 2 }, () => "  // line"),
    "}"
  ].join("\n");
}

function arrowFunctionLines(count, name = "longArrow") {
  return [
    `export const ${name} = () => {`,
    ...Array.from({ length: count - 2 }, () => "  // line"),
    "};"
  ].join("\n");
}

function anonymousArrowLines(count) {
  return [
    "export const callbacks = [1].map(() => {",
    ...Array.from({ length: count - 2 }, () => "  // line"),
    "});"
  ].join("\n");
}

function codes(result, severity = null) {
  const entries = severity === "error" ? result.errors : severity === "warning" ? result.warnings : result.findings;
  return new Set(entries.map((entry) => entry.code));
}

function captureStream() {
  let content = "";
  return {
    stream: {
      write(chunk) {
        content += String(chunk);
        return true;
      }
    },
    read() {
      return content;
    }
  };
}

test("physical LOC treats newline encodings and trailing terminators consistently", () => {
  assert.equal(physicalLineCount(""), 0);
  assert.equal(physicalLineCount("one"), 1);
  assert.equal(physicalLineCount("one\n"), 1);
  assert.equal(physicalLineCount("one\n\n"), 2);
  assert.equal(physicalLineCount("one\r\ntwo\r\n"), 2);
  assert.equal(physicalLineCount("one\rtwo"), 2);
  assert.equal(physicalLineCount("one\u2028two\u2029"), 2);
  assert.throws(() => physicalLineCount(null), TypeError);
});

test("Acorn spans cover declarations, expressions, arrows, object and class methods", () => {
  const source = [
    "export async function* declared() {", "  return 1;", "}",
    "const expression = function* named() {", "  return 2;", "};",
    "const arrow = async () => {", "  return 3;", "};",
    "const object = {", "  method() { return 4; },", "  get value() { return 5; },", "  set value(next) { void next; }", "};",
    "class Example {", "  async *iterate() { return 6; }", "  get item() { return 7; }", "  set item(next) { void next; }", "}",
    "class Fields {", "  field = () => 8;", "  [dynamic] = () => 9;", "}",
    "class PrivateNames {", "  foo() { return 10; }", "  #foo() { return 11; }", "}",
    "export { expression, arrow, object, Example, Fields, PrivateNames };"
  ].join("\n");
  const parsed = parseSourceStructure(source, "kinds.mjs");
  const spans = collectFunctionSpans(parsed.ast);
  assert.ok(spans.some((span) => span.key === "function:declared#1" && span.async && span.generator));
  assert.ok(spans.some((span) => span.key === "function:expression#1" && span.generator));
  assert.ok(spans.some((span) => span.key === "arrow:arrow#1" && span.async));
  assert.ok(spans.some((span) => span.key === "method:method#1"));
  assert.ok(spans.some((span) => span.key === "arrow:field#1" && span.stableIdentity));
  assert.ok(spans.some((span) => span.key === "arrow:<anonymous>#1" && !span.stableIdentity));
  assert.ok(spans.some((span) => span.key === "method:foo#1" && span.stableIdentity));
  assert.ok(spans.some((span) => span.key === "method:#foo#1" && span.stableIdentity));
  assert.equal(spans.filter((span) => span.kind === "get").length, 2);
  assert.equal(spans.filter((span) => span.kind === "set").length, 2);
  assert.ok(spans.every((span) => span.lines === span.endLine - span.startLine + 1));
  assert.ok(spans.filter((span) => span.name !== "anonymous").every((span) => span.stableIdentity));
});

test("static dependency extraction ignores dynamic import and require", () => {
  const parsed = parseSourceStructure([
    "import './one.mjs';",
    "export { value } from './two.mjs';",
    "export * from './three.mjs';",
    "await import('./dynamic.mjs');",
    "require('./required.cjs');"
  ].join("\n"), "imports.mjs");
  assert.deepEqual(parsed.specifiers, ["./one.mjs", "./two.mjs", "./three.mjs"]);
  assert.doesNotThrow(() => parseSourceStructure("module.exports = require('./value.cjs');", "module.cjs"));
  assert.throws(() => parseSourceStructure("await Promise.resolve();", "module.cjs"), /Could not parse/u);
  assert.doesNotThrow(() => parseSourceStructure("await Promise.resolve();", "module.mjs"));
});

test("configuration fails closed on changed budgets, wildcard paths, and unsorted function vectors", () => {
  assert.deepEqual(validateSourceStructurePolicy(policy()), []);
  const wrongBudget = policy();
  wrongBudget.budgets.product.fileLines = 1501;
  assert.ok(validateSourceStructurePolicy(wrongBudget).some((message) => /canonical budgets/u.test(message)));
  const wrongFacadeFunctionBudget = policy();
  wrongFacadeFunctionBudget.budgets.facade.functionLines = 251;
  assert.ok(validateSourceStructurePolicy(wrongFacadeFunctionBudget)
    .some((message) => /canonical budgets/u.test(message)));

  const rootExtra = policy();
  rootExtra.unexpected = true;
  assert.ok(validateSourceStructurePolicy(rootExtra).some((message) => /Policy must have exactly/u.test(message)));

  const nestedExtra = policy();
  nestedExtra.budgets.product.spare = 1;
  assert.ok(validateSourceStructurePolicy(nestedExtra).some((message) => /budgets\.product must have exactly/u.test(message)));

  const wildcard = policy({ facadePaths: ["plugins/*.mjs"] });
  assert.ok(validateSourceStructurePolicy(wildcard).some((message) => /facadePaths/u.test(message)));

  const unsorted = policy({
    legacyDebt: {
      "plugins/large.mjs": {
        category: "product", initialLines: 1501, lineCap: 1501,
        issue: "#56", rationale: "Existing debt.", removalCriterion: "Within budget.",
        functions: [
          { key: "function:z#1", initialLines: 300, capLines: 300 },
          { key: "function:a#1", initialLines: 260, capLines: 260 }
        ]
      }
    }
  });
  assert.ok(validateSourceStructurePolicy(unsorted).some((message) => /sorted order/u.test(message)));
});

test("observe reports new debt while ratchet rejects it", () => withRepository((root) => {
  write(root, "plugins/new-large.mjs", sourceLines(1501));
  const observe = evaluateSourceStructure({ root, config: policy() });
  assert.equal(observe.ok, true);
  assert.ok(codes(observe, "warning").has("new-file-overage"));
  assert.ok(codes(observe, "warning").has("missing-legacy-exception"));

  const ratchet = evaluateSourceStructure({ root, config: policy(), mode: "ratchet" });
  assert.equal(ratchet.ok, false);
  assert.ok(codes(ratchet, "error").has("new-file-overage"));
}));

test("exact file caps reject growth and require same-change reduction", () => withRepository((root) => {
  const entry = {
    category: "product", initialLines: 1501, lineCap: 1501,
    issue: "#56", rationale: "Existing debt.", removalCriterion: "Within budget.", functions: []
  };
  const config = policy({ legacyDebt: { "plugins/large.mjs": entry } });
  write(root, "plugins/large.mjs", sourceLines(1501));
  assert.equal(evaluateSourceStructure({ root, config, mode: "ratchet" }).ok, true);

  write(root, "plugins/large.mjs", sourceLines(1502));
  assert.ok(codes(evaluateSourceStructure({ root, config, mode: "ratchet" }), "error").has("legacy-file-growth"));

  write(root, "plugins/large.mjs", sourceLines(1500));
  assert.ok(codes(evaluateSourceStructure({ root, config, mode: "ratchet" }), "error")
    .has("stale-file-exception"));
  const loweredInBudgetCap = structuredClone(config);
  loweredInBudgetCap.legacyDebt["plugins/large.mjs"].lineCap = 1500;
  refreshPolicyDigest(loweredInBudgetCap);
  assert.ok(codes(evaluateSourceStructure({ root, config: loweredInBudgetCap, mode: "ratchet" }), "error")
    .has("stale-file-exception"));
}));

test("per-function vectors reject new, grown, reduced, and stale long functions", () => withRepository((root) => {
  const exact = {
    category: "product", initialLines: 251, lineCap: null,
    issue: "#56", rationale: "Existing debt.", removalCriterion: "Within budget.",
    functions: [{ key: "function:longFunction#1", initialLines: 251, capLines: 251 }]
  };
  write(root, "plugins/functions.mjs", functionLines(251));
  const config = policy({ legacyDebt: { "plugins/functions.mjs": exact } });
  assert.equal(evaluateSourceStructure({ root, config, mode: "ratchet" }).ok, true);

  const staleFileCap = structuredClone(config);
  staleFileCap.legacyDebt["plugins/functions.mjs"].lineCap = 251;
  refreshPolicyDigest(staleFileCap);
  assert.ok(codes(evaluateSourceStructure({ root, config: staleFileCap, mode: "ratchet" }), "error")
    .has("stale-file-exception"));

  write(root, "plugins/functions.mjs", functionLines(252));
  assert.ok(codes(evaluateSourceStructure({ root, config, mode: "ratchet" }), "error").has("legacy-function-growth"));

  write(root, "plugins/functions.mjs", functionLines(250));
  const reduced = codes(evaluateSourceStructure({ root, config, mode: "ratchet" }), "error");
  assert.ok(reduced.has("stale-function-exception"));
  assert.equal(reduced.has("stale-file-exception"), false);

  const noBaseline = evaluateSourceStructure({ root, config: policy(), mode: "ratchet" });
  assert.equal(noBaseline.ok, true, "a now-within-budget function needs no exception");
}));

test("long-function caps use unique named identities instead of encounter ordinals", () => withRepository((root) => {
  const stableCap = {
    category: "product", initialLines: 252, lineCap: null,
    issue: "#56", rationale: "Existing named debt.", removalCriterion: "Within budget.",
    functions: [{ key: "arrow:stableLong#1", initialLines: 251, capLines: 251 }]
  };
  const config = policy({ legacyDebt: { "plugins/stable.mjs": stableCap } });
  const longArrow = arrowFunctionLines(251, "stableLong");

  write(root, "plugins/stable.mjs", `export const short = [1].map(() => 1);\n${longArrow}`);
  let result = evaluateSourceStructure({ root, config, mode: "ratchet" });
  assert.equal(result.ok, true);
  assert.ok(result.files.find((entry) => entry.file === "plugins/stable.mjs")
    .functions.some((span) => span.key === "arrow:<anonymous>#1" && !span.stableIdentity));
  assert.equal(
    result.files.find((entry) => entry.file === "plugins/stable.mjs")
      .functions.find((span) => span.name === "stableLong").key,
    "arrow:stableLong#1"
  );

  write(root, "plugins/stable.mjs", longArrow);
  result = evaluateSourceStructure({ root, config, mode: "ratchet" });
  assert.equal(result.ok, true, "removing an unrelated earlier anonymous function must not rename debt");
}));

test("class-field arrows use static property names and reject dynamic computed identities", () => withRepository((root) => {
  const staticField = [
    "export class Example {",
    "  handler = () => {",
    ...Array.from({ length: 249 }, () => "    // line"),
    "  };",
    "}"
  ].join("\n");
  const staticCap = {
    category: "product", initialLines: physicalLineCount(staticField), lineCap: null,
    issue: "#56", rationale: "Existing named debt.", removalCriterion: "Within budget.",
    functions: [{ key: "arrow:handler#1", initialLines: 251, capLines: 251 }]
  };
  write(root, "plugins/fields.mjs", staticField);
  assert.equal(evaluateSourceStructure({
    root,
    config: policy({ legacyDebt: { "plugins/fields.mjs": staticCap } }),
    mode: "ratchet"
  }).ok, true);

  const dynamicField = `const handlerName = "handler";\n${staticField.replace("handler =", "[handlerName] =")}`;
  write(root, "plugins/fields.mjs", dynamicField);
  const dynamic = evaluateSourceStructure({ root, config: policy() });
  assert.ok(codes(dynamic, "error").has("unstable-function-identity"));
}));

test("anonymous and colliding long-function identities fail closed and cannot be baselined", () => withRepository((root) => {
  write(root, "plugins/anonymous.mjs", anonymousArrowLines(251));
  const anonymous = evaluateSourceStructure({ root, config: policy() });
  assert.equal(anonymous.ok, false);
  assert.ok(codes(anonymous, "error").has("unstable-function-identity"));

  write(root, "plugins/anonymous.mjs", [
    "const handlerName = 'handler';",
    "export const handlers = {",
    "  [handlerName]: () => {",
    ...Array.from({ length: 249 }, () => "    // line"),
    "  }",
    "};"
  ].join("\n"));
  const dynamicComputed = evaluateSourceStructure({ root, config: policy() });
  assert.ok(codes(dynamicComputed, "error").has("unstable-function-identity"));

  const anonymousCap = {
    category: "product", initialLines: 251, lineCap: null,
    issue: "#56", rationale: "Invalid anonymous debt.", removalCriterion: "Within budget.",
    functions: [{ key: "arrow:<anonymous>#1", initialLines: 251, capLines: 251 }]
  };
  assert.ok(validateSourceStructurePolicy(policy({
    legacyDebt: { "plugins/anonymous.mjs": anonymousCap }
  })).some((message) => /unique named function keys ending in #1/u.test(message)));
  fs.rmSync(path.join(root, "plugins/anonymous.mjs"));

  const duplicateSource = [
    "{",
    arrowFunctionLines(251, "repeated").replace("export const", "const"),
    "}",
    "{ const repeated = () => 1; void repeated; }"
  ].join("\n");
  write(root, "plugins/duplicate.mjs", duplicateSource);
  const duplicateCap = {
    category: "product", initialLines: physicalLineCount(duplicateSource), lineCap: null,
    issue: "#56", rationale: "Existing named debt.", removalCriterion: "Within budget.",
    functions: [{ key: "arrow:repeated#1", initialLines: 251, capLines: 251 }]
  };
  const duplicate = evaluateSourceStructure({
    root,
    config: policy({ legacyDebt: { "plugins/duplicate.mjs": duplicateCap } }),
    mode: "ratchet"
  });
  assert.equal(duplicate.ok, false);
  assert.ok(codes(duplicate, "error").has("ambiguous-function-identity"));
  assert.ok(codes(duplicate, "error").has("stale-function-exception"));

  const resolvedSource = [
    "{ const repeated = () => 1; void repeated; }",
    "{ const repeated = () => 2; void repeated; }"
  ].join("\n");
  write(root, "plugins/duplicate.mjs", resolvedSource);
  const resolvedInitial = {
    "plugins/duplicate.mjs": {
      category: "product",
      functions: [{ initialLines: 251, key: "arrow:repeated#1" }],
      initialLines: physicalLineCount(duplicateSource)
    }
  };
  const resolvedCap = {
    ...duplicateCap,
    functions: []
  };
  const resolvedDuplicate = evaluateSourceStructure({
    root,
    config: policy({
      initialDebt: resolvedInitial,
      legacyDebt: { "plugins/duplicate.mjs": resolvedCap }
    }),
    mode: "ratchet"
  });
  assert.ok(codes(resolvedDuplicate, "error").has("ambiguous-function-identity"),
    "resolved immutable identities must remain unique while their file exists");

  const ordinalCap = structuredClone(duplicateCap);
  ordinalCap.functions[0].key = "arrow:repeated#2";
  assert.ok(validateSourceStructurePolicy(policy({
    legacyDebt: { "plugins/duplicate.mjs": ordinalCap }
  })).some((message) => /unique named function keys ending in #1/u.test(message)));
}));

test("resolved file and function caps stay immutable and reject regression", () => withRepository((root) => {
  const initialDebt = {
    "plugins/resolved.mjs": {
      category: "product",
      functions: [{ initialLines: 251, key: "function:longFunction#1" }],
      initialLines: 1501
    }
  };
  const resolvedCap = {
    category: "product", initialLines: 1501, lineCap: null,
    issue: "#56", rationale: "Resolved debt history.", removalCriterion: "Remain within budget.", functions: []
  };
  const config = policy({ initialDebt, legacyDebt: { "plugins/resolved.mjs": resolvedCap } });
  write(root, "plugins/resolved.mjs", functionLines(250));
  assert.equal(evaluateSourceStructure({ root, config, mode: "ratchet" }).ok, true);

  write(root, "plugins/resolved.mjs", functionLines(251));
  assert.ok(codes(evaluateSourceStructure({ root, config, mode: "ratchet" }), "error")
    .has("resolved-function-regression"));

  write(root, "plugins/resolved.mjs", sourceLines(1501));
  assert.ok(codes(evaluateSourceStructure({ root, config, mode: "ratchet" }), "error")
    .has("resolved-file-regression"));

  fs.rmSync(path.join(root, "plugins/resolved.mjs"));
  assert.equal(evaluateSourceStructure({ root, config, mode: "ratchet" }).ok, true);
  const active = structuredClone(config);
  active.legacyDebt["plugins/resolved.mjs"].lineCap = 1501;
  refreshPolicyDigest(active);
  assert.ok(codes(evaluateSourceStructure({ root, config: active, mode: "ratchet" }), "error")
    .has("stale-file-exception"));
}));

test("new and enlarged static ESM cycles fail only in ratchet mode", () => withRepository((root) => {
  write(root, "plugins/a.mjs", "import './b.mjs';\nexport const a = 1;");
  write(root, "plugins/b.mjs", "import './a.mjs';\nexport const b = 1;");
  const observe = evaluateSourceStructure({ root, config: policy() });
  assert.equal(observe.ok, true);
  assert.ok(codes(observe, "warning").has("new-cycle"));
  assert.ok(codes(evaluateSourceStructure({ root, config: policy(), mode: "ratchet" }), "error").has("new-cycle"));

  const baseline = policy({
    initialCycles: [["plugins/a.mjs", "plugins/b.mjs"]],
    capCycleComponents: [["plugins/a.mjs", "plugins/b.mjs"]]
  });
  assert.equal(evaluateSourceStructure({ root, config: baseline, mode: "ratchet" }).ok, true);
  write(root, "plugins/b.mjs", "import './c.mjs';\nexport const b = 1;");
  write(root, "plugins/c.mjs", "import './a.mjs';\nexport const c = 1;");
  assert.ok(codes(evaluateSourceStructure({ root, config: baseline, mode: "ratchet" }), "error").has("enlarged-cycle"));

  write(root, "plugins/b.mjs", "import './a.mjs';\nexport const b = 1;");
  write(root, "plugins/c.mjs", "export const c = 1;");
  const reduced = policy({
    initialCycles: [["plugins/a.mjs", "plugins/b.mjs", "plugins/c.mjs"]],
    capCycleComponents: [["plugins/a.mjs", "plugins/b.mjs"]]
  });
  assert.equal(evaluateSourceStructure({ root, config: reduced, mode: "ratchet" }).ok, true);
}));

test("ordinal fragments are observed, exactly baselined, and rejected when new", () => withRepository((root) => {
  write(root, "plugins/domain_part1.mjs", "export const value = 1;");
  assert.ok(codes(evaluateSourceStructure({ root, config: policy() }), "warning").has("new-ordinal-fragment"));
  assert.ok(codes(evaluateSourceStructure({ root, config: policy(), mode: "ratchet" }), "error").has("new-ordinal-fragment"));
  const legacy = policy({
    initialOrdinalFragments: ["plugins/domain_part1.mjs"],
    capOrdinalFragments: ["plugins/domain_part1.mjs"]
  });
  assert.equal(evaluateSourceStructure({ root, config: legacy, mode: "ratchet" }).ok, true);
  assert.ok(codes(evaluateSourceStructure({ root, config: legacy, mode: "ratchet" }), "warning").has("legacy-ordinal-fragment"));

  fs.rmSync(path.join(root, "plugins/domain_part1.mjs"));
  const reduced = policy({
    initialOrdinalFragments: ["plugins/domain_part1.mjs"],
    capOrdinalFragments: []
  });
  assert.equal(evaluateSourceStructure({ root, config: reduced, mode: "ratchet" }).ok, true);
  write(root, "plugins/domain_part1.mjs", "export const value = 1;");
  assert.ok(codes(evaluateSourceStructure({ root, config: reduced, mode: "ratchet" }), "error")
    .has("new-ordinal-fragment"));

  write(root, "plugins/handler_2.mjs", "export const handler = 2;");
  write(root, "plugins/utils_2024.mjs", "export const utility = 2024;");
  const legitimateNumericSuffixes = evaluateSourceStructure({ root, config: legacy, mode: "ratchet" });
  assert.equal(legitimateNumericSuffixes.ok, true);
  assert.equal(
    legitimateNumericSuffixes.findings.some((entry) =>
      entry.code === "new-ordinal-fragment"
      && ["plugins/handler_2.mjs", "plugins/utils_2024.mjs"].includes(entry.file)),
    false
  );
}));

test("ratchet rejects implementation imports through a registered facade", () => withRepository((root) => {
  write(root, "plugins/facade.mjs", "export { value } from './domain.mjs';");
  write(root, "plugins/domain.mjs", "export const value = 1;");
  write(root, "plugins/implementation.mjs", "import { value } from './facade.mjs';\nexport { value };");
  const config = policy({ facadePaths: ["plugins/facade.mjs"] });
  assert.ok(codes(evaluateSourceStructure({ root, config }), "warning").has("reverse-facade-import"));
  assert.ok(codes(evaluateSourceStructure({ root, config, mode: "ratchet" }), "error").has("reverse-facade-import"));
}));

test("file-URL query, fragment, and percent encoding cannot hide facade cycles", () => withRepository((root) => {
  write(root, "plugins/facade name.mjs", "export { value } from './implementation.mjs';\n");
  const config = policy({ facadePaths: ["plugins/facade name.mjs"] });
  for (const specifier of [
    "./facade%20name.mjs?bypass",
    "./facade%20name.mjs#bypass"
  ]) {
    write(root, "plugins/implementation.mjs", `import { value } from '${specifier}';\nexport { value };\n`);
    const result = evaluateSourceStructure({ root, config, mode: "ratchet" });
    assert.ok(codes(result, "error").has("reverse-facade-import"), specifier);
    assert.ok(codes(result, "error").has("new-cycle"), specifier);
  }
}));

test("immutable and active digests pin history and the shrink-only policy boundary", () => {
  const config = loadSourceStructurePolicy({ root: ROOT });
  assert.equal(SOURCE_STRUCTURE_INITIAL_DIGEST, "6cd632e75601aad00a3872546281f1794960eb86f278fa0d7f5340898315396b");
  assert.equal(config.baseline.initialDigest, SOURCE_STRUCTURE_INITIAL_DIGEST);
  assert.equal(sourceStructureInitialDigest(config), SOURCE_STRUCTURE_INITIAL_DIGEST);
  assert.equal(config.baseline.policyDigest, SOURCE_STRUCTURE_POLICY_DIGEST);
  assert.equal(sourceStructurePolicyDigest(config), SOURCE_STRUCTURE_POLICY_DIGEST);

  const selfReference = structuredClone(config);
  selfReference.baseline.policyDigest = "0".repeat(64);
  assert.equal(sourceStructurePolicyDigest(selfReference), SOURCE_STRUCTURE_POLICY_DIGEST);

  const changedHistoryBoundary = structuredClone(config);
  changedHistoryBoundary.initialDebt["plugins/grok/scripts/lib/worker-mutation.mjs"].initialLines += 1;
  assert.notEqual(sourceStructurePolicyDigest(changedHistoryBoundary), SOURCE_STRUCTURE_POLICY_DIGEST);

  const raised = structuredClone(config);
  raised.initialDebt["plugins/grok/scripts/lib/worker-mutation.mjs"].initialLines += 1;
  raised.legacyDebt["plugins/grok/scripts/lib/worker-mutation.mjs"].initialLines += 1;
  raised.legacyDebt["plugins/grok/scripts/lib/worker-mutation.mjs"].lineCap += 1;
  assert.ok(validateSourceStructurePolicy(raised, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST
  }).some((message) => /initialDigest/u.test(message)));

  const lowerCap = structuredClone(config);
  lowerCap.legacyDebt["plugins/grok/scripts/lib/worker-mutation.mjs"].lineCap -= 1;
  refreshPolicyDigest(lowerCap);
  assert.deepEqual(validateSourceStructurePolicy(lowerCap, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST,
    expectedPolicyDigest: lowerCap.baseline.policyDigest
  }), []);

  const removedCap = structuredClone(config);
  delete removedCap.legacyDebt["plugins/grok/scripts/lib/worker-mutation.mjs"];
  refreshPolicyDigest(removedCap);
  assert.deepEqual(validateSourceStructurePolicy(removedCap, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST,
    expectedPolicyDigest: removedCap.baseline.policyDigest
  }), []);

  const splitCycleCap = structuredClone(config);
  splitCycleCap.capCycleComponents = [[
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs"
  ]];
  refreshPolicyDigest(splitCycleCap);
  assert.deepEqual(validateSourceStructurePolicy(splitCycleCap, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST,
    expectedPolicyDigest: splitCycleCap.baseline.policyDigest
  }), []);

  const reopenedCap = structuredClone(lowerCap);
  reopenedCap.legacyDebt["plugins/grok/scripts/lib/worker-mutation.mjs"].lineCap += 1;
  refreshPolicyDigest(reopenedCap);
  assert.ok(validateSourceStructurePolicy(reopenedCap, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST,
    expectedPolicyDigest: lowerCap.baseline.policyDigest
  }).some((message) => /repository-pinned policy boundary/u.test(message)));

  const rewrittenProvenance = structuredClone(config);
  rewrittenProvenance.baseline.date = "2026-08-04";
  rewrittenProvenance.baseline.revision = "1".repeat(40);
  assert.ok(validateSourceStructurePolicy(rewrittenProvenance, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST,
    expectedPolicyDigest: SOURCE_STRUCTURE_POLICY_DIGEST
  }).some((message) => /policyDigest/u.test(message)));

  const invalidCycleCap = structuredClone(config);
  invalidCycleCap.capCycleComponents = [[
    "plugins/grok/scripts/lib/state.mjs",
    "plugins/grok/scripts/lib/worker-mutation.mjs"
  ]];
  assert.ok(validateSourceStructurePolicy(invalidCycleCap, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST
  }).some((message) => /subset of one immutable initial cycle/u.test(message)));

  const changedInitialCycle = structuredClone(config);
  changedInitialCycle.initialCycles[0].pop();
  assert.ok(validateSourceStructurePolicy(changedInitialCycle, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST
  }).some((message) => /initialDigest/u.test(message)));

  const invalidOrdinalCap = structuredClone(config);
  invalidOrdinalCap.capOrdinalFragments.push("tests/new_part1.mjs");
  invalidOrdinalCap.capOrdinalFragments.sort();
  assert.ok(validateSourceStructurePolicy(invalidOrdinalCap, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST
  }).some((message) => /subset of immutable initialOrdinalFragments/u.test(message)));

  const changedInitialFragments = structuredClone(config);
  changedInitialFragments.initialOrdinalFragments.pop();
  assert.ok(validateSourceStructurePolicy(changedInitialFragments, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST
  }).some((message) => /initialDigest/u.test(message)));
});

test("every giga file needs an exact disposition and stale dispositions fail", () => withRepository((root) => {
  write(root, "plugins/giga.mjs", sourceLines(5001));
  const missing = evaluateSourceStructure({ root, config: policy(), mode: "ratchet" });
  assert.ok(codes(missing, "error").has("missing-giga-disposition"));

  write(root, "plugins/giga.mjs", sourceLines(10));
  const stale = policy({
    dispositions: {
      "plugins/giga.mjs": { stage: "pilot", target: "Split by domain." }
    }
  });
  assert.ok(codes(evaluateSourceStructure({ root, config: stale, mode: "ratchet" }), "error").has("stale-giga-disposition"));
}));

test("canonical source roots, extensions, and resource ceilings cannot be narrowed", () => {
  const narrowedRoots = policy();
  narrowedRoots.roots.pop();
  refreshPolicyDigest(narrowedRoots);
  assert.ok(validateSourceStructurePolicy(narrowedRoots, {
    expectedPolicyDigest: narrowedRoots.baseline.policyDigest
  }).some((message) => /canonical set/u.test(message)));

  const narrowedExtensions = policy();
  narrowedExtensions.extensions.shift();
  refreshPolicyDigest(narrowedExtensions);
  assert.ok(validateSourceStructurePolicy(narrowedExtensions, {
    expectedPolicyDigest: narrowedExtensions.baseline.policyDigest
  }).some((message) => /canonical set/u.test(message)));

  const raisedSourceLimit = policy({ maxSourceBytes: SOURCE_STRUCTURE_MAX_SOURCE_BYTES + 1 });
  assert.ok(validateSourceStructurePolicy(raisedSourceLimit).some((message) => /maxSourceBytes/u.test(message)));

  const raisedLineLimit = policy({
    maxPhysicalLineBytes: SOURCE_STRUCTURE_MAX_PHYSICAL_LINE_BYTES + 1
  });
  assert.ok(validateSourceStructurePolicy(raisedLineLimit).some((message) => /maxPhysicalLineBytes/u.test(message)));
});

test("nested build, coverage, dist, and vendor source cannot escape the scan", () => withRepository((root) => {
  for (const directory of ["build", "coverage", "dist", "vendor"]) {
    const relative = `scripts/${directory}/giga.mjs`;
    write(root, relative, sourceLines(6001));
    const result = evaluateSourceStructure({ root, config: policy(), mode: "ratchet" });
    assert.equal(result.files.some((entry) => entry.file === relative), true, relative);
    assert.ok(codes(result, "error").has("missing-giga-disposition"), relative);
    fs.rmSync(path.join(root, "scripts", directory), { force: true, recursive: true });
  }
}));

test("excluded and outside source edges plus replaced roots fail closed", () => withRepository((root) => {
  write(root, "scripts/main.mjs", [
    "import './node_modules/hidden.mjs';",
    "import '../../outside.mjs';"
  ].join("\n"));
  write(root, "scripts/node_modules/hidden.mjs", "export const hidden = true;\n");
  const unsafeEdges = evaluateSourceStructure({ root, config: policy(), mode: "ratchet" });
  assert.ok(codes(unsafeEdges, "error").has("excluded-source-edge"));
  assert.ok(codes(unsafeEdges, "error").has("outside-source-root-edge"));

  fs.rmSync(path.join(root, "apps"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps"), "not a directory\n");
  const replacedRoot = evaluateSourceStructure({ root, config: policy() });
  assert.ok(codes(replacedRoot, "error").has("invalid-scan-root"));
}));

test("source byte and physical-line bounds fail before policy parsing can be gamed", () => withRepository((root) => {
  const oversized = path.join(root, "plugins", "oversized.mjs");
  fs.writeFileSync(oversized, Buffer.alloc(SOURCE_STRUCTURE_MAX_SOURCE_BYTES + 1, 0x20));
  const byteLimited = evaluateSourceStructure({ root, config: policy() });
  assert.ok(codes(byteLimited, "error").has("source-byte-limit"));
  assert.equal(byteLimited.files.some((entry) => entry.file === "plugins/oversized.mjs"), false);

  fs.rmSync(oversized);
  write(root, "plugins/packed.mjs", `export const packed = [${"0,".repeat(5000)}];`);
  const packed = evaluateSourceStructure({ root, config: policy(), mode: "ratchet" });
  assert.ok(codes(packed, "error").has("physical-line-byte-limit"));
}));

test("parser, symlink, and unreadable source failures are hard errors in observe mode", () => withRepository((root) => {
  write(root, "plugins/broken.mjs", "export const = ;");
  assert.ok(codes(evaluateSourceStructure({ root, config: policy() }), "error").has("parse-error"));

  fs.rmSync(path.join(root, "plugins/broken.mjs"));
  write(root, "plugins/link.mjs", "export const value = 1;");
  const symlinkFs = {
    lstatSync(file) {
      if (String(file).endsWith(`${path.sep}plugins${path.sep}link.mjs`)) {
        return {
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true
        };
      }
      return fs.lstatSync(file);
    },
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync
  };
  assert.ok(codes(evaluateSourceStructure({ root, config: policy(), fsApi: symlinkFs }), "error")
    .has("symlinked-source-path"));

  fs.rmSync(path.join(root, "plugins/link.mjs"));
  write(root, "plugins/unreadable.mjs", "export const value = 1;");
  const fsApi = {
    lstatSync: fs.lstatSync,
    readdirSync: fs.readdirSync,
    readFileSync(file, encoding) {
      if (String(file).endsWith("unreadable.mjs")) throw new Error("simulated read denial");
      return fs.readFileSync(file, encoding);
    }
  };
  assert.ok(codes(evaluateSourceStructure({ root, config: policy(), fsApi }), "error").has("unreadable-source"));
}));

test("CLI JSON is a stable bounded portable projection of the internal result", () => withRepository((root) => {
  const absoluteSource = path.join(root, "plugins", "large.mjs");
  const internal = {
    ok: false,
    mode: "observe",
    files: [{ absolute: absoluteSource, ast: { source: "secret" }, functions: [{ key: "function:large#1" }] }],
    errors: [{
      code: "parse-error",
      file: absoluteSource,
      message: `Could not parse ${absoluteSource}`,
      severity: "error",
      ast: { source: "secret" }
    }],
    warnings: [{
      code: "legacy-function-growth",
      file: "plugins/large.mjs",
      message: "Function grew.",
      functionKey: "function:large#1",
      severity: "warning",
      lines: 9999
    }],
    cycles: [["plugins/z.mjs", "plugins/a.mjs"]],
    fragments: ["tests/example_part2.mjs", "tests/example_part1.mjs"]
  };
  const first = publicSourceStructureResult(internal, { root });
  const second = publicSourceStructureResult(structuredClone(internal), { root });
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), [
    "schemaVersion", "ok", "mode", "summary", "errors", "warnings", "cycles", "fragments"
  ]);
  assert.deepEqual(first.errors[0], {
    code: "parse-error",
    file: "plugins/large.mjs",
    message: "Could not parse <root>/plugins/large.mjs"
  });
  assert.deepEqual(first.warnings[0], {
    code: "legacy-function-growth",
    file: "plugins/large.mjs",
    message: "Function grew.",
    functionKey: "function:large#1"
  });
  assert.deepEqual(first.cycles, [["plugins/a.mjs", "plugins/z.mjs"]]);
  assert.deepEqual(first.fragments, ["tests/example_part1.mjs", "tests/example_part2.mjs"]);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes(absoluteSource), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes('"files"'), false);
  assert.ok(Buffer.byteLength(serialized) < 16 * 1024);
}));

test("CLI text and JSON modes return public exit codes without leaking internal results", () => {
  const jsonOut = captureStream();
  const jsonErr = captureStream();
  assert.equal(sourceStructureCliMain(["--json"], {
    stdout: jsonOut.stream,
    stderr: jsonErr.stream
  }), 0);
  assert.equal(jsonErr.read(), "");
  const payload = JSON.parse(jsonOut.read());
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.scannedFiles > 0, true);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "files"), false);
  assert.equal(jsonOut.read().includes(ROOT), false);
  assert.ok(Buffer.byteLength(jsonOut.read()) < 128 * 1024);

  const success = {
    ok: true, mode: "observe", files: [], errors: [], warnings: [], cycles: [], fragments: []
  };
  const textOut = captureStream();
  const textErr = captureStream();
  assert.equal(sourceStructureCliMain([], {
    root: path.join(os.tmpdir(), "structure-cli-text"),
    stdout: textOut.stream,
    stderr: textErr.stream,
    loadPolicy: () => ({ mode: "observe" }),
    evaluate: () => success
  }), 0);
  assert.match(textOut.read(), /passed in observe mode/u);
  assert.equal(textErr.read(), "");

  const failure = {
    ok: false,
    mode: "ratchet",
    files: [],
    errors: [{ code: "new-cycle", file: "plugins/a.mjs", message: "New cycle." }],
    warnings: [], cycles: [["plugins/a.mjs"]], fragments: []
  };
  const failedJsonOut = captureStream();
  assert.equal(sourceStructureCliMain(["--json"], {
    root: path.join(os.tmpdir(), "structure-cli-json"),
    stdout: failedJsonOut.stream,
    stderr: captureStream().stream,
    loadPolicy: () => ({ mode: "ratchet" }),
    evaluate: () => failure
  }), 1);
  assert.equal(JSON.parse(failedJsonOut.read()).ok, false);

  const failedTextErr = captureStream();
  assert.equal(sourceStructureCliMain([], {
    root: path.join(os.tmpdir(), "structure-cli-failure"),
    stdout: captureStream().stream,
    stderr: failedTextErr.stream,
    loadPolicy: () => ({ mode: "ratchet" }),
    evaluate: () => failure
  }), 1);
  assert.match(failedTextErr.read(), /failed with 1 error/u);
});

test("portable paths normalize Windows separators", () => {
  assert.equal(
    normalizePortableRelative("C:\\repo", "C:\\repo\\plugins\\file.mjs", path.win32),
    "plugins/file.mjs"
  );
});

test("checked-in ratchet baseline exactly covers all current file and function debt", () => {
  const config = loadSourceStructurePolicy({ root: ROOT });
  assert.equal(config.mode, "ratchet");
  assert.deepEqual(config.extensions, [...SOURCE_STRUCTURE_EXTENSIONS]);
  assert.deepEqual(config.roots, [...SOURCE_STRUCTURE_ROOTS]);
  assert.equal(config.maxPhysicalLineBytes, SOURCE_STRUCTURE_MAX_PHYSICAL_LINE_BYTES);
  assert.equal(config.maxSourceBytes, SOURCE_STRUCTURE_MAX_SOURCE_BYTES);
  assert.equal(config.baseline.revision, "ffa84d4ce22252777d887e8ab6616c7155b40da7");
  assert.equal(config.baseline.initialDigest, SOURCE_STRUCTURE_INITIAL_DIGEST);
  assert.equal(config.baseline.policyDigest, SOURCE_STRUCTURE_POLICY_DIGEST);
  assert.deepEqual(config.facadePaths, [
    "apps/grok-review-app/src/actions/runner-cli.mjs",
    "apps/grok-review-app/src/index.mjs",
    "plugins/grok/mcp/server.mjs",
    "plugins/grok/scripts/grok-codex.mjs",
    "plugins/grok/scripts/grok-companion.mjs",
    "plugins/grok/scripts/lib/task-contract.mjs",
    "plugins/grok/scripts/session-lifecycle-hook.mjs",
    "plugins/grok/scripts/stop-review-gate-hook.mjs",
    "scripts/check-source-structure.mjs"
  ]);
  const result = evaluateSourceStructure({ root: ROOT, config });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 226);
  assert.equal(result.warnings.length, 58);
  assert.equal(result.cycles.length, 0);
  assert.equal(result.fragments.length, 14);
  const debtPaths = result.files.filter((entry) => {
    if (!entry.category) return entry.lines > 5000;
    const budget = config.budgets[entry.category];
    return entry.lines > budget.fileLines
      || entry.functions.some((span) => span.lines > budget.functionLines);
  }).map((entry) => entry.file).sort();
  assert.equal(debtPaths.length, 44);
  assert.deepEqual(debtPaths, Object.keys(config.legacyDebt));
  for (const [file, entry] of Object.entries(config.legacyDebt)) {
    const measured = result.files.find((candidate) => candidate.file === file);
    const fileBudget = config.budgets[entry.category].fileLines;
    if (measured.lines <= fileBudget) assert.equal(entry.lineCap, null, file);
    else assert.ok(entry.lineCap <= entry.initialLines, file);
    assert.ok(entry.functions.every((span) => span.capLines <= span.initialLines));
  }
  for (const [file, initial] of Object.entries(config.initialDebt)) {
    const cap = config.legacyDebt[file];
    if (!cap) {
      assert.equal(debtPaths.includes(file), false, `${file} must remain resolved`);
      continue;
    }
    assert.equal(initial.initialLines, cap.initialLines);
    assert.ok(initial.functions.every((span) => /#1$/u.test(span.key)));
    const initialFunctions = new Map(initial.functions.map((span) => [span.key, span]));
    for (const span of cap.functions) {
      assert.deepEqual(
        { initialLines: span.initialLines, key: span.key },
        initialFunctions.get(span.key),
        `${file}:${span.key}`
      );
    }
    const activeKeys = new Set(cap.functions.map((span) => span.key));
    const measured = result.files.find((candidate) => candidate.file === file);
    const functionBudget = config.budgets[cap.category].functionLines;
    for (const span of initial.functions.filter((candidate) => !activeKeys.has(candidate.key))) {
      const current = measured.functions.find((candidate) => candidate.key === span.key);
      assert.ok(!current || current.lines <= functionBudget, `${file}:${span.key}`);
    }
  }
  for (const entry of result.files) {
    if (!entry.category) continue;
    const budget = config.budgets[entry.category].functionLines;
    assert.ok(entry.functions.filter((span) => span.lines > budget)
      .every((span) => span.stableIdentity && span.key.endsWith("#1")), entry.file);
  }
  assert.equal(Object.keys(config.dispositions).length, 9);
  assert.deepEqual(
    Object.keys(config.dispositions),
    result.files.filter((entry) => entry.lines > 5000).map((entry) => entry.file)
  );
  assert.deepEqual(result.cycles, config.capCycleComponents);
  assert.deepEqual(result.fragments, config.capOrdinalFragments);
  const driftCodes = new Set([
    "ambiguous-function-identity",
    "legacy-category-drift", "legacy-file-growth", "legacy-function-growth",
    "missing-legacy-exception", "new-file-overage", "new-function-overage",
    "stale-file-cap", "stale-function-cap", "stale-function-exception",
    "unstable-function-identity"
  ]);
  assert.equal(result.warnings.some((entry) => driftCodes.has(entry.code)), false);
});
