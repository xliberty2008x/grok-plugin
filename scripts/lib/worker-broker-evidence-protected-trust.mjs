/** Internal Worker Broker evidence protected-trust domain. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redactText } from "../../plugins/grok/scripts/lib/redact.mjs";
import {
  createPluginInventory,
  digestInventory
} from "./plugin-inventory.mjs";

import {
  PROTECTED_REVIEW_EMPTY_HOOKS_PATH,
  PROTECTED_REVIEW_GIT_PATH,
  PROTECTED_REVIEW_MODULE_MAX_BYTES,
  PROTECTED_REVIEW_POLICY_DIGEST,
  PROTECTED_REVIEW_RUNTIME_BUNDLE_ENTRY_FIELDS,
  PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS,
  PROTECTED_REVIEW_TRUST_FIELDS,
  PROTECTED_REVIEW_TRUST_FILE,
  PROTECTED_REVIEW_TRUST_MAX_BYTES,
  REVIEW_ATTESTATION_ALGORITHM,
  REVIEW_ATTESTATION_DOMAIN,
  SHA256,
  sha256Text,
  stableStringify
} from "./worker-broker-evidence-core.mjs";
import {
  captureEvidencePathChain,
  assertProtectedHostPath,
  exactFields,
  fixedEvidenceError,
  protectedReviewTrustError,
  readBoundedEvidenceFileSnapshot,
  sameFileSnapshot
} from "./worker-broker-evidence-files.mjs";
import {
  computeReviewPublicKeyFingerprint
} from "./worker-broker-evidence-review.mjs";
import {
  captureBoundFile,
  execTrustedGit
} from "./worker-broker-evidence-toolchain.mjs";

function canonicalProtectedReviewDescriptorBody(descriptor) {
  const body = structuredClone(descriptor);
  delete body.descriptorDigest;
  return stableStringify(body);
}

function loadProtectedReviewRuntimeBundle(runtimeRoot, descriptor) {
  if (!Array.isArray(descriptor.runtimeBundle)
    || descriptor.runtimeBundle.length !== PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS.length
    || descriptor.runtimeBundle.some((entry, index) => (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || !exactFields(entry, PROTECTED_REVIEW_RUNTIME_BUNDLE_ENTRY_FIELDS)
      || entry.path !== PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS[index]
      || !SHA256.test(entry.digest || "")
    ))
    || !SHA256.test(descriptor.runtimeBundleDigest || "")
    || descriptor.runtimeBundleDigest !== sha256Text(stableStringify(descriptor.runtimeBundle))) {
    throw protectedReviewTrustError();
  }
  const before = [];
  try {
    for (const entry of descriptor.runtimeBundle) {
      const absolute = path.join(runtimeRoot, ...entry.path.split("/"));
      assertProtectedHostPath(absolute, "file");
      const snapshot = readBoundedEvidenceFileSnapshot(
        runtimeRoot,
        absolute,
        PROTECTED_REVIEW_MODULE_MAX_BYTES
      );
      if (sha256Text(snapshot.contents) !== entry.digest) {
        throw protectedReviewTrustError();
      }
      before.push({ absolute, snapshot });
    }
  } catch {
    throw protectedReviewTrustError();
  }
  return before;
}

export function loadProtectedReviewTrust() {
  const runtimeModule = fileURLToPath(import.meta.url);
  const runtimeRoot = path.resolve(path.dirname(runtimeModule), "../..");
  const descriptorPath = path.join(runtimeRoot, PROTECTED_REVIEW_TRUST_FILE);
  const emptyHooksPath = path.join(runtimeRoot, PROTECTED_REVIEW_EMPTY_HOOKS_PATH);
  try {
    assertProtectedHostPath(runtimeRoot, "directory");
    assertProtectedHostPath(path.dirname(descriptorPath), "directory");
    assertProtectedHostPath(descriptorPath, "file");
    assertProtectedHostPath(emptyHooksPath, "directory");
    if (fs.readdirSync(emptyHooksPath).length !== 0) {
      throw protectedReviewTrustError();
    }
  } catch {
    throw protectedReviewTrustError();
  }
  let descriptorSnapshot;
  let descriptor;
  try {
    descriptorSnapshot = readBoundedEvidenceFileSnapshot(
      runtimeRoot,
      descriptorPath,
      PROTECTED_REVIEW_TRUST_MAX_BYTES
    );
    descriptor = JSON.parse(descriptorSnapshot.contents);
  } catch {
    throw protectedReviewTrustError();
  }
  if (!descriptor
    || typeof descriptor !== "object"
    || Array.isArray(descriptor)
    || !exactFields(descriptor, PROTECTED_REVIEW_TRUST_FIELDS)
    || descriptor.schemaVersion !== 1
    || descriptor.domain !== REVIEW_ATTESTATION_DOMAIN
    || descriptor.algorithm !== REVIEW_ATTESTATION_ALGORITHM
    || typeof descriptor.issuer !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(descriptor.issuer)
    || typeof descriptor.publicKeySpkiBase64 !== "string"
    || !Array.isArray(descriptor.revokedKeyFingerprints)
    || descriptor.revokedKeyFingerprints.some((fingerprint) => !SHA256.test(fingerprint || ""))
    || !SHA256.test(descriptor.keyFingerprint || "")
    || !SHA256.test(descriptor.gitDigest || "")
    || descriptor.policyDigest !== PROTECTED_REVIEW_POLICY_DIGEST
    || !SHA256.test(descriptor.descriptorDigest || "")
    || descriptor.descriptorDigest
      !== sha256Text(canonicalProtectedReviewDescriptorBody(descriptor))) {
    throw protectedReviewTrustError();
  }
  const runtimeBundle = loadProtectedReviewRuntimeBundle(runtimeRoot, descriptor);
  let spki;
  let publicKey;
  try {
    spki = Buffer.from(descriptor.publicKeySpkiBase64, "base64");
    if (spki.length < 1 || spki.toString("base64") !== descriptor.publicKeySpkiBase64) {
      throw new Error("non-canonical SPKI");
    }
    publicKey = crypto.createPublicKey({
      key: spki,
      type: "spki",
      format: "der"
    });
  } catch {
    throw protectedReviewTrustError();
  }
  if (publicKey.asymmetricKeyType !== "ed25519"
    || computeReviewPublicKeyFingerprint(publicKey) !== descriptor.keyFingerprint) {
    throw protectedReviewTrustError();
  }
  let gitBinding;
  try {
    assertProtectedHostPath(PROTECTED_REVIEW_GIT_PATH, "file");
    gitBinding = {
      ...captureBoundFile(PROTECTED_REVIEW_GIT_PATH, { executable: true }),
      emptyHooksPath
    };
    if (gitBinding.entryType !== "file"
      || gitBinding.entryPath !== PROTECTED_REVIEW_GIT_PATH
      || gitBinding.canonicalPath !== PROTECTED_REVIEW_GIT_PATH
      || gitBinding.sha256 !== descriptor.gitDigest) {
      throw protectedReviewTrustError();
    }
  } catch {
    throw protectedReviewTrustError();
  }
  let descriptorAfter;
  try {
    descriptorAfter = readBoundedEvidenceFileSnapshot(
      runtimeRoot,
      descriptorPath,
      PROTECTED_REVIEW_TRUST_MAX_BYTES
    );
  } catch {
    throw protectedReviewTrustError();
  }
  if (descriptorAfter.contents !== descriptorSnapshot.contents
    || !sameFileSnapshot(descriptorAfter.fileSnapshot, descriptorSnapshot.fileSnapshot)) {
    throw protectedReviewTrustError();
  }
  for (const { absolute, snapshot } of runtimeBundle) {
    let after;
    try {
      after = readBoundedEvidenceFileSnapshot(
        runtimeRoot,
        absolute,
        PROTECTED_REVIEW_MODULE_MAX_BYTES
      );
    } catch {
      throw protectedReviewTrustError();
    }
    if (after.contents !== snapshot.contents
      || !sameFileSnapshot(after.fileSnapshot, snapshot.fileSnapshot)) {
      throw protectedReviewTrustError();
    }
  }
  return Object.freeze({
    runtimeRoot,
    publicKey,
    gitBinding,
    expectedIssuer: descriptor.issuer,
    revokedKeyFingerprints: Object.freeze([...descriptor.revokedKeyFingerprints])
  });
}

export function protectedWorkspaceRoot(workspace, runtimeRoot) {
  if (typeof workspace !== "string"
    || !workspace
    || !path.isAbsolute(workspace)
    || path.normalize(workspace) !== workspace) {
    throw protectedReviewTrustError();
  }
  let resolved;
  let canonical;
  let stat;
  try {
    resolved = path.resolve(workspace);
    canonical = fs.realpathSync.native(resolved);
    stat = fs.lstatSync(resolved);
  } catch {
    throw protectedReviewTrustError();
  }
  if (stat.isSymbolicLink()
    || !stat.isDirectory()
    || canonical !== resolved
    || canonical === runtimeRoot
    || canonical.startsWith(`${runtimeRoot}${path.sep}`)) {
    throw protectedReviewTrustError();
  }
  const gitDirectory = path.join(canonical, ".git");
  const requiredGitPaths = [
    [gitDirectory, "directory"],
    [path.join(gitDirectory, "config"), "file"],
    [path.join(gitDirectory, "index"), "file"],
    [path.join(gitDirectory, "objects"), "directory"]
  ];
  try {
    for (const [absolute, expectedType] of requiredGitPaths) {
      const gitStat = fs.lstatSync(absolute);
      if (gitStat.isSymbolicLink()
        || (expectedType === "file" && !gitStat.isFile())
        || (expectedType === "directory" && !gitStat.isDirectory())) {
        throw protectedReviewTrustError();
      }
    }
    for (const forbidden of [
      path.join(gitDirectory, "commondir"),
      path.join(gitDirectory, "config.worktree"),
      path.join(gitDirectory, "objects", "info", "alternates")
    ]) {
      if (fs.existsSync(forbidden)) throw protectedReviewTrustError();
    }
  } catch {
    throw protectedReviewTrustError();
  }
  return canonical;
}

export function assertProtectedWorkspaceGitConfiguration(root) {
  const configPath = path.join(root, ".git", "config");
  let before;
  let names;
  let after;
  try {
    before = readBoundedEvidenceFileSnapshot(root, configPath, 64 * 1024);
    names = execTrustedGit([
      "config",
      "--file",
      configPath,
      "--no-includes",
      "--null",
      "--name-only",
      "--list"
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024
    }).split("\0").filter(Boolean);
    after = readBoundedEvidenceFileSnapshot(root, configPath, 64 * 1024);
  } catch {
    throw protectedReviewTrustError();
  }
  if (before.contents !== after.contents
    || !sameFileSnapshot(before.fileSnapshot, after.fileSnapshot)
    || names.length > 512
    || names.some((name) => (
      typeof name !== "string"
      || name.length < 1
      || name.length > 512
      || /^(?:include|includeif)\./i.test(name)
      || /^(?:alias|credential|diff|difftool|filter|gpg|gpgssh|merge|mergetool|submodule)\./i.test(name)
      || /^core\.(?:askpass|attributesfile|editor|excludesfile|fsmonitor|gitproxy|hookspath|pager|sshcommand|worktree)$/i.test(name)
      || /^extensions\.(?:partialclone|worktreeconfig)$/i.test(name)
      || /^interactive\.difffilter$/i.test(name)
      || /^remote\..*\.promisor$/i.test(name)
      || /^sequence\.editor$/i.test(name)
    ))) {
    throw protectedReviewTrustError();
  }
}
