import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertDeepResearchCapability,
  attestWebFetchAllowLocalFalse,
  buildDeepResearchCapabilityReceipt,
  buildDeepResearchSlashCommand,
  buildWorkflowStopSlashCommand,
  cleanupResearchRuntimeArtifacts,
  collectResearchReport,
  createWorkflowBinder,
  createWorkspaceSnapshot,
  DEEP_RESEARCH_KIND,
  DEEP_RESEARCH_PROFILE_ID,
  DEEP_RESEARCH_QUERY_LIMIT_BYTES,
  isUnexpectedDeepResearchPermission,
  mapDeepResearchTerminal,
  noteAgentLaunchFromToolEvent,
  parseDeepResearchOptions,
  parseDeepResearchQuery,
  publicResearchReport,
  proveWorkspaceUnchanged,
  removeResearchTree,
  researchReportRelativePath,
  runDeepResearch,
  stageDeepResearchQuery,
  consumeDeepResearchQuery,
  thawTreeWritable
} from "../plugins/grok/scripts/lib/deep-research.mjs";
import { profileFor, sameSecurityProfile } from "../plugins/grok/scripts/lib/profiles.mjs";
import { generateId, readJob, writeJob } from "../plugins/grok/scripts/lib/state.mjs";
import { projectWorkerSnapshot } from "../plugins/grok/scripts/lib/worker-protocol.mjs";
import { assertSafeJobId } from "../plugins/grok/scripts/lib/workspace.mjs";
import { integritySnapshot } from "../plugins/grok/scripts/lib/git-review.mjs";
import { git, initRepo, tempDir, ROOT, testEnvironment } from "./helpers.mjs";
import { installFakeGrok } from "./fake-grok.mjs";

function fixtureHome(t) {
  const root = tempDir("deep-research-home-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("parseDeepResearchOptions defaults to background and web-only", () => {
  assert.deepEqual(parseDeepResearchOptions({}), {
    background: true,
    wait: false,
    webOnly: true,
    workspace: false,
    model: null,
    effort: null
  });
  assert.equal(parseDeepResearchOptions({ wait: true }).background, false);
  assert.equal(parseDeepResearchOptions({ workspace: true }).webOnly, false);
  assert.throws(
    () => parseDeepResearchOptions({ wait: true, background: true }),
    (error) => error.code === "E_USAGE"
  );
  assert.throws(
    () => parseDeepResearchOptions({ workspace: true, "web-only": true }),
    (error) => error.code === "E_USAGE"
  );
});

test("parseDeepResearchQuery enforces private stdin privacy, UTF-8, NUL rejection, and 32 KiB cap", () => {
  assert.equal(parseDeepResearchQuery("  what is xAI?  "), "what is xAI?");
  assert.throws(() => parseDeepResearchQuery(""), (error) => error.code === "E_USAGE");
  assert.throws(() => parseDeepResearchQuery("a\0b"), (error) => error.code === "E_USAGE");
  const oversize = "x".repeat(DEEP_RESEARCH_QUERY_LIMIT_BYTES + 1);
  assert.throws(() => parseDeepResearchQuery(oversize), (error) => error.code === "E_USAGE");
  assert.equal(
    parseDeepResearchQuery(Buffer.from("ok query", "utf8")),
    "ok query"
  );
});

test("upstream slash command is exactly /deep-research <query> without wrapper flags", () => {
  assert.equal(buildDeepResearchSlashCommand("topic"), "/deep-research topic");
  assert.equal(
    buildDeepResearchSlashCommand("multi word query"),
    "/deep-research multi word query"
  );
  // Wrapper-only options must never appear in upstream slash text.
  assert.doesNotMatch(buildDeepResearchSlashCommand("topic"), /--background|--web-only|--workspace|--model|--effort/);
  assert.equal(buildWorkflowStopSlashCommand("run-abc"), "/workflow stop run-abc");
  assert.throws(
    () => buildWorkflowStopSlashCommand("run with space"),
    (error) => error.code === "E_PROTOCOL"
  );
});

test("capability gate requires exact deep-research command and workflow tool", () => {
  assert.throws(
    () => assertDeepResearchCapability({}),
    (error) => error.code === "E_CAPABILITY" && /deep-research/.test(error.message)
  );
  assert.throws(
    () => assertDeepResearchCapability({
      _meta: { availableCommands: [{ name: "/deep-research" }] }
    }),
    (error) => error.code === "E_CAPABILITY" && /workflow/.test(error.message)
  );
  assert.throws(
    () => assertDeepResearchCapability({}, {
      availableCommands: [{ name: "/deep-research" }],
      inspect: { tools: [{ name: "workflow" }] }
    }),
    (error) => error.code === "E_CAPABILITY"
  );
  const ok = assertDeepResearchCapability({
    agentCapabilities: { tools: [{ name: "workflow" }] },
    _meta: {
      availableCommands: [{ name: "/deep-research" }]
    }
  });
  assert.equal(ok.deepResearchCommand, true);
  assert.equal(ok.workflowTool, true);
  const liveCommands = assertDeepResearchCapability({
    tools: [{ name: "workflow" }]
  }, {
    availableCommands: [{ name: "deep-research" }, { name: "workflow" }],
    inspect: { tools: [{ name: "not-live-workflow" }] }
  });
  assert.equal(liveCommands.workflowTool, true);
});

test("feature capability receipt is bound to provider bytes, profile, and live commands", () => {
  const receipt = buildDeepResearchCapabilityReceipt({
    executableIdentity: {
      executableDigest: "a".repeat(64),
      size: 123
    },
    providerVersion: "0.2.112",
    profileDigest: "b".repeat(64),
    availableCommands: ["workflow", "deep-research"],
    workflowToolAttested: true
  });
  assert.equal(receipt.receiptType, "grok-deep-research-capability");
  assert.equal(receipt.workflowToolAttested, true);
  assert.equal(receipt.deepResearchCommand, true);
  assert.equal(receipt.workflowCommand, true);
  assert.match(receipt.capabilityDigest, /^[a-f0-9]{64}$/);
});

test("workflow binder binds one run and enforces monotonic revisions", () => {
  const binder = createWorkflowBinder({ expectedObjective: "topic" });
  assert.equal(binder.applyUpdate({
    runId: "old",
    revision: 7,
    status: "complete",
    name: "deep-research",
    objective: "topic"
  }), null);
  binder.arm();
  assert.equal(binder.applyUpdate({ status: "running" }), null);
  const first = binder.applyUpdate({
    runId: "run-1",
    revision: 1,
    status: "running",
    kind: "deep-research",
    name: "deep-research",
    objective: "topic"
  });
  assert.equal(first.bound, true);
  assert.equal(first.runId, "run-1");
  const foreign = binder.applyUpdate({ runId: "run-2", revision: 2, status: "complete", activeAgents: 99 });
  assert.equal(foreign.accepted, false);
  assert.equal(foreign.ignored, "foreign-run");
  assert.equal(binder.state.activeAgents, null);
  const stale = binder.applyUpdate({ runId: "run-1", revision: 0, status: "complete", activeAgents: 99 });
  assert.equal(stale.accepted, false);
  assert.equal(stale.ignored, "stale-revision");
  assert.equal(binder.state.status, "running");
  const next = binder.applyUpdate({ runId: "run-1", revision: 2, status: "complete", activeAgents: 0 });
  assert.equal(next.status, "complete");
  assert.equal(next.settled, true);
});

test("workflow binder enforces agent caps", () => {
  const binder = createWorkflowBinder();
  binder.arm();
  binder.applyUpdate({ runId: "run-a", revision: 1, status: "running", activeAgents: 4, name: "deep-research" });
  assert.throws(
    () => binder.applyUpdate({ runId: "run-a", revision: 2, status: "running", activeAgents: 5 }),
    (error) => error.code === "E_SECURITY_PROFILE"
  );
  const binder2 = createWorkflowBinder();
  binder2.arm();
  binder2.applyUpdate({ runId: "run-b", revision: 1, status: "running", agentLaunches: 8, name: "deep-research" });
  assert.throws(
    () => binder2.applyUpdate({ runId: "run-b", revision: 2, status: "running", agentLaunches: 9 }),
    (error) => error.code === "E_SECURITY_PROFILE"
  );
  const binder3 = createWorkflowBinder();
  for (let index = 0; index < 8; index += 1) binder3.noteAgentLaunch();
  assert.throws(
    () => binder3.noteAgentLaunch(),
    (error) => error.code === "E_SECURITY_PROFILE"
  );
  const binder4 = createWorkflowBinder();
  binder4.arm();
  binder4.applyUpdate({
    runId: "run-c",
    revision: 1,
    status: "running",
    agentLaunches: 1,
    name: "deep-research"
  });
  binder4.noteAgentLaunch();
  assert.equal(binder4.state.agentLaunches, 1);
});

test("cancellation requires a later revision that explicitly proves zero active agents", () => {
  const binder = createWorkflowBinder({ expectedObjective: "cancel topic" });
  binder.arm();
  binder.applyUpdate({
    runId: "run-cancel-proof",
    revision: 1,
    status: "running",
    activeAgents: 1,
    name: "deep-research",
    objective: "cancel topic"
  });
  assert.equal(binder.applyUpdate({
    runId: "run-cancel-proof",
    revision: 2,
    status: "cancelled",
    activeAgents: 0
  }).settled, false);
  assert.equal(binder.applyUpdate({
    runId: "run-cancel-proof",
    revision: 3,
    status: "cancelled"
  }).settled, false);
  assert.equal(binder.applyUpdate({
    runId: "run-cancel-proof",
    revision: 4,
    status: "cancelled",
    activeAgents: 0
  }).settled, true);
});

test("agent launch tool events are identity-deduplicated and ignore updates without identity", () => {
  const seen = new Set();
  let launches = 0;
  const note = () => { launches += 1; };
  assert.equal(noteAgentLaunchFromToolEvent({
    type: "tool",
    name: "task",
    event: "tool_call",
    toolCallId: "call-1"
  }, seen, note), true);
  assert.equal(noteAgentLaunchFromToolEvent({
    type: "tool",
    name: "task",
    event: "tool_call_update",
    toolCallId: "call-1"
  }, seen, note), false);
  assert.equal(noteAgentLaunchFromToolEvent({
    type: "tool",
    name: "task",
    event: "tool_call_update",
    toolCallId: null
  }, seen, note), false);
  for (const name of ["get_task_output", "kill_task", "GrokBuild:get_task_output"]) {
    assert.equal(noteAgentLaunchFromToolEvent({
      type: "tool",
      name,
      event: "tool_call",
      toolCallId: `call-${name}`
    }, seen, note), false);
  }
  assert.equal(launches, 1);
});

test("terminal mapping covers complete/partial, cancel, pause, failure, and no replay", () => {
  assert.equal(
    mapDeepResearchTerminal({
      status: "complete",
      report: { valid: true, status: "verified" }
    }).jobStatus,
    "completed"
  );
  assert.equal(
    mapDeepResearchTerminal({ status: "complete", report: { valid: false } }).error.code,
    "E_WORKFLOW_INCOMPLETE"
  );
  assert.equal(mapDeepResearchTerminal({ status: "cancelled" }).error.code, "E_CANCELLED");
  assert.equal(mapDeepResearchTerminal({ status: "paused" }).error.code, "E_RESEARCH_PAUSED");
  assert.equal(mapDeepResearchTerminal({ status: "budget-limited" }).error.code, "E_RESEARCH_PAUSED");
  assert.equal(mapDeepResearchTerminal({ status: "failed" }).error.code, "E_WORKFLOW_INCOMPLETE");
  assert.equal(mapDeepResearchTerminal({ status: "interrupted" }).error.code, "E_WORKFLOW_INCOMPLETE");
  for (const status of ["complete", "cancelled", "paused", "failed"]) {
    const mapped = mapDeepResearchTerminal({
      status,
      report: status === "complete" ? { valid: true } : null
    });
    assert.equal(mapped.replay, false);
    assert.equal(mapped.resume, false);
  }
});

test("report collection is bound to exact session/run path with no unbound fallback", (t) => {
  const home = fixtureHome(t);
  const providerCwd = path.join(home, "provider-cwd");
  fs.mkdirSync(providerCwd, { recursive: true, mode: 0o700 });
  const sessionId = "sess-abc";
  const runId = "run-abc123";
  const relative = researchReportRelativePath(providerCwd, sessionId, runId);
  const reportPath = path.join(home, ...relative.split("/"));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  const body = "# Research\n\nSources: https://example.com/a https://example.com/b\nPartial coverage noted.\n";
  fs.writeFileSync(reportPath, body, { mode: 0o600 });
  // Unbound GROK_HOME/workflows path must not be used even if present.
  const unbound = path.join(home, "workflows", runId, "scratch", "report.md");
  fs.mkdirSync(path.dirname(unbound), { recursive: true });
  fs.writeFileSync(unbound, "WRONG unbound report\n");

  const report = collectResearchReport({ grokHome: home, providerCwd, sessionId, runId });
  assert.equal(report.valid, true);
  assert.equal(report.path, relative);
  assert.equal(report.bytes, Buffer.byteLength(body));
  assert.equal(report.sha256, crypto.createHash("sha256").update(body).digest("hex"));
  assert.ok(report.sourceCount >= 2);
  assert.equal(report.hostVerification, "not_run");
  assert.equal(report.status, "partial");
  assert.equal(report.markdown.includes("WRONG"), false);

  assert.throws(
    () => collectResearchReport({ grokHome: home, providerCwd, sessionId, runId: "../escape" }),
    (error) => error.code === "E_SCHEMA" || error.code === "E_SECURITY_PROFILE"
  );
  assert.throws(
    () => collectResearchReport({ grokHome: home, providerCwd, runId }),
    (error) => error.code === "E_SCHEMA"
  );

  const missing = collectResearchReport({
    grokHome: home,
    providerCwd,
    sessionId,
    runId: "missing-run"
  });
  assert.equal(missing.valid, false);

  const bigSession = "sess-big";
  const big = path.join(
    home,
    ...researchReportRelativePath(providerCwd, bigSession, "big").split("/")
  );
  fs.mkdirSync(path.dirname(big), { recursive: true });
  fs.writeFileSync(big, "x".repeat(512 * 1024 + 1));
  assert.throws(
    () => collectResearchReport({
      grokHome: home,
      providerCwd,
      sessionId: bigSession,
      runId: "big"
    }),
    (error) => error.code === "E_OUTPUT_LIMIT"
  );
});

test("artifact symlink attack is rejected under bound session path", (t) => {
  if (process.platform === "win32") return;
  const home = fixtureHome(t);
  const providerCwd = path.join(home, "provider-cwd");
  fs.mkdirSync(providerCwd, { recursive: true, mode: 0o700 });
  const sessionId = "sess-symlink";
  const runId = "symlink-run";
  const dir = path.dirname(path.join(
    home,
    ...researchReportRelativePath(providerCwd, sessionId, runId).split("/")
  ));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(home, "outside.md");
  fs.writeFileSync(target, "secret\n", { mode: 0o600 });
  fs.symlinkSync(target, path.join(dir, "report.md"));
  assert.throws(
    () => collectResearchReport({ grokHome: home, providerCwd, sessionId, runId }),
    (error) => error.code === "E_SECURITY_PROFILE" || error.code === "E_SCHEMA"
  );
});

test("WebFetch attestation fail-closed or reduced coverage", () => {
  const ok = attestWebFetchAllowLocalFalse({
    configText: "[tools.web_fetch]\nallow_local = false\n",
    inspect: { tools: [{ name: "web_fetch", allow_local: false }] }
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.reducedCoverage, false);
  const reduced = attestWebFetchAllowLocalFalse({ configText: "" });
  assert.equal(reduced.ok, false);
  assert.equal(reduced.reducedCoverage, true);
  assert.equal(isUnexpectedDeepResearchPermission({ options: [] }), true);
});

test("private query staging is digest-bound, mode-restricted, and consumed once", (t) => {
  const state = tempDir("deep-research-query-");
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const staged = stageDeepResearchQuery(state, "deep-research-abc", "private topic");
  assert.match(staged.digest, /^[a-f0-9]{64}$/);
  assert.equal(
    consumeDeepResearchQuery(state, "deep-research-abc", staged.digest),
    "private topic"
  );
  assert.throws(
    () => consumeDeepResearchQuery(state, "deep-research-abc", staged.digest),
    (error) => error.code === "ENOENT"
  );
});

test("workspace snapshot is tracked-only read-only, leaves original unchanged, and cleans up after thaw", (t) => {
  const repo = initRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "nope\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "tracked");
  fs.symlinkSync("tracked.txt", path.join(repo, "link.txt"));
  const before = integritySnapshot(repo);
  const stateDirPath = tempDir("deep-research-state-");
  t.after(() => {
    // Ensure test temp cleanup never fails on frozen trees.
    try { thawTreeWritable(stateDirPath); } catch { /* ignore */ }
    fs.rmSync(stateDirPath, { recursive: true, force: true });
  });
  const snapshot = createWorkspaceSnapshot(repo, stateDirPath, "deep-research-testjob");
  assert.equal(fs.existsSync(path.join(snapshot.cwd, "tracked.txt")), true);
  assert.equal(fs.existsSync(path.join(snapshot.cwd, "untracked.txt")), false);
  assert.equal(fs.existsSync(path.join(snapshot.cwd, "link.txt")), false);
  assert.equal(fs.existsSync(path.join(snapshot.cwd, ".git")), false);
  const mode = fs.statSync(path.join(snapshot.cwd, "tracked.txt")).mode & 0o777;
  assert.equal(mode, 0o400);
  proveWorkspaceUnchanged(repo, before);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "still original side\n");
  // Original may change by host; snapshot remains independent.
  assert.equal(fs.readFileSync(path.join(snapshot.cwd, "tracked.txt"), "utf8"), "tracked\n");

  // Frozen RO tree must still be removable via research cleanup helpers.
  removeResearchTree(path.dirname(snapshot.cwd));
  assert.equal(fs.existsSync(snapshot.cwd), false);
  const cleanup = cleanupResearchRuntimeArtifacts(stateDirPath, "deep-research-testjob", []);
  assert.equal(cleanup.ok, true);
});

test("web-only profile denies repository reads; workspace profile permits read tools only", () => {
  const research = profileFor("deep-research");
  assert.equal(research.id, DEEP_RESEARCH_PROFILE_ID);
  assert.equal(research.webSearch, true);
  assert.equal(research.subagents, true);
  assert.equal(research.transport, "acp");
  assert.deepEqual(research.allowedTools, ["WebSearch", "Agent"]);
  assert.ok(research.deniedTools.includes("WebFetch"));
  assert.ok(research.deniedProviderToolIds.includes("GrokBuild:web_fetch"));
  assert.ok(research.deniedTools.includes("Bash"));
  assert.ok(research.deniedTools.includes("read_file"));
  assert.ok(research.deniedProviderToolIds.includes("GrokBuild:run_terminal_cmd"));
  assert.ok(research.deniedProviderToolIds.includes("GrokBuild:search_replace"));
  assert.ok(research.deniedProviderToolIds.includes("GrokBuild:read_file"));
  assert.match(research.agentProfileDigest, /^[a-f0-9]{64}$/);

  const workspace = profileFor("deep-research-workspace");
  assert.equal(workspace.id, "deep-research-workspace-v1");
  assert.ok(workspace.allowedTools.includes("read_file"));
  assert.ok(workspace.allowedTools.includes("list_dir"));
  assert.ok(workspace.allowedTools.includes("grep"));
  assert.ok(workspace.deniedTools.includes("Bash"));
  assert.ok(workspace.deniedTools.includes("search_replace"));
  assert.ok(!workspace.deniedProviderToolIds.includes("GrokBuild:read_file"));
  assert.equal(sameSecurityProfile(research, workspace), false);

  const read = profileFor("task", false);
  const write = profileFor("task", true);
  assert.equal(read.id, "rescue-read-v3");
  assert.equal(write.id, "rescue-write-v3");
  assert.equal(read.webSearch, false);
  assert.equal(write.webSearch, false);
  assert.equal(sameSecurityProfile(research, read), false);
});

test("state persists kind deep-research with schema v3 and public projection fields", (t) => {
  const repo = initRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const pluginData = tempDir("deep-research-plugin-data-");
  t.after(() => fs.rmSync(pluginData, { recursive: true, force: true }));
  process.env.GROK_COMPANION_PLUGIN_DATA = pluginData;
  process.env.GROK_COMPANION_HOST = "claude-code";
  process.env.GROK_COMPANION_HOST_SESSION_ID = "session-dr-1";
  const id = generateId(DEEP_RESEARCH_KIND);
  assert.match(id, /^deep-research-[a-f0-9]{24}$/);
  assert.equal(assertSafeJobId(id), id);
  const job = {
    schemaVersion: 3,
    id,
    kind: DEEP_RESEARCH_KIND,
    jobClass: "research",
    title: "research",
    summary: "running",
    write: false,
    status: "running",
    phase: "researching",
    workspaceRoot: repo,
    host: { kind: "claude-code", sessionId: "session-dr-1" },
    createdAt: "2026-07-28T00:00:00.000Z",
    startedAt: "2026-07-28T00:00:01.000Z",
    updatedAt: "2026-07-28T00:00:02.000Z",
    completedAt: null,
    heartbeatAt: "2026-07-28T00:00:02.000Z",
    profile: profileFor("deep-research"),
    model: null,
    effort: null,
    progress: "Workflow running",
    latestPlan: [],
    commandOutcomes: [],
    lifecycleEvents: [],
    completionContextManifest: null,
    request: {
      researchOptions: { background: true, webOnly: true, workspace: false },
      publicObjective: "topic"
    },
    workflow: { runId: "run-1", revision: 3, status: "running", activeAgents: 1, agentLaunches: 2 },
    result: {
      hostVerification: "not_run",
      workflow: { runId: "run-1", revision: 3, status: "running", activeAgents: 1, agentLaunches: 2 },
      researchReport: {
        valid: true,
        path: "workflows/run-1/scratch/report.md",
        bytes: 12,
        sha256: "a".repeat(64),
        sourceCount: 2,
        coverageNotes: ["ok"],
        status: "verified",
        hostVerification: "not_run",
        textPreview: "preview"
      }
    },
    error: null
  };
  writeJob(repo, job);
  const loaded = readJob(repo, id);
  assert.equal(loaded.kind, DEEP_RESEARCH_KIND);
  assert.equal(loaded.jobClass, "research");
  assert.equal(loaded.schemaVersion, 3);
  const snapshot = projectWorkerSnapshot(loaded);
  assert.equal(snapshot.kind, DEEP_RESEARCH_KIND);
  assert.equal(snapshot.jobClass, "research");
  assert.equal(snapshot.result.hostVerification, "not_run");
  assert.equal(snapshot.result.researchReport.status, "verified");
  assert.equal(snapshot.result.workflow.runId, "run-1");
  // Private absolute paths / full report body are not required in public projection.
  assert.equal(Object.hasOwn(snapshot.result.researchReport, "text"), false);
});

test("public research report projection keeps hostVerification not_run", () => {
  const projected = publicResearchReport({
    valid: true,
    path: "workflows/r/scratch/report.md",
    bytes: 10,
    sha256: "b".repeat(64),
    sourceCount: 1,
    coverageNotes: ["n"],
    status: "partial",
    markdown: "full private body"
  });
  assert.equal(projected.hostVerification, "not_run");
  assert.equal(projected.status, "partial");
  assert.equal(projected.textPreview, "full private body".slice(0, 500));
});

test("packaging surfaces exist for Codex skill and Claude command", () => {
  const skill = path.join(ROOT, "plugins/grok/skills/deep-research/SKILL.md");
  const yaml = path.join(ROOT, "plugins/grok/skills/deep-research/agents/openai.yaml");
  const command = path.join(ROOT, "plugins/grok/commands/deep-research.md");
  const profile = path.join(ROOT, "plugins/grok/provider-agents/deep-research.md");
  for (const file of [skill, yaml, command, profile]) {
    assert.equal(fs.existsSync(file), true, file);
  }
  const skillText = fs.readFileSync(skill, "utf8");
  assert.match(skillText, /--background/);
  assert.match(skillText, /--web-only/);
  assert.match(skillText, /--workspace/);
  assert.match(skillText, /hostVerification/);
  const commandText = fs.readFileSync(command, "utf8");
  assert.match(commandText, /deep-research/);
  assert.match(commandText, /query-stdin/);
});

test("non-replay mapping never offers resume after provider failure classes", () => {
  for (const status of ["failed", "interrupted", "paused", "budget_limited", "cancelled"]) {
    const mapped = mapDeepResearchTerminal({ status });
    assert.equal(mapped.replay, false);
    assert.equal(mapped.resume, false);
  }
});

test("fake-ACP lifecycle: session-scoped capability, launch-ack nonterminal, report, cancel, non-replay", async (t) => {
  if (process.platform === "win32") return;
  const fakeRoot = tempDir("deep-research-fake-");
  t.after(() => fs.rmSync(fakeRoot, { recursive: true, force: true }));
  const fake = installFakeGrok(fakeRoot, {
    deepResearch: true,
    deepResearchRunId: "run-lifecycle-1",
    deepResearchReport: "# Lifecycle\n\nSources: https://example.com/doc\nVerified coverage.\n",
    deepResearchReportStatus: "verified",
    authMethods: [{ id: "local", name: "Local test auth" }],
    models: [{ modelId: "grok-test", _meta: { reasoningEfforts: [{ id: "low" }, { id: "medium" }, { id: "high" }] } }]
  });
  const env = testEnvironment({ fake, pluginData: tempDir("deep-research-plugin-"), sessionId: "deep-research-session" });
  const previous = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });

  const root = initRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = tempDir("deep-research-runtime-state-");
  t.after(() => {
    try { thawTreeWritable(state); } catch { /* ignore */ }
    fs.rmSync(state, { recursive: true, force: true });
  });

  const events = [];
  const result = await runDeepResearch({
    root,
    profile: profileFor("deep-research"),
    query: "lifecycle topic",
    options: { background: true, "web-only": true },
    stateDir: state,
    jobMarker: "deep-research-lifecycle",
    onEvent: (event) => events.push(event),
    timeoutMs: 10_000
  });

  assert.equal(result.sessionId, "fake-session-00000001");
  assert.equal(result.workflow.runId, "run-lifecycle-1");
  assert.equal(result.workflow.status, "complete");
  assert.equal(result.researchReport?.valid, true);
  assert.equal(result.researchReport?.status, "verified");
  assert.equal(
    result.researchReport.path,
    researchReportRelativePath(path.resolve(
      state,
      "research-homes",
      "deep-research-lifecycle",
      "cwd-web-only"
    ), "fake-session-00000001", "run-lifecycle-1")
  );
  assert.equal(result.hostVerification, "not_run");
  assert.equal(result.replay, false);
  assert.equal(result.resume, false);

  const launchAck = events.find((event) => event.type === "launch-ack");
  assert.ok(launchAck, "expected launch acknowledgement event");
  assert.equal(launchAck.slash, "/deep-research lifecycle topic");
  assert.ok(events.some((event) => event.type === "available-commands"));
  assert.ok(events.some((event) => event.type === "workflow" && event.status === "complete"));

  // Capability absence must fail closed before slash launch.
  const noCmdFakeRoot = tempDir("deep-research-nocmd-");
  t.after(() => fs.rmSync(noCmdFakeRoot, { recursive: true, force: true }));
  const noCmdFake = installFakeGrok(noCmdFakeRoot, {
    deepResearch: true,
    availableCommands: [{ name: "/other" }],
    authMethods: [{ id: "local", name: "Local test auth" }]
  });
  Object.assign(process.env, testEnvironment({
    fake: noCmdFake,
    pluginData: tempDir("deep-research-plugin-nocmd-"),
    sessionId: "deep-research-session-2"
  }));
  await assert.rejects(
    () => runDeepResearch({
      root,
      profile: profileFor("deep-research"),
      query: "should fail capability",
      options: { "web-only": true },
      stateDir: tempDir("deep-research-state-nocmd-"),
      jobMarker: "deep-research-nocmd",
      timeoutMs: 5_000
    }),
    (error) => error.code === "E_CAPABILITY"
  );

  // Interruption maps to non-replay workflow incomplete.
  const interrupted = mapDeepResearchTerminal({ status: "interrupted" });
  assert.equal(interrupted.error.code, "E_WORKFLOW_INCOMPLETE");
  assert.equal(interrupted.replay, false);
  assert.equal(interrupted.resume, false);
});

test("early deep-research startup failures retain the non-replay contract", async (t) => {
  if (process.platform === "win32") return;
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });

  const fakeRoot = tempDir("deep-research-startup-failure-fake-");
  const fake = installFakeGrok(fakeRoot, {
    deepResearch: true,
    authMethods: [{ id: "local", name: "Local test auth" }]
  });
  const pluginData = tempDir("deep-research-startup-failure-plugin-");
  Object.assign(process.env, testEnvironment({
    fake,
    pluginData,
    sessionId: "deep-research-startup-failure-session"
  }));
  const root = initRepo();
  const state = tempDir("deep-research-startup-failure-state-");
  t.after(() => {
    try { thawTreeWritable(state); } catch { /* ignore */ }
    for (const directory of [state, root, pluginData, fakeRoot]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await assert.rejects(
    () => runDeepResearch({
      root,
      profile: profileFor("deep-research"),
      query: "forced startup failure",
      options: { "web-only": true },
      stateDir: state,
      jobMarker: "deep-research-startup-failure",
      timeoutMs: 5_000,
      testHooks: {
        beforeDispatchPromotion() {
          const error = new Error("forced startup security failure");
          error.code = "E_SECURITY_PROFILE";
          throw error;
        }
      }
    }),
    (error) => error.code === "E_SECURITY_PROFILE"
      && error.details?.replay === false
      && error.details?.resume === false
  );
});

test("fake-ACP terminal matrix covers partial, foreign/stale updates, pauses, budgets, failures, interruption, missing report, and timeout", async (t) => {
  if (process.platform === "win32") return;
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });

  const cases = [
    {
      name: "partial",
      config: {
        deepResearchReport: "# Partial\n\nhttps://example.com/a\nPartial coverage.\n",
        deepResearchNoiseUpdates: true
      },
      expectedStatus: "partial"
    },
    { name: "user-paused", config: { deepResearchTerminalStatus: "user_paused" }, expectedCode: "E_RESEARCH_PAUSED" },
    { name: "budget", config: { deepResearchTerminalStatus: "budget_limited" }, expectedCode: "E_RESEARCH_PAUSED" },
    { name: "failed", config: { deepResearchTerminalStatus: "failed" }, expectedCode: "E_WORKFLOW_INCOMPLETE" },
    { name: "interrupted", config: { deepResearchTerminalStatus: "interrupted" }, expectedCode: "E_WORKFLOW_INCOMPLETE" },
    { name: "missing-report", config: { deepResearchOmitReport: true }, expectedCode: "E_WORKFLOW_INCOMPLETE" },
    { name: "permission-init", config: { permissionRequest: true }, expectedCode: "E_SECURITY_PROFILE" },
    { name: "timeout", config: { deepResearchNeverComplete: true }, expectedCode: "E_TIMEOUT", timeoutMs: 600 }
  ];

  for (const fixture of cases) {
    const fakeRoot = tempDir(`deep-research-${fixture.name}-fake-`);
    const fake = installFakeGrok(fakeRoot, {
      deepResearch: true,
      deepResearchRunId: `run-${fixture.name}`,
      authMethods: [{ id: "local", name: "Local test auth" }],
      ...fixture.config
    });
    const pluginData = tempDir(`deep-research-${fixture.name}-plugin-`);
    Object.assign(process.env, testEnvironment({
      fake,
      pluginData,
      sessionId: `deep-research-${fixture.name}-session`
    }));
    const root = initRepo();
    const state = tempDir(`deep-research-${fixture.name}-state-`);
    try {
      const invocation = () => runDeepResearch({
        root,
        profile: profileFor("deep-research"),
        query: `case ${fixture.name}`,
        options: { "web-only": true },
        stateDir: state,
        jobMarker: `deep-research-${fixture.name}`,
        timeoutMs: fixture.timeoutMs || 5_000
      });
      if (fixture.expectedCode) {
        await assert.rejects(
          invocation,
          (error) => error.code === fixture.expectedCode
            && error.details?.replay === false
            && error.details?.resume === false
        );
      } else {
        const result = await invocation();
        assert.equal(result.researchReport.status, fixture.expectedStatus);
        assert.equal(result.workflow.runId, `run-${fixture.name}`);
        assert.equal(result.workflow.revision, 2);
      }
    } finally {
      try { thawTreeWritable(state); } catch { /* ignore */ }
      fs.rmSync(state, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(pluginData, { recursive: true, force: true });
      fs.rmSync(fakeRoot, { recursive: true, force: true });
    }
  }
});

test("fake-ACP cancellation settles with exact /workflow stop and zero active agents", async (t) => {
  if (process.platform === "win32") return;
  const fakeRoot = tempDir("deep-research-cancel-fake-");
  t.after(() => fs.rmSync(fakeRoot, { recursive: true, force: true }));
  const fake = installFakeGrok(fakeRoot, {
    deepResearch: true,
    deepResearchRunId: "run-cancel-1",
    deepResearchCancelWait: true,
    authMethods: [{ id: "local", name: "Local test auth" }]
  });
  const env = testEnvironment({ fake, pluginData: tempDir("deep-research-plugin-cancel-"), sessionId: "deep-research-cancel" });
  const previous = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
  const root = initRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = tempDir("deep-research-cancel-state-");
  t.after(() => {
    try { thawTreeWritable(state); } catch { /* ignore */ }
    fs.rmSync(state, { recursive: true, force: true });
  });

  let cancel = false;
  const cancellationEvents = [];
  await assert.rejects(
    () => runDeepResearch({
      root,
      profile: profileFor("deep-research"),
      query: "cancel me",
      options: { "web-only": true },
      stateDir: state,
      jobMarker: "deep-research-cancel-job",
      cancelRequested: () => cancel,
      onEvent: (event) => {
        cancellationEvents.push(event);
        if (event.type === "workflow" && event.runId && event.status === "running") {
          cancel = true;
        }
      },
      timeoutMs: 10_000,
      testHooks: { forceSettledAfterCancel: false }
    }),
    (error) => error.code === "E_CANCELLED" && error.details?.replay === false
  );
  assert.deepEqual(
    cancellationEvents
      .filter((event) => event.type === "workflow" && event.status === "cancelled")
      .map((event) => [event.revision, event.activeAgents]),
    [[98, 1], [99, 0]]
  );
});
