export class CompanionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CompanionError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Attach transfer cleanup evidence to a primary error without replacing its code/message.
 * When a private converted transcript or import alias may remain, set privacyWarning.
 */
export function attachTransferCleanupEvidence(error, cleanupWarnings, { privacy = false } = {}) {
  const warnings = (Array.isArray(cleanupWarnings) ? cleanupWarnings : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!warnings.length) return error;
  const text = warnings.join("; ");
  const baseDetails = error?.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? { ...error.details }
    : {};
  const append = (prior) => (prior ? `${prior}; ${text}` : text);
  baseDetails.warning = append(baseDetails.warning);
  if (privacy) baseDetails.privacyWarning = append(baseDetails.privacyWarning);
  if (error instanceof CompanionError) {
    error.details = baseDetails;
    return error;
  }
  if (error && typeof error === "object") {
    error.details = baseDetails;
    return error;
  }
  return new CompanionError("E_PROVIDER_EXIT", String(error), baseDetails);
}

export function asErrorPayload(error) {
  return {
    code: error?.code || "E_PROVIDER_EXIT",
    message: error?.message || String(error),
    ...(error?.details === undefined ? {} : { details: error.details })
  };
}

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, PREREQ: 3, PROVIDER: 4, VALIDATION: 5, CANCELLED: 6, SAFETY: 7 });

/** Node/OS errors that mean the control store cannot accept durable writes. */
export function isStorageCapabilityError(error) {
  return Boolean(error && ["EPERM", "EACCES", "EROFS"].includes(error.code));
}

/**
 * Sanitized prerequisite error for unwritable plugin state storage.
 * Never embed private absolute state paths in the public payload.
 */
export function storageReadonlyError(cause = undefined) {
  const capability = cause && typeof cause.code === "string" ? cause.code : undefined;
  return new CompanionError(
    "E_STORAGE_READONLY",
    "Plugin state storage is not writable. Ensure the plugin data directory is owned by this user, is on writable media, and allows private mode 0700 state directories; then retry.",
    capability ? { capability } : undefined
  );
}

/** Remap EPERM/EACCES/EROFS to E_STORAGE_READONLY; rethrow everything else unchanged. */
export function rethrowStorageCapability(error) {
  if (error instanceof CompanionError) throw error;
  if (isStorageCapabilityError(error)) throw storageReadonlyError(error);
  throw error;
}

export function exitCodeFor(error) {
  if (error?.code === "E_USAGE") return EXIT.USAGE;
  if (["E_GIT_REQUIRED", "E_GROK_NOT_FOUND", "E_GROK_VERSION", "E_AUTH_REQUIRED", "E_CAPABILITY", "E_POLICY", "E_STORAGE_READONLY"].includes(error?.code)) return EXIT.PREREQ;
  if (["E_SCHEMA", "E_IMPORT_SOURCE", "E_IMPORT_RESULT", "E_JOB_NOT_FOUND", "E_JOB_ACTIVE", "E_NO_RESUME_CANDIDATE", "E_CONTEXT_DRIFT", "E_CONTEXT_INCOMPLETE", "E_INPUT_READ", "E_INPUT_TIMEOUT"].includes(error?.code)) return EXIT.VALIDATION;
  if (error?.code === "E_CANCELLED") return EXIT.CANCELLED;
  if (["E_RECURSION", "E_REVIEW_MUTATED_WORKSPACE", "E_PROCESS_IDENTITY", "E_SCOPE_VIOLATION"].includes(error?.code)) return EXIT.SAFETY;
  return EXIT.PROVIDER;
}
