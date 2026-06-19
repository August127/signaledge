import crypto from "node:crypto";

function decodePrivateKey(value) {
  if (!value) return null;
  const normalized = value.includes("BEGIN PRIVATE KEY")
    ? value.replaceAll("\\n", "\n")
    : Buffer.from(value, "base64").toString("utf8");
  return crypto.createPrivateKey(normalized);
}

export function createEvidenceSigner({
  privateKey = process.env.EVIDENCE_PRIVATE_KEY ?? process.env.EVIDENCE_PRIVATE_KEY_B64,
  production = process.env.NODE_ENV === "production",
} = {}) {
  let privateKeyObject = decodePrivateKey(privateKey);
  let ephemeral = false;
  if (!privateKeyObject) {
    if (production) throw new Error("EVIDENCE_PRIVATE_KEY_required_in_production");
    privateKeyObject = crypto.generateKeyPairSync("ed25519").privateKey;
    ephemeral = true;
  }
  if (privateKeyObject.asymmetricKeyType !== "ed25519") throw new Error("EVIDENCE_PRIVATE_KEY_must_be_ed25519");
  const publicKeyObject = crypto.createPublicKey(privateKeyObject);
  const publicDer = publicKeyObject.export({ format: "der", type: "spki" });
  const keyId = crypto.createHash("sha256").update(publicDer).digest("base64url").slice(0, 24);

  return {
    algorithm: "Ed25519",
    keyId,
    ephemeral,
    publicJwk: publicKeyObject.export({ format: "jwk" }),
    sign(payload) {
      const serialized = JSON.stringify(payload);
      return crypto.sign(null, Buffer.from(serialized), privateKeyObject).toString("base64url");
    },
    verify(payload, signature) {
      return crypto.verify(null, Buffer.from(JSON.stringify(payload)), publicKeyObject, Buffer.from(signature, "base64url"));
    },
  };
}

export function evidenceEtag(payload, keyId) {
  return `"${crypto.createHash("sha256").update(`${keyId}:${JSON.stringify(payload)}`).digest("base64url").slice(0, 24)}"`;
}
