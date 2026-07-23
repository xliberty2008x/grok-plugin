import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  PHASE_MANDATORY_GATE_IDS,
  PHASE_PROOF_GATE_MANIFEST,
  PROOF_PRODUCER_ID,
  PROOF_PRODUCER_VERSION,
  PROTECTED_REVIEW_POLICY_DIGEST,
  PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS,
  REVIEW_ATTESTATION_ALGORITHM,
  REVIEW_ATTESTATION_DOMAIN,
  REVIEW_ATTESTATION_ROOT,
  SIGNED_REVIEW_MANIFEST_DIGEST,
  attachRecordDigest,
  attachReviewAttestationDigest,
  buildEvidenceRecord,
  canonicalReviewAttestationSigningBody,
  computeProofManifestDigest,
  computeReviewPublicKeyFingerprint,
  createPhaseOneReviewRequest,
  listSourceInventory,
  sha256Text,
  verifyLedger
} from "../scripts/lib/worker-broker-evidence.mjs";
import { ROOT, run, tempDir } from "./helpers.mjs";

const PINNED_NODE_IMAGE = "node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const REVIEW_ISSUER = "worker-broker-docker-review-e2e";
const REVIEW_BOOTSTRAP = "/opt/grok-protected/scripts/trusted/worker-broker-review.mjs";
const WORKSPACE = "/workspace";
const LEDGER_RELATIVE = "tests/e2e-results/worker-broker/ledger.json";
const STARTED_AT = "2026-07-23T10:00:00.000Z";
const ENDED_AT = "2026-07-23T10:00:01.000Z";
const REQUIRED = process.env.GROK_PROTECTED_REVIEW_E2E === "1"
  || process.env.npm_lifecycle_event === "test:protected-review";
let hostGitAuthority = null;

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(",")}}`;
}

function copySourceInventory(destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of listSourceInventory(ROOT)) {
    const source = path.join(ROOT, relative);
    const target = path.join(destination, relative);
    const stat = fs.lstatSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else if (stat.isFile()) {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, stat.mode);
    }
  }
}

function exactPhaseProof(phase) {
  return PHASE_PROOF_GATE_MANIFEST[String(phase)].map((gate) => ({
    gateId: gate.gateId,
    argv: [...gate.argv],
    boundary: gate.boundary,
    outcome: "pass",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    exitCode: 0,
    outputDigest: sha256Text(`${gate.gateId}:protected-review-e2e:${phase}`)
  }));
}

function proofProducer(phase) {
  return {
    id: PROOF_PRODUCER_ID,
    version: PROOF_PRODUCER_VERSION,
    manifestDigest: computeProofManifestDigest(phase)
  };
}

function deterministicQualification() {
  return {
    deterministic: "pass",
    installedHost: "not_run",
    provider: "not_run",
    release: "not_run"
  };
}

function writeRecord(root, record) {
  const relative = path.posix.join(
    "tests/e2e-results/worker-broker",
    `phase-${record.phase}`,
    `${record.source.sourceInventoryDigest.slice(0, 16)}-${
      record.recordDigest.slice(0, 12)
    }.json`
  );
  const absolute = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600
  });
  return relative;
}

function seedLedger(root, entries) {
  const absolute = path.join(root, LEDGER_RELATIVE);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify({
    schemaVersion: 1,
    roadmapVersion: "1.0",
    issue: "https://github.com/xliberty2008x/grok-plugin/issues/25",
    updatedAt: entries.at(-1).recordedAt,
    entries
  }, null, 2)}\n`, { mode: 0o600 });
}

function establishHostGitAuthority() {
  const candidates = process.platform === "darwin"
    ? ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
    : ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];
  let client = null;
  for (const candidate of candidates) {
    try {
      const observed = fileIdentity(candidate, { allowSymlink: true });
      const probe = run(observed.canonicalPath, ["--version"], {
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0"
        },
        timeout: 10_000
      });
      if (probe.status !== 0 || !/^git version \S+\s*$/.test(probe.stdout)) continue;
      client = observed;
      break;
    } catch {}
  }
  if (!client) throw new Error("A fixed absolute host Git client is unavailable.");
  const configRoot = tempDir("grok-protected-host-git-config-");
  const configPath = path.join(configRoot, "config");
  fs.writeFileSync(configPath, "", { mode: 0o600 });
  return Object.freeze({
    client,
    configRoot,
    configPath,
    environment: Object.freeze({
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: configRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: configPath,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      PAGER: "cat"
    })
  });
}

function assertHostGitAuthority({ digest = false } = {}) {
  if (!hostGitAuthority) throw new Error("Host Git authority is not initialized.");
  const current = fileIdentity(
    hostGitAuthority.client.entryPath,
    { allowSymlink: true }
  );
  for (const field of [
    "entryPath",
    "entryType",
    "linkTarget",
    "canonicalPath",
    "device",
    "inode",
    "mode",
    "size",
    "mtimeNs",
    "ctimeNs",
    ...(digest ? ["digest"] : [])
  ]) {
    assert.equal(
      current[field],
      hostGitAuthority.client[field],
      `Host Git client ${field} changed during fixture construction.`
    );
  }
  const configStat = fs.lstatSync(hostGitAuthority.configPath);
  assert.equal(configStat.isFile(), true);
  assert.equal(configStat.isSymbolicLink(), false);
  assert.equal(fs.readFileSync(hostGitAuthority.configPath, "utf8"), "");
}

function fixtureGit(cwd, ...args) {
  assertHostGitAuthority();
  const result = run(hostGitAuthority.client.canonicalPath, [
    "--no-pager",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.pager=cat",
    "-c", "diff.external=",
    ...args
  ], {
    cwd,
    env: hostGitAuthority.environment,
    timeout: 30_000
  });
  if (result.status !== 0) {
    throw new Error(`Fixture Git failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function initializeFixture() {
  const root = tempDir("grok-protected-review-workspace-");
  fixtureGit(root, "init", "-b", "main");
  fixtureGit(root, "config", "user.email", "protected-review@example.com");
  fixtureGit(root, "config", "user.name", "Protected Review E2E");
  copySourceInventory(root);
  const evidenceRoot = path.join(root, "tests/e2e-results/worker-broker");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, ".gitkeep"), "");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-m", "protected review baseline");
  const baseCommit = fixtureGit(root, "rev-parse", "HEAD");

  fs.appendFileSync(
    path.join(root, "plugins/grok/scripts/lib/errors.mjs"),
    "\n// protected review Docker boundary delta\n"
  );
  fixtureGit(root, "add", "plugins/grok/scripts/lib/errors.mjs");
  fixtureGit(root, "commit", "-m", "add protected review delta");

  let phaseZero = buildEvidenceRecord({
    root,
    phase: "0",
    slice: "evidence-system",
    status: "verified_on_draft",
    verification: exactPhaseProof("0"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true
  });
  phaseZero = attachRecordDigest({
    ...phaseZero,
    proofProducer: proofProducer("0")
  });
  const phaseZeroPath = writeRecord(root, phaseZero);

  let phaseOne = buildEvidenceRecord({
    root,
    phase: "1",
    slice: "worker-api",
    status: "implemented_unverified",
    verification: exactPhaseProof("1"),
    qualification: deterministicQualification(),
    evidenceSystemQualification: true,
    prerequisites: [{
      phase: "0",
      recordDigest: phaseZero.recordDigest,
      gateIds: [...PHASE_MANDATORY_GATE_IDS["0"]]
    }],
    authorities: {
      workerClaims: "none",
      runtimeObservations: "bounded protected-review external test",
      hostVerification: "not_run",
      independentValidation: "not_run"
    }
  });
  phaseOne = attachRecordDigest({
    ...phaseOne,
    proofProducer: proofProducer("1")
  });
  const phaseOnePath = writeRecord(root, phaseOne);
  seedLedger(root, [
    {
      phase: "0",
      slice: phaseZero.slice,
      status: phaseZero.status,
      path: phaseZeroPath,
      recordDigest: phaseZero.recordDigest,
      sourceCommit: phaseZero.source.headCommit,
      currency: "current",
      recordedAt: phaseZero.recordedAt
    },
    {
      phase: "1",
      slice: phaseOne.slice,
      status: phaseOne.status,
      path: phaseOnePath,
      recordDigest: phaseOne.recordDigest,
      sourceCommit: phaseOne.source.headCommit,
      currency: "current",
      recordedAt: phaseOne.recordedAt
    }
  ]);
  const strict = verifyLedger(root, { strict: true });
  assert.equal(strict.ok, true, strict.errors.join("; "));

  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const requestResult = createPhaseOneReviewRequest({
    root,
    baseCommit,
    createdAt,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    nonce: crypto.randomBytes(32).toString("base64url"),
    write: true
  });
  return {
    root,
    requestResult,
    originalPhaseOnePath: phaseOnePath
  };
}

function signAttestation(requestResult, keyPair) {
  const request = requestResult.request;
  const unsigned = {
    schemaVersion: 1,
    domain: REVIEW_ATTESTATION_DOMAIN,
    issuer: REVIEW_ISSUER,
    keyFingerprint: computeReviewPublicKeyFingerprint(keyPair.publicKey),
    algorithm: REVIEW_ATTESTATION_ALGORITHM,
    requestPath: requestResult.path,
    requestDigest: request.requestDigest,
    nonce: request.nonce,
    manifestDigest: SIGNED_REVIEW_MANIFEST_DIGEST,
    reviewerRuntimeDigest: sha256Text(
      "worker-broker-protected-review-external-issuer/v1"
    ),
    headCommit: request.source.headCommit,
    headTree: request.source.headTree,
    sourceInventoryDigest: request.source.sourceInventoryDigest,
    phaseScopeDigest: request.source.phaseScopeDigest,
    diffBaseCommit: request.diff.baseCommit,
    diffPatchDigest: request.diff.patchDigest,
    diffPathsDigest: request.diff.pathsDigest,
    proofRecordDigest: request.proof.recordDigest,
    prerequisiteRecordDigest: request.prerequisite.recordDigest,
    startedAt: new Date(Date.parse(request.createdAt) + 1_000).toISOString(),
    endedAt: new Date(Date.parse(request.createdAt) + 2_000).toISOString(),
    outcome: "pass",
    unresolvedFindings: 0
  };
  const signature = crypto.sign(
    null,
    Buffer.from(canonicalReviewAttestationSigningBody(unsigned), "utf8"),
    keyPair.privateKey
  ).toString("base64url");
  return attachReviewAttestationDigest({ ...unsigned, signature });
}

function descriptorProvisionerSource() {
  return `
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const runtimeRoot = "/opt/grok-protected";
const paths = ${JSON.stringify(PROTECTED_REVIEW_RUNTIME_BUNDLE_PATHS)};
const policyDigest = ${JSON.stringify(PROTECTED_REVIEW_POLICY_DIGEST)};
const [publicKeySpkiBase64, keyFingerprint, issuer] = process.argv.slice(2);
const stable = ${stableStringify.toString()};
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const runtimeBundle = paths.map((relative) => ({
  path: relative,
  digest: sha(fs.readFileSync(path.join(runtimeRoot, ...relative.split("/"))))
}));
const descriptor = {
  schemaVersion: 1,
  domain: ${JSON.stringify(REVIEW_ATTESTATION_DOMAIN)},
  algorithm: ${JSON.stringify(REVIEW_ATTESTATION_ALGORITHM)},
  issuer,
  publicKeySpkiBase64,
  keyFingerprint,
  revokedKeyFingerprints: [],
  gitDigest: sha(fs.readFileSync("/usr/bin/git")),
  policyDigest,
  runtimeBundle,
  runtimeBundleDigest: sha(stable(runtimeBundle))
};
descriptor.descriptorDigest = sha(stable(descriptor));
const directory = path.join(runtimeRoot, ".worker-broker-host-state");
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(path.join(directory, "empty-hooks"), { recursive: true });
fs.writeFileSync(
  path.join(directory, "review-trust-v1.json"),
  JSON.stringify(descriptor, null, 2) + "\\n",
  { mode: 0o444 }
);
`;
}

function prepareBuildContext(fixture, keyPair) {
  const context = tempDir("grok-protected-review-image-");
  copySourceInventory(path.join(context, "runtime-root"));
  fs.cpSync(fixture.root, path.join(context, "workspace"), {
    recursive: true,
    preserveTimestamps: true
  });
  fs.writeFileSync(
    path.join(context, "provision.mjs"),
    descriptorProvisionerSource()
  );
  const publicKeySpkiBase64 = keyPair.publicKey.export({
    type: "spki",
    format: "der"
  }).toString("base64");
  const keyFingerprint = computeReviewPublicKeyFingerprint(keyPair.publicKey);
  fs.writeFileSync(path.join(context, "Dockerfile"), `
FROM ${PINNED_NODE_IMAGE}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git \\
 && rm -rf /var/lib/apt/lists/* \\
 && groupadd --gid 10001 reviewer \\
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin reviewer
COPY --chown=0:0 runtime-root/ /opt/grok-protected/
COPY --chown=10001:10001 workspace/ /workspace/
COPY --chown=0:0 provision.mjs /tmp/provision.mjs
ARG REVIEW_PUBLIC_KEY_SPKI_BASE64
ARG REVIEW_KEY_FINGERPRINT
ARG REVIEW_ISSUER
RUN /usr/local/bin/node /tmp/provision.mjs \\
      "$REVIEW_PUBLIC_KEY_SPKI_BASE64" "$REVIEW_KEY_FINGERPRINT" "$REVIEW_ISSUER" \\
 && rm -f /tmp/provision.mjs \\
 && chown -R 0:0 /opt/grok-protected \\
 && find /opt/grok-protected -type d -exec chmod 0555 {} + \\
 && find /opt/grok-protected -type f -exec chmod 0444 {} + \\
 && chown -R 10001:10001 /workspace
CMD ["/bin/sleep", "infinity"]
`);
  return {
    context,
    publicKeySpkiBase64,
    keyFingerprint
  };
}

let dockerAuthority = null;

function fileIdentity(absolute, { allowSymlink = false } = {}) {
  const entry = fs.lstatSync(absolute, { bigint: true });
  if (entry.isSymbolicLink() && !allowSymlink) {
    throw new Error(`Unexpected symlink: ${absolute}`);
  }
  const canonical = fs.realpathSync.native(absolute);
  const stat = fs.statSync(canonical, { bigint: true });
  if (!stat.isFile() || (stat.mode & 0o111n) === 0n) {
    throw new Error(`Docker client is not an executable file: ${absolute}`);
  }
  return Object.freeze({
    entryPath: absolute,
    entryType: entry.isSymbolicLink() ? "symlink" : "file",
    linkTarget: entry.isSymbolicLink() ? fs.readlinkSync(absolute) : null,
    canonicalPath: canonical,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    digest: crypto.createHash("sha256").update(fs.readFileSync(canonical)).digest("hex")
  });
}

function socketIdentity(absolute) {
  const entry = fs.lstatSync(absolute, { bigint: true });
  if (entry.isSymbolicLink() || !entry.isSocket()) {
    throw new Error(`Docker endpoint is not a direct Unix socket: ${absolute}`);
  }
  return Object.freeze({
    path: fs.realpathSync.native(absolute),
    device: String(entry.dev),
    inode: String(entry.ino),
    mode: String(entry.mode),
    uid: String(entry.uid),
    gid: String(entry.gid)
  });
}

function establishDockerAuthority() {
  const clientCandidates = process.platform === "darwin"
    ? [
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker"
    ]
    : ["/usr/bin/docker", "/usr/local/bin/docker"];
  let client = null;
  for (const candidate of clientCandidates) {
    try {
      client = fileIdentity(candidate, { allowSymlink: true });
      break;
    } catch {}
  }
  if (!client) throw new Error("A fixed absolute Docker client is unavailable.");
  const buildxCandidates = process.platform === "darwin"
    ? ["/Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx"]
    : [
      "/usr/libexec/docker/cli-plugins/docker-buildx",
      "/usr/lib/docker/cli-plugins/docker-buildx",
      "/usr/local/lib/docker/cli-plugins/docker-buildx"
    ];
  let buildx = null;
  for (const candidate of buildxCandidates) {
    try {
      buildx = fileIdentity(candidate);
      break;
    } catch {}
  }
  if (!buildx) throw new Error("A fixed absolute Docker Buildx plugin is unavailable.");

  const home = os.userInfo().homedir;
  const socketCandidates = [
    ...(process.platform === "darwin"
      ? [path.join(home, ".docker/run/docker.sock")]
      : []),
    "/var/run/docker.sock",
    "/run/docker.sock",
    path.join(home, ".docker/run/docker.sock")
  ];
  let endpoint = null;
  for (const candidate of [...new Set(socketCandidates)]) {
    try {
      endpoint = socketIdentity(candidate);
      break;
    } catch {}
  }
  if (!endpoint) throw new Error("A fixed local Docker Unix socket is unavailable.");

  const configRoot = tempDir("grok-protected-docker-config-");
  const configPath = path.join(configRoot, "config.json");
  const configContents = `${JSON.stringify({
    cliPluginsExtraDirs: [path.dirname(buildx.canonicalPath)]
  })}\n`;
  fs.writeFileSync(configPath, configContents, { mode: 0o600 });
  return Object.freeze({
    client,
    buildx,
    endpoint,
    configRoot,
    configPath,
    configContents,
    environment: Object.freeze({
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: configRoot,
      DOCKER_CONFIG: configRoot,
      DOCKER_HOST: `unix://${endpoint.path}`
    })
  });
}

function assertDockerAuthority({ digest = false } = {}) {
  if (!dockerAuthority) throw new Error("Docker authority is not initialized.");
  const currentClient = fileIdentity(
    dockerAuthority.client.entryPath,
    { allowSymlink: true }
  );
  for (const field of [
    "entryPath",
    "entryType",
    "linkTarget",
    "canonicalPath",
    "device",
    "inode",
    "mode",
    "size",
    "mtimeNs",
    "ctimeNs",
    ...(digest ? ["digest"] : [])
  ]) {
    assert.equal(
      currentClient[field],
      dockerAuthority.client[field],
      `Docker client ${field} changed during the protected gate.`
    );
  }
  const currentBuildx = fileIdentity(dockerAuthority.buildx.entryPath);
  for (const field of [
    "entryPath",
    "entryType",
    "linkTarget",
    "canonicalPath",
    "device",
    "inode",
    "mode",
    "size",
    "mtimeNs",
    "ctimeNs",
    ...(digest ? ["digest"] : [])
  ]) {
    assert.equal(
      currentBuildx[field],
      dockerAuthority.buildx[field],
      `Docker Buildx ${field} changed during the protected gate.`
    );
  }
  assert.deepEqual(
    socketIdentity(dockerAuthority.endpoint.path),
    dockerAuthority.endpoint,
    "Docker Unix endpoint identity changed during the protected gate."
  );
  const configStat = fs.lstatSync(dockerAuthority.configPath);
  assert.equal(configStat.isFile(), true);
  assert.equal(configStat.isSymbolicLink(), false);
  assert.equal(
    fs.readFileSync(dockerAuthority.configPath, "utf8"),
    dockerAuthority.configContents
  );
}

function docker(args, options = {}) {
  assertDockerAuthority();
  return run(dockerAuthority.client.canonicalPath, args, {
    cwd: options.cwd,
    env: dockerAuthority.environment,
    input: options.input,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 64 * 1024 * 1024
  });
}

function dockerServerIdentity() {
  const payload = JSON.parse(requireSuccess(docker([
    "info",
    "--format",
    "{{json .}}"
  ], { timeout: 30_000 }), "inspect Docker server"));
  return Object.freeze({
    id: payload.ID,
    name: payload.Name,
    driver: payload.Driver,
    serverVersion: payload.ServerVersion,
    operatingSystem: payload.OperatingSystem
  });
}

function requireSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed (${result.status}):\n${result.stdout}\n${result.stderr}`
  );
  assert.equal(result.signal, null, label);
  return result.stdout.trim();
}

function sameStableStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readStableImageId(absolute, parentBefore) {
  const parent = path.dirname(absolute);
  let descriptor;
  try {
    const parentAfter = fs.lstatSync(parent, { bigint: true });
    if (parentAfter.isSymbolicLink()
      || !parentAfter.isDirectory()
      || parentAfter.dev !== parentBefore.dev
      || parentAfter.ino !== parentBefore.ino
      || parentAfter.mode !== parentBefore.mode
      || parentAfter.uid !== parentBefore.uid
      || parentAfter.gid !== parentBefore.gid) {
      throw new Error("Image-ID directory identity changed.");
    }
    const before = fs.lstatSync(absolute, { bigint: true });
    if (before.isSymbolicLink()
      || !before.isFile()
      || before.size < 71n
      || before.size > 72n) {
      throw new Error("Image-ID file is unsafe.");
    }
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const contents = fs.readFileSync(descriptor, "utf8");
    const afterOpen = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(absolute, { bigint: true });
    if (!sameStableStat(before, opened)
      || !sameStableStat(opened, afterOpen)
      || !sameStableStat(afterOpen, after)
      || !/^sha256:[0-9a-f]{64}\n?$/.test(contents)) {
      throw new Error("Image-ID file changed or is malformed.");
    }
    return contents.trim();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertImageBinding(imageId) {
  assert.equal(
    requireSuccess(docker([
      "image",
      "inspect",
      imageId,
      "--format",
      "{{.Id}}"
    ]), "inspect bound image"),
    imageId,
    "Docker image identity changed."
  );
}

function assertContainerBinding(binding) {
  const payload = JSON.parse(requireSuccess(docker([
    "container",
    "inspect",
    binding.id,
    "--format",
    "{{json .}}"
  ]), `inspect ${binding.name}`));
  assert.equal(payload.Id, binding.id, "Docker container ID changed.");
  assert.equal(payload.Name, `/${binding.name}`, "Docker container name changed.");
  assert.equal(payload.Image, binding.imageId, "Docker container image changed.");
  assert.equal(
    payload.Config?.Image,
    binding.imageId,
    "Docker container launch image changed."
  );
}

function withBoundContainer(binding, action) {
  assertContainerBinding(binding);
  let result;
  let failure;
  try {
    result = action(binding.id);
  } catch (error) {
    failure = error;
  }
  assertContainerBinding(binding);
  if (failure) throw failure;
  return result;
}

function startContainer(imageId, name) {
  assertImageBinding(imageId);
  const id = requireSuccess(docker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "none",
    imageId
  ]), `start ${name}`);
  assert.match(id, /^[0-9a-f]{64}$/, `start ${name}`);
  const binding = Object.freeze({ id, name, imageId });
  assertContainerBinding(binding);
  return binding;
}

function removeContainer(binding, { strict = true } = {}) {
  if (strict) assertContainerBinding(binding);
  const result = docker(["rm", "--force", binding.id], { timeout: 30_000 });
  if (strict) {
    requireSuccess(result, `remove ${binding.name}`);
    const after = docker([
      "container",
      "inspect",
      binding.id
    ], { timeout: 30_000 });
    assert.notEqual(after.status, 0, `Removed container ${binding.id} is still visible.`);
  }
}

function protectedCommand(name, mode, args, {
  input,
  pathValue = "/usr/bin:/bin",
  nodeOptions = null
} = {}) {
  const environment = [`PATH=${pathValue}`];
  if (nodeOptions != null) environment.push(`NODE_OPTIONS=${nodeOptions}`);
  return docker([
    "exec",
    "--user",
    "10001:10001",
    "--interactive",
    name,
    "/usr/bin/env",
    "-i",
    ...environment,
    "/usr/local/bin/node",
    REVIEW_BOOTSTRAP,
    mode,
    ...args
  ], { input, timeout: 120_000 });
}

function parseProtectedResult(result, {
  status,
  code = null,
  label
}) {
  assert.equal(result.status, status, `${label}:\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null, label);
  assert.equal(result.stderr, "", label);
  const payload = JSON.parse(result.stdout);
  if (code == null) assert.equal(payload.ok, true, label);
  else {
    assert.deepEqual(payload, { ok: false, code }, label);
  }
  return payload;
}

const WORKSPACE_STATE_SCRIPT = `
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = "/workspace/tests/e2e-results/worker-broker";
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 32;
const MAX_TOTAL_FILE_BYTES = 64 * 1024 * 1024;
let totalFileBytes = 0;
const entries = [];
const identity = (stat) => ({
  mode: String(stat.mode),
  uid: String(stat.uid),
  gid: String(stat.gid),
  size: String(stat.size),
  device: String(stat.dev),
  inode: String(stat.ino),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs)
});
const visit = (absolute, relative, depth) => {
  if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) {
    throw new Error("Evidence manifest bound exceeded.");
  }
  const before = fs.lstatSync(absolute, { bigint: true });
  const entry = { path: relative, ...identity(before) };
  if (before.isDirectory()) {
    entry.type = "directory";
    entries.push(entry);
    const children = fs.readdirSync(absolute).sort();
    for (const name of children) {
      visit(
        path.join(absolute, name),
        relative === "." ? name : relative + "/" + name,
        depth + 1
      );
    }
  } else if (before.isFile()) {
    entry.type = "file";
    if (before.size > BigInt(MAX_TOTAL_FILE_BYTES)
      || totalFileBytes + Number(before.size) > MAX_TOTAL_FILE_BYTES) {
      throw new Error("Evidence manifest file-byte bound exceeded.");
    }
    const contents = fs.readFileSync(absolute);
    totalFileBytes += contents.byteLength;
    const after = fs.lstatSync(absolute, { bigint: true });
    if (JSON.stringify(identity(after)) !== JSON.stringify(identity(before))
      || contents.byteLength !== Number(before.size)) {
      throw new Error("Evidence changed during manifest capture.");
    }
    entry.digest = crypto.createHash("sha256").update(contents).digest("hex");
    entries.push(entry);
  } else if (before.isSymbolicLink()) {
    entry.type = "symlink";
    const target = fs.readlinkSync(absolute);
    if (Buffer.byteLength(target) > 4096) {
      throw new Error("Evidence symlink target is oversized.");
    }
    entry.targetDigest = crypto.createHash("sha256").update(target).digest("hex");
    entries.push(entry);
  } else {
    throw new Error("Unsupported evidence path type.");
  }
};
visit(root, ".", 0);
const serialized = JSON.stringify(entries);
process.stdout.write(JSON.stringify({
  manifestDigest: crypto.createHash("sha256").update(serialized).digest("hex"),
  entryCount: entries.length,
  totalFileBytes,
  entries,
  transientFiles: entries.map((entry) => entry.path).filter((file) => (
    file.includes(".tmp") || file.includes(".ledger.lock")
  ))
}));
`;

function workspaceState(name) {
  const result = docker([
    "exec",
    "--user",
    "0:0",
    name,
    "/usr/local/bin/node",
    "-e",
    WORKSPACE_STATE_SCRIPT
  ]);
  return JSON.parse(requireSuccess(result, `inspect ${name}`));
}

function inspectPositiveWorkspace(name, destination) {
  requireSuccess(docker([
    "cp",
    `${name}:/workspace/tests/e2e-results/worker-broker`,
    destination
  ]), "copy promoted evidence");
  const root = path.join(destination, "worker-broker");
  const ledger = JSON.parse(fs.readFileSync(path.join(root, "ledger.json"), "utf8"));
  const current = ledger.entries.filter((entry) => (
    entry.phase === "1" && entry.currency === "current"
  ));
  const historical = ledger.entries.filter((entry) => (
    entry.phase === "1" && entry.currency === "historical"
  ));
  assert.equal(current.length, 1);
  assert.equal(current[0].status, "verified_on_draft");
  assert.equal(historical.length, 1);
  assert.equal(historical[0].status, "implemented_unverified");
  const record = JSON.parse(fs.readFileSync(
    path.join(root, path.relative(
      "tests/e2e-results/worker-broker",
      current[0].path
    )),
    "utf8"
  ));
  return { root, ledger, current: current[0], historical: historical[0], record };
}

test("root-owned protected review runtime promotes and replays exact signed evidence", {
  skip: !REQUIRED,
  timeout: 15 * 60_000
}, (t) => {
  dockerAuthority = establishDockerAuthority();
  try {
    hostGitAuthority = establishHostGitAuthority();
  } catch (error) {
    fs.rmSync(dockerAuthority.configRoot, { recursive: true, force: true });
    dockerAuthority = null;
    throw error;
  }
  let image = null;
  let builtImageId = null;
  const containers = new Set();
  const temporary = new Set();
  t.after(() => {
    try {
      for (const binding of containers) {
        removeContainer(binding, { strict: false });
      }
      if (builtImageId) {
        docker(["image", "rm", "--force", builtImageId], { timeout: 60_000 });
      }
    } finally {
      for (const directory of temporary) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
      if (hostGitAuthority) {
        fs.rmSync(hostGitAuthority.configRoot, { recursive: true, force: true });
        hostGitAuthority = null;
      }
      if (dockerAuthority) {
        fs.rmSync(dockerAuthority.configRoot, { recursive: true, force: true });
        dockerAuthority = null;
      }
    }
  });
  const dockerServerBefore = dockerServerIdentity();
  const dockerProbe = docker(["version", "--format", "{{.Server.Version}}"], {
    timeout: 30_000
  });
  assert.equal(dockerProbe.status, 0, "Docker daemon is required for this external gate.");

  const fixture = initializeFixture();
  temporary.add(fixture.root);
  assertHostGitAuthority({ digest: true });
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const attestation = signAttestation(fixture.requestResult, keyPair);
  const attestationInput = `${JSON.stringify(attestation)}\n`;
  const build = prepareBuildContext(fixture, keyPair);
  temporary.add(build.context);
  const nonce = crypto.randomBytes(6).toString("hex");
  image = `grok-protected-review-e2e:${nonce}`;
  const imageIdentityRoot = tempDir("grok-protected-review-image-id-");
  fs.chmodSync(imageIdentityRoot, 0o700);
  temporary.add(imageIdentityRoot);
  const imageIdFile = path.join(imageIdentityRoot, "image.id");
  const imageIdParentBefore = fs.lstatSync(imageIdentityRoot, { bigint: true });

  const imageBuild = docker([
    "buildx",
    "build",
    "--load",
    "--progress=plain",
    "--iidfile",
    imageIdFile,
    "--tag",
    image,
    "--build-arg",
    `REVIEW_PUBLIC_KEY_SPKI_BASE64=${build.publicKeySpkiBase64}`,
    "--build-arg",
    `REVIEW_KEY_FINGERPRINT=${build.keyFingerprint}`,
    "--build-arg",
    `REVIEW_ISSUER=${REVIEW_ISSUER}`,
    build.context
  ], { timeout: 10 * 60_000 });
  requireSuccess(imageBuild, "build protected runtime image");
  builtImageId = readStableImageId(imageIdFile, imageIdParentBefore);
  assertImageBinding(builtImageId);

  const positive = startContainer(
    builtImageId,
    `grok-protected-positive-${nonce}`
  );
  containers.add(positive);
  const identity = withBoundContainer(positive, (containerId) => (
    requireSuccess(docker([
    "exec",
    "--user",
    "10001:10001",
    containerId,
    "/usr/bin/id",
    "-u"
    ]), "protected executor identity")
  ));
  assert.equal(identity, "10001");

  parseProtectedResult(withBoundContainer(positive, (containerId) => (
    protectedCommand(
      containerId,
      "verify",
      ["--workspace", WORKSPACE]
    )
  )), { status: 0, label: "baseline verify" });
  const promoted = parseProtectedResult(withBoundContainer(
    positive,
    (containerId) => protectedCommand(
      containerId,
      "promote",
      [
        "--workspace",
        WORKSPACE,
        "--request",
        fixture.requestResult.path
      ],
      { input: attestationInput }
    )
  ), { status: 0, label: "signed promotion" });
  assert.equal(promoted.converged, false);
  assert.match(promoted.recordDigest, /^[0-9a-f]{64}$/);
  const converged = parseProtectedResult(withBoundContainer(
    positive,
    (containerId) => protectedCommand(
      containerId,
      "promote",
      [
        "--workspace",
        WORKSPACE,
        "--request",
        fixture.requestResult.path
      ],
      { input: attestationInput }
    )
  ), { status: 0, label: "signed promotion replay" });
  assert.equal(converged.converged, true);
  assert.equal(converged.recordDigest, promoted.recordDigest);
  parseProtectedResult(withBoundContainer(positive, (containerId) => (
    protectedCommand(
      containerId,
      "verify",
      ["--workspace", WORKSPACE]
    )
  )), { status: 0, label: "post-promotion verify" });
  withBoundContainer(positive, (containerId) => (
    requireSuccess(docker(["stop", containerId]), "stop protected runtime")
  ));
  withBoundContainer(positive, (containerId) => (
    requireSuccess(docker(["start", containerId]), "restart protected runtime")
  ));
  parseProtectedResult(withBoundContainer(positive, (containerId) => (
    protectedCommand(
      containerId,
      "verify",
      ["--workspace", WORKSPACE]
    )
  )), { status: 0, label: "post-restart verify" });

  const copied = tempDir("grok-protected-review-result-");
  temporary.add(copied);
  const inspected = withBoundContainer(positive, (containerId) => (
    inspectPositiveWorkspace(containerId, copied)
  ));
  assert.equal(inspected.current.recordDigest, promoted.recordDigest);
  assert.equal(inspected.historical.path, fixture.originalPhaseOnePath);
  assert.equal(inspected.record.independentReviewReceipt.schemaVersion, 2);
  const attestationRelative = inspected.record.independentReviewReceipt.attestation.path;
  assert.ok(attestationRelative.startsWith(`${REVIEW_ATTESTATION_ROOT}/`));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(
      inspected.root,
      path.relative(
        "tests/e2e-results/worker-broker",
        attestationRelative
      )
    ), "utf8")),
    attestation
  );
  assert.deepEqual(
    withBoundContainer(positive, (containerId) => (
      workspaceState(containerId)
    )).transientFiles,
    []
  );

  const negativeScenarios = [
    {
      id: "git-digest",
      mutate(name) {
        requireSuccess(docker([
          "exec",
          "--user",
          "0:0",
          name,
          "/bin/sh",
          "-c",
          "cp /bin/true /usr/bin/git && chown 0:0 /usr/bin/git && chmod 0755 /usr/bin/git"
        ]), "replace protected Git");
      },
      invoke(name) {
        return protectedCommand(name, "verify", ["--workspace", WORKSPACE]);
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "nested-bundle-tamper",
      mutate(name) {
        requireSuccess(docker([
          "exec",
          "--user",
          "0:0",
          name,
          "/bin/sh",
          "-c",
          "printf '\\n// tampered\\n' >> /opt/grok-protected/scripts/lib/plugin-inventory.mjs"
        ]), "tamper nested runtime dependency");
      },
      invoke(name) {
        return protectedCommand(name, "verify", ["--workspace", WORKSPACE]);
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "writable-bundle",
      mutate(name) {
        requireSuccess(docker([
          "exec",
          "--user",
          "0:0",
          name,
          "/bin/chmod",
          "0666",
          "/opt/grok-protected/scripts/lib/plugin-inventory.mjs"
        ]), "make runtime dependency writable");
      },
      invoke(name) {
        return protectedCommand(name, "verify", ["--workspace", WORKSPACE]);
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "nonempty-hooks",
      mutate(name) {
        requireSuccess(docker([
          "exec",
          "--user",
          "0:0",
          name,
          "/bin/sh",
          "-c",
          "printf '#!/bin/sh\\nexit 0\\n' > /opt/grok-protected/.worker-broker-host-state/empty-hooks/canary"
        ]), "populate protected empty hooks directory");
      },
      invoke(name) {
        return protectedCommand(name, "verify", ["--workspace", WORKSPACE]);
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "fsmonitor-config",
      mutate(name) {
        requireSuccess(docker([
          "exec",
          "--user",
          "10001:10001",
          name,
          "/bin/sh",
          "-c",
          "printf '#!/bin/sh\\ntouch /workspace/.git/fsmonitor-executed\\n' > /workspace/.git/fsmonitor-canary.sh && chmod 0700 /workspace/.git/fsmonitor-canary.sh && printf '\\n[core]\\n\\tfsmonitor = /workspace/.git/fsmonitor-canary.sh\\n' >> /workspace/.git/config"
        ]), "install workspace fsmonitor canary");
      },
      invoke(name) {
        return protectedCommand(name, "verify", ["--workspace", WORKSPACE]);
      },
      assertNoExecution(name) {
        const result = docker([
          "exec",
          "--user",
          "0:0",
          name,
          "/usr/bin/test",
          "!",
          "-e",
          "/workspace/.git/fsmonitor-executed"
        ]);
        assert.equal(result.status, 0, "Workspace fsmonitor canary executed.");
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "textconv-config",
      mutate(name) {
        requireSuccess(docker([
          "exec",
          "--user",
          "10001:10001",
          name,
          "/bin/sh",
          "-c",
          "printf '#!/bin/sh\\ntouch /workspace/.git/textconv-executed\\ncat \"$1\"\\n' > /workspace/.git/textconv-canary.sh && chmod 0700 /workspace/.git/textconv-canary.sh && printf '\\n[diff \"canary\"]\\n\\ttextconv = /workspace/.git/textconv-canary.sh\\n' >> /workspace/.git/config && printf '*.mjs diff=canary\\n' > /workspace/.gitattributes"
        ]), "install workspace textconv canary");
      },
      invoke(name) {
        return protectedCommand(name, "verify", ["--workspace", WORKSPACE]);
      },
      assertNoExecution(name) {
        const result = docker([
          "exec",
          "--user",
          "0:0",
          name,
          "/usr/bin/test",
          "!",
          "-e",
          "/workspace/.git/textconv-executed"
        ]);
        assert.equal(result.status, 0, "Workspace textconv canary executed.");
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "clean-filter-config",
      mutate(name) {
        requireSuccess(docker([
          "exec",
          "--user",
          "10001:10001",
          name,
          "/bin/sh",
          "-c",
          "printf '#!/bin/sh\\ntouch /workspace/.git/filter-executed\\ncat\\n' > /workspace/.git/filter-canary.sh && chmod 0700 /workspace/.git/filter-canary.sh && printf '\\n[filter \"canary\"]\\n\\tclean = /workspace/.git/filter-canary.sh\\n' >> /workspace/.git/config && printf '*.mjs filter=canary\\n' > /workspace/.gitattributes"
        ]), "install workspace clean-filter canary");
      },
      invoke(name) {
        return protectedCommand(name, "verify", ["--workspace", WORKSPACE]);
      },
      assertNoExecution(name) {
        const result = docker([
          "exec",
          "--user",
          "0:0",
          name,
          "/usr/bin/test",
          "!",
          "-e",
          "/workspace/.git/filter-executed"
        ]);
        assert.equal(result.status, 0, "Workspace clean-filter canary executed.");
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "hostile-path",
      invoke(name) {
        return protectedCommand(
          name,
          "verify",
          ["--workspace", WORKSPACE],
          { pathValue: "/caller-controlled:/usr/bin:/bin" }
        );
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "node-options",
      invoke(name) {
        return protectedCommand(
          name,
          "verify",
          ["--workspace", WORKSPACE],
          { nodeOptions: "--no-warnings" }
        );
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "malformed-stdin",
      invoke(name) {
        return protectedCommand(
          name,
          "promote",
          [
            "--workspace",
            WORKSPACE,
            "--request",
            fixture.requestResult.path
          ],
          { input: "{malformed\n" }
        );
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "oversized-stdin",
      invoke(name) {
        return protectedCommand(
          name,
          "promote",
          [
            "--workspace",
            WORKSPACE,
            "--request",
            fixture.requestResult.path
          ],
          { input: `"${"x".repeat(300 * 1024)}"` }
        );
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "tampered-attestation",
      invoke(name) {
        return protectedCommand(
          name,
          "promote",
          [
            "--workspace",
            WORKSPACE,
            "--request",
            fixture.requestResult.path
          ],
          {
            input: `${JSON.stringify({
              ...attestation,
              reviewerRuntimeDigest: "f".repeat(64)
            })}\n`
          }
        );
      },
      code: "E_REVIEW_ATTESTATION_INVALID"
    },
    {
      id: "caller-key",
      invoke(name) {
        return protectedCommand(
          name,
          "verify",
          ["--workspace", WORKSPACE, "--key", "caller-key"]
        );
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    },
    {
      id: "caller-attestation-path",
      invoke(name) {
        return protectedCommand(
          name,
          "promote",
          [
            "--workspace",
            WORKSPACE,
            "--request",
            fixture.requestResult.path,
            "--attestation",
            "caller.json"
          ],
          { input: attestationInput }
        );
      },
      code: "E_REVIEW_TRUST_UNAVAILABLE"
    }
  ];

  for (const scenario of negativeScenarios) {
    const binding = startContainer(
      builtImageId,
      `grok-protected-${scenario.id}-${nonce}`
    );
    containers.add(binding);
    const before = withBoundContainer(binding, (containerId) => (
      workspaceState(containerId)
    ));
    if (scenario.mutate) {
      withBoundContainer(binding, (containerId) => scenario.mutate(containerId));
    }
    const result = withBoundContainer(
      binding,
      (containerId) => scenario.invoke(containerId)
    );
    parseProtectedResult(result, {
      status: scenario.status ?? 1,
      code: scenario.code,
      label: scenario.id
    });
    if (scenario.assertNoExecution) {
      withBoundContainer(
        binding,
        (containerId) => scenario.assertNoExecution(containerId)
      );
    }
    const after = withBoundContainer(binding, (containerId) => (
      workspaceState(containerId)
    ));
    assert.deepEqual(after, before, `${scenario.id} mutated protected workspace evidence`);
    removeContainer(binding);
    containers.delete(binding);
  }

  const imageId = requireSuccess(docker([
    "image",
    "inspect",
    builtImageId,
    "--format",
    "{{.Id}}"
  ]), "inspect protected image");
  assert.equal(imageId, builtImageId, "Bound Docker image changed.");
  assertDockerAuthority({ digest: true });
  assertHostGitAuthority({ digest: true });
  const dockerServerAfter = dockerServerIdentity();
  assert.deepEqual(
    dockerServerAfter,
    dockerServerBefore,
    "Docker server identity changed during the protected gate."
  );
  t.diagnostic(JSON.stringify({
    imageId,
    baseImage: PINNED_NODE_IMAGE,
    externalGateTestDigest: sha256Text(fs.readFileSync(
      path.join(ROOT, "tests/worker-broker-protected-review.test.mjs")
    )),
    requestDigest: fixture.requestResult.request.requestDigest,
    sourceInventoryDigest:
      fixture.requestResult.request.source.sourceInventoryDigest,
    phaseScopeDigest: fixture.requestResult.request.source.phaseScopeDigest,
    dockerClient: {
      canonicalPath: dockerAuthority.client.canonicalPath,
      digest: dockerAuthority.client.digest
    },
    dockerBuildx: {
      canonicalPath: dockerAuthority.buildx.canonicalPath,
      digest: dockerAuthority.buildx.digest
    },
    dockerServer: dockerServerAfter,
    dockerEndpointIdentityDigest: sha256Text(stableStringify(
      dockerAuthority.endpoint
    )),
    hostGit: {
      canonicalPath: hostGitAuthority.client.canonicalPath,
      digest: hostGitAuthority.client.digest
    },
    executorUid: 10001,
    keyFingerprint: build.keyFingerprint,
    policyDigest: PROTECTED_REVIEW_POLICY_DIGEST,
    promotedRecordDigest: promoted.recordDigest,
    restartVerified: true,
    negativeScenarios: negativeScenarios.map((scenario) => scenario.id)
  }));
});
