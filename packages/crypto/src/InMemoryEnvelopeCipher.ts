/**
 * InMemoryEnvelopeCipher — test double for EnvelopeCipher.
 *
 * Uses the Node.js built-in `crypto` module directly (no AWS SDK dependency).
 * The DEK is generated with randomBytes and wrapped with a dummy XOR operation
 * rather than KMS — the wrapped key is structurally identical to the real
 * implementation so tests exercise the same code paths.
 *
 * Cryptographic erasure is demonstrated by setting destroyed=true for a
 * subject's key: subsequent decryptForSubject calls throw, simulating
 * the effect of deleting/overwriting the wrapped DEK on a real row.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  EnvelopeCipher,
  EncryptionContext,
  EncryptedField,
  SubjectEncryptResult,
  WrappedKey,
} from "./EnvelopeCipher.js";

const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;
const DEK_LENGTH = 32; // 256-bit

// Fake "wrap" key — XOR with a fixed pattern (tests only, never secure)
const WRAP_KEY = Buffer.alloc(DEK_LENGTH, 0xab);

interface StoredDek {
  plaintext: Buffer;
  destroyed: boolean;
}

export class InMemoryEnvelopeCipher implements EnvelopeCipher {
  // subjectId → stored DEK (keyed by subjectId for cryptographic erasure testing)
  private readonly store = new Map<string, StoredDek>();

  /**
   * Simulate a wrapped DEK: XOR plaintext DEK with WRAP_KEY to produce a
   * deterministic fake "ciphertext" that unwraps in decryptForSubject.
   */
  async encryptForSubject(
    context: EncryptionContext,
    fields: Record<string, Buffer | null>,
  ): Promise<SubjectEncryptResult> {
    const plaintextDek = randomBytes(DEK_LENGTH);

    // "Wrap" the DEK
    const wrappedDekBytes = xorBuffers(plaintextDek, WRAP_KEY);

    // Store for erasure tests
    this.store.set(context.subjectId, { plaintext: Buffer.from(plaintextDek), destroyed: false });

    const encryptedFields: Record<string, EncryptedField> = {};

    try {
      for (const [fieldName, plaintext] of Object.entries(fields)) {
        if (plaintext === null) {
          continue;
        }
        const iv = randomBytes(GCM_IV_LENGTH);
        const cipher = createCipheriv("aes-256-gcm", plaintextDek, iv);
        const ciphertextBody = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const authTag = cipher.getAuthTag();
        encryptedFields[fieldName] = {
          ciphertext: Buffer.concat([ciphertextBody, authTag]),
          iv,
        };
      }
    } finally {
      plaintextDek.fill(0);
    }

    return {
      wrappedKey: { wrappedDek: wrappedDekBytes, dekKeyId: "in-memory-key" },
      encryptedFields,
    };
  }

  async decryptForSubject(
    context: EncryptionContext,
    wrappedKey: WrappedKey,
    fields: Record<string, EncryptedField>,
  ): Promise<Record<string, Buffer>> {
    const stored = this.store.get(context.subjectId);

    if (!stored || stored.destroyed) {
      throw new Error(
        `InMemoryEnvelopeCipher: DEK for subject ${context.subjectId} has been destroyed — ciphertext is permanently unrecoverable`,
      );
    }

    // "Unwrap" the DEK
    const plaintextDek = xorBuffers(wrappedKey.wrappedDek, WRAP_KEY);

    const decryptedFields: Record<string, Buffer> = {};

    try {
      for (const [fieldName, { ciphertext, iv }] of Object.entries(fields)) {
        const ciphertextBody = ciphertext.subarray(0, ciphertext.length - GCM_AUTH_TAG_LENGTH);
        const authTag = ciphertext.subarray(ciphertext.length - GCM_AUTH_TAG_LENGTH);

        const decipher = createDecipheriv("aes-256-gcm", plaintextDek, iv);
        decipher.setAuthTag(authTag);

        decryptedFields[fieldName] = Buffer.concat([
          decipher.update(ciphertextBody),
          decipher.final(),
        ]);
      }
    } finally {
      plaintextDek.fill(0);
    }

    return decryptedFields;
  }

  /**
   * Simulate cryptographic erasure for a subject.
   * After this call, decryptForSubject for the subject will throw.
   */
  destroySubjectKey(subjectId: string): void {
    const stored = this.store.get(subjectId);
    if (stored) {
      stored.plaintext.fill(0);
      stored.destroyed = true;
    } else {
      // Mark as destroyed even if not yet in store — idempotent
      this.store.set(subjectId, { plaintext: Buffer.alloc(0), destroyed: true });
    }
  }

  /** Inspect whether a subject's DEK has been destroyed (test helper). */
  isKeyDestroyed(subjectId: string): boolean {
    return this.store.get(subjectId)?.destroyed === true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function xorBuffers(a: Buffer, b: Buffer): Buffer {
  const result = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) {
    result[i] = (a[i] ?? 0) ^ (b[i % b.length] ?? 0);
  }
  return result;
}
