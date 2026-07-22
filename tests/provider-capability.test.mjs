import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  MCP_CAPABILITY_CONTRACT_VERSION,
  ROOT_READ_PROVIDER_CAPABILITY,
  clearProviderCapabilityReceipt,
  readValidProviderCapabilityReceipt,
  writeProviderCapabilityReceipt
} from "../plugins/grok/scripts/lib/provider-capability.mjs";
import { installFakeGrok } from "./fake-grok.mjs";
import { ROOT, tempDir } from "./helpers.mjs";

const RECEIPT_RELATIVE_PATH = path.join("capabilities", "provider-capability-v1.json");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fixture() {
  const fake = installFakeGrok(tempDir("grok-provider-capability-bin-"));
  const pluginData = tempDir("grok-provider-capability-data-");
  const env = {
    HOME: path.dirname(pluginData),
    PLUGIN_DATA: pluginData,
    GROK_BIN: fake.binary,
    GROK_COMPANION_HOST: "codex"
  };
  const runtime = {
    binary: fake.binary,
    version: "0.2.99",
    authenticated: true,
    protocolVersion: 1,
    loadSession: true,
    acpIsolation: {
      isolated: true,
      unattendedPrivilegeExpansion: false,
      agentProfileDigest: sha256(path.join(ROOT, "plugins/grok/provider-agents/setup-probe.md"))
    }
  };
  return { fake, pluginData, env, runtime, receiptFile: path.join(pluginData, RECEIPT_RELATIVE_PATH) };
}

test("provider capability receipt is private, body-free, tamper-evident, and durably clearable", (t) => {
  const { env, runtime, receiptFile, fake } = fixture();
  const issuedAt = Date.parse("2026-07-23T10:00:00.000Z");
  const receipt = writeProviderCapabilityReceipt({ runtime, env, clock: () => issuedAt });

  assert.deepEqual(receipt.capabilities, [ROOT_READ_PROVIDER_CAPABILITY]);
  assert.match(receipt.capabilityDigest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.mcpCapabilityContractVersion, MCP_CAPABILITY_CONTRACT_VERSION);
  assert.equal(fs.lstatSync(receiptFile).mode & 0o077, 0);
  const serialized = fs.readFileSync(receiptFile, "utf8");
  for (const forbidden of [fake.binary, "auth", "credential", "prompt", "models"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const observed = readValidProviderCapabilityReceipt({
    env,
    clock: () => issuedAt + 1000
  });
  assert.equal(observed?.capabilityDigest, receipt.capabilityDigest);

  const stored = JSON.parse(serialized);
  stored.providerVersion = "9.9.9";
  fs.writeFileSync(receiptFile, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  assert.equal(readValidProviderCapabilityReceipt({ env, clock: () => issuedAt + 1000 }), null);

  writeProviderCapabilityReceipt({ runtime, env, clock: () => issuedAt });
  let directoryFsyncObserved = process.platform === "win32";
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = (descriptor) => {
    if (fs.fstatSync(descriptor).isDirectory()) directoryFsyncObserved = true;
    return originalFsync(descriptor);
  };
  t.after(() => { fs.fsyncSync = originalFsync; });
  assert.equal(clearProviderCapabilityReceipt({ env }), true);
  assert.equal(fs.existsSync(receiptFile), false);
  assert.equal(readValidProviderCapabilityReceipt({ env, clock: () => issuedAt + 1000 }), null);
  assert.equal(directoryFsyncObserved, true);
  assert.equal(clearProviderCapabilityReceipt({ env }), false);
});

test("provider capability receipt fails closed on expiry and every bound identity drift", () => {
  const { env, runtime } = fixture();
  const issuedAt = Date.parse("2026-07-23T10:00:00.000Z");
  const receipt = writeProviderCapabilityReceipt({ runtime, env, clock: () => issuedAt, ttlMs: 60_000 });
  const validOptions = { env, clock: () => issuedAt + 1000 };
  assert.ok(readValidProviderCapabilityReceipt(validOptions));

  const driftCases = [
    { clock: () => issuedAt + 60_000 },
    { pluginVersion: "0.3.0-drift" },
    { mcpCapabilityContractVersion: "999.0.0" },
    { platform: `${process.platform}-drift` },
    { architecture: `${process.arch}-drift` },
    { setupProfileDigest: "a".repeat(64) },
    { rootReadProfileDigest: "b".repeat(64) },
    { resolveVersion: () => "9.9.9" }
  ];
  for (const drift of driftCases) {
    assert.equal(
      readValidProviderCapabilityReceipt({ ...validOptions, ...drift }),
      null,
      JSON.stringify(Object.keys(drift))
    );
  }

  assert.equal(receipt.mcpCapabilityContractVersion, MCP_CAPABILITY_CONTRACT_VERSION);
});

test("provider file replacement invalidates the capability receipt", () => {
  const { env, runtime, fake } = fixture();
  const observedAt = Date.now();
  writeProviderCapabilityReceipt({ runtime, env, clock: () => observedAt });
  assert.ok(readValidProviderCapabilityReceipt({ env, clock: () => observedAt + 1 }));
  fs.appendFileSync(fake.binary, "\n// provider identity drift\n");
  assert.equal(readValidProviderCapabilityReceipt({ env, clock: () => observedAt + 2 }), null);
});
