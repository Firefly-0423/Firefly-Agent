import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(path.join(process.cwd(), "package.json"));
const forge = require("node-forge");
const modulus =
  "E932AC92252F585B3A80A4DD76A897C8B7652952FE788F6EC8DD640587A1EE56" +
  "47670A8AD4C2BE0F9FA6E49C605ADF77B5174230AF7BD50E5D6D6D6D28CCF0A8" +
  "86A514CC72E51D209CC772A52EF419F6A953F3135929588EBE9B351FCA61CED7" +
  "8F346FE00DBB6306E5C2A4C6DFC3779AF85AB417371CF34D8387B9B30AE46D7A" +
  "5FF5A655B8D8455F1B94AE736989D60A6F2FD5CADBFFBD504C5A756A2E6BB5CE" +
  "CC13BCA7503F6DF8B52ACE5C410997E98809DB4DC30D943DE4E812A47553DCE5" +
  "4844A78E36401D13F77DC650619FED88D8B3926E3D8E319C80C744779AC5D6AB" +
  "E252896950917476ECE5E8FC27D5F053D6018D91B502C4787558A002B9283DA7";
const malformedSignature =
  "a4ae63dd5e7712b78f4870d0f51e294df5503d4f16c5d27ae33370981fb57f0de49f" +
  "50f3d6a04666774cd984cd13972db9bf8e12bd294ef0ddc916c7c86cbae63efd7b6b" +
  "97885e69760c208a40f1aecc76a90d7af5145177efce1bb55807a8d05c20b1596753" +
  "ba710642fc9acdde6c160232654662c77cc4466c8257a38edb49f894e8845d0fd987" +
  "b857ced88f4b62505a080bd87ef700d35d392a6e8f6fde34250c50b86fae606cb551" +
  "215e8f4813239b77651d5565ad453698c071d48c31e8e526fb4a37610f64b3e1fb8e" +
  "5be5898e408ad08197a0947794a530b54f84485377ce4a7488ed485ce4e5e105dd89" +
  "698a472f390c3b1b76bc16b73276c4d1c81d";

describe("node-forge CVE-2026-85393 backport", () => {
  it("rejects the upstream nested DigestAlgorithm garbage signature with normal padding checks", () => {
    const publicKey = forge.pki.rsa.setPublicKey(new forge.jsbn.BigInteger(modulus, 16), new forge.jsbn.BigInteger("3"));
    const digest = forge.md.sha256.create().update("hello world!").digest().getBytes();
    expect(() => publicKey.verify(digest, forge.util.hexToBytes(malformedSignature))).toThrow(/valid RSASSA-PKCS1-v1_5 DigestInfo/);
  });

  for (const publicExponent of [3, 65537]) {
    it(`preserves normal SHA-256 signing and verification with exponent ${publicExponent}`, () => {
      const pair = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent });
      const privateKey = forge.pki.privateKeyFromPem(pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      const publicKey = forge.pki.publicKeyFromPem(pair.publicKey.export({ type: "spki", format: "pem" }).toString());
      const signature = privateKey.sign(forge.md.sha256.create().update("public Firefly signature fixture"));
      expect(publicKey.verify(forge.md.sha256.create().update("public Firefly signature fixture").digest().getBytes(), signature)).toBe(true);
      expect(publicKey.verify(forge.md.sha256.create().update("different public fixture").digest().getBytes(), signature)).toBe(false);
    });
  }
});
