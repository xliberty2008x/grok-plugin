import {
  assert, crypto, fs, path, test, appendLifecycleEvent,
  assertContextCompatible, assertContextManifestIntegrity, assertTaskContextReady, buildRuntimeEvidence, buildTaskEnvelope, buildWorkerReport,
  buildWorkerReportOutputSchema, captureContextManifest, composeProviderPrompt, composeWorkerReportRepairPrompt, CONTEXT_METADATA_POLICIES, evaluateScope,
  observeChangedPaths, validateReview, REVIEW_SCHEMA, processStartToken, STDIN_READY_MARKER, initRepo,
  git, run, runCompanion, spawnNonblockingStdin, testEnvironment, waitFor,
  ROOT, tempDir, installFakeGrok, readFakeLog, installPinnedFakeCompanion, missingInvalidProviderCapabilityReceiptMessage,
  PROVIDER_LIFECYCLE_AVAILABLE, fixture, parseJson, canonicalizeForDigest, stableDigestForTest, workerReport
} from "./control-plane-test-support.mjs";

test("verification observer tolerates only pytest/Python cache ignored drift", () => {
  const root = initRepo();
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    ".pytest_cache/\n__pycache__/\n.pytest_cache-copy/\n__pycache__-copy/\nbuild-output.txt\n"
  );
  git(root, "add", ".gitignore");
  git(root, "commit", "-m", "ignore cache and build output");

  const before = captureContextManifest(root);
  assert.match(before.git.verificationIgnoredDigest, /^[a-f0-9]{64}$/);
  assert.equal(before.git.verificationIgnoredEntryCount, 0);

  fs.mkdirSync(path.join(root, ".pytest_cache", "v"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pytest_cache", "v", "cache"), "nodeids\n");
  fs.mkdirSync(path.join(root, "pkg", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg", "__pycache__", "mod.cpython-311.pyc"), "bytecode");
  const afterCache = captureContextManifest(root);

  assert.notEqual(afterCache.git.ignoredDigest, before.git.ignoredDigest);
  assert.equal(afterCache.git.verificationIgnoredDigest, before.git.verificationIgnoredDigest);
  const fullObserved = observeChangedPaths(before, afterCache);
  assert.deepEqual(fullObserved.sort(), [
    ".pytest_cache/v/cache",
    "pkg/__pycache__/mod.cpython-311.pyc"
  ]);
  assert.deepEqual(observeChangedPaths(before, afterCache, { observer: "verification" }), []);

  fs.mkdirSync(path.join(root, ".pytest_cache-copy"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pytest_cache-copy", "evidence.txt"), "not pytest cache\n");
  fs.mkdirSync(path.join(root, "pkg", "__pycache__-copy"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg", "__pycache__-copy", "evidence.pyc"), "not pycache\n");
  fs.writeFileSync(path.join(root, "build-output.txt"), "meaningful ignored write\n");
  const afterMeaningful = captureContextManifest(root);
  assert.notEqual(afterMeaningful.git.verificationIgnoredDigest, before.git.verificationIgnoredDigest);
  assert.deepEqual(observeChangedPaths(before, afterMeaningful, { observer: "verification" }).sort(), [
    ".pytest_cache-copy/evidence.txt",
    "build-output.txt",
    "pkg/__pycache__-copy/evidence.pyc"
  ]);
});

test("verification observer falls back fail-closed without verification-only identity", () => {
  const legacyBefore = {
    git: {
      dirtyDigest: "dirty",
      dirtyEntries: [],
      ignoredDigest: "ignored-before",
      ignoredEntriesAttributable: false,
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  const current = {
    git: {
      dirtyDigest: "dirty",
      dirtyEntries: [],
      ignoredDigest: "ignored-after",
      ignoredEntriesAttributable: false,
      verificationIgnoredDigest: "verification-same",
      verificationIgnoredEntriesAttributable: true,
      verificationIgnoredEntries: [],
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  assert.deepEqual(
    observeChangedPaths(legacyBefore, current, { observer: "verification" }),
    ["[IGNORED_WORKTREE]"]
  );

  const malformedBefore = {
    git: {
      ...legacyBefore.git,
      verificationIgnoredDigest: "not-a-sha256",
      verificationIgnoredEntryCount: 0,
      verificationIgnoredEntriesAttributable: true,
      verificationIgnoredEntries: [],
      verificationIgnoredInventoryComplete: true
    }
  };
  const malformedAfter = {
    git: {
      ...malformedBefore.git,
      ignoredDigest: "ignored-after"
    }
  };
  assert.deepEqual(
    observeChangedPaths(malformedBefore, malformedAfter, { observer: "verification" }),
    ["[IGNORED_WORKTREE]"]
  );

  const attributableBefore = {
    git: {
      dirtyDigest: "dirty",
      dirtyEntries: [],
      ignoredDigest: "ignored-a",
      ignoredEntriesAttributable: true,
      ignoredEntries: [{ path: "secret.bin", fingerprint: "fp-a" }],
      verificationIgnoredDigest: "verification-stable",
      verificationIgnoredEntryCount: 1,
      verificationIgnoredEntriesAttributable: true,
      verificationIgnoredEntries: [{ path: "secret.bin", fingerprint: "verify-fp" }],
      // Deliberately omit verificationIgnoredInventoryComplete. A partially
      // populated new identity must fall back to the full ignored observer.
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  const attributableAfter = {
    git: {
      ...attributableBefore.git,
      ignoredDigest: "ignored-b",
      ignoredEntries: [{ path: "secret.bin", fingerprint: "fp-b" }],
      verificationIgnoredDigest: "verification-stable"
    }
  };
  assert.deepEqual(
    observeChangedPaths(attributableBefore, attributableAfter, { observer: "verification" }),
    ["secret.bin"]
  );

  const impossibleBefore = {
    git: {
      ...attributableBefore.git,
      verificationIgnoredDigest: "0".repeat(64),
      verificationIgnoredEntryCount: 0,
      verificationIgnoredEntriesAttributable: false,
      verificationIgnoredEntries: [],
      verificationIgnoredInventoryComplete: true
    }
  };
  const impossibleAfter = {
    git: {
      ...impossibleBefore.git,
      ignoredDigest: "ignored-b",
      ignoredEntries: [{ path: "secret.bin", fingerprint: "fp-b" }]
    }
  };
  assert.deepEqual(
    observeChangedPaths(impossibleBefore, impossibleAfter, { observer: "verification" }),
    ["secret.bin"]
  );
});

test("verification observer retains [IGNORED_WORKTREE] when non-cache ignored drift is not attributable", () => {
  const before = {
    git: {
      dirtyDigest: "dirty",
      dirtyEntries: [],
      ignoredDigest: "full-a",
      ignoredEntriesAttributable: false,
      verificationIgnoredDigest: "verify-a",
      verificationIgnoredEntryCount: 2001,
      verificationIgnoredEntriesAttributable: false,
      verificationIgnoredEntries: [],
      verificationIgnoredInventoryComplete: true,
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  const after = {
    git: {
      ...before.git,
      ignoredDigest: "full-b",
      verificationIgnoredDigest: "verify-b"
    }
  };
  assert.deepEqual(observeChangedPaths(before, after), ["[IGNORED_WORKTREE]"]);
  assert.deepEqual(observeChangedPaths(before, after, { observer: "verification" }), ["[IGNORED_WORKTREE]"]);
});

test("changed-path overflow remains a fail-closed scope violation", () => {
  const entries = Array.from({ length: 201 }, (_, index) => ({
    status: " M",
    path: index === 200 ? "outside/escape.js" : `src/file-${String(index).padStart(3, "0")}.js`,
    fileKind: "file",
    fileMode: 0o100644,
    worktreeHash: `before-${index}`
  }));
  const before = {
    git: {
      dirtyDigest: "before",
      dirtyEntries: entries,
      ignoredDigest: "ignored",
      head: "head",
      trackedTreeIdentity: "tree",
      metadataIdentity: "metadata"
    }
  };
  const after = {
    git: {
      ...before.git,
      dirtyDigest: "after",
      dirtyEntries: entries.map((entry, index) => ({ ...entry, worktreeHash: `after-${index}` }))
    }
  };
  const observed = observeChangedPaths(before, after);
  assert.equal(observed.length, 201);
  assert.deepEqual(evaluateScope(observed, { include: ["src/**"], exclude: [] }), ["outside/escape.js"]);
  assert.deepEqual(
    evaluateScope(observed.map((item) => item === "outside/escape.js" ? "src/file-200.js" : item), { include: ["src/**"], exclude: [] }),
    []
  );
  const evidence = buildRuntimeEvidence({ changedPaths: observed });
  assert.equal(evidence.observedChangedPaths.length, 200);
  assert.equal(evidence.observedChangedPaths[0], "[CHANGED_PATHS_OVERFLOW]");
});

test("structured context readiness fails closed for unverified whole-project work", () => {
  const root = initRepo();
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = \"fixture\"\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Fixture guidance\n");
  fs.writeFileSync(path.join(root, ".github", "workflows", "quality.yml"), "name: quality\n");
  git(root, "add", "pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml");
  git(root, "commit", "-m", "add project markers");
  const manifest = captureContextManifest(root);
  assert.deepEqual(manifest.projectMarkers, ["pyproject.toml"]);
  const complete = buildTaskEnvelope({
    userRequest: "inspect the whole project",
    context: {
      workspaceState: "complete",
      upstreamFreshness: "not_checked",
      expectedProjectMarkers: ["pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml"]
    }
  });
  assert.throws(
    () => assertTaskContextReady(complete, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE" && /upstream-freshness-not-verified/.test(error.message)
  );

  const verifiedComplete = buildTaskEnvelope({
    userRequest: "inspect all declared project markers",
    context: {
      workspaceState: "complete",
      upstreamFreshness: "verified",
      expectedProjectMarkers: ["pyproject.toml", "AGENTS.md", ".github/workflows/quality.yml"]
    }
  });
  assert.doesNotThrow(() => assertTaskContextReady(verifiedComplete, manifest, { structuredInput: true }));

  const linkedParent = tempDir("grok-plugin-linked-parent-");
  const linkedRoot = path.join(linkedParent, "checkout");
  git(root, "worktree", "add", "-b", "linked-fixture", linkedRoot);
  const linkedManifest = captureContextManifest(linkedRoot);
  assert.deepEqual(linkedManifest.projectMarkers, ["pyproject.toml"]);
  assert.doesNotThrow(() => assertTaskContextReady(verifiedComplete, linkedManifest, { structuredInput: true }));

  const scoped = buildTaskEnvelope({
    userRequest: "inspect the available package",
    context: {
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked",
      expectedProjectMarkers: ["pyproject.toml", "AGENTS.md"],
      requiredPaths: ["tracked.txt", "pyproject.toml"]
    }
  });
  assert.doesNotThrow(() => assertTaskContextReady(scoped, manifest, { structuredInput: true }));

  const missingMarker = buildTaskEnvelope({
    userRequest: "inspect a project with a missing marker",
    context: {
      workspaceState: "task_scoped",
      expectedProjectMarkers: ["docs/missing-marker.md"],
      requiredPaths: ["tracked.txt"]
    }
  });
  assert.throws(
    () => assertTaskContextReady(missingMarker, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
      && error.details?.missingMarkers?.includes("docs/missing-marker.md")
      && error.details?.reasons?.includes("missing-project-markers:docs/missing-marker.md")
      && !/Complete host preflight/.test(error.message)
  );

  for (const marker of [
    "/tmp/outside",
    "C:\\outside",
    "C:outside",
    "nested/../outside",
    "file:///etc/passwd",
    "././https://example.test/marker",
    "~/outside",
    "a".repeat(1025)
  ]) {
    assert.throws(
      () => buildTaskEnvelope({
        userRequest: "reject an unsafe project marker",
        context: { expectedProjectMarkers: [marker] }
      }),
      (error) => error?.code === "E_USAGE"
    );
  }

  fs.mkdirSync(path.join(root, "marker-links"));
  fs.symlinkSync("../AGENTS.md", path.join(root, "marker-links", "internal"));
  const externalMarker = path.join(tempDir("grok-plugin-external-marker-"), "marker.txt");
  fs.writeFileSync(externalMarker, "outside\n");
  fs.symlinkSync(externalMarker, path.join(root, "marker-links", "external"));
  const internalSymlinkMarker = buildTaskEnvelope({
    userRequest: "accept an internal project marker symlink",
    context: {
      workspaceState: "task_scoped",
      expectedProjectMarkers: ["marker-links/internal"],
      requiredPaths: ["tracked.txt"]
    }
  });
  assert.doesNotThrow(() => assertTaskContextReady(internalSymlinkMarker, manifest, { structuredInput: true }));
  const escapingSymlinkMarker = buildTaskEnvelope({
    userRequest: "reject an escaping project marker symlink",
    context: {
      workspaceState: "task_scoped",
      expectedProjectMarkers: ["marker-links/external"],
      requiredPaths: ["tracked.txt"]
    }
  });
  assert.throws(
    () => assertTaskContextReady(escapingSymlinkMarker, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
      && error.details?.unsafeMarkers?.includes("marker-links/external")
      && error.details?.reasons?.includes("project-markers-escape-workspace:marker-links/external")
  );

  const emptySlice = buildTaskEnvelope({
    userRequest: "inspect an unspecified checkout slice",
    context: { workspaceState: "task_scoped", upstreamFreshness: "not_checked" }
  });
  assert.throws(
    () => assertTaskContextReady(emptySlice, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
      && error.details?.reasons?.includes("task-scoped-inventory-missing")
  );
  const missingSlice = buildTaskEnvelope({
    userRequest: "inspect source that is not checked out",
    context: {
      workspaceState: "task_scoped",
      upstreamFreshness: "not_checked",
      requiredPaths: ["src", "pyproject.toml"]
    }
  });
  assert.throws(
    () => assertTaskContextReady(missingSlice, manifest, { structuredInput: true }),
    (error) => error?.code === "E_CONTEXT_INCOMPLETE"
      && error.details?.missingPaths?.includes("src")
      && /missing-required-paths:src/.test(error.message)
  );
  assert.throws(
    () => buildTaskEnvelope({
      userRequest: "unsafe inventory",
      context: { workspaceState: "task_scoped", requiredPaths: ["../outside"] }
    }),
    (error) => error?.code === "E_USAGE"
  );
  assert.deepEqual(evaluateScope(["index.js", "src/index.js"], { include: ["**/*.js"] }), []);
});

test("lifecycle events are bounded typed operational evidence only", () => {
  let events = [];
  events = appendLifecycleEvent(events, "task.accepted", "Task accepted", { envelopeId: "env-1" });
  events = appendLifecycleEvent(events, "plan.updated", "Plan updated");
  events = appendLifecycleEvent(events, "activity.started", "tool: read");
  events = appendLifecycleEvent(events, "activity.completed", "tool: read");
  events = appendLifecycleEvent(events, "checkpoint", "Grok session created");
  events = appendLifecycleEvent(events, "blocked", "Waiting on input");
  events = appendLifecycleEvent(events, "final.report", "Worker report ready");
  assert.equal(events.length, 7);
  assert.ok(events.every((event) => event.at && event.type && event.summary));
  assert.throws(() => appendLifecycleEvent(events, "secret.thought", "nope"), (error) => error?.code === "E_STATE");
});

test("interim text never contaminates structured final worker report", () => {
  const interim = "INTERIM_SHOULD_NOT_ENTER_WORKER_REPORT";
  const finalText = workerReport({
    summary: "FINAL_ANSWER_ONLY_FOR_REPORT",
    acceptanceResults: [{ id: "AC-01", status: "met" }]
  });
  const report = buildWorkerReport({
    providerText: finalText,
    acceptanceCriteria: [{ id: "AC-01", text: "Done" }]
  });
  assert.equal(report.summary.includes(interim), false);
  assert.match(report.summary, /FINAL_ANSWER_ONLY_FOR_REPORT/);
  assert.equal(JSON.stringify(report).includes(interim), false);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.outcome, "complete");
});

test("worker reports require the final marker and exact acceptance IDs", () => {
  const criteria = [
    { id: "AC-01", text: "First" },
    { id: "AC-02", text: "Second" }
  ];
  const unmarked = buildWorkerReport({
    providerText: JSON.stringify({
      outcome: "complete",
      summary: "looks structured",
      changedFiles: [],
      checksClaimed: [],
      acceptanceResults: criteria.map((item) => ({ id: item.id, status: "met" })),
      risks: [],
      questions: []
    }),
    acceptanceCriteria: criteria
  });
  assert.equal(unmarked.valid, false);
  assert.ok(unmarked.validationIssues.some((item) => /required GROK_WORKER_REPORT marker/.test(item)));

  const invalid = buildWorkerReport({
    providerText: workerReport({
      acceptanceResults: [
        { id: "AC-01", status: "met" },
        { id: "AC-01", status: "met" },
        { id: "AC-99", status: "met" }
      ]
    }),
    acceptanceCriteria: criteria
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.validationIssues.some((item) => /Duplicate acceptance result AC-01/.test(item)));
  assert.ok(invalid.validationIssues.some((item) => /Unknown acceptance criterion AC-99/.test(item)));
  assert.ok(invalid.validationIssues.some((item) => /Missing acceptance result AC-02/.test(item)));
});

test("native Grok Build worker reports take precedence and bind a canonical digest", () => {
  const criteria = [
    { id: "AC-01", text: "First" },
    { id: "AC-02", text: "Second" }
  ];
  const native = {
    outcome: "complete",
    summary: "native report",
    changedFiles: ["target.txt"],
    checksClaimed: ["checked target.txt"],
    acceptanceResults: criteria.map(({ id }) => ({ id, status: "met" })),
    risks: [],
    questions: [],
    hostActionRequest: null
  };
  const report = buildWorkerReport({
    providerText: workerReport({ summary: "contradictory marker report" }),
    nativeStructuredOutput: native,
    acceptanceCriteria: criteria
  });
  assert.equal(report.valid, true);
  assert.equal(report.structured, true);
  assert.equal(report.summary, "native report");
  assert.equal(report.reportSource, "acp-structured");
  assert.match(report.reportDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    buildWorkerReport({
      nativeStructuredOutput: structuredClone(native),
      acceptanceCriteria: criteria
    }).reportDigest,
    report.reportDigest
  );

  const failedNative = buildWorkerReport({
    providerText: workerReport({
      summary: "valid marker must not downgrade an explicit native error",
      acceptanceResults: criteria.map(({ id }) => ({ id, status: "met" }))
    }),
    nativeStructuredOutputError: "schema mismatch",
    acceptanceCriteria: criteria
  });
  assert.equal(failedNative.valid, false);
  assert.equal(failedNative.reportSource, "acp-structured-error");
  assert.equal(failedNative.reportDigest, null);

  const schema = buildWorkerReportOutputSchema(criteria);
  assert.deepEqual(schema.required, [
    "outcome",
    "summary",
    "changedFiles",
    "checksClaimed",
    "acceptanceResults",
    "risks",
    "questions",
    "hostActionRequest"
  ]);
  assert.deepEqual(
    schema.properties.acceptanceResults.items.properties.id.enum,
    ["AC-01", "AC-02"]
  );
});

test("report repair prompt forbids tool use and is marker-bound and acceptance-complete", () => {
  const envelope = buildTaskEnvelope({
    userRequest: "repair fixture",
    acceptanceCriteria: [
      { id: "AC-01", text: "First" },
      { id: "AC-02", text: "Second" }
    ]
  });
  const invalid = buildWorkerReport({ providerText: "not a report", acceptanceCriteria: envelope.acceptanceCriteria });
  const prompt = composeWorkerReportRepairPrompt(envelope, invalid);
  assert.match(prompt, /Report-format repair only/);
  assert.match(prompt, /Do not call tools/);
  assert.match(prompt, /GROK_WORKER_REPORT:/);
  assert.match(prompt, /AC-01/);
  assert.match(prompt, /AC-02/);
});

test("provider formatter and setup profiles expose only compatibility plan state", () => {
  for (const [file, name, description] of [
    [
      "report-repair.md",
      "grok-companion-report-repair",
      "No-workspace formatter for a completed Grok Companion task report."
    ],
    [
      "setup-probe.md",
      "grok-companion-setup-probe",
      "Restricted no-workspace ACP setup probe agent for Grok Companion."
    ]
  ]) {
    const text = fs.readFileSync(
      path.join(ROOT, "plugins/grok/provider-agents", file),
      "utf8"
    );
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
    assert.equal(frontmatter, [
      `name: ${name}`,
      `description: ${description}`,
      "prompt_mode: full",
      "permission_mode: dontAsk",
      "agents_md: false",
      "injectDefaultTools: false",
      "toolConfig:",
      "  tools:",
      "    - id: GrokBuild:todo_write"
    ].join("\n"));
    assert.match(frontmatter, /^permission_mode:\s*dontAsk$/m);
    assert.match(frontmatter, /^injectDefaultTools:\s*false$/m);
    assert.deepEqual(
      [...frontmatter.matchAll(/^\s+- id:\s*(\S+)\s*$/gm)].map((match) => match[1]),
      ["GrokBuild:todo_write"]
    );
    assert.doesNotMatch(
      frontmatter,
      /GrokBuild:(?:read_file|list_dir|grep|search_replace|run_terminal_cmd|web_search|web_fetch|task|ask_user_question)/
    );
    assert.match(text, /never invoke it/i);
  }
});

test("provider success claims leave hostVerification not_run in runtime evidence", () => {
  const root = initRepo();
  const pre = captureContextManifest(root);
  fs.writeFileSync(path.join(root, "extra.txt"), "x\n");
  const post = captureContextManifest(root);
  const evidence = buildRuntimeEvidence({
    preContext: pre,
    postContext: post,
    changedPaths: observeChangedPaths(pre, post),
    executionStatus: "completed"
  });
  assert.equal(evidence.hostVerification, "not_run");
  assert.equal(evidence.executionStatus, "completed");
  assert.ok(evidence.observedChangedPaths.some((item) => item.includes("extra.txt")));
  const report = buildWorkerReport({
    providerText: JSON.stringify({
      outcome: "complete",
      summary: "Provider claims all checks passed",
      checksClaimed: ["npm test"],
      changedFiles: ["extra.txt"]
    })
  });
  assert.deepEqual(report.checksClaimed, ["npm test"]);
  // Runtime evidence remains independent of provider claims.
  assert.equal(evidence.hostVerification, "not_run");
});

test("review verdict is derived solely from validated findings", () => {
  assert.equal(validateReview({ summary: "clean", findings: [] }).verdict, "pass");
  assert.throws(
    () => validateReview({
      verdict: "pass",
      summary: "bad",
      findings: [{ severity: "high", title: "x", body: "y" }]
    }),
    (error) => error?.code === "E_SCHEMA"
  );
  assert.throws(
    () => validateReview({
      verdict: "needs_changes",
      summary: "ok",
      findings: []
    }),
    (error) => error?.code === "E_SCHEMA"
  );
  assert.deepEqual(REVIEW_SCHEMA.required, ["summary", "findings"]);
});

test("schema failure diagnostics are actionable, bounded, and redacted", () => {
  const secret = "xai-controlplanediagnosticsecret";
  try {
    validateReview({ summary: secret, findings: "nope" });
    assert.fail("expected schema failure");
  } catch (error) {
    assert.equal(error.code, "E_SCHEMA");
    assert.ok(error.details?.hint);
    assert.equal(error.details.findingsShapeOk, false);
    assert.equal(JSON.stringify(error.details).includes(secret), false);
    if (error.details.redactedSnippet) {
      assert.equal(error.details.redactedSnippet.includes(secret), false);
      assert.ok(error.details.redactedSnippet.length <= 400);
    }
  }
});

test("composeProviderPrompt keeps task text out of argv and binds envelope fields", () => {
  const root = initRepo();
  const manifest = captureContextManifest(root);
  const envelope = buildTaskEnvelope({
    userRequest: "literal user request",
    mode: "read",
    contextManifestId: manifest.manifestId
  });
  const prompt = composeProviderPrompt(envelope, { root });
  assert.match(prompt, /literal user request/);
  assert.match(prompt, /Acceptance criteria/);
  assert.match(prompt, new RegExp(manifest.manifestId));
  assert.match(prompt, /Grok Companion constraints/);
});

test("Codex control-plane skill contracts describe host authority and explicit job IDs", () => {
  const rescue = fs.readFileSync(path.join(ROOT, "plugins/grok/skills/rescue/SKILL.md"), "utf8");
  const status = fs.readFileSync(path.join(ROOT, "plugins/grok/skills/status/SKILL.md"), "utf8");
  const result = fs.readFileSync(path.join(ROOT, "plugins/grok/skills/result/SKILL.md"), "utf8");
  assert.match(rescue, /--job-id/);
  assert.match(rescue, /host verification/i);
  assert.match(rescue, /substitute a different worker unless the active fallback policy permits it/i);
  assert.match(rescue, /authoritative verification/i);
  assert.match(rescue, /record-verification/);
  assert.match(rescue, /command\/status\/exit-code/i);
  assert.match(rescue, /commandOutcomes/);
  assert.match(rescue, /passed\|failed|passed" or "failed/i);
  assert.match(rescue, /64 KiB|64\s*KiB/i);
  assert.match(rescue, /at most 64|≤64|64 outcomes/i);
  assert.match(rescue, /fix-and-reverify loop/i);
  assert.match(rescue, /same failure repeats/i);
  assert.match(rescue, /write_stdin/);
  assert.match(rescue, /session ID/i);
  assert.match(rescue, /EOT|frame terminator/i);
  assert.match(rescue, /--stdin-ready/);
  assert.match(rescue, new RegExp(STDIN_READY_MARKER));
  assert.match(rescue, /disables PTY echo/i);
  assert.match(status, /heartbeat|progress/i);
  assert.match(status, /job ID/i);
  assert.match(result, /hostVerification/);
  assert.match(result, /worker report/i);
  assert.match(result, /not_run/);
});

test("rescue skill remediates only the exact missing capability-receipt admission error", () => {
  const rescue = fs.readFileSync(path.join(ROOT, "plugins/grok/skills/rescue/SKILL.md"), "utf8");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const companion = fs.readFileSync(path.join(ROOT, "plugins/grok/scripts/lib/companion-provider-admission.mjs"), "utf8");
  const hostLib = fs.readFileSync(path.join(ROOT, "plugins/grok/scripts/lib/host.mjs"), "utf8");
  const canonicalCodex = missingInvalidProviderCapabilityReceiptMessage({
    CODEX_THREAD_ID: "codex-thread"
  });
  const canonicalClaude = missingInvalidProviderCapabilityReceiptMessage({
    GROK_COMPANION_CLAUDE_SESSION_ID: "claude-session"
  });

  // AC-1: single helper source of truth; the shared gate emitter uses it; skill/docs bind to canonical forms.
  assert.match(hostLib, /export function missingInvalidProviderCapabilityReceiptMessage/);
  assert.equal(companion.split("missingInvalidProviderCapabilityReceiptMessage(").length - 1, 1);
  assert.equal(companion.includes("Valid provider capability receipt is missing or invalid; run"), false);
  assert.equal(
    canonicalCodex,
    "Valid provider capability receipt is missing or invalid; run $grok:setup before admitting a Codex task."
  );
  assert.equal(
    canonicalClaude,
    "Valid provider capability receipt is missing or invalid; run /grok:setup before admitting a Codex task."
  );
  assert.ok(rescue.includes(canonicalCodex));
  assert.ok(readme.includes(canonicalCodex));
  assert.match(rescue, /missingInvalidProviderCapabilityReceiptMessage/);
  assert.match(rescue, /Recoverable exact match only/i);
  assert.match(rescue, /Do \*\*not\*\* auto-setup for arbitrary `E_CAPABILITY`/i);
  assert.match(rescue, /unsupported model, effort, platform, executable identity, provider capability drift/i);
  assert.match(rescue, /sole host-local variable is the setup command token/i);

  // AC-2: setup success → one identical bounded task retry; preserve envelope bounds.
  assert.match(rescue, /authoritative setup action \*\*at most once\*\*/i);
  assert.match(rescue, /node <resolved-grok-codex\.mjs> setup/);
  assert.match(rescue, /Setup success:[\s\S]*?identical\*\* bounded task launch \*\*exactly once\*\*/i);
  assert.match(rescue, /Preserve the original TaskEnvelope/i);
  assert.match(
    rescue,
    /same user request, objective, scope, mode, freshness facts, model, effort, acceptance criteria/i
  );
  assert.match(rescue, /process\/PTY framing, and write profile/i);
  assert.match(rescue, /Do not start a concurrent second process/i);
  assert.match(rescue, /do not re-run setup before or after this single retry/i);

  // AC-3: setup failure surfaces unchanged and stops without task retry or fallback concealment.
  assert.match(
    rescue,
    /Setup failure:[\s\S]*?surface the setup failure unchanged and \*\*stop\*\*/i
  );
  assert.match(rescue, /Do not retry the task[\s\S]*?do not conceal the failure via worker fallback/i);

  // AC-4: persistent receipt error or any non-receipt E_CAPABILITY stays terminal + fallback-eligible.
  assert.match(
    rescue,
    /Persistent receipt error after that one retry[\s\S]*?any non-receipt `E_CAPABILITY`[\s\S]*?\*\*terminal\*\* and eligible for the documented fallback policy/i
  );
  assert.match(rescue, /Do not auto-setup again; do not auto-retry again/i);

  // AC-5 / AC-6 bounds: pre-launch receipt gate; status --readonly is neither capability nor writability.
  assert.match(rescue, /fail-closed pre-launch provider capability receipt gate/i);
  assert.match(
    rescue,
    /Pure `status --readonly` is neither a capability check nor a writability check/i
  );
  assert.match(readme, /pre-launch provider capability receipt gate/i);
  assert.match(
    readme,
    /status --readonly`?\s*is neither a capability check nor a writability check/i
  );
  assert.match(readme, /any other `E_CAPABILITY` message/);
  assert.match(readme, /exact setup-recoverable message only/);
  assert.match(readme, /\*\*Sole setup-recoverable path:\*\*/i);
  assert.match(rescue, /One setup, one identical retry, no duplicate launch/i);
  assert.match(rescue, /E_STORAGE_READONLY/);
});
