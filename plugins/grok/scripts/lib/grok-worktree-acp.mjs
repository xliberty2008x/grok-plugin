/**
 * Protocol-only adapter for the official Grok ACP worktree extensions.
 *
 * This module deliberately owns no filesystem cleanup, Git subprocess,
 * provider process, durable journal, or host authority. It only validates and
 * correlates the live-proven Grok extension protocol over an existing
 * AcpClient.
 */

import path from "node:path";

import { CompanionError } from "./errors.mjs";

export const XAI_WORKTREE_CREATE = "x.ai/git/worktree/create";
export const XAI_WORKTREE_REMOVE = "x.ai/git/worktree/remove";
export const XAI_WORKTREE_STATUS = "x.ai/git/worktree/status";
export const XAI_SESSION_CLOSE = "x.ai/session/close";

export const XAI_WORKTREE_CREATE_WIRE = "_x.ai/git/worktree/create";
export const XAI_WORKTREE_REMOVE_WIRE = "_x.ai/git/worktree/remove";
export const XAI_WORKTREE_STATUS_WIRE = "_x.ai/git/worktree/status";
export const XAI_SESSION_CLOSE_WIRE = "_x.ai/session/close";

const LOGICAL_EXTENSION_METHOD = /^x\.ai(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const EXACT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CREATE_RESPONSE_STATUSES = new Set(["creating", "exists"]);
const CREATE_PROGRESS_STATUSES = new Set([
  "progress",
  "analyzing",
  "sourceInfo",
  "copyingChanges"
]);
const CREATE_TERMINAL_STATUSES = new Set(["created", "error", "cancelled"]);

function protocolError(message, details = undefined) {
  return new CompanionError("E_PROTOCOL", message, details);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError(`${label} must be an object.`);
  }
  return value;
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw protocolError(`${label} contains unsupported fields.`, {
      fields: unknown.slice(0, 8)
    });
  }
}

function assertRequiredKeys(value, required, label) {
  const missing = [...required].filter((key) => !Object.hasOwn(value, key));
  if (missing.length) {
    throw protocolError(`${label} is missing required fields.`, {
      fields: missing
    });
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value) {
    throw protocolError(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertOptionalNonEmptyString(value, label) {
  if (value === undefined) return undefined;
  return assertNonEmptyString(value, label);
}

function assertAbsolutePath(value, label) {
  assertNonEmptyString(value, label);
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw protocolError(`${label} must be an absolute path.`);
  }
  return value;
}

function assertExactCommit(value, label = "gitRef") {
  if (typeof value !== "string" || !EXACT_COMMIT.test(value)) {
    throw protocolError(`${label} must be an exact lowercase Git object ID.`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw protocolError(`${label} must be a boolean.`);
  }
  return value;
}

function assertTimeout(timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw protocolError(`${label} timeoutMs must be a positive finite number.`);
  }
  return timeoutMs;
}

function validateSourceGitRoot(value, label) {
  return assertAbsolutePath(value, `${label}.sourceGitRoot`);
}

function validateCopiedChanges(value, label) {
  const object = assertPlainObject(value, label);
  const keys = new Set([
    "stagedCopied",
    "modifiedCopied",
    "untrackedCopied",
    "deletionsApplied",
    "warnings"
  ]);
  assertOnlyKeys(object, keys, label);
  assertRequiredKeys(object, keys, label);
  for (const key of [
    "stagedCopied",
    "modifiedCopied",
    "untrackedCopied",
    "deletionsApplied"
  ]) {
    if (!Number.isSafeInteger(object[key]) || object[key] < 0) {
      throw protocolError(`${label}.${key} must be a non-negative integer.`);
    }
  }
  if (!Array.isArray(object.warnings)
    || object.warnings.some((warning) => typeof warning !== "string")) {
    throw protocolError(`${label}.warnings must be a string array.`);
  }
  return object;
}

function validateDirtyState(value, label) {
  const object = assertPlainObject(value, label);
  const keys = new Set([
    "stagedCount",
    "modifiedCount",
    "deletedCount",
    "untrackedCount",
    "hasPartiallyStaged",
    "skippedDirs"
  ]);
  assertOnlyKeys(object, keys, label);
  assertRequiredKeys(object, keys, label);
  for (const key of [
    "stagedCount",
    "modifiedCount",
    "deletedCount",
    "untrackedCount"
  ]) {
    if (!Number.isSafeInteger(object[key]) || object[key] < 0) {
      throw protocolError(`${label}.${key} must be a non-negative integer.`);
    }
  }
  assertBoolean(object.hasPartiallyStaged, `${label}.hasPartiallyStaged`);
  if (!Array.isArray(object.skippedDirs)
    || object.skippedDirs.some((directory) => typeof directory !== "string")) {
    throw protocolError(`${label}.skippedDirs must be a string array.`);
  }
  return object;
}

/**
 * Map a logical x.ai extension method to the underscore-prefixed ACP wire
 * method used by the installed Grok agent.
 */
export function toWireExtensionMethod(logicalMethod) {
  if (typeof logicalMethod !== "string"
    || !LOGICAL_EXTENSION_METHOD.test(logicalMethod)) {
    throw protocolError("Logical x.ai extension method is invalid.");
  }
  return `_${logicalMethod}`;
}

/**
 * Validate and unwrap the official extension response:
 * `{ result: T | null, error?: string | { code, message, data? } }`.
 */
export function unwrapExtensionResult(envelope) {
  const object = assertPlainObject(envelope, "ACP extension result envelope");
  assertOnlyKeys(object, new Set(["result", "error"]), "ACP extension result envelope");
  assertRequiredKeys(object, new Set(["result"]), "ACP extension result envelope");

  if (Object.hasOwn(object, "error") && object.error != null) {
    if (typeof object.error === "string") {
      if (!object.error) {
        throw protocolError("ACP extension inner error is malformed.");
      }
      throw protocolError(object.error);
    }
    const inner = assertPlainObject(object.error, "ACP extension inner error");
    assertOnlyKeys(inner, new Set(["code", "message", "data"]), "ACP extension inner error");
    assertRequiredKeys(inner, new Set(["code", "message"]), "ACP extension inner error");
    assertNonEmptyString(inner.code, "ACP extension inner error.code");
    assertNonEmptyString(inner.message, "ACP extension inner error.message");
    throw protocolError(inner.message, {
      extensionCode: inner.code,
      ...(Object.hasOwn(inner, "data") ? { data: inner.data } : {})
    });
  }

  return object.result;
}

function validateCreateResponse(result) {
  const object = assertPlainObject(result, "Worktree create result");
  assertOnlyKeys(
    object,
    new Set(["status", "sessionId", "worktreePath", "sourceGitRoot", "commit"]),
    "Worktree create result"
  );
  assertRequiredKeys(
    object,
    new Set(["status", "sessionId", "worktreePath"]),
    "Worktree create result"
  );
  if (!CREATE_RESPONSE_STATUSES.has(object.status)) {
    throw protocolError("Worktree create result status is invalid.");
  }
  const response = {
    status: object.status,
    sessionId: assertNonEmptyString(
      object.sessionId,
      "Worktree create result.sessionId"
    ),
    worktreePath: assertAbsolutePath(
      object.worktreePath,
      "Worktree create result.worktreePath"
    ),
    ...(Object.hasOwn(object, "sourceGitRoot")
      ? {
          sourceGitRoot: validateSourceGitRoot(
            object.sourceGitRoot,
            "Worktree create result"
          )
        }
      : {})
  };
  if (object.status === "exists") {
    assertRequiredKeys(object, new Set(["commit"]), "Worktree create result");
    response.commit = assertExactCommit(
      object.commit,
      "Worktree create result.commit"
    );
  } else if (Object.hasOwn(object, "commit")) {
    throw protocolError("Creating worktree result must not include commit.");
  }
  return Object.freeze(response);
}

function validateWorktreeStatusParams(params) {
  const object = assertPlainObject(params, "Worktree status notification params");
  assertRequiredKeys(
    object,
    new Set(["status", "sessionId"]),
    "Worktree status notification params"
  );
  const status = assertNonEmptyString(
    object.status,
    "Worktree status notification params.status"
  );
  if (!CREATE_PROGRESS_STATUSES.has(status)
    && !CREATE_TERMINAL_STATUSES.has(status)) {
    throw protocolError("Worktree status notification status is invalid.");
  }
  const sessionId = assertNonEmptyString(
    object.sessionId,
    "Worktree status notification params.sessionId"
  );
  const base = { status, sessionId };

  if (status === "progress" || status === "analyzing") {
    assertOnlyKeys(
      object,
      new Set(["status", "sessionId", "message"]),
      "Worktree status notification params"
    );
    assertRequiredKeys(
      object,
      new Set(["message"]),
      "Worktree status notification params"
    );
    return Object.freeze({
      ...base,
      message: assertNonEmptyString(
        object.message,
        "Worktree status notification params.message"
      )
    });
  }

  if (status === "sourceInfo") {
    assertOnlyKeys(
      object,
      new Set([
        "status",
        "sessionId",
        "sourceCommit",
        "sourceBranch",
        "dirtyState"
      ]),
      "Worktree status notification params"
    );
    assertRequiredKeys(
      object,
      new Set(["sourceCommit", "sourceBranch", "dirtyState"]),
      "Worktree status notification params"
    );
    if (object.sourceBranch !== null && typeof object.sourceBranch !== "string") {
      throw protocolError(
        "Worktree status notification params.sourceBranch must be a string or null."
      );
    }
    return Object.freeze({
      ...base,
      sourceCommit: assertExactCommit(
        object.sourceCommit,
        "Worktree status notification params.sourceCommit"
      ),
      sourceBranch: object.sourceBranch,
      dirtyState: validateDirtyState(
        object.dirtyState,
        "Worktree status notification params.dirtyState"
      )
    });
  }

  if (status === "copyingChanges") {
    assertOnlyKeys(
      object,
      new Set([
        "status",
        "sessionId",
        "phase",
        "current",
        "total",
        "currentFile"
      ]),
      "Worktree status notification params"
    );
    assertRequiredKeys(
      object,
      new Set(["phase", "current", "total", "currentFile"]),
      "Worktree status notification params"
    );
    assertNonEmptyString(
      object.phase,
      "Worktree status notification params.phase"
    );
    for (const key of ["current", "total"]) {
      if (!Number.isSafeInteger(object[key]) || object[key] < 0) {
        throw protocolError(
          `Worktree status notification params.${key} must be a non-negative integer.`
        );
      }
    }
    if (object.currentFile !== null && typeof object.currentFile !== "string") {
      throw protocolError(
        "Worktree status notification params.currentFile must be a string or null."
      );
    }
    return Object.freeze({
      ...base,
      phase: object.phase,
      current: object.current,
      total: object.total,
      currentFile: object.currentFile
    });
  }

  if (status === "created") {
    assertOnlyKeys(
      object,
      new Set([
        "status",
        "sessionId",
        "worktreePath",
        "commit",
        "sourceGitRoot",
        "copiedChanges"
      ]),
      "Worktree status notification params"
    );
    assertRequiredKeys(
      object,
      new Set(["worktreePath", "commit"]),
      "Worktree status notification params"
    );
    return Object.freeze({
      ...base,
      worktreePath: assertAbsolutePath(
        object.worktreePath,
        "Worktree status notification params.worktreePath"
      ),
      commit: assertExactCommit(
        object.commit,
        "Worktree status notification params.commit"
      ),
      ...(Object.hasOwn(object, "sourceGitRoot")
        ? {
            sourceGitRoot: validateSourceGitRoot(
              object.sourceGitRoot,
              "Worktree status notification params"
            )
          }
        : {}),
      ...(Object.hasOwn(object, "copiedChanges")
        ? {
            copiedChanges: validateCopiedChanges(
              object.copiedChanges,
              "Worktree status notification params.copiedChanges"
            )
          }
        : {})
    });
  }

  if (status === "error") {
    assertOnlyKeys(
      object,
      new Set(["status", "sessionId", "message"]),
      "Worktree status notification params"
    );
    assertRequiredKeys(
      object,
      new Set(["message"]),
      "Worktree status notification params"
    );
    return Object.freeze({
      ...base,
      message: assertNonEmptyString(
        object.message,
        "Worktree status notification params.message"
      )
    });
  }

  assertOnlyKeys(
    object,
    new Set(["status", "sessionId"]),
    "Worktree status notification params"
  );
  return Object.freeze(base);
}

function validateExpectedCreateIdentity(value, {
  operationId,
  worktreePath,
  gitRef,
  allowCreating
}) {
  if (value.sessionId !== operationId) {
    throw new CompanionError(
      "E_WORKTREE",
      "Worktree operation identity does not match the requested operation.",
      { expectedOperationId: operationId, actualOperationId: value.sessionId }
    );
  }
  if (value.worktreePath !== worktreePath) {
    throw new CompanionError(
      "E_WORKTREE",
      "Worktree path does not match the requested path.",
      { expectedPath: worktreePath, actualPath: value.worktreePath }
    );
  }
  if (!allowCreating && value.commit !== gitRef) {
    throw new CompanionError(
      "E_WORKTREE",
      "Worktree commit does not match the requested commit.",
      { expectedCommit: gitRef, actualCommit: value.commit }
    );
  }
  return value;
}

function validateCloseResult(result) {
  const object = assertPlainObject(result, "Session close result");
  assertOnlyKeys(object, new Set(["success"]), "Session close result");
  assertRequiredKeys(object, new Set(["success"]), "Session close result");
  if (object.success !== true) {
    throw protocolError("Session close result.success must be true.");
  }
  return Object.freeze({ success: true });
}

function validateRemoveResult(result, {
  dryRun,
  expectedWorktreePath = null
}) {
  const object = assertPlainObject(result, "Worktree remove result");
  assertOnlyKeys(object, new Set(["removed", "resolvedPath"]), "Worktree remove result");
  assertRequiredKeys(object, new Set(["removed"]), "Worktree remove result");
  assertBoolean(object.removed, "Worktree remove result.removed");
  if (object.removed === dryRun) {
    throw new CompanionError(
      "E_WORKTREE",
      dryRun
        ? "Official Grok reported removal during a dry run."
        : "Official Grok did not confirm worktree removal."
    );
  }
  const normalized = {
    removed: object.removed,
    ...(Object.hasOwn(object, "resolvedPath")
      ? {
          resolvedPath: assertAbsolutePath(
            object.resolvedPath,
            "Worktree remove result.resolvedPath"
          )
        }
      : {})
  };
  if (expectedWorktreePath !== null
    && normalized.resolvedPath !== expectedWorktreePath) {
    throw new CompanionError(
      "E_WORKTREE",
      "Official Grok removed a different worktree path.",
      {
        expectedPath: expectedWorktreePath,
        actualPath: normalized.resolvedPath ?? null
      }
    );
  }
  return Object.freeze(normalized);
}

export class GrokWorktreeAcp {
  constructor(client, { timeoutMs = 30000 } = {}) {
    if (!client
      || typeof client.request !== "function"
      || typeof client.on !== "function"
      || typeof client.off !== "function") {
      throw protocolError("GrokWorktreeAcp requires an ACP event client.");
    }
    this.client = client;
    this.timeoutMs = assertTimeout(timeoutMs, "GrokWorktreeAcp");
  }

  async extensionRequest(
    logicalMethod,
    params = {},
    { timeoutMs = this.timeoutMs } = {}
  ) {
    const wireMethod = toWireExtensionMethod(logicalMethod);
    assertTimeout(timeoutMs, logicalMethod);
    if (this.client.closed) {
      throw protocolError("ACP transport is closed.");
    }
    const envelope = await this.client.request(wireMethod, params, timeoutMs);
    return unwrapExtensionResult(envelope);
  }

  /**
   * Create one clean Git worktree at an exact commit.
   *
   * The status listener is attached before request dispatch. Notifications are
   * correlated to the caller-selected operationId, so malformed or terminal
   * events from another concurrent operation cannot poison this operation.
   */
  async create({
    operationId,
    sourcePath,
    worktreePath,
    gitRef,
    label,
    timeoutMs = this.timeoutMs
  } = {}) {
    const expectedOperationId = assertNonEmptyString(operationId, "operationId");
    const expectedSourcePath = assertAbsolutePath(sourcePath, "sourcePath");
    const expectedWorktreePath = assertAbsolutePath(worktreePath, "worktreePath");
    const expectedGitRef = assertExactCommit(gitRef);
    const expectedLabel = assertOptionalNonEmptyString(label, "label");
    assertTimeout(timeoutMs, XAI_WORKTREE_CREATE);
    if (this.client.closed) {
      throw protocolError("ACP transport is closed.");
    }

    const request = {
      sessionId: expectedOperationId,
      sourcePath: expectedSourcePath,
      worktreePath: expectedWorktreePath,
      copyMode: "clean",
      gitRef: expectedGitRef,
      copyIgnoredInBackground: false,
      ignoredSkipPatterns: [],
      worktreeType: "git",
      ...(expectedLabel === undefined ? {} : { label: expectedLabel })
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let createResponse = null;
      let terminalCreated = null;

      const cleanup = () => {
        clearTimeout(timer);
        this.client.off("notification", onNotification);
        this.client.off("closed", onClosed);
      };

      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };

      const maybeResolve = () => {
        if (!createResponse || settled) return;
        if (createResponse.status === "exists") {
          // A replay may observe the exact worktree after the in-progress
          // marker is cleared but while the original created notification is
          // still in flight. Both branches have already been bound to the same
          // operation, path, and commit, so the richer created receipt wins.
          settle(null, terminalCreated || createResponse);
          return;
        }
        if (terminalCreated) settle(null, terminalCreated);
      };

      const onNotification = (notification) => {
        if (settled
          || !notification
          || typeof notification !== "object"
          || (
            notification.method !== XAI_WORKTREE_STATUS_WIRE
            && notification.method !== XAI_WORKTREE_STATUS
          )) {
          return;
        }

        const params = notification.params;
        // Only an exact operation ID makes this notification ours. A malformed
        // or terminal event from another worker must not affect this operation.
        if (!params
          || typeof params !== "object"
          || Array.isArray(params)
          || params.sessionId !== expectedOperationId) {
          return;
        }

        let status;
        try {
          status = validateWorktreeStatusParams(params);
        } catch (error) {
          settle(
            error instanceof CompanionError
              ? error
              : protocolError(error?.message || "Worktree status is malformed.")
          );
          return;
        }

        if (CREATE_PROGRESS_STATUSES.has(status.status)) return;
        if (status.status === "error") {
          settle(new CompanionError(
            "E_WORKTREE",
            status.message,
            { operationId: expectedOperationId }
          ));
          return;
        }
        if (status.status === "cancelled") {
          settle(new CompanionError(
            "E_CANCELLED",
            "Official Grok worktree creation was cancelled.",
            { operationId: expectedOperationId }
          ));
          return;
        }
        if (terminalCreated) {
          settle(protocolError(
            "Worktree create emitted more than one terminal created notification."
          ));
          return;
        }
        try {
          terminalCreated = validateExpectedCreateIdentity(status, {
            operationId: expectedOperationId,
            worktreePath: expectedWorktreePath,
            gitRef: expectedGitRef,
            allowCreating: false
          });
        } catch (error) {
          settle(error);
          return;
        }
        maybeResolve();
      };

      const onClosed = (error) => {
        settle(
          error instanceof CompanionError
            ? error
            : protocolError("ACP transport closed during worktree creation.")
        );
      };

      const timer = setTimeout(() => {
        settle(new CompanionError(
          "E_TIMEOUT",
          `${XAI_WORKTREE_CREATE} timed out.`
        ));
      }, timeoutMs);

      // Attach both lifecycle listeners before request() writes any bytes.
      this.client.on("notification", onNotification);
      this.client.on("closed", onClosed);

      this.extensionRequest(
        XAI_WORKTREE_CREATE,
        request,
        { timeoutMs }
      ).then((result) => {
        if (settled) return;
        let validated;
        try {
          validated = validateCreateResponse(result);
          validateExpectedCreateIdentity(validated, {
            operationId: expectedOperationId,
            worktreePath: expectedWorktreePath,
            gitRef: expectedGitRef,
            allowCreating: validated.status === "creating"
          });
        } catch (error) {
          settle(
            error instanceof CompanionError
              ? error
              : protocolError(error?.message || "Worktree create result is malformed.")
          );
          return;
        }
        createResponse = validated;
        maybeResolve();
      }).catch((error) => {
        settle(
          error instanceof CompanionError
            ? error
            : protocolError(error?.message || "Worktree create request failed.")
        );
      });
    });
  }

  async close({ sessionId, timeoutMs = this.timeoutMs } = {}) {
    const id = assertNonEmptyString(sessionId, "sessionId");
    const result = await this.extensionRequest(
      XAI_SESSION_CLOSE,
      { sessionId: id },
      { timeoutMs }
    );
    return validateCloseResult(result);
  }

  async remove({
    worktreePath,
    idOrPath,
    force = false,
    dryRun = false,
    timeoutMs = this.timeoutMs
  } = {}) {
    const hasWorktreePath = worktreePath !== undefined;
    const hasIdOrPath = idOrPath !== undefined;
    if (hasWorktreePath === hasIdOrPath) {
      throw protocolError(
        "Worktree remove requires exactly one of worktreePath or idOrPath."
      );
    }
    assertBoolean(force, "force");
    assertBoolean(dryRun, "dryRun");
    const identifier = hasWorktreePath
      ? {
          worktreePath: assertAbsolutePath(worktreePath, "worktreePath")
        }
      : {
          idOrPath: assertNonEmptyString(idOrPath, "idOrPath")
        };
    const result = await this.extensionRequest(
      XAI_WORKTREE_REMOVE,
      {
        ...identifier,
        force,
        dryRun
      },
      { timeoutMs }
    );
    return validateRemoveResult(result, {
      dryRun,
      expectedWorktreePath: hasWorktreePath ? identifier.worktreePath : null
    });
  }
}

export default GrokWorktreeAcp;
