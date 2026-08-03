/** Issue #56 worker-mutation request-contract domain. */
import { CompanionError, asErrorPayload } from "./errors.mjs";
import {
  SHA256_HEX,
  digestKey,
  isPlainRecord,
  spawnRequestOwner,
  stableDigest
} from "./worker-mutation-primitives.mjs";

export function stableEnvelopeDigestBinding(envelope) {
  if (!isPlainRecord(envelope)) {
    throw new CompanionError("E_STATE", "Worker spawn envelope is malformed.");
  }
  let userRequestDigest;
  if (typeof envelope.userRequest === "string") {
    userRequestDigest = digestKey(envelope.userRequest);
    if (Object.hasOwn(envelope, "userRequestDigest")
      && envelope.userRequestDigest !== userRequestDigest) {
      throw new CompanionError(
        "E_AUTH_REQUIRED",
        "Worker spawn request text does not match its durable privacy digest."
      );
    }
  } else if (envelope.userRequest === null && SHA256_HEX.test(envelope.userRequestDigest || "")) {
    userRequestDigest = envelope.userRequestDigest;
  } else {
    throw new CompanionError(
      "E_AUTH_REQUIRED",
      "Worker spawn request requires literal text or its valid durable privacy digest."
    );
  }
  const stable = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key === "userRequest" || key === "userRequestDigest" || value === undefined) continue;
    stable[key] = key === "objective"
      && (value === envelope.userRequest || value === userRequestDigest)
      ? userRequestDigest
      : value;
  }
  stable.userRequestDigest = userRequestDigest;
  return stable;
}

export function requestDigest({
  principal,
  controlWorkspaceId,
  executionRoot,
  envelope,
  contextManifest,
  roleId,
  write,
  contextBinding = undefined,
  providerLaunchBindingDigest = undefined
}) {
  return stableDigest({
    owner: spawnRequestOwner(principal),
    controlWorkspaceId,
    executionRoot,
    envelope: stableEnvelopeDigestBinding(envelope),
    contextManifestDigest: contextManifest?.digest || null,
    roleId,
    write: Boolean(write),
    ...(contextBinding === undefined ? {} : { contextBinding }),
    ...(providerLaunchBindingDigest === undefined
      ? {}
      : { providerLaunchBindingDigest })
  });
}
