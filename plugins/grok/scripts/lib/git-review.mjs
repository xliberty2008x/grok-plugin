import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CompanionError } from "./errors.mjs";
import { git } from "./workspace.mjs";

const MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const UNTRACKED_FILE_BYTES = 1024 * 1024;

function stdout(root, args, options = {}) { return String(git(root, args, options).stdout ?? ""); }
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function hashFile(file) {
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), buffer = Buffer.allocUnsafe(64 * 1024);
  try { for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } }
  finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

export function resolveTarget(root, { scope = "auto", base = null } = {}) {
  if (!["auto", "working-tree", "branch"].includes(scope)) throw new CompanionError("E_USAGE", "--scope must be auto, working-tree, or branch.");
  const status = stdout(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!base && (scope === "working-tree" || (scope === "auto" && status.length))) return { mode: "working-tree", label: "staged, unstaged, and untracked working-tree changes", base: null };
  let selected = base;
  if (!selected) {
    const originHead = stdout(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowFailure: true }).trim();
    for (const candidate of [originHead, "origin/main", "origin/master", "origin/trunk", "main", "master", "trunk"].filter(Boolean)) if (git(root, ["rev-parse", "--verify", "--quiet", candidate], { allowFailure: true }).status === 0) { selected = candidate; break; }
  }
  if (!selected) throw new CompanionError("E_USAGE", "Could not determine a base branch; pass --base <ref>.");
  if (git(root, ["rev-parse", "--verify", "--quiet", `${selected}^{commit}`], { allowFailure: true }).status !== 0) throw new CompanionError("E_USAGE", `Base ref ${selected} is not a commit.`);
  return { mode: "branch", label: `changes from ${selected}...HEAD`, base: selected };
}

function untracked(root) {
  const raw = stdout(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = raw.split("\0").filter(Boolean);
  return paths.map((relative) => {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return { path: relative, kind: "symlink", content: fs.readlinkSync(full) };
    if (!stat.isFile()) return { path: relative, kind: "other", content: "" };
    const sample = Buffer.allocUnsafe(Math.min(stat.size, 8192)), fd = fs.openSync(full, "r");
    try { fs.readSync(fd, sample, 0, sample.length, 0); } finally { fs.closeSync(fd); }
    if (sample.includes(0)) return { path: relative, kind: "file", content: `[binary: ${stat.size} bytes, sha256 ${hashFile(full)}]` };
    if (stat.size > UNTRACKED_FILE_BYTES) throw new CompanionError("E_REVIEW_TOO_LARGE", `Untracked text file ${relative} is too large for a tool-free review (${stat.size} bytes). Review a smaller scope.`);
    return { path: relative, kind: "file", content: fs.readFileSync(full, "utf8") };
  });
}

export function collectContext(root, target) {
  if (target.mode === "branch") {
    const diff = stdout(root, ["diff", "--binary", `${target.base}...HEAD`], { maxBuffer: 32 * 1024 * 1024 });
    if (Buffer.byteLength(diff) > MAX_REVIEW_BYTES) throw new CompanionError("E_REVIEW_TOO_LARGE", `Branch diff exceeds the ${MAX_REVIEW_BYTES / (1024 * 1024)} MiB tool-free review limit. Review a smaller scope.`);
    return { target, empty: diff.length === 0, collectionGuidance: "Branch diff collected by the plugin.", content: diff || "[empty branch diff]" };
  }
  const status = stdout(root, ["status", "--short", "--untracked-files=all"]);
  const staged = stdout(root, ["diff", "--binary", "--cached"], { maxBuffer: 32 * 1024 * 1024 });
  const unstaged = stdout(root, ["diff", "--binary"], { maxBuffer: 32 * 1024 * 1024 });
  const extras = untracked(root);
  const content = [`STATUS\n${status || "[clean]"}`, `STAGED DIFF\n${staged || "[empty]"}\nUNSTAGED DIFF\n${unstaged || "[empty]"}`, ...extras.map((x) => `UNTRACKED ${x.kind}: ${x.path}\n${x.content}`)].join("\n\n");
  if (Buffer.byteLength(content) > MAX_REVIEW_BYTES) throw new CompanionError("E_REVIEW_TOO_LARGE", `Working-tree context exceeds the ${MAX_REVIEW_BYTES / (1024 * 1024)} MiB tool-free review limit. Review a smaller scope.`);
  return { target, empty: status.trim().length === 0, collectionGuidance: "Complete tool-free working-tree context is embedded by the plugin.", content };
}

export function integritySnapshot(root) {
  const head = stdout(root, ["rev-parse", "HEAD"], { allowFailure: true }).trim();
  const indexTree = sha(stdout(root, ["ls-files", "--stage", "-z"], { allowFailure: true }));
  const staged = stdout(root, ["diff", "--binary", "--cached"], { maxBuffer: 64 * 1024 * 1024 });
  const worktree = stdout(root, ["diff", "--binary"], { maxBuffer: 64 * 1024 * 1024 });
  const paths = stdout(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const extras = paths.map((relative) => {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return `${relative}\0symlink\0${stat.mode}\0${sha(fs.readlinkSync(full))}`;
    if (stat.isFile()) return `${relative}\0file\0${stat.mode}\0${stat.size}\0${hashFile(full)}`;
    return `${relative}\0other\0${stat.mode}`;
  }).sort().join("\0");
  return { head, indexTree, staged: sha(staged), worktree: sha(worktree), untracked: sha(extras) };
}

export function assertUnchanged(before, after) {
  const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
  if (changed.length) throw new CompanionError("E_REVIEW_MUTATED_WORKSPACE", `Read-only Grok review changed repository state (${changed.join(", ")}).`, { changed });
}
