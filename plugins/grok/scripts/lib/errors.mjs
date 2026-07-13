export class CompanionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CompanionError";
    this.code = code;
    this.details = details;
  }
}

export function asErrorPayload(error) {
  return {
    code: error?.code || "E_PROVIDER_EXIT",
    message: error?.message || String(error),
    ...(error?.details === undefined ? {} : { details: error.details })
  };
}

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, PREREQ: 3, PROVIDER: 4, VALIDATION: 5, CANCELLED: 6, SAFETY: 7 });

export function exitCodeFor(error) {
  if (error?.code === "E_USAGE") return EXIT.USAGE;
  if (["E_GIT_REQUIRED", "E_GROK_NOT_FOUND", "E_GROK_VERSION", "E_AUTH_REQUIRED", "E_CAPABILITY", "E_POLICY"].includes(error?.code)) return EXIT.PREREQ;
  if (["E_SCHEMA", "E_IMPORT_SOURCE", "E_IMPORT_RESULT", "E_JOB_NOT_FOUND", "E_JOB_ACTIVE", "E_NO_RESUME_CANDIDATE"].includes(error?.code)) return EXIT.VALIDATION;
  if (error?.code === "E_CANCELLED") return EXIT.CANCELLED;
  if (["E_RECURSION", "E_REVIEW_MUTATED_WORKSPACE", "E_PROCESS_IDENTITY"].includes(error?.code)) return EXIT.SAFETY;
  return EXIT.PROVIDER;
}
