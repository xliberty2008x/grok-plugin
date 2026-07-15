/**
 * Parse a unified diff and return Set of "path:line" pairs that are valid
 * GitHub pull review comment targets on side RIGHT (added or context lines).
 */
export function collectRightSideLines(diffText) {
  const lines = String(diffText || "").split(/\r?\n/);
  const out = new Set();
  let file = null;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const rest = line.slice(4).trim();
      if (rest === "/dev/null") {
        file = null;
        inHunk = false;
        continue;
      }
      // "b/path" or "path"
      file = rest.startsWith("b/") ? rest.slice(2) : rest;
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = Boolean(file);
      continue;
    }
    if (!inHunk || !file) continue;
    if (line.startsWith("\\")) continue; // \ No newline at end of file
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.add(`${file}:${newLine}`);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      // deleted: do not advance newLine
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      // context (empty line in hunk is rare; treat " " prefix as context)
      if (line.startsWith(" ")) {
        out.add(`${file}:${newLine}`);
        newLine += 1;
      }
      continue;
    }
  }
  return out;
}
