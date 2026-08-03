import { CompanionError } from "./errors.mjs";
import { missingInvalidProviderCapabilityReceiptMessage } from "./host.mjs";
import { readValidProviderCapabilityReceipt } from "./provider-capability.mjs";
import {
  assertProviderLaunchBinding as assertExecutableProviderLaunchBinding,
  providerLaunchBindingDigest as digestProviderLaunchBinding
} from "./provider-executable-pin.mjs";

function invalidProviderCapabilityError() {
  return new CompanionError(
    "E_CAPABILITY",
    missingInvalidProviderCapabilityReceiptMessage()
  );
}

function requiredProviderSpawnBinding() {
  const capabilityReceipt = readValidProviderCapabilityReceipt();
  if (!capabilityReceipt) {
    throw invalidProviderCapabilityError();
  }
  const providerLaunchBinding = assertExecutableProviderLaunchBinding(
    capabilityReceipt.providerLaunchBinding
  );
  const providerLaunchBindingDigest = digestProviderLaunchBinding(
    providerLaunchBinding
  );
  if (providerLaunchBindingDigest !== capabilityReceipt.providerLaunchBindingDigest) {
    throw invalidProviderCapabilityError();
  }
  return Object.freeze({
    providerCapabilityDigest: capabilityReceipt.capabilityDigest,
    providerLaunchBinding,
    providerLaunchBindingDigest
  });
}

export { invalidProviderCapabilityError, requiredProviderSpawnBinding };
