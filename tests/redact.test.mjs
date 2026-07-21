import assert from "node:assert/strict";
import test from "node:test";

import {
  redact,
  redactText,
  sanitizeDisplayText
} from "../plugins/grok/scripts/lib/redact.mjs";

const GITHUB_TOKEN_CANARY = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz", "1234567890"].join("");
const POSTGRES_CANARY = [
  "post",
  "gresql",
  "://",
  "worker",
  ":",
  "hunter2",
  "@",
  "db.example.test",
  "/app"
].join("");
const REDACTED_POSTGRES = [
  "post",
  "gresql",
  "://",
  "worker",
  ":",
  "[REDACTED]",
  "@",
  "db.example.test",
  "/app"
].join("");

const SECRET_CANARIES = [
  "xai-abcdefghijklmnop",
  GITHUB_TOKEN_CANARY,
  "AKIAIOSFODNN7EXAMPLE",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
  "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----"
];

test("text redaction covers token, private-key, DSN, and assignment formats", () => {
  const input = [
    ...SECRET_CANARIES,
    "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    POSTGRES_CANARY,
    "password=correct-horse-battery-staple",
    "{\"password\":\"hunter2\"}",
    "password=\"correct horse battery staple\"",
    "GITHUB_TOKEN=github-env-canary",
    "DATABASE_PASSWORD=database-env-canary",
    "MY_API_KEY=api-env-canary",
    "HTTP_AUTHORIZATION=Basic authorization-env-canary",
    "clientSecret=camel-secret",
    "githubToken=camel-token",
    "dbPassword=camel-password",
    "accessToken=camel-access"
  ].join("\n");
  const output = redactText(input);
  for (const secret of SECRET_CANARIES) assert.equal(output.includes(secret), false);
  for (const secretPart of [
    "EXAMPLEKEY",
    "hunter2",
    "correct-horse-battery-staple",
    "correct horse battery staple",
    "github-env-canary",
    "database-env-canary",
    "api-env-canary",
    "authorization-env-canary",
    "camel-secret",
    "camel-token",
    "camel-password",
    "camel-access"
  ]) {
    assert.equal(output.includes(secretPart), false);
  }
  assert.ok(output.includes(REDACTED_POSTGRES));
});

test("structured and display redaction remain recursive and control-safe", () => {
  const value = {
    safe: "public",
    password: "secret-value",
    token: "opaque-value",
    nested: { note: SECRET_CANARIES[1] }
  };
  assert.deepEqual(redact(value), {
    safe: "public",
    password: "[REDACTED]",
    token: "[REDACTED]",
    nested: { note: "[REDACTED]" }
  });
  assert.equal(sanitizeDisplayText(`ok\u001b[31m ${SECRET_CANARIES[0]}`), "ok [REDACTED]");
});

test("structured redaction removes untrusted tokens while retaining numeric usage counters", () => {
  const value = redact({
    process: { pid: 123, startToken: "Wed Jul 16 12:35:43 2026" },
    token: "plain-secret",
    githubToken: "github-secret",
    GITHUB_TOKEN: "environment-secret",
    usage: { inputTokens: 12, output_tokens: 7, tokenCount: 19, cachedTokens: "not-a-counter" }
  });

  assert.equal(value.process.startToken, "[REDACTED]");
  assert.equal(value.token, "[REDACTED]");
  assert.equal(value.githubToken, "[REDACTED]");
  assert.equal(value.GITHUB_TOKEN, "[REDACTED]");
  assert.deepEqual(value.usage, {
    inputTokens: 12,
    output_tokens: 7,
    tokenCount: 19,
    cachedTokens: "[REDACTED]"
  });
});
