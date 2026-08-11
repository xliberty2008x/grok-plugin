import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { parse } = require("acorn");

export const SOURCE_STRUCTURE_POLICY_PATH = "scripts/source-structure-policy.json";
export const SOURCE_STRUCTURE_INITIAL_DIGEST = "6cd632e75601aad00a3872546281f1794960eb86f278fa0d7f5340898315396b";
<<<<<<< HEAD
export const SOURCE_STRUCTURE_POLICY_DIGEST = "70c74fda0ca49f9a9e80ebc068f91906361238467c538b7c410f5d916176b86b";
=======
export const SOURCE_STRUCTURE_POLICY_DIGEST = "58bad7575abac6efbbccd31f646b32b214770410732a1b4073021e94c65e2024";
>>>>>>> e483f53 (fix: ratchet companion structure caps after task extraction)
export const SOURCE_STRUCTURE_EXTENSIONS = Object.freeze([".cjs", ".js", ".mjs"]);
export const SOURCE_STRUCTURE_ROOTS = Object.freeze(["plugins", "scripts", "tests"]);
export const SOURCE_STRUCTURE_MAX_PHYSICAL_LINE_BYTES = 4 * 1024;
export const SOURCE_STRUCTURE_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const POLICY_MODES = new Set(["observe", "ratchet"]);
const CATEGORY_NAMES = Object.freeze(["product", "tooling", "tests", "facade"]);
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules"
]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression"
]);
const ORDINAL_FRAGMENT = /(?:^|[_-])(?:part|segment|chunk)[_-]?\d+$/iu;

function portable(value) {
  return value.replace(/\\/gu, "/");
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validateExactKeys(value, expected, label, errors) {
  if (!isPlainObject(value)) return;
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    errors.push(`${label} must have exactly these keys: ${canonical.join(", ")}.`);
  }
}

function isPortableRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value === portable(value)
    && !value.startsWith("/")
    && !/^[A-Za-z]:/u.test(value)
    && !value.split("/").some((part) => part === "" || part === "." || part === "..")
    && !/[?*\[\]{}]/u.test(value);
}

function sortedUniqueStrings(value) {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string")
    && new Set(value).size === value.length
    && JSON.stringify(value) === JSON.stringify([...value].sort());
}

export function physicalLineCount(source) {
  if (typeof source !== "string") throw new TypeError("Source text must be a string.");
  if (source.length === 0) return 0;
  const normalized = source.replace(/\r\n|\r|\u2028|\u2029/gu, "\n");
  const lines = normalized.split("\n");
  return normalized.endsWith("\n") ? lines.length - 1 : lines.length;
}

function maximumPhysicalLineBytes(source) {
  if (source.length === 0) return 0;
  return source
    .replace(/\r\n|\r|\u2028|\u2029/gu, "\n")
    .split("\n")
    .reduce((largest, line) => Math.max(largest, Buffer.byteLength(line)), 0);
}

export function normalizePortableRelative(root, file, pathApi = path) {
  const relative = pathApi.relative(root, file);
  return portable(relative);
}

function propertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateIdentifier") return `#${node.name}`;
  if (node.type === "Literal") return String(node.value);
  return null;
}

function staticPropertyName(node, computed = false) {
  if (computed && node?.type !== "Literal") return null;
  return propertyName(node);
}

function describedFunction(kind, name) {
  return {
    kind,
    name: name ?? "anonymous",
    named: name != null
  };
}

function functionDescriptor(node, parent) {
  if (parent?.type === "MethodDefinition" && parent.value === node) {
    const prefix = parent.kind === "get" || parent.kind === "set" ? parent.kind : "method";
    return describedFunction(prefix, staticPropertyName(parent.key, parent.computed));
  }
  if ((parent?.type === "Property" || parent?.type === "PropertyDefinition")
    && parent.value === node) {
    const prefix = parent.type === "Property" && (parent.kind === "get" || parent.kind === "set")
      ? parent.kind
      : parent.type === "Property" && parent.method
        ? "method"
        : node.type === "ArrowFunctionExpression" ? "arrow" : "function";
    return describedFunction(prefix, staticPropertyName(parent.key, parent.computed));
  }
  if (parent?.type === "VariableDeclarator" && parent.init === node) {
    return describedFunction(
      node.type === "ArrowFunctionExpression" ? "arrow" : "function",
      propertyName(parent.id)
    );
  }
  if (parent?.type === "AssignmentExpression" && parent.right === node) {
    const name = parent.left?.type === "MemberExpression"
      ? staticPropertyName(parent.left.property, parent.left.computed)
      : propertyName(parent.left);
    return describedFunction(
      node.type === "ArrowFunctionExpression" ? "arrow" : "function",
      name
    );
  }
  return describedFunction(
    node.type === "ArrowFunctionExpression" ? "arrow" : "function",
    node.id?.name ?? null
  );
}

function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry.type === "string") children.push(entry);
      }
    } else if (value && typeof value.type === "string") {
      children.push(value);
    }
  }
  return children;
}

export function collectFunctionSpans(ast) {
  const raw = [];
  const visit = (node, parent = null) => {
    if (FUNCTION_TYPES.has(node.type)) {
      const descriptor = functionDescriptor(node, parent);
      raw.push({
        ...descriptor,
        async: node.async === true,
        generator: node.generator === true,
        startLine: node.loc.start.line,
        endLine: node.loc.end.line,
        lines: node.loc.end.line - node.loc.start.line + 1
      });
    }
    for (const child of childNodes(node)) visit(child, node);
  };
  visit(ast);
  raw.sort((left, right) => left.startLine - right.startLine
    || left.endLine - right.endLine
    || left.kind.localeCompare(right.kind)
    || left.name.localeCompare(right.name));
  const identityCounts = new Map();
  for (const entry of raw) {
    if (!entry.named) continue;
    const base = `${entry.kind}:${entry.name}`;
    identityCounts.set(base, (identityCounts.get(base) || 0) + 1);
  }
  const occurrences = new Map();
  return raw.map((entry) => {
    const base = entry.named
      ? `${entry.kind}:${entry.name}`
      : `${entry.kind}:<anonymous>`;
    const ordinal = (occurrences.get(base) || 0) + 1;
    occurrences.set(base, ordinal);
    const identityCount = entry.named ? identityCounts.get(base) : null;
    return {
      ...entry,
      identityCount,
      key: `${base}#${ordinal}`,
      stableIdentity: entry.named
        && entry.name !== "anonymous"
        && entry.name !== "<anonymous>"
        && identityCount === 1
    };
  });
}

export function parseSourceStructure(source, file = "<source>") {
  let ast;
  try {
    ast = parse(source, {
      allowHashBang: true,
      ecmaVersion: "latest",
      locations: true,
      sourceFile: file,
      sourceType: file.toLowerCase().endsWith(".cjs") ? "script" : "module"
    });
  } catch (error) {
    const detail = error?.loc ? `${error.message} at ${error.loc.line}:${error.loc.column}` : error.message;
    throw new Error(`Could not parse ${file}: ${detail}`, { cause: error });
  }
  const specifiers = [];
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration"
      || ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source)) {
      specifiers.push(node.source.value);
    }
  }
  return {
    ast,
    functions: collectFunctionSpans(ast),
    specifiers,
    facade: ast.body.some((node) => node.type.startsWith("Export"))
      && ast.body.every((node) => node.type === "ImportDeclaration" || node.type.startsWith("Export"))
  };
}

function validateBudget(name, value, errors) {
  validateExactKeys(value, ["fileLines", "functionLines"], `budgets.${name}`, errors);
  if (!isPlainObject(value)
    || !isPositiveInteger(value.fileLines)
    || !isPositiveInteger(value.functionLines)) {
    errors.push(`budgets.${name} must define positive integer fileLines and functionLines.`);
  }
}

function isStableFunctionDebtKey(value) {
  if (typeof value !== "string") return false;
  const match = /^(?:arrow|function|get|method|set):(.+)#1$/u.exec(value);
  return match != null && match[1] !== "anonymous" && match[1] !== "<anonymous>";
}

function validateLegacyFunctionVector(file, functions, errors) {
  if (!Array.isArray(functions)) {
    errors.push(`legacyDebt.${file}.functions must be an array.`);
    return;
  }
  const keys = [];
  for (const entry of functions) {
    validateExactKeys(entry, ["capLines", "initialLines", "key"], `legacyDebt.${file}.functions entry`, errors);
    if (!isPlainObject(entry)
      || typeof entry.key !== "string"
      || !isPositiveInteger(entry.initialLines)
      || !isPositiveInteger(entry.capLines)
      || entry.capLines > entry.initialLines) {
      errors.push(`legacyDebt.${file}.functions contains an invalid function cap.`);
      continue;
    }
    if (!isStableFunctionDebtKey(entry.key)) {
      errors.push(`legacyDebt.${file}.functions may persist only unique named function keys ending in #1.`);
    }
    keys.push(entry.key);
  }
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort()) || new Set(keys).size !== keys.length) {
    errors.push(`legacyDebt.${file}.functions must have unique keys in sorted order.`);
  }
}

function validateLegacyDebt(config, errors) {
  if (!isPlainObject(config.legacyDebt)) {
    errors.push("legacyDebt must be an object keyed by exact portable source paths.");
    return;
  }
  const files = Object.keys(config.legacyDebt);
  if (JSON.stringify(files) !== JSON.stringify([...files].sort())) {
    errors.push("legacyDebt paths must be sorted.");
  }
  for (const file of files) {
    const entry = config.legacyDebt[file];
    validateExactKeys(entry, [
      "category", "functions", "initialLines", "issue", "lineCap", "rationale", "removalCriterion"
    ], `legacyDebt.${file}`, errors);
    if (!isPortableRelativePath(file)) errors.push(`legacyDebt path is not exact and portable: ${file}`);
    if (!isPlainObject(entry)
      || !CATEGORY_NAMES.includes(entry.category)
      || !isPositiveInteger(entry.initialLines)
      || (entry.lineCap !== null && !isPositiveInteger(entry.lineCap))
      || (entry.lineCap !== null && entry.lineCap > entry.initialLines)
      || typeof entry.issue !== "string" || entry.issue.length === 0
      || typeof entry.rationale !== "string" || entry.rationale.length === 0
      || typeof entry.removalCriterion !== "string" || entry.removalCriterion.length === 0) {
      errors.push(`legacyDebt.${file} is invalid.`);
      continue;
    }
    validateLegacyFunctionVector(file, entry.functions, errors);
  }
}

function validateInitialDebt(config, errors) {
  if (!isPlainObject(config.initialDebt)) {
    errors.push("initialDebt must be an object keyed by exact portable source paths.");
    return;
  }
  const files = Object.keys(config.initialDebt);
  if (JSON.stringify(files) !== JSON.stringify([...files].sort())) {
    errors.push("initialDebt paths must be sorted.");
  }
  for (const file of files) {
    const entry = config.initialDebt[file];
    validateExactKeys(entry, ["category", "functions", "initialLines"], `initialDebt.${file}`, errors);
    if (!isPortableRelativePath(file)
      || !isPlainObject(entry)
      || !CATEGORY_NAMES.includes(entry.category)
      || !isPositiveInteger(entry.initialLines)
      || !Array.isArray(entry.functions)) {
      errors.push(`initialDebt.${file} is invalid.`);
      continue;
    }
    const keys = [];
    for (const span of entry.functions) {
      validateExactKeys(span, ["initialLines", "key"], `initialDebt.${file}.functions entry`, errors);
      if (!isPlainObject(span) || typeof span.key !== "string" || !isPositiveInteger(span.initialLines)) {
        errors.push(`initialDebt.${file}.functions contains an invalid initial span.`);
        continue;
      }
      if (!isStableFunctionDebtKey(span.key)) {
        errors.push(`initialDebt.${file}.functions may persist only unique named function keys ending in #1.`);
      }
      keys.push(span.key);
    }
    if (JSON.stringify(keys) !== JSON.stringify([...keys].sort()) || new Set(keys).size !== keys.length) {
      errors.push(`initialDebt.${file}.functions must have unique keys in sorted order.`);
    }
  }
}

function validateDebtCapsAgainstInitial(config, errors) {
  if (!isPlainObject(config.initialDebt) || !isPlainObject(config.legacyDebt)) return;
  for (const [file, cap] of Object.entries(config.legacyDebt)) {
    const initial = config.initialDebt[file];
    if (!initial) {
      errors.push(`legacyDebt.${file} must be a subset of immutable initialDebt.`);
      continue;
    }
    if (cap.category !== initial.category
      || cap.initialLines !== initial.initialLines
      || (cap.lineCap !== null && cap.lineCap > initial.initialLines)) {
      errors.push(`legacyDebt.${file} must preserve its immutable initial category and line count.`);
    }
    const initialFunctions = new Map(initial.functions.map((span) => [span.key, span.initialLines]));
    for (const span of cap.functions || []) {
      if (initialFunctions.get(span.key) !== span.initialLines || span.capLines > span.initialLines) {
        errors.push(`legacyDebt.${file} function ${span.key} must preserve its immutable initial span.`);
      }
    }
  }
}

function validateCycleList(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  const serialized = [];
  for (const cycle of value) {
    if (!sortedUniqueStrings(cycle) || cycle.length === 0 || cycle.some((file) => !isPortableRelativePath(file))) {
      errors.push(`Each ${label} entry must be a nonempty sorted list of exact portable paths.`);
      continue;
    }
    serialized.push(cycle.join("\u0000"));
  }
  if (JSON.stringify(serialized) !== JSON.stringify([...serialized].sort())
    || new Set(serialized).size !== serialized.length) {
    errors.push(`${label} must be unique and sorted.`);
  }
}

function validateCycleCaps(config, errors) {
  validateCycleList(config.initialCycles, "initialCycles", errors);
  validateCycleList(config.capCycleComponents, "capCycleComponents", errors);
  if (!Array.isArray(config.initialCycles) || !Array.isArray(config.capCycleComponents)) return;
  const used = new Set();
  for (const component of config.capCycleComponents) {
    const owner = config.initialCycles.find((cycle) => component.every((file) => cycle.includes(file)));
    if (!owner) errors.push("Every capCycleComponents entry must be a subset of one immutable initial cycle.");
    for (const file of component) {
      if (used.has(file)) errors.push("capCycleComponents must be disjoint after a cycle splits.");
      used.add(file);
    }
  }
}

function validateDispositions(config, errors) {
  if (!isPlainObject(config.dispositions)) {
    errors.push("dispositions must be an object keyed by exact portable source paths.");
    return;
  }
  const files = Object.keys(config.dispositions);
  if (JSON.stringify(files) !== JSON.stringify([...files].sort())) {
    errors.push("disposition paths must be sorted.");
  }
  for (const file of files) {
    const value = config.dispositions[file];
    validateExactKeys(value, ["stage", "target"], `dispositions.${file}`, errors);
    if (!isPortableRelativePath(file)
      || !isPlainObject(value)
      || typeof value.stage !== "string" || value.stage.length === 0
      || typeof value.target !== "string" || value.target.length === 0) {
      errors.push(`dispositions.${file} is invalid.`);
    }
  }
}

function initialBaselineProjection(config) {
  const debt = isPlainObject(config?.initialDebt) ? Object.fromEntries(
    Object.keys(config.initialDebt).sort().map((file) => {
      const entry = config.initialDebt[file] || {};
      const functions = Array.isArray(entry.functions) ? entry.functions.map((span) => ({
        initialLines: span?.initialLines,
        key: span?.key
      })) : [];
      return [file, {
        category: entry.category,
        functions,
        initialLines: entry.initialLines
      }];
    })
  ) : {};
  return {
    initialCycles: Array.isArray(config?.initialCycles) ? config.initialCycles : [],
    initialDebt: debt,
    initialOrdinalFragments: Array.isArray(config?.initialOrdinalFragments)
      ? config.initialOrdinalFragments
      : []
  };
}

export function sourceStructureInitialDigest(config) {
  const canonical = JSON.stringify(initialBaselineProjection(config));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function canonicalPolicyValue(value) {
  if (Array.isArray(value)) return value.map(canonicalPolicyValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalPolicyValue(value[key])])
  );
}

function currentPolicyProjection(config) {
  if (!isPlainObject(config)) return canonicalPolicyValue(config);
  const baseline = isPlainObject(config.baseline)
    ? Object.fromEntries(Object.entries(config.baseline).filter(([key]) => key !== "policyDigest"))
    : config.baseline;
  return canonicalPolicyValue({ ...config, baseline });
}

export function sourceStructurePolicyDigest(config) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(currentPolicyProjection(config)))
    .digest("hex");
}

export function validateSourceStructurePolicy(config, {
  expectedInitialDigest = config?.baseline?.initialDigest,
  expectedPolicyDigest = config?.baseline?.policyDigest
} = {}) {
  const errors = [];
  if (!isPlainObject(config)) return ["Policy must be a JSON object."];
  validateExactKeys(config, [
    "baseline", "budgets", "capCycleComponents", "capOrdinalFragments", "dispositions",
    "extensions", "facadePaths", "initialCycles", "initialDebt", "initialOrdinalFragments", "legacyDebt",
    "maxPhysicalLineBytes", "maxSourceBytes", "mode", "roots", "schemaVersion"
  ], "Policy", errors);
  if (config.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (!POLICY_MODES.has(config.mode)) errors.push("mode must be observe or ratchet.");
  if (!sortedUniqueStrings(config.extensions)
    || config.extensions.some((entry) => !/^\.[a-z0-9]+$/u.test(entry))) {
    errors.push("extensions must be a sorted unique list of lowercase file extensions.");
  } else if (JSON.stringify(config.extensions) !== JSON.stringify(SOURCE_STRUCTURE_EXTENSIONS)) {
    errors.push(`extensions must remain the canonical set: ${SOURCE_STRUCTURE_EXTENSIONS.join(", ")}.`);
  }
  if (!sortedUniqueStrings(config.roots)
    || config.roots.some((entry) => !isPortableRelativePath(entry))) {
    errors.push("roots must be a sorted unique list of exact portable directories.");
  } else if (JSON.stringify(config.roots) !== JSON.stringify(SOURCE_STRUCTURE_ROOTS)) {
    errors.push(`roots must remain the canonical set: ${SOURCE_STRUCTURE_ROOTS.join(", ")}.`);
  }
  if (!sortedUniqueStrings(config.facadePaths)
    || config.facadePaths.some((entry) => !isPortableRelativePath(entry))) {
    errors.push("facadePaths must be a sorted unique list of exact portable source paths.");
  }
  if (!isPlainObject(config.budgets)) errors.push("budgets must be an object.");
  validateExactKeys(config.budgets, CATEGORY_NAMES, "budgets", errors);
  for (const category of CATEGORY_NAMES) validateBudget(category, config.budgets?.[category], errors);
  if (config.budgets?.product?.fileLines !== 1500 || config.budgets?.product?.functionLines !== 250
    || config.budgets?.tooling?.fileLines !== 2000 || config.budgets?.tooling?.functionLines !== 350
    || config.budgets?.tests?.fileLines !== 2000 || config.budgets?.tests?.functionLines !== 400
    || config.budgets?.facade?.fileLines !== 300 || config.budgets?.facade?.functionLines !== 250) {
    errors.push("The canonical budgets are product 1500/250, tooling 2000/350, tests 2000/400, and facades 300/250 lines.");
  }
  if (config.maxPhysicalLineBytes !== SOURCE_STRUCTURE_MAX_PHYSICAL_LINE_BYTES) {
    errors.push(`maxPhysicalLineBytes must remain ${SOURCE_STRUCTURE_MAX_PHYSICAL_LINE_BYTES}.`);
  }
  if (config.maxSourceBytes !== SOURCE_STRUCTURE_MAX_SOURCE_BYTES) {
    errors.push(`maxSourceBytes must remain ${SOURCE_STRUCTURE_MAX_SOURCE_BYTES}.`);
  }
  validateExactKeys(config.baseline, ["date", "initialDigest", "policyDigest", "revision"], "baseline", errors);
  if (!isPlainObject(config.baseline)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(config.baseline.date)
    || !/^[0-9a-f]{40}$/u.test(config.baseline.revision)
    || !/^[0-9a-f]{64}$/u.test(config.baseline.initialDigest)
    || !/^[0-9a-f]{64}$/u.test(config.baseline.policyDigest)) {
    errors.push("baseline must contain an ISO date, full Git revision, and SHA-256 initialDigest and policyDigest values.");
  }
  validateDispositions(config, errors);
  validateInitialDebt(config, errors);
  validateLegacyDebt(config, errors);
  validateDebtCapsAgainstInitial(config, errors);
  validateCycleCaps(config, errors);
  if (!sortedUniqueStrings(config.initialOrdinalFragments)
    || config.initialOrdinalFragments.some((entry) => !isPortableRelativePath(entry))) {
    errors.push("initialOrdinalFragments must be a sorted unique list of exact portable paths.");
  }
  if (!sortedUniqueStrings(config.capOrdinalFragments)
    || config.capOrdinalFragments.some((entry) => !isPortableRelativePath(entry))) {
    errors.push("capOrdinalFragments must be a sorted unique list of exact portable paths.");
  } else if (Array.isArray(config.initialOrdinalFragments)
    && config.capOrdinalFragments.some((entry) => !config.initialOrdinalFragments.includes(entry))) {
    errors.push("capOrdinalFragments must be a subset of immutable initialOrdinalFragments.");
  }
  if (/^[0-9a-f]{64}$/u.test(config.baseline?.initialDigest || "")) {
    const calculated = sourceStructureInitialDigest(config);
    if (config.baseline.initialDigest !== calculated) {
      errors.push("baseline.initialDigest does not match the immutable initial debt and topology data.");
    }
    if (typeof expectedInitialDigest === "string" && config.baseline.initialDigest !== expectedInitialDigest) {
      errors.push("baseline.initialDigest does not match the repository-pinned initial digest.");
    }
  }
  if (/^[0-9a-f]{64}$/u.test(config.baseline?.policyDigest || "")) {
    const calculated = sourceStructurePolicyDigest(config);
    if (config.baseline.policyDigest !== calculated) {
      errors.push("baseline.policyDigest does not match the current policy boundary.");
    }
    if (typeof expectedPolicyDigest === "string" && config.baseline.policyDigest !== expectedPolicyDigest) {
      errors.push("baseline.policyDigest does not match the repository-pinned policy boundary.");
    }
  }
  return errors;
}

export function loadSourceStructurePolicy({
  root,
  policyPath = SOURCE_STRUCTURE_POLICY_PATH,
  fsApi = fs
}) {
  const absolute = path.resolve(root, policyPath);
  let text;
  try {
    const stat = fsApi.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("policy path must be a regular non-symlink file");
    }
    text = fsApi.readFileSync(absolute, "utf8");
  } catch (error) {
    throw new Error(`Could not read source-structure policy: ${error.message}`, { cause: error });
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse source-structure policy JSON: ${error.message}`, { cause: error });
  }
  const errors = validateSourceStructurePolicy(config, {
    expectedInitialDigest: SOURCE_STRUCTURE_INITIAL_DIGEST,
    expectedPolicyDigest: SOURCE_STRUCTURE_POLICY_DIGEST
  });
  if (errors.length > 0) throw new Error(`Invalid source-structure policy:\n- ${errors.join("\n- ")}`);
  return config;
}

function categoryForFile(file, config) {
  if (config.facadePaths.includes(file)) return "facade";
  if (file.startsWith("tests/")) return "tests";
  if (file.startsWith("scripts/")) return "tooling";
  if (file.startsWith("apps/") || file.startsWith("plugins/")) return "product";
  return null;
}

function finding(code, file, message, details = {}) {
  return { code, file, message, ...details };
}

function walkSources({ root, config, fsApi }, hardFindings) {
  const files = [];
  const extensions = new Set(config.extensions);
  const visit = (absolute, { scanRoot = false } = {}) => {
    let stat;
    try {
      stat = fsApi.lstatSync(absolute);
    } catch (error) {
      hardFindings.push(finding("unreadable-path", normalizePortableRelative(root, absolute), error.message));
      return;
    }
    const relative = normalizePortableRelative(root, absolute);
    if (stat.isSymbolicLink()) {
      hardFindings.push(finding("symlinked-source-path", relative, "Source scan roots must not contain symlinks."));
      return;
    }
    if (scanRoot && !stat.isDirectory()) {
      hardFindings.push(finding("invalid-scan-root", relative, "Every canonical source scan root must be a real directory."));
      return;
    }
    if (stat.isDirectory()) {
      if (absolute !== root && DEFAULT_EXCLUDED_DIRECTORIES.has(path.basename(absolute))) return;
      let entries;
      try {
        entries = fsApi.readdirSync(absolute).sort();
      } catch (error) {
        hardFindings.push(finding("unreadable-directory", relative, error.message));
        return;
      }
      for (const name of entries) visit(path.join(absolute, name));
      return;
    }
    if (stat.isFile() && extensions.has(path.extname(absolute).toLowerCase())) files.push(absolute);
  };
  for (const scanRoot of config.roots) {
    const absolute = path.resolve(root, ...scanRoot.split("/"));
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) {
      hardFindings.push(finding("unsafe-scan-root", scanRoot, "Scan root escapes the repository."));
      continue;
    }
    visit(absolute, { scanRoot: true });
  }
  return [...new Set(files)].sort((left, right) => (
    normalizePortableRelative(root, left).localeCompare(normalizePortableRelative(root, right))
  ));
}

function readAndParseFiles({ root, config, fsApi }, hardFindings) {
  const analyzed = [];
  for (const absolute of walkSources({ root, config, fsApi }, hardFindings)) {
    const file = normalizePortableRelative(root, absolute);
    let stat;
    try {
      stat = fsApi.lstatSync(absolute);
    } catch (error) {
      hardFindings.push(finding("unreadable-source-metadata", file, error.message));
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      hardFindings.push(finding("invalid-source-metadata", file, "Source metadata changed or is not a bounded regular file."));
      continue;
    }
    if (stat.size > config.maxSourceBytes) {
      hardFindings.push(finding(
        "source-byte-limit",
        file,
        `Source exceeds the ${config.maxSourceBytes}-byte pre-parse limit.`
      ));
      continue;
    }
    let source;
    try {
      source = fsApi.readFileSync(absolute, "utf8");
    } catch (error) {
      hardFindings.push(finding("unreadable-source", file, error.message));
      continue;
    }
    if (Buffer.byteLength(source) > config.maxSourceBytes) {
      hardFindings.push(finding(
        "source-byte-limit",
        file,
        `Source exceeded the ${config.maxSourceBytes}-byte limit while being read.`
      ));
      continue;
    }
    if (maximumPhysicalLineBytes(source) > config.maxPhysicalLineBytes) {
      hardFindings.push(finding(
        "physical-line-byte-limit",
        file,
        `A physical source line exceeds the ${config.maxPhysicalLineBytes}-byte handwritten limit.`
      ));
      continue;
    }
    let parsed;
    try {
      parsed = parseSourceStructure(source, file);
    } catch (error) {
      hardFindings.push(finding("parse-error", file, error.message));
      continue;
    }
    const category = categoryForFile(file, config);
    analyzed.push({
      absolute,
      category,
      facade: category === "facade",
      file,
      functions: parsed.functions,
      lines: physicalLineCount(source),
      specifiers: parsed.specifiers
    });
  }
  return analyzed;
}

const STATIC_FILE_URL_ROOT = "file:///__source_structure__/";

function normalizeStaticSpecifier(importer, specifier) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return null;
  if (/%(?:2f|5c)/iu.test(specifier)) return null;
  try {
    const encodedImporter = importer.split("/").map(encodeURIComponent).join("/");
    const resolved = new URL(specifier, new URL(encodedImporter, STATIC_FILE_URL_ROOT));
    const decoded = decodeURIComponent(resolved.pathname);
    const prefix = new URL(STATIC_FILE_URL_ROOT).pathname;
    if (!decoded.startsWith(prefix)) {
      return { excluded: false, outside: true, path: portable(decoded) };
    }
    const target = path.posix.normalize(decoded.slice(prefix.length));
    const segments = target.split("/");
    return {
      excluded: segments.some((segment) => DEFAULT_EXCLUDED_DIRECTORIES.has(segment)),
      outside: !SOURCE_STRUCTURE_ROOTS.some((root) => target === root || target.startsWith(`${root}/`)),
      path: target
    };
  } catch {
    return null;
  }
}

function resolveStaticEdge(base, knownFiles) {
  if (!base) return null;
  const candidates = path.posix.extname(base)
    ? [base]
    : [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}/index.mjs`, `${base}/index.js`];
  return candidates.find((candidate) => knownFiles.has(candidate)) || null;
}

export function stronglyConnectedComponents(nodes, edges) {
  const indexByNode = new Map();
  const lowByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let nextIndex = 0;
  const visit = (node) => {
    indexByNode.set(node, nextIndex);
    lowByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of [...(edges.get(node) || [])].sort()) {
      if (!indexByNode.has(target)) {
        visit(target);
        lowByNode.set(node, Math.min(lowByNode.get(node), lowByNode.get(target)));
      } else if (onStack.has(target)) {
        lowByNode.set(node, Math.min(lowByNode.get(node), indexByNode.get(target)));
      }
    }
    if (lowByNode.get(node) !== indexByNode.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    component.sort();
    if (component.length > 1 || (edges.get(component[0]) || new Set()).has(component[0])) {
      components.push(component);
    }
  };
  for (const node of [...nodes].sort()) if (!indexByNode.has(node)) visit(node);
  return components.sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")));
}

function dependencyAnalysis(files) {
  const knownFiles = new Set(files.map((entry) => entry.file));
  const byPath = new Map(files.map((entry) => [entry.file, entry]));
  const edges = new Map(files.map((entry) => [entry.file, new Set()]));
  const excludedSourceEdges = [];
  const outsideSourceEdges = [];
  const reverseFacadeImports = [];
  for (const entry of files) {
    for (const specifier of entry.specifiers) {
      const normalized = normalizeStaticSpecifier(entry.file, specifier);
      if (normalized?.excluded) {
        excludedSourceEdges.push({ importer: entry.file, target: normalized.path });
        continue;
      }
      if (normalized?.outside) {
        outsideSourceEdges.push({ importer: entry.file, target: normalized.path });
        continue;
      }
      const target = resolveStaticEdge(normalized?.path, knownFiles);
      if (!target) continue;
      edges.get(entry.file).add(target);
      if (!entry.facade && entry.category !== "tests" && byPath.get(target)?.facade) {
        reverseFacadeImports.push({ importer: entry.file, facade: target });
      }
    }
  }
  return {
    cycles: stronglyConnectedComponents(knownFiles, edges),
    edges,
    excludedSourceEdges: excludedSourceEdges.sort((left, right) => (
      left.importer.localeCompare(right.importer) || left.target.localeCompare(right.target)
    )),
    outsideSourceEdges: outsideSourceEdges.sort((left, right) => (
      left.importer.localeCompare(right.importer) || left.target.localeCompare(right.target)
    )),
    reverseFacadeImports: reverseFacadeImports.sort((left, right) => (
      left.importer.localeCompare(right.importer) || left.facade.localeCompare(right.facade)
    ))
  };
}

function policySeverity(mode, code) {
  if (code === "ambiguous-function-identity" || code === "unstable-function-identity") {
    return "error";
  }
  if (mode === "observe") return "warning";
  if (code === "legacy-cycle"
    || code === "legacy-ordinal-fragment"
    || code === "current-debt") {
    return "warning";
  }
  return "error";
}

function addPolicyFinding(findings, mode, code, file, message, details = {}) {
  findings.push({ ...finding(code, file, message, details), severity: policySeverity(mode, code) });
}

function assessFunctionDebt(entry, legacy, initial, budget, mode, findings) {
  const overBudget = entry.functions.filter((span) => span.lines > budget.functionLines);
  const reportedAmbiguities = new Set();
  const persistedKeys = new Set([
    ...(initial?.functions || []).map((span) => span.key),
    ...(legacy?.functions || []).map((span) => span.key)
  ]);
  for (const key of persistedKeys) {
    const base = key.slice(0, -2);
    const matches = entry.functions.filter((span) => (
      span.named && `${span.kind}:${span.name}` === base
    ));
    if (matches.length < 2) continue;
    reportedAmbiguities.add(base);
    addPolicyFinding(findings, mode, "ambiguous-function-identity", entry.file,
      `${base} occurs ${matches.length} times in this file; persisted function debt requires a unique named identity.`, {
        functionKey: key
      });
  }
  const current = [];
  for (const span of overBudget) {
    if (!span.stableIdentity) {
      const ambiguous = span.named
        && span.name !== "anonymous"
        && span.name !== "<anonymous>"
        && span.identityCount > 1;
      const code = ambiguous ? "ambiguous-function-identity" : "unstable-function-identity";
      const base = `${span.kind}:${span.name}`;
      if (ambiguous && reportedAmbiguities.has(base)) continue;
      if (ambiguous) reportedAmbiguities.add(base);
      const message = ambiguous
        ? `${span.kind}:${span.name} occurs ${span.identityCount} times in this file; long-function debt requires a unique named identity.`
        : `${span.key} is ${span.lines} lines but has no unique syntactic name; anonymous long functions cannot be baselined.`;
      addPolicyFinding(findings, mode, code, entry.file, message, {
        endLine: span.endLine,
        functionKey: span.key,
        startLine: span.startLine
      });
      continue;
    }
    current.push({ key: span.key, lines: span.lines });
  }
  current.sort((left, right) => left.key.localeCompare(right.key));
  const baseline = new Map((legacy?.functions || []).map((span) => [span.key, span]));
  const initialKeys = new Set((initial?.functions || []).map((span) => span.key));
  for (const span of current) {
    const cap = baseline.get(span.key);
    if (!cap) {
      const code = initialKeys.has(span.key) ? "resolved-function-regression" : "new-function-overage";
      addPolicyFinding(findings, mode, code, entry.file,
        `${span.key} is ${span.lines} lines; the ${entry.category} function budget is ${budget.functionLines}.`, { functionKey: span.key });
    } else if (span.lines > cap.capLines) {
      addPolicyFinding(findings, mode, "legacy-function-growth", entry.file,
        `${span.key} grew from its ${cap.capLines}-line cap to ${span.lines} lines.`, { functionKey: span.key });
    } else if (span.lines < cap.capLines) {
      addPolicyFinding(findings, mode, "stale-function-cap", entry.file,
        `${span.key} shrank to ${span.lines} lines; lower its ${cap.capLines}-line cap in the same change.`, { functionKey: span.key });
    }
    baseline.delete(span.key);
  }
  for (const [key] of baseline) {
    addPolicyFinding(findings, mode, "stale-function-exception", entry.file,
      `${key} is no longer over budget; remove its legacy function exception.`, { functionKey: key });
  }
  return overBudget.length;
}

function assessFileDebt(entry, config, mode, findings) {
  const budget = entry.category ? config.budgets[entry.category] : null;
  const legacy = config.legacyDebt[entry.file];
  const initial = config.initialDebt[entry.file];
  if (!budget) {
    if (entry.lines > 5000) {
      addPolicyFinding(findings, mode, "unclassified-giga-file", entry.file,
        `Unclassified handwritten source has ${entry.lines} lines (limit before classification: 5000).`);
    }
    return;
  }
  const fileOver = entry.lines > budget.fileLines;
  const functionDebtCount = assessFunctionDebt(entry, legacy, initial, budget, mode, findings);
  if ((fileOver || functionDebtCount > 0) && !legacy) {
    addPolicyFinding(findings, mode, "missing-legacy-exception", entry.file,
      `Current debt is not recorded with an exact-path disposition and removal criterion.`);
  }
  if (fileOver) {
    if (!legacy) {
      addPolicyFinding(findings, mode, initial ? "resolved-file-regression" : "new-file-overage", entry.file,
        `${entry.lines} lines exceeds the ${entry.category} file budget of ${budget.fileLines}.`);
    } else if (legacy.lineCap === null) {
      addPolicyFinding(findings, mode, "resolved-file-regression", entry.file,
        `${entry.lines} lines regresses a resolved file cap above the ${budget.fileLines}-line budget.`);
    } else if (entry.lines > legacy.lineCap) {
      addPolicyFinding(findings, mode, "legacy-file-growth", entry.file,
        `${entry.lines} lines exceeds the exact legacy cap of ${legacy.lineCap}.`);
    } else if (entry.lines < legacy.lineCap) {
      addPolicyFinding(findings, mode, "stale-file-cap", entry.file,
        `File shrank to ${entry.lines} lines; lower its ${legacy.lineCap}-line cap in the same change.`);
    } else {
      addPolicyFinding(findings, mode, "current-debt", entry.file,
        `File remains at its ${entry.lines}-line legacy cap.`);
    }
  } else if (legacy && legacy.lineCap !== null) {
    addPolicyFinding(findings, mode, "stale-file-exception", entry.file,
      `File is within its ${budget.fileLines}-line budget; set its legacy lineCap to null.`);
  } else if (legacy && functionDebtCount > 0) {
    addPolicyFinding(findings, mode, "current-debt", entry.file,
      `File retains ${functionDebtCount} exact-capped long function${functionDebtCount === 1 ? "" : "s"}.`);
  }
  if (legacy && legacy.category !== entry.category) {
    addPolicyFinding(findings, mode, "legacy-category-drift", entry.file,
      `Legacy category ${legacy.category} does not match current category ${entry.category}.`);
  }
}

function assessDispositions(files, config, mode, findings) {
  const current = new Set(files.filter((entry) => entry.lines > 5000).map((entry) => entry.file));
  for (const file of current) {
    if (!config.dispositions[file]) {
      addPolicyFinding(findings, mode, "missing-giga-disposition", file,
        "Every handwritten source above 5,000 lines needs an exact staged disposition.");
    }
  }
  for (const file of Object.keys(config.dispositions)) {
    if (!current.has(file)) {
      addPolicyFinding(findings, mode, "stale-giga-disposition", file,
        "The file is no longer above 5,000 lines; remove its giga-file disposition.");
    }
  }
}

function assessStaleDebt(files, config, mode, findings) {
  const present = new Set(files.map((entry) => entry.file));
  for (const file of Object.keys(config.legacyDebt)) {
    if (!present.has(file)) {
      const cap = config.legacyDebt[file];
      if (cap.lineCap !== null || cap.functions.length > 0) {
        addPolicyFinding(findings, mode, "stale-file-exception", file,
          "Missing source still has active caps; resolve every cap before retaining its immutable history.");
      }
    }
  }
}

function assessCycles(cycles, config, mode, findings) {
  const current = new Map(cycles.map((cycle) => [cycle.join("\u0000"), cycle]));
  const baseline = new Map(config.capCycleComponents.map((cycle) => [cycle.join("\u0000"), cycle]));
  for (const [key, cycle] of current) {
    if (baseline.has(key)) {
      addPolicyFinding(findings, mode, "legacy-cycle", cycle[0],
        `Static ESM cycle remains across ${cycle.length} modules.`, { cycle });
      baseline.delete(key);
      continue;
    }
    const enlarged = config.capCycleComponents.find((old) => old.every((file) => cycle.includes(file)));
    addPolicyFinding(findings, mode, enlarged ? "enlarged-cycle" : "new-cycle", cycle[0],
      `${enlarged ? "Enlarged" : "New"} static ESM cycle: ${cycle.join(" -> ")}.`, { cycle });
  }
  for (const cycle of baseline.values()) {
    addPolicyFinding(findings, mode, "stale-cycle-exception", cycle[0],
      "A legacy cycle was reduced or removed; update the cycle baseline.", { cycle });
  }
}

function detectOrdinalFragments(files) {
  return files.map((entry) => entry.file).filter((file) => {
    const extension = path.posix.extname(file);
    const stem = path.posix.basename(file, extension);
    return ORDINAL_FRAGMENT.test(stem);
  }).sort();
}

function assessFragments(fragments, config, mode, findings) {
  const baseline = new Set(config.capOrdinalFragments);
  const current = new Set(fragments);
  for (const file of fragments) {
    addPolicyFinding(findings, mode, baseline.has(file) ? "legacy-ordinal-fragment" : "new-ordinal-fragment",
      file, baseline.has(file)
        ? "Legacy ordinal fragment remains and must be replaced by domain-oriented modules."
        : "New ordinal source fragments are prohibited; split by domain rather than sequence number.");
  }
  for (const file of baseline) {
    if (!current.has(file)) {
      addPolicyFinding(findings, mode, "stale-ordinal-exception", file,
        "Ordinal fragment is gone; remove its exact baseline entry.");
    }
  }
}

export function evaluateSourceStructure({
  root,
  config,
  mode = config?.mode,
  fsApi = fs,
  expectedInitialDigest = config?.baseline?.initialDigest,
  expectedPolicyDigest = config?.baseline?.policyDigest
}) {
  const hardFindings = [];
  const configErrors = validateSourceStructurePolicy(config, {
    expectedInitialDigest,
    expectedPolicyDigest
  });
  if (configErrors.length > 0) {
    return {
      errors: configErrors.map((message) => ({
        code: "invalid-config",
        file: SOURCE_STRUCTURE_POLICY_PATH,
        message,
        severity: "error"
      })),
      files: [],
      findings: [],
      mode,
      ok: false,
      warnings: []
    };
  }
  if (!POLICY_MODES.has(mode)) {
    return {
      errors: [{ code: "invalid-mode", file: null, message: "Mode must be observe or ratchet.", severity: "error" }],
      files: [], findings: [], mode, ok: false, warnings: []
    };
  }
  const files = readAndParseFiles({ root: path.resolve(root), config, fsApi }, hardFindings);
  const dependency = dependencyAnalysis(files);
  const findings = [];
  for (const entry of files) assessFileDebt(entry, config, mode, findings);
  assessStaleDebt(files, config, mode, findings);
  assessDispositions(files, config, mode, findings);
  assessCycles(dependency.cycles, config, mode, findings);
  const fragments = detectOrdinalFragments(files);
  assessFragments(fragments, config, mode, findings);
  for (const edge of dependency.reverseFacadeImports) {
    addPolicyFinding(findings, mode, "reverse-facade-import", edge.importer,
      `Implementation module imports facade ${edge.facade}; dependencies must point toward domain modules.`, edge);
  }
  for (const edge of dependency.excludedSourceEdges) {
    addPolicyFinding(
      findings,
      mode,
      "excluded-source-edge",
      edge.importer,
      `Relative static dependency enters excluded source directory: ${edge.target}.`,
      edge
    );
  }
  for (const edge of dependency.outsideSourceEdges) {
    addPolicyFinding(
      findings,
      mode,
      "outside-source-root-edge",
      edge.importer,
      "Relative static dependency escapes the canonical source roots.",
      edge
    );
  }
  const errors = [
    ...hardFindings.map((entry) => ({ ...entry, severity: "error" })),
    ...findings.filter((entry) => entry.severity === "error")
  ];
  const warnings = findings.filter((entry) => entry.severity === "warning");
  return {
    cycles: dependency.cycles,
    errors,
    files,
    findings,
    fragments,
    mode,
    ok: errors.length === 0,
    warnings
  };
}
