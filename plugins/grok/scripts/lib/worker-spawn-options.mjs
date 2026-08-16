import { CompanionError } from "./errors.mjs";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CONTEXT_MODES = new Set(["none", "all", "recent"]);
const DISPLAY_NAME = /^[\w .:@/+-]{1,64}$/u;

export function assertPublicSpawnOptions({
  contextMode = null,
  inheritTurns = null,
  contextDigest = null,
  name = null,
  parentId = null,
  model = null,
  effort = null
} = {}) {
  if (model != null && model !== "") {
    throw new CompanionError(
      "E_CAPABILITY",
      "The installed provider capability receipt does not advertise selectable models."
    );
  }
  if (effort != null && effort !== "") {
    throw new CompanionError(
      "E_CAPABILITY",
      "The installed provider capability receipt does not advertise selectable effort."
    );
  }
  if (contextMode != null && !CONTEXT_MODES.has(contextMode)) {
    throw new CompanionError("E_USAGE", "contextMode must be none, all, or recent.");
  }
  if (contextMode === "recent") {
    if (!Number.isInteger(inheritTurns) || inheritTurns < 1 || inheritTurns > 32) {
      throw new CompanionError("E_USAGE", "recent context requires inheritTurns from 1 to 32.");
    }
    if (!SHA256_HEX.test(contextDigest || "")) {
      throw new CompanionError("E_USAGE", "recent context requires a SHA-256 contextDigest.");
    }
  } else if (contextMode === "all") {
    if (inheritTurns != null) {
      throw new CompanionError("E_USAGE", "all context does not take inheritTurns.");
    }
    if (!SHA256_HEX.test(contextDigest || "")) {
      throw new CompanionError("E_USAGE", "all context requires a SHA-256 contextDigest.");
    }
  } else if (inheritTurns != null || contextDigest != null) {
    throw new CompanionError("E_USAGE", "inheritTurns and contextDigest require all or recent contextMode.");
  }
  if (name != null && !DISPLAY_NAME.test(name)) {
    throw new CompanionError("E_USAGE", "name must be a 1-64 character worker alias.");
  }
  if (parentId != null && (typeof parentId !== "string" || parentId.length < 1 || parentId.length > 256)) {
    throw new CompanionError("E_USAGE", "parentId must be a worker identity.");
  }
  return {
    contextMode: contextMode || null,
    inheritTurns: contextMode === "recent" ? inheritTurns : null,
    contextDigest: contextMode === "all" || contextMode === "recent" ? contextDigest : null,
    name: name || null,
    parentId: parentId || null
  };
}
