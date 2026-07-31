/**
 * EnvelopeCipher — injectable interface for KMS envelope encryption.
 *
 * Key hierarchy:
 *   CMK (AWS KMS customer managed key, per environment)
 *     └─ DEK (256-bit AES data key, per traveler subject)
 *            └─ ciphertext = AES-256-GCM(plaintext, DEK, IV)
 *
 * The plaintext DEK is used in-process and immediately discarded.
 * Only the KMS-wrapped DEK (wrappedDek) is persisted, along with the
 * KMS key ID and an encryption context that binds the ciphertext to a
 * specific subject and booking so it cannot be replayed onto another row.
 *
 * Cryptographic erasure: overwriting or deleting a row's wrapped_dek
 * renders that subject's ciphertext permanently unrecoverable without
 * CMK-wide key destruction.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * The persistent representation stored alongside the ciphertext.
 * Both fields come from a single KMS GenerateDataKey call.
 */
export interface WrappedKey {
  /** KMS-wrapped data encryption key (base64-encoded ciphertext). */
  wrappedDek: Buffer;
  /** ARN/ID of the KMS key that wrapped the DEK. */
  dekKeyId: string;
}

/**
 * Encryption context — bound to the ciphertext; must be supplied verbatim
 * on decryption. Mismatch causes KMS to reject the Decrypt call, preventing
 * ciphertext replay across subjects or bookings.
 */
export interface EncryptionContext {
  subjectId: string;
  bookingId: string;
}

/**
 * A single encrypted field: the ciphertext blob and the IV used during
 * AES-256-GCM. Both must be persisted together.
 */
export interface EncryptedField {
  /** AES-256-GCM ciphertext (includes 16-byte auth tag appended by Node crypto). */
  ciphertext: Buffer;
  /** 12-byte random initialisation vector for AES-GCM. */
  iv: Buffer;
}

/**
 * The full output of encryptForSubject: the wrapped DEK (persisted on the row)
 * plus the per-field encrypted values.
 */
export interface SubjectEncryptResult {
  wrappedKey: WrappedKey;
  encryptedFields: Record<string, EncryptedField>;
}

// ---------------------------------------------------------------------------
// EnvelopeCipher interface
// ---------------------------------------------------------------------------

/**
 * Injectable envelope cipher interface.
 *
 * Implementations:
 *   - KmsEnvelopeCipher — production, calls AWS KMS GenerateDataKey/Decrypt
 *   - InMemoryEnvelopeCipher — test double, no AWS dependency
 */
export interface EnvelopeCipher {
  /**
   * Generate a per-subject DEK, encrypt each plaintext value with AES-256-GCM,
   * and return the wrapped DEK + per-field ciphertexts.
   *
   * @param context  Encryption context — bound into the KMS GenerateDataKey call.
   * @param fields   Map of field name → plaintext Buffer (or null to skip encryption).
   * @returns        Wrapped DEK metadata + per-field encrypted blobs.
   */
  encryptForSubject(
    context: EncryptionContext,
    fields: Record<string, Buffer | null>,
  ): Promise<SubjectEncryptResult>;

  /**
   * Decrypt all fields that were encrypted with encryptForSubject.
   *
   * @param context    Must match the context used during encryption exactly.
   * @param wrappedKey Persisted wrapped DEK and key ID.
   * @param fields     Per-field ciphertext + IV blobs.
   * @returns          Map of field name → decrypted plaintext Buffer.
   * @throws           If the wrapped DEK cannot be unwrapped (context mismatch,
   *                   key destroyed, KMS unavailable).
   */
  decryptForSubject(
    context: EncryptionContext,
    wrappedKey: WrappedKey,
    fields: Record<string, EncryptedField>,
  ): Promise<Record<string, Buffer>>;
}
