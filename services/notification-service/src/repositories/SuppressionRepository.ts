/**
 * Repository for the email_suppressions table.
 *
 * Email addresses are never stored raw — only their SHA-256 hex hash.
 * The hash is checked before every SES send; a match means the recipient
 * has bounced or complained and the send must be skipped.
 */

import { createHash } from 'node:crypto';
import { TransientDbError } from '../domain/backoff.js';

export type SuppressionReason = 'BOUNCE' | 'COMPLAINT' | 'MANUAL';

// Minimal Prisma client interface for suppression operations.
export interface SuppressionPrismaClient {
  emailSuppression: {
    findUnique(args: {
      where: { emailHash: string };
    }): Promise<{ emailHash: string; reason: string } | null>;
    upsert(args: {
      where: { emailHash: string };
      create: { emailHash: string; reason: string; sourceEventId?: string | null };
      update: { reason: string; sourceEventId?: string | null };
    }): Promise<unknown>;
  };
}

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

export class SuppressionRepository {
  constructor(private readonly db: SuppressionPrismaClient) {}

  async isSuppressed(email: string): Promise<boolean> {
    try {
      const hash = hashEmail(email);
      const row = await this.db.emailSuppression.findUnique({
        where: { emailHash: hash },
      });
      return row !== null;
    } catch (err) {
      if (isPrismaConnectionError(err)) {
        throw new TransientDbError(
          `Database connection error while checking suppression: ${errorMessage(err)}`,
        );
      }
      throw err;
    }
  }

  async suppress(
    email: string,
    reason: SuppressionReason,
    sourceEventId?: string,
  ): Promise<void> {
    try {
      const hash = hashEmail(email);
      await this.db.emailSuppression.upsert({
        where: { emailHash: hash },
        create: {
          emailHash: hash,
          reason,
          sourceEventId: sourceEventId ?? null,
        },
        update: {
          reason,
          sourceEventId: sourceEventId ?? null,
        },
      });
    } catch (err) {
      if (isPrismaConnectionError(err)) {
        throw new TransientDbError(
          `Database connection error while upserting suppression: ${errorMessage(err)}`,
        );
      }
      throw err;
    }
  }
}

function isPrismaConnectionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as Record<string, unknown>)['code'];
  return code === 'P1001' || code === 'P1017';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
