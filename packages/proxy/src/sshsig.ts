import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";

// SSHSIG: sign a message the way OpenSSH's `ssh-keygen -Y sign` does, so a
// signature this module produces is byte-for-byte what git would attach to a
// commit — which is what makes GitHub report the commit `verified` (issue
// #120). Spec: OpenSSH PROTOCOL.sshsig. Fixed to git's parameters: namespace
// "git", hash "sha512", key type ssh-ed25519.
const NAMESPACE = "git";
const HASH_ALG = "sha512";

/** SSH wire `string`: a uint32 big-endian length followed by the raw bytes. */
function sshString(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/** Sequential reader over an SSH wire buffer (uint32 + length-prefixed strings). */
function sshReader(buf: Buffer) {
  let offset = 0;
  return {
    uint32(): number {
      const v = buf.readUInt32BE(offset);
      offset += 4;
      return v;
    },
    string(): Buffer {
      const n = buf.readUInt32BE(offset);
      offset += 4;
      const s = buf.subarray(offset, offset + n);
      offset += n;
      return s;
    },
  };
}

// PKCS#8 DER prefix for an Ed25519 private key: the fixed ASN.1 header up to
// (and including) the inner OCTET STRING tag/length, after which come the 32
// raw seed bytes. node cannot import the OpenSSH private-key format directly
// (ERR_OSSL_UNSUPPORTED), so we extract the seed and re-wrap it as PKCS#8,
// which node imports.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const OPENSSH_MAGIC = "openssh-key-v1\0";

/** Extract the 32-byte seed and 32-byte public key from an unencrypted OpenSSH
 *  ed25519 private key. Throws on anything else (encrypted, non-ed25519,
 *  malformed) so a misconfiguration fails loudly instead of producing a
 *  signature that will not verify. */
function parseOpenSshEd25519(pem: string): { seed: Buffer; publicKey: Buffer } {
  const body = pem
    .replace("-----BEGIN OPENSSH PRIVATE KEY-----", "")
    .replace("-----END OPENSSH PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const bin = Buffer.from(body, "base64");
  if (bin.subarray(0, OPENSSH_MAGIC.length).toString("latin1") !== OPENSSH_MAGIC) {
    throw new Error("not an OpenSSH private key");
  }
  const r = sshReader(bin.subarray(OPENSSH_MAGIC.length));
  const cipher = r.string().toString();
  const kdf = r.string().toString();
  r.string(); // kdfoptions
  const keyCount = r.uint32();
  if (cipher !== "none" || kdf !== "none") {
    throw new Error("encrypted OpenSSH keys are not supported; provide a passphraseless key");
  }
  if (keyCount !== 1) throw new Error("expected exactly one key in the OpenSSH blob");
  r.string(); // public-key blob (re-read from the private section below)
  const priv = sshReader(r.string());
  priv.uint32();
  priv.uint32(); // two check-ints (equal for an unencrypted key)
  const keyType = priv.string().toString();
  if (keyType !== "ssh-ed25519") throw new Error(`unsupported key type ${keyType}; expected ssh-ed25519`);
  const publicKey = priv.string(); // 32 bytes
  const secret = priv.string(); // 64 bytes: seed(32) || public(32)
  return { seed: secret.subarray(0, 32), publicKey };
}

/**
 * SSH-sign `message` with an OpenSSH ed25519 private key, returning the armored
 * `-----BEGIN SSH SIGNATURE-----` blob (namespace "git", hash "sha512") ready
 * for GitHub's git-data commit `signature` field. Deterministic: equal inputs
 * always yield equal output (ed25519), so it matches `ssh-keygen -Y sign` byte
 * for byte.
 */
export function sshSign(message: Buffer, opensshEd25519PrivateKey: string): string {
  const { seed, publicKey } = parseOpenSshEd25519(opensshEd25519PrivateKey);
  const keyObject = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });

  // The pre-image OpenSSH hashes and signs: the literal ASCII "SSHSIG" (NOT
  // length-prefixed) followed by namespace, reserved, hash-alg, and the digest
  // of the message — each an SSH string.
  const hashed = createHash(HASH_ALG).update(message).digest();
  const signedBlob = Buffer.concat([
    Buffer.from("SSHSIG", "latin1"),
    sshString(NAMESPACE),
    sshString(""),
    sshString(HASH_ALG),
    sshString(hashed),
  ]);
  const rawSignature = cryptoSign(null, signedBlob, keyObject); // 64 raw ed25519 bytes

  // The armored blob: "SSHSIG" magic + version + the public key, namespace,
  // reserved, hash-alg, and the signature (itself an ssh-ed25519 wire blob).
  const publicKeyBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(publicKey)]);
  const signatureBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(rawSignature)]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1, 0);
  const wrapped = Buffer.concat([
    Buffer.from("SSHSIG", "latin1"),
    version,
    sshString(publicKeyBlob),
    sshString(NAMESPACE),
    sshString(""),
    sshString(HASH_ALG),
    sshString(signatureBlob),
  ]);

  const wrappedLines = wrapped.toString("base64").match(/.{1,70}/g) ?? [];
  return `-----BEGIN SSH SIGNATURE-----\n${wrappedLines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}
