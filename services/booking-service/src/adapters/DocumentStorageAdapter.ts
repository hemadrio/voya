/**
 * DocumentStorageAdapter — port interface and in-memory stub for object storage (WO-054).
 *
 * Production implementation writes to S3 with KMS-SSE (see infra/terraform/s3-documents.tf).
 * The domain layer depends only on DocumentStoragePort; the concrete S3 adapter is wired
 * at startup and never imported by domain code.
 *
 * Security: signed download URLs are short-lived (max 900 s / 15 min as required by AC7).
 * URLs must never be included in logs, traces, or audit records.
 */

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface DocumentStoragePort {
  /**
   * Write the PDF buffer to object storage at the given key.
   * The key is namespaced: `{userId}/{itineraryId}/{documentId}.pdf`
   */
  store(key: string, content: Buffer): Promise<void>;

  /**
   * Issue a short-lived pre-signed URL for the object at `key`.
   *
   * @param key             - Storage key previously passed to store()
   * @param expirySeconds   - URL lifetime. Must be ≤ 900 (15 minutes per AC7).
   * @returns Pre-signed URL string.  Must never be logged by the caller.
   */
  issueSignedUrl(key: string, expirySeconds: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class DocumentStorageError extends Error {
  constructor(
    readonly operation: "store" | "sign",
    readonly key: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentStorageError";
  }
}

// ---------------------------------------------------------------------------
// InMemoryDocumentStorageAdapter — test/stub implementation
//
// Stores buffers in a Map and generates deterministic mock URLs.
// The mock URL is intentionally not a real URL so tests can detect if it
// were accidentally logged — its format is recognisable but non-routable.
// ---------------------------------------------------------------------------

export class InMemoryDocumentStorageAdapter implements DocumentStoragePort {
  readonly objects = new Map<string, Buffer>();

  async store(key: string, content: Buffer): Promise<void> {
    this.objects.set(key, content);
  }

  async issueSignedUrl(key: string, expirySeconds: number): Promise<string> {
    if (!this.objects.has(key)) {
      throw new DocumentStorageError("sign", key, `Object not found: ${key}`);
    }
    const expiry = Date.now() + expirySeconds * 1000;
    // Synthetic URL — deterministic, detectable in tests, never real
    return `https://documents.internal/signed/${encodeURIComponent(key)}?expires=${expiry}`;
  }
}

// ---------------------------------------------------------------------------
// S3DocumentStorageAdapter — production stub
//
// In production, this adapter wraps @aws-sdk/client-s3 and
// @aws-sdk/s3-request-presigner.  The bucket name and KMS key ARN are
// injected from the environment (SSM parameter store).
// ---------------------------------------------------------------------------

export class S3DocumentStorageAdapter implements DocumentStoragePort {
  constructor(
    private readonly bucketName: string,
    private readonly kmsKeyArn: string,
  ) {}

  async store(_key: string, _content: Buffer): Promise<void> {
    // Production implementation:
    //
    //   const client = new S3Client({})
    //   await client.send(new PutObjectCommand({
    //     Bucket: this.bucketName,
    //     Key: _key,
    //     Body: _content,
    //     ContentType: 'application/pdf',
    //     ServerSideEncryption: 'aws:kms',
    //     SSEKMSKeyId: this.kmsKeyArn,
    //   }))
    //
    // @aws-sdk/client-s3 is not installed in this monorepo at present.
    // Wire S3DocumentStorageAdapter when the SDK is added as a dependency.
    throw new DocumentStorageError(
      "store",
      _key,
      "S3DocumentStorageAdapter requires @aws-sdk/client-s3. " +
        "Use InMemoryDocumentStorageAdapter in tests.",
    );
  }

  async issueSignedUrl(_key: string, _expirySeconds: number): Promise<string> {
    // Production implementation:
    //
    //   const client = new S3Client({})
    //   return getSignedUrl(client, new GetObjectCommand({
    //     Bucket: this.bucketName,
    //     Key: _key,
    //   }), { expiresIn: _expirySeconds })
    //
    throw new DocumentStorageError(
      "sign",
      _key,
      "S3DocumentStorageAdapter requires @aws-sdk/s3-request-presigner.",
    );
  }
}
