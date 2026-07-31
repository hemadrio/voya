/**
 * KmsEnvelopeCipher — production envelope cipher backed by AWS KMS.
 *
 * Key flow:
 *   encrypt:
 *     1. KMS.GenerateDataKey(KeyId=cmkArn, KeySpec=AES_256, EncryptionContext)
 *        → { Plaintext: DEK, CiphertextBlob: wrappedDek, KeyId }
 *     2. For each non-null field: IV = randomBytes(12),
 *        ciphertext = AES-256-GCM(DEK, IV, plaintext)
 *     3. Zero the plaintext DEK buffer.
 *     4. Return wrappedDek + per-field { ciphertext, iv }.
 *
 *   decrypt:
 *     1. KMS.Decrypt(CiphertextBlob=wrappedDek, EncryptionContext)
 *        → { Plaintext: DEK }
 *     2. For each field: AES-256-GCM.decrypt(DEK, IV, ciphertext)
 *     3. Zero the plaintext DEK buffer.
 *     4. Return decrypted field buffers.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
  type KMSClientConfig,
} from "@aws-sdk/client-kms";
import type {
  EnvelopeCipher,
  EncryptionContext,
  EncryptedField,
  SubjectEncryptResult,
  WrappedKey,
} from "./EnvelopeCipher.js";

// AES-256-GCM constants
const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;
const AES_KEY_SPEC = "AES_256" as const;

export interface KmsEnvelopeCipherConfig {
  /** ARN of the CMK used as the key-encryption key. */
  cmkArn: string;
  kmsClientConfig?: KMSClientConfig;
}

export class KmsEnvelopeCipher implements EnvelopeCipher {
  private readonly kms: KMSClient;
  private readonly cmkArn: string;

  constructor(config: KmsEnvelopeCipherConfig) {
    this.cmkArn = config.cmkArn;
    this.kms = new KMSClient(config.kmsClientConfig ?? {});
  }

  async encryptForSubject(
    context: EncryptionContext,
    fields: Record<string, Buffer | null>,
  ): Promise<SubjectEncryptResult> {
    // 1. Generate a per-subject data key via KMS
    const encryptionContext = buildKmsContext(context);
    const genKeyResult = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: this.cmkArn,
        KeySpec: AES_KEY_SPEC,
        EncryptionContext: encryptionContext,
      }),
    );

    if (
      !genKeyResult.Plaintext ||
      !genKeyResult.CiphertextBlob ||
      !genKeyResult.KeyId
    ) {
      throw new Error("KMS GenerateDataKey returned incomplete result");
    }

    const plaintextDek = Buffer.from(genKeyResult.Plaintext);
    const wrappedDekBytes = Buffer.from(genKeyResult.CiphertextBlob);
    const dekKeyId = genKeyResult.KeyId;

    try {
      // 2. Encrypt each non-null field with AES-256-GCM
      const encryptedFields: Record<string, EncryptedField> = {};

      for (const [fieldName, plaintext] of Object.entries(fields)) {
        if (plaintext === null) {
          continue;
        }
        const iv = randomBytes(GCM_IV_LENGTH);
        const cipher = createCipheriv("aes-256-gcm", plaintextDek, iv);
        const ciphertextBody = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();
        // Auth tag is appended to the ciphertext for single-blob storage
        const ciphertext = Buffer.concat([ciphertextBody, authTag]);
        encryptedFields[fieldName] = { ciphertext, iv };
      }

      return {
        wrappedKey: { wrappedDek: wrappedDekBytes, dekKeyId },
        encryptedFields,
      };
    } finally {
      // 3. Zero the plaintext DEK immediately after use
      plaintextDek.fill(0);
    }
  }

  async decryptForSubject(
    context: EncryptionContext,
    wrappedKey: WrappedKey,
    fields: Record<string, EncryptedField>,
  ): Promise<Record<string, Buffer>> {
    // 1. Unwrap the DEK via KMS (context must match exactly)
    const encryptionContext = buildKmsContext(context);
    const decryptResult = await this.kms.send(
      new DecryptCommand({
        CiphertextBlob: wrappedKey.wrappedDek,
        KeyId: wrappedKey.dekKeyId,
        EncryptionContext: encryptionContext,
      }),
    );

    if (!decryptResult.Plaintext) {
      throw new Error("KMS Decrypt returned no plaintext — key may be disabled or destroyed");
    }

    const plaintextDek = Buffer.from(decryptResult.Plaintext);

    try {
      // 2. Decrypt each field
      const decryptedFields: Record<string, Buffer> = {};

      for (const [fieldName, { ciphertext, iv }] of Object.entries(fields)) {
        const ciphertextBody = ciphertext.subarray(
          0,
          ciphertext.length - GCM_AUTH_TAG_LENGTH,
        );
        const authTag = ciphertext.subarray(
          ciphertext.length - GCM_AUTH_TAG_LENGTH,
        );

        const decipher = createDecipheriv("aes-256-gcm", plaintextDek, iv);
        decipher.setAuthTag(authTag);

        decryptedFields[fieldName] = Buffer.concat([
          decipher.update(ciphertextBody),
          decipher.final(),
        ]);
      }

      return decryptedFields;
    } finally {
      // 3. Zero the plaintext DEK immediately after use
      plaintextDek.fill(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildKmsContext(
  context: EncryptionContext,
): Record<string, string> {
  return {
    "travel:subjectId": context.subjectId,
    "travel:bookingId": context.bookingId,
  };
}
