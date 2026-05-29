// SHA-256 standard test vectors.
//
// Verifies the inline implementation against published outputs before we
// rely on it for bucketing. If these pass and the cross-language fixture
// fails, the bug is in bucket.ts (concatenation, byte order, etc.); if these
// fail, the bug is in sha256.ts itself.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes, sha256 } from "./sha256.js";

const TE = new TextEncoder();
function digest(text: string): string {
  return bytesToHex(sha256(TE.encode(text)));
}

describe("sha256", () => {
  it("hashes empty input (NIST vector)", () => {
    assert.equal(
      digest(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes 'abc' (RFC 6234 vector)", () => {
    assert.equal(
      digest("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes a 56-byte input (block boundary)", () => {
    // exactly 56 bytes — exercises the case where padding pushes us into a
    // second block.
    assert.equal(
      digest("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("hashes a longer multi-block input", () => {
    // 1000 'a' characters → known digest.
    const a = "a".repeat(1000);
    assert.equal(
      digest(a),
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
  });

  it("hex round-trips", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xab, 0xcd, 0xef, 0xff]);
    assert.equal(bytesToHex(bytes), "0001abcdefff");
    assert.deepEqual(hexToBytes("0001abcdefff"), bytes);
  });

  it("rejects odd-length hex", () => {
    assert.throws(() => hexToBytes("abc"));
  });

  it("rejects non-hex chars", () => {
    assert.throws(() => hexToBytes("xx"));
  });
});
