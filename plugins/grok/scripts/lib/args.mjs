import { CompanionError } from "./errors.mjs";

export function splitArgs(raw) {
  const text = String(raw ?? "");
  const out = [];
  let token = "", quote = null, escaped = false;
  for (const char of text) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else token += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (token) { out.push(token); token = ""; } continue; }
    token += char;
  }
  if (escaped || quote) throw new CompanionError("E_USAGE", "Unterminated quote or escape in arguments.");
  if (token) out.push(token);
  return out;
}

export function parseArgs(argv, { values = [], booleans = [] } = {}) {
  const valueSet = new Set(values), boolSet = new Set(booleans), options = {}, positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq < 0 ? undefined : eq);
    if (boolSet.has(key)) { if (eq >= 0) throw new CompanionError("E_USAGE", `--${key} does not accept a value.`); options[key] = true; continue; }
    if (!valueSet.has(key)) throw new CompanionError("E_USAGE", `Unknown option --${key}.`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value == null || value.startsWith("--")) throw new CompanionError("E_USAGE", `--${key} requires a value.`);
    options[key] = value;
  }
  return { options, positionals };
}
