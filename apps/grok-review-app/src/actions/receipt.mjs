/**
 * Runner-side receipt signing. The private Ed25519 key is used only after the
 * bounded review has completed; the Worker independently verifies the result.
 */

import {
  RECEIPT_SIGNATURE_ALGORITHM,
  canonicalJson,
  computeReceiptDigest,
  receiptKeyId,
  validateSanitizedReceipt,
  verifyReceiptEnvelope
} from "../receipt-contract.mjs";

function signingError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function pemToPkcs8(pem) {
  if (typeof pem !== "string" || pem.length > 32 * 1024) {
    throw signingError("invalid_receipt_private_key");
  }
  const normalized = pem.replace(/\r\n/g, "\n").trim();
  const match = /^-----BEGIN PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END PRIVATE KEY-----$/.exec(
    normalized
  );
  if (!match) throw signingError("invalid_receipt_private_key");
  const base64 = match[1].replace(/\n/g, "");
  try {
    if (typeof Buffer !== "undefined") {
      const bytes = new Uint8Array(Buffer.from(base64, "base64"));
      if (bytes.byteLength === 0) throw signingError("invalid_receipt_private_key");
      return bytes;
    }
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength === 0) throw signingError("invalid_receipt_private_key");
    return bytes;
  } catch (error) {
    if (error?.code) throw error;
    throw signingError("invalid_receipt_private_key");
  }
}

function bytesToBase64Url(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {{
 *   receipt: object,
 *   privateKeyPem: string,
 *   publicKeyPem: string
 * }} input
 * @returns {Promise<{ receipt: object, envelope: {
 *   alg: "Ed25519", kid: string, receipt_sha256: string, signature: string
 * } }>}
 */
export async function signReceipt(input) {
  const validation = validateSanitizedReceipt(input?.receipt);
  if (!validation.ok) throw signingError(validation.reason);

  const privateDer = pemToPkcs8(input.privateKeyPem);
  let privateKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateDer,
      { name: RECEIPT_SIGNATURE_ALGORITHM },
      false,
      ["sign"]
    );
  } catch {
    throw signingError("invalid_receipt_private_key_type");
  }
  if (privateKey.algorithm?.name !== RECEIPT_SIGNATURE_ALGORITHM) {
    throw signingError("invalid_receipt_private_key_type");
  }

  const kid = await receiptKeyId(input.publicKeyPem);
  const canonical = canonicalJson(validation.receipt);
  const bytes = new TextEncoder().encode(canonical);
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign(
      { name: RECEIPT_SIGNATURE_ALGORITHM },
      privateKey,
      bytes
    )
  );
  if (signatureBytes.byteLength !== 64) {
    throw signingError("invalid_receipt_signature");
  }

  const envelope = {
    alg: RECEIPT_SIGNATURE_ALGORITHM,
    kid,
    receipt_sha256: await computeReceiptDigest(validation.receipt),
    signature: bytesToBase64Url(signatureBytes)
  };

  // Fail closed if the configured public key does not match the private key.
  const verified = await verifyReceiptEnvelope(
    validation.receipt,
    envelope,
    JSON.stringify({ [kid]: input.publicKeyPem })
  );
  if (!verified.ok) throw signingError("receipt_key_pair_mismatch");

  return { receipt: validation.receipt, envelope };
}

export const signSanitizedReceipt = signReceipt;
