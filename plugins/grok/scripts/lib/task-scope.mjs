import { sanitizeDisplayText } from "./redact.mjs";

const MAX_SCOPE_RULES = 64;
const MAX_SCOPE_RULE_CHARS = 2 * 1024;

function clipScopeRule(value) {
  const text = sanitizeDisplayText(value);
  return text.length <= MAX_SCOPE_RULE_CHARS
    ? text
    : `${text.slice(0, MAX_SCOPE_RULE_CHARS)}…`;
}

function scopeRules(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clipScopeRule(String(item ?? "").trim()))
    .filter(Boolean)
    .slice(0, MAX_SCOPE_RULES);
}

/**
 * Return paths that fall outside the declared include/exclude scope.
 *
 * Input ordering and spelling are retained in the result so callers can bind
 * violations to their original evidence. Matching alone normalizes Windows
 * separators and one leading `./` segment.
 */
export function evaluateScope(paths, scope = null) {
  const include = scopeRules(scope?.include).map((item) => item.replace(/\\/g, "/"));
  const exclude = scopeRules(scope?.exclude).map((item) => item.replace(/\\/g, "/"));
  const matches = (relativePath, pattern) => globToRegExp(pattern).test(relativePath);
  return [...new Set(Array.isArray(paths) ? paths : [])].filter((rawPath) => {
    const relativePath = String(rawPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!relativePath || relativePath.startsWith("[")) return true;
    const included = include.length === 0 || include.some((pattern) => matches(relativePath, pattern));
    const excluded = exclude.some((pattern) => matches(relativePath, pattern));
    return !included || excluded;
  });
}

function globToRegExp(pattern) {
  const source = String(pattern || "").replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}
