/**
 * PaymentRepository — payments ledger persistence (WO-045).
 *
 * Injectable: depends only on duck-typed interfaces so tests supply in-memory
 * doubles without Prisma.
 *
 * PCI note: the repository never touches full card numbers, CVCs, or expiry
 * dates — only providerReference, cardBrand, and cardLast4 are persisted.
 */

import type { AuditTxClient } from "../domain/AuditWriter.js";

// ---------------------------------------------------------------------------
// Injectable DB interface
// ---------------------------------------------------------------------------

export interface PaymentRow {
  id: string;
  bookingId: string;
  provider: string;
  providerReference: string;
  type: string;
  parentPaymentId: string | null;
  amountMinor: bigint;
  currency: string;
  status: string;
  cardBrand: string | null;
  cardLast4: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePaymentData {
  id?: string;
  bookingId: string;
  provider: string;
  providerReference: string;
  type: string;
  parentPaymentId?: string | null;
  amountMinor: bigint;
  currency: string;
  status: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
}

/** Minimal duck-typed Prisma client slice for payment operations. */
export interface PaymentPrismaClient {
  payment: {
    findFirst(args: {
      where:
        | { bookingId: string; provider: string; providerReference: string }
        | { bookingId: string; amountMinor: bigint; currency: string; status?: { not: string } };
      orderBy?: { createdAt: "desc" | "asc" };
    }): Promise<PaymentRow | null>;
    create(args: { data: CreatePaymentData }): Promise<PaymentRow>;
  };
  bookingAuditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  $transaction<T>(
    fn: (tx: PaymentPrismaClient & AuditTxClient) => Promise<T>,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Repository port interface
// ---------------------------------------------------------------------------

export interface PaymentRepositoryPort {
  /** Find an existing non-failed CHARGE payment for this booking with matching amount+currency. */
  findExistingCharge(
    bookingId: string,
    amountMinor: bigint,
    currency: string,
  ): Promise<PaymentRow | null>;

  /** Find a payment by provider + providerReference (for webhook deduplication). */
  findByProviderRef(
    provider: string,
    providerReference: string,
  ): Promise<PaymentRow | null>;

  /** Write a new payment row inside the provided transaction. */
  createPaymentInTx(
    data: CreatePaymentData,
    tx: AuditTxClient,
  ): Promise<PaymentRow>;

  /** Wrap work in a transaction. */
  runInTransaction<T>(
    work: (tx: AuditTxClient) => Promise<T>,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Repository implementation
// ---------------------------------------------------------------------------

export class PaymentRepository implements PaymentRepositoryPort {
  constructor(private readonly db: PaymentPrismaClient) {}

  async findExistingCharge(
    bookingId: string,
    amountMinor: bigint,
    currency: string,
  ): Promise<PaymentRow | null> {
    return this.db.payment.findFirst({
      where: {
        bookingId,
        amountMinor,
        currency: currency.toUpperCase(),
        status: { not: "FAILED" },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findByProviderRef(
    provider: string,
    providerReference: string,
  ): Promise<PaymentRow | null> {
    return this.db.payment.findFirst({
      where: { bookingId: providerReference, provider, providerReference },
    });
  }

  async createPaymentInTx(
    data: CreatePaymentData,
    tx: AuditTxClient,
  ): Promise<PaymentRow> {
    const dbTx = tx as unknown as PaymentPrismaClient;
    return dbTx.payment.create({ data });
  }

  async runInTransaction<T>(
    work: (tx: AuditTxClient) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction((tx) => work(tx as unknown as AuditTxClient));
  }
}
