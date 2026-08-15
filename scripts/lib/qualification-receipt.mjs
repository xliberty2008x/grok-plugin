import fs from "node:fs";
import path from "node:path";

import {
  createPluginInventory,
  digestInventory,
  digestRegularFile
} from "./plugin-inventory.mjs";

export const QUALIFICATION_RECEIPT_SCHEMA = 1;
export const QUALIFICATION_RECEIPT_RELATIVE_PATH = path.posix.join(
  ".qualification",
  "receipt.json"
);

export function qualificationReceiptPath(root) {
  return path.join(root, ".qualification", "receipt.json");
}

export function collectInstallIdentity(root) {
  const sourcePlugin = path.join(root, "plugins", "grok");
  const packagePath = path.join(root, "package.json");
  const marketplacePath = path.join(root, ".agents", "plugins", "marketplace.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const sourceEntries = createPluginInventory(sourcePlugin);
  return Object.freeze({
    version: String(packageJson.version),
    sourceEntries,
    sourceDigest: digestInventory(sourceEntries),
    packageDigest: digestRegularFile(packagePath),
    marketplaceDigest: digestRegularFile(marketplacePath),
    fileCount: sourceEntries.length
  });
}

export function buildQualificationReceipt(identity, extras = {}) {
  if (!identity || typeof identity.version !== "string" || identity.version.length < 1) {
    throw new Error("Qualification receipt requires a package version.");
  }
  if (!/^[0-9a-f]{64}$/.test(identity.sourceDigest)) {
    throw new Error("Qualification receipt requires a 64-hex source digest.");
  }
  if (!/^[0-9a-f]{64}$/.test(identity.packageDigest)) {
    throw new Error("Qualification receipt requires a 64-hex package digest.");
  }
  if (!/^[0-9a-f]{64}$/.test(identity.marketplaceDigest)) {
    throw new Error("Qualification receipt requires a 64-hex marketplace digest.");
  }
  if (!Number.isSafeInteger(identity.fileCount) || identity.fileCount < 1) {
    throw new Error("Qualification receipt requires a positive file count.");
  }
  return Object.freeze({
    schema_version: QUALIFICATION_RECEIPT_SCHEMA,
    version: identity.version,
    created_at: extras.createdAt ?? new Date().toISOString(),
    source_digest: identity.sourceDigest,
    package_digest: identity.packageDigest,
    marketplace_digest: identity.marketplaceDigest,
    file_count: identity.fileCount,
    check_command: extras.checkCommand ?? "npm run check"
  });
}

export function readQualificationReceipt(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No qualification receipt at ${filePath}. Run \`npm run qualify\` for these exact bytes before installing.`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Qualification receipt is not valid JSON: ${filePath}`);
  }
  if (
    !parsed
    || parsed.schema_version !== QUALIFICATION_RECEIPT_SCHEMA
    || typeof parsed.version !== "string"
    || !/^[0-9a-f]{64}$/.test(parsed.source_digest)
    || !/^[0-9a-f]{64}$/.test(parsed.package_digest)
    || !/^[0-9a-f]{64}$/.test(parsed.marketplace_digest)
    || !Number.isSafeInteger(parsed.file_count)
    || parsed.file_count < 1
  ) {
    throw new Error(`Qualification receipt is malformed: ${filePath}`);
  }
  return parsed;
}

export function assertReceiptMatchesIdentity(receipt, identity) {
  if (receipt.version !== identity.version) {
    throw new Error(
      `Qualification receipt version ${receipt.version} does not match source ${identity.version}. Run \`npm run qualify\`.`
    );
  }
  if (receipt.source_digest !== identity.sourceDigest) {
    throw new Error(
      "Qualification receipt does not match the current plugin inventory. Run `npm run qualify`."
    );
  }
  if (receipt.package_digest !== identity.packageDigest) {
    throw new Error(
      "Qualification receipt does not match package.json. Run `npm run qualify`."
    );
  }
  if (receipt.marketplace_digest !== identity.marketplaceDigest) {
    throw new Error(
      "Qualification receipt does not match marketplace metadata. Run `npm run qualify`."
    );
  }
  if (receipt.file_count !== identity.fileCount) {
    throw new Error(
      "Qualification receipt file count does not match the current plugin inventory. Run `npm run qualify`."
    );
  }
}

export function writeQualificationReceiptAtomic(filePath, receipt) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}
