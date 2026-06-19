import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceSigner, evidenceEtag } from "./evidence-signer.js";

test("evidence signer creates verifiable Ed25519 envelopes", () => {
  const signer = createEvidenceSigner({ production: false });
  const payload = { score: 82, snapshotId: "snapshot-1" };
  const signature = signer.sign(payload);
  assert.equal(signer.algorithm, "Ed25519");
  assert.equal(signer.ephemeral, true);
  assert.equal(signer.verify(payload, signature), true);
  assert.equal(signer.verify({ ...payload, score: 83 }, signature), false);
});

test("production signing requires a stable Ed25519 private key", () => {
  assert.throws(() => createEvidenceSigner({ privateKey: "", production: true }), /required_in_production/);
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const signer = createEvidenceSigner({ privateKey: pem, production: true });
  assert.equal(signer.ephemeral, false);
  assert.equal(signer.verify({ ok: true }, signer.sign({ ok: true })), true);
});

test("evidence ETag changes on signing-key rotation even when payload is unchanged", () => {
  const payload = { snapshotId: "same-snapshot", score: 79 };
  assert.notEqual(evidenceEtag(payload, "key-a"), evidenceEtag(payload, "key-b"));
  assert.equal(evidenceEtag(payload, "key-a"), evidenceEtag(payload, "key-a"));
});
