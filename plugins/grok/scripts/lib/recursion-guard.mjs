import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { identityMatches, processGroupAlive } from "./process-control.mjs";

const ROOT = path.join(os.tmpdir(), `grok-companion-guards-${typeof process.getuid === "function" ? process.getuid() : "user"}`);

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function markerName(marker) {
  return String(marker).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

function workspaceDirectory(workspaceRoot) {
  return path.join(ROOT, digest(fs.realpathSync(workspaceRoot)));
}

function guardFile(workspaceRoot, marker) {
  return path.join(workspaceDirectory(workspaceRoot), `${markerName(marker)}.json`);
}

function ownerDigest(owner) {
  return typeof owner === "string" && owner ? digest(owner) : null;
}

function atomicJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

export function registerProviderGuard(workspaceRoot, marker, providerProcess, owner = null, identityKind = "provider") {
  if (!providerProcess?.pid || !providerProcess?.startToken) return;
  const kind = identityKind === "import" ? "import" : "provider";
  atomicJson(guardFile(workspaceRoot, marker), {
    schemaVersion: 1,
    marker: markerName(marker),
    owner: ownerDigest(owner),
    identityKind: kind,
    providerProcess,
    createdAt: new Date().toISOString()
  });
}

export function unregisterProviderGuard(workspaceRoot, marker) {
  try {
    fs.unlinkSync(guardFile(workspaceRoot, marker));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function hasForeignActiveProvider(workspaceRoot, owner = null) {
  const directory = workspaceDirectory(workspaceRoot);
  let names;
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    return true;
  }
  const expectedOwner = ownerDigest(owner);
  let conflict = false;
  for (const name of names) {
    const file = path.join(directory, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      conflict = true;
      continue;
    }
    const sameOwner = Boolean(expectedOwner) && record.owner === expectedOwner;
    const kind = record.identityKind === "import" ? "import" : "provider";
    if (!identityMatches(record.providerProcess, record.marker, kind)) {
      if (record.providerProcess?.processGroupId && process.platform !== "win32" && processGroupAlive(record.providerProcess.processGroupId)) {
        conflict = true;
        continue;
      }
      const age = Date.now() - Date.parse(record.createdAt);
      if (sameOwner || Number.isFinite(age) && age > 2 * 60 * 60 * 1000) try { fs.unlinkSync(file); } catch {}
      else conflict = true;
      continue;
    }
    if (!sameOwner) conflict = true;
  }
  return conflict;
}
