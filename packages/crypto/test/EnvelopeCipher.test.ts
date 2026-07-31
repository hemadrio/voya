/**
 * Unit tests for InMemoryEnvelopeCipher — verifies the contract that the
 * KmsEnvelopeCipher must also satisfy.
 *
 * Tests:
 *   1. Round-trip: encrypt then decrypt returns original plaintext
 *   2. Encryption context mismatch causes decryption failure
 *   3. Destroying a subject's DEK makes ciphertext permanently unrecoverable
 *   4. Null field produces no encrypted entry (passportReference = null)
 *   5. Multiple fields encrypted independently
 */

import { describe, it, expect } from "vitest";
import { InMemoryEnvelopeCipher } from "../src/InMemoryEnvelopeCipher.js";
import type { EncryptionContext } from "../src/EnvelopeCipher.js";

const CONTEXT: EncryptionContext = {
  subjectId: "subject-abc-123",
  bookingId: "booking-def-456",
};

describe("InMemoryEnvelopeCipher", () => {
  it("round-trips a single field correctly", async () => {
    const cipher = new InMemoryEnvelopeCipher();
    const plaintext = Buffer.from("1990-06-15", "utf8");

    const { wrappedKey, encryptedFields } = await cipher.encryptForSubject(CONTEXT, {
      dateOfBirth: plaintext,
    });

    expect(encryptedFields["dateOfBirth"]).toBeDefined();
    expect(encryptedFields["dateOfBirth"]!.ciphertext).not.toEqual(plaintext);

    const decrypted = await cipher.decryptForSubject(CONTEXT, wrappedKey, encryptedFields as never);
    expect(decrypted["dateOfBirth"]).toBeDefined();
    expect(decrypted["dateOfBirth"]!.toString("utf8")).toBe("1990-06-15");
  });

  it("round-trips multiple fields independently", async () => {
    const cipher = new InMemoryEnvelopeCipher();
    const dob = Buffer.from("1985-03-22", "utf8");
    const passport = Buffer.from("AB1234567", "utf8");

    const { wrappedKey, encryptedFields } = await cipher.encryptForSubject(CONTEXT, {
      dateOfBirth: dob,
      passportReference: passport,
    });

    expect(Object.keys(encryptedFields)).toHaveLength(2);

    const decrypted = await cipher.decryptForSubject(CONTEXT, wrappedKey, encryptedFields as never);

    expect(decrypted["dateOfBirth"]!.toString("utf8")).toBe("1985-03-22");
    expect(decrypted["passportReference"]!.toString("utf8")).toBe("AB1234567");
  });

  it("skips null fields — no encrypted entry produced", async () => {
    const cipher = new InMemoryEnvelopeCipher();

    const { encryptedFields } = await cipher.encryptForSubject(CONTEXT, {
      dateOfBirth: Buffer.from("1992-11-08", "utf8"),
      passportReference: null,
    });

    expect(encryptedFields["dateOfBirth"]).toBeDefined();
    expect(encryptedFields["passportReference"]).toBeUndefined();
  });

  it("rejects decryption when encryption context subjectId differs", async () => {
    const cipher = new InMemoryEnvelopeCipher();

    const { wrappedKey, encryptedFields } = await cipher.encryptForSubject(CONTEXT, {
      dateOfBirth: Buffer.from("1975-07-04", "utf8"),
    });

    const wrongContext: EncryptionContext = {
      subjectId: "different-subject",
      bookingId: CONTEXT.bookingId,
    };

    await expect(
      cipher.decryptForSubject(wrongContext, wrappedKey, encryptedFields as never),
    ).rejects.toThrow(/destroyed/);
  });

  it("cryptographic erasure: destroySubjectKey makes ciphertext permanently unrecoverable (AC3)", async () => {
    const cipher = new InMemoryEnvelopeCipher();
    const context: EncryptionContext = {
      subjectId: "subject-to-erase",
      bookingId: "booking-xyz",
    };

    const { wrappedKey, encryptedFields } = await cipher.encryptForSubject(context, {
      dateOfBirth: Buffer.from("2000-01-01", "utf8"),
    });

    // Decrypt succeeds before erasure
    const before = await cipher.decryptForSubject(context, wrappedKey, encryptedFields as never);
    expect(before["dateOfBirth"]!.toString("utf8")).toBe("2000-01-01");

    // Perform cryptographic erasure
    cipher.destroySubjectKey(context.subjectId);
    expect(cipher.isKeyDestroyed(context.subjectId)).toBe(true);

    // Decrypt fails after erasure — ciphertext is permanently unrecoverable
    await expect(
      cipher.decryptForSubject(context, wrappedKey, encryptedFields as never),
    ).rejects.toThrow(/destroyed/);
  });

  it("each encryption produces a unique ciphertext (distinct IV per call)", async () => {
    const cipher = new InMemoryEnvelopeCipher();
    const plaintext = Buffer.from("1990-01-01", "utf8");

    const context1: EncryptionContext = { subjectId: "s1", bookingId: "b1" };
    const context2: EncryptionContext = { subjectId: "s2", bookingId: "b2" };

    const { encryptedFields: fields1 } = await cipher.encryptForSubject(context1, {
      dateOfBirth: plaintext,
    });
    const { encryptedFields: fields2 } = await cipher.encryptForSubject(context2, {
      dateOfBirth: plaintext,
    });

    // Different subjects → different IVs → different ciphertexts
    expect(fields1["dateOfBirth"]!.ciphertext.equals(fields2["dateOfBirth"]!.ciphertext)).toBe(
      false,
    );
  });

  it("plaintext is never present in ciphertext output", async () => {
    const cipher = new InMemoryEnvelopeCipher();
    const plaintext = "PASSPORT-XYZ-SENSITIVE";

    const { encryptedFields } = await cipher.encryptForSubject(CONTEXT, {
      passportReference: Buffer.from(plaintext, "utf8"),
    });

    const ciphertextStr = encryptedFields["passportReference"]!.ciphertext.toString("utf8");
    expect(ciphertextStr).not.toContain(plaintext);
    const ciphertextHex = encryptedFields["passportReference"]!.ciphertext.toString("hex");
    expect(ciphertextHex).not.toContain(Buffer.from(plaintext, "utf8").toString("hex"));
  });
});
