/**
 * Parse a unified diff into a structured RIGHT-side map for GitHub pull-review
 * comment targets (added or context lines). Paths are kept as full strings so
 * colons/spaces do not collide the way a flat "path:line" Set can.
 *
 * Legacy {@link collectRightSideLines} remains a compatibility wrapper.
 */

/**
 * Unquote a Git path from `diff --git` / `+++` headers.
 * Handles C-style quoted paths (`"a/foo bar"`).
 * @param {string} raw
 * @returns {string|null}
 */
export function unquoteGitPath(raw) {
  const input = String(raw ?? "").trim();
  if (!input || input === "/dev/null") return null;
  if (!input.startsWith("\"")) return input;
  if (!input.endsWith("\"") || input.length < 2) return null;
  const bytes = [];
  const appendText = (text) => {
    bytes.push(...Buffer.from(text, "utf8"));
  };
  for (let i = 1; i < input.length - 1; i++) {
    const ch = input[i];
    if (ch !== "\\") {
      const codePoint = input.codePointAt(i);
      const literal = String.fromCodePoint(codePoint);
      appendText(literal);
      i += literal.length - 1;
      continue;
    }
    i += 1;
    if (i >= input.length - 1) return null;
    const esc = input[i];
    if (esc === "n") appendText("\n");
    else if (esc === "t") appendText("\t");
    else if (esc === "r") appendText("\r");
    else if (esc === "b") appendText("\b");
    else if (esc === "f") appendText("\f");
    else if (esc === "\"") appendText("\"");
    else if (esc === "\\") appendText("\\");
    else if (esc === "a") appendText("\u0007");
    else if (esc === "v") appendText("\u000b");
    else if (esc >= "0" && esc <= "7") {
      let oct = esc;
      for (let k = 0; k < 2 && i + 1 < input.length - 1; k++) {
        const next = input[i + 1];
        if (next < "0" || next > "7") break;
        i += 1;
        oct += next;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
    } else {
      appendText(esc);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes)
    );
  } catch {
    return null;
  }
}

/**
 * Strip a leading a/ or b/ prefix from a diff path token when present.
 * @param {string} pathText
 * @returns {string}
 */
function stripDiffPrefix(pathText) {
  if (pathText.startsWith("a/") || pathText.startsWith("b/")) return pathText.slice(2);
  return pathText;
}

/**
 * Parse `diff --git a/... b/...` into old/new paths (best-effort).
 * @param {string} line
 * @returns {{ oldPath: string|null, newPath: string|null }|null}
 */
function parseDiffGitLine(line) {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice("diff --git ".length);
  // Quoted form: diff --git "a/foo bar" "b/foo bar"
  if (rest.startsWith("\"")) {
    const paths = [];
    let i = 0;
    while (i < rest.length && paths.length < 2) {
      while (i < rest.length && rest[i] === " ") i += 1;
      if (i >= rest.length) break;
      if (rest[i] !== "\"") {
        // Mixed / unquoted tail — fall through to space split below.
        break;
      }
      let j = i + 1;
      let escaped = false;
      for (; j < rest.length; j++) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (rest[j] === "\\") {
          escaped = true;
          continue;
        }
        if (rest[j] === "\"") break;
      }
      if (j >= rest.length) return null;
      const quoted = rest.slice(i, j + 1);
      const unquoted = unquoteGitPath(quoted);
      if (unquoted == null) return null;
      paths.push(unquoted);
      i = j + 1;
    }
    if (paths.length === 2) {
      return {
        oldPath: stripDiffPrefix(paths[0]),
        newPath: stripDiffPrefix(paths[1])
      };
    }
  }

  // Unquoted: split on " b/" boundary when possible, else last-space heuristic.
  const bMarker = " b/";
  const bIndex = rest.lastIndexOf(bMarker);
  if (rest.startsWith("a/") && bIndex > 0) {
    return {
      oldPath: stripDiffPrefix(rest.slice(0, bIndex)),
      newPath: stripDiffPrefix(rest.slice(bIndex + 1))
    };
  }
  const parts = rest.split(" ");
  if (parts.length >= 2) {
    return {
      oldPath: stripDiffPrefix(parts[0]),
      newPath: stripDiffPrefix(parts[parts.length - 1])
    };
  }
  return null;
}

/**
 * @typedef {{ lines: Set<number> }} RightSideHunk
 * @typedef {{ hunks: RightSideHunk[] }} RightSideFile
 */

/**
 * Structured RIGHT-side target map.
 */
export class RightSideMap {
  constructor() {
    /** @type {Map<string, RightSideFile>} */
    this.files = new Map();
  }

  /**
   * @param {string} filePath
   * @param {number} line
   * @returns {boolean}
   */
  hasLine(filePath, line) {
    if (typeof filePath !== "string" || !filePath) return false;
    if (!Number.isSafeInteger(line) || line < 1) return false;
    const file = this.files.get(filePath);
    if (!file) return false;
    for (const hunk of file.hunks) {
      if (hunk.lines.has(line)) return true;
    }
    return false;
  }

  /**
   * True when every integer line in [startLine, endLine] is present on the
   * RIGHT side of a single hunk for the path (GitHub multi-line requirement).
   * @param {string} filePath
   * @param {number} startLine
   * @param {number} endLine
   * @returns {boolean}
   */
  hasRange(filePath, startLine, endLine) {
    if (typeof filePath !== "string" || !filePath) return false;
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) return false;
    if (startLine < 1 || endLine < startLine) return false;
    const file = this.files.get(filePath);
    if (!file) return false;
    for (const hunk of file.hunks) {
      let ok = true;
      for (let line = startLine; line <= endLine; line++) {
        if (!hunk.lines.has(line)) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  /**
   * @param {string} filePath
   * @param {number} line
   * @param {RightSideHunk|null} hunk
   */
  addLine(filePath, line, hunk) {
    if (!filePath || !hunk || !Number.isSafeInteger(line) || line < 1) return;
    let file = this.files.get(filePath);
    if (!file) {
      file = { hunks: [] };
      this.files.set(filePath, file);
    }
    if (!file.hunks.includes(hunk)) file.hunks.push(hunk);
    hunk.lines.add(line);
  }
}

/**
 * Parse a unified diff into a {@link RightSideMap}.
 * @param {string} diffText
 * @returns {RightSideMap}
 */
export function collectRightSideMap(diffText) {
  const lines = String(diffText || "").split(/\r?\n/);
  const map = new RightSideMap();
  let file = null;
  let newLine = 0;
  let inHunk = false;
  /** @type {RightSideHunk|null} */
  let currentHunk = null;
  let pendingNewPath = null;
  let binaryFile = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      currentHunk = null;
      pendingNewPath = null;
      binaryFile = false;
      const parsed = parseDiffGitLine(line);
      if (parsed?.newPath) pendingNewPath = parsed.newPath;
      continue;
    }

    if (
      line.startsWith("Binary files ")
      || line.startsWith("GIT binary patch")
      || line === "new file mode"
      || line.startsWith("new file mode ")
      || line.startsWith("deleted file mode ")
      || line.startsWith("old mode ")
      || line.startsWith("new mode ")
      || line.startsWith("similarity index ")
      || line.startsWith("dissimilarity index ")
      || line.startsWith("rename from ")
      || line.startsWith("rename to ")
      || line.startsWith("copy from ")
      || line.startsWith("copy to ")
      || line.startsWith("index ")
    ) {
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        binaryFile = true;
        file = null;
        inHunk = false;
        currentHunk = null;
      }
      if (line.startsWith("rename to ")) {
        const renamed = unquoteGitPath(line.slice("rename to ".length));
        if (renamed) pendingNewPath = renamed;
      }
      if (line.startsWith("copy to ")) {
        const copied = unquoteGitPath(line.slice("copy to ".length));
        if (copied) pendingNewPath = copied;
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      // Old path; deletions use /dev/null for brand-new files.
      continue;
    }

    if (line.startsWith("+++ ")) {
      const rest = line.slice(4).trim();
      const unquoted = unquoteGitPath(rest);
      if (unquoted == null || rest === "/dev/null" || unquoted === "/dev/null") {
        // Pure deletion: no RIGHT-side targets.
        file = null;
        inHunk = false;
        currentHunk = null;
        continue;
      }
      file = stripDiffPrefix(unquoted);
      // The +++ header is authoritative for RIGHT-side hunk paths. In
      // particular, an unquoted filename may itself contain " b/", which
      // makes the best-effort `diff --git` split ambiguous.
      inHunk = false;
      currentHunk = null;
      binaryFile = false;
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (binaryFile || !file) {
        inHunk = false;
        currentHunk = null;
        continue;
      }
      newLine = Number(hunk[1]);
      inHunk = true;
      currentHunk = { lines: new Set() };
      continue;
    }

    if (!inHunk || !file || !currentHunk) continue;
    if (line.startsWith("\\")) continue; // \ No newline at end of file
    if (line.startsWith("+") && !line.startsWith("+++")) {
      map.addLine(file, newLine, currentHunk);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      // deleted: do not advance newLine
      continue;
    }
    // Context lines begin with a single space. Empty lines inside a hunk are
    // treated as non-targets (unified diffs normally emit " \n" for blank context).
    if (line.startsWith(" ")) {
      map.addLine(file, newLine, currentHunk);
      newLine += 1;
    }
  }

  return map;
}

/**
 * Parse a unified diff and return Set of "path:line" pairs that are valid
 * GitHub pull review comment targets on side RIGHT (added or context lines).
 *
 * Compatibility wrapper over {@link collectRightSideMap}. Paths containing
 * colons can collide in this flat encoding; prefer the structured map for new
 * structured publication paths.
 * @param {string} diffText
 * @returns {Set<string>}
 */
export function collectRightSideLines(diffText) {
  const map = collectRightSideMap(diffText);
  const out = new Set();
  for (const [filePath, file] of map.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        out.add(`${filePath}:${line}`);
      }
    }
  }
  return out;
}
