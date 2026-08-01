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
        | { bookingId: string; amountMinor: bigint; currency: string; status?: { not: string } }
        | { bookingId: string; type: string; status?: { not: string } };
      orderBy?: { createdAt: "desc" | "asc" };
    }): Promise<PaymentRow | null>;
    findMany(args: {
      where: { parentPaymentId: string; type: string };
      select?: { amountMinor: boolean };
    }): Promise<Array<{ amountMinor: bigint }>>;
    create(args: { data: CreatePaymentData }): Promise<PaymentRow>;
  };
  bookingAuditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
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

  /** Find the most-recent CHARGE payment for this booking (any amount). */
  findChargeForBooking(bookingId: string): Promise<PaymentRow | null>;

  /** Find a payment by provider + providerReference (for webhook deduplication). */
  findByProviderRef(
    provider: string,
    providerReference: string,
  ): Promise<PaymentRow | null>;

  /**
   * Lock a CHARGE row for update within a transaction (SELECT FOR UPDATE).
   *
   * Serialises concurrent refund requests for the same charge so only one
   * can pass the ceiling check at a time.
   */
  findAndLockCharge(
    chargeId: string,
    tx: AuditTxClient,
  ): Promise<PaymentRow | null>;

  /**
   * Sum all previously-issued REFUND amounts for a parent charge.
   *
   * Must be called within the same transaction that holds the FOR UPDATE lock
   * on the CHARGE row so the read is serialised with concurrent inserts.
   */
  sumRefundedAmount(
    parentPaymentId: string,
    tx: AuditTxClient,
  ): Promise<bigint>;

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

  async findChargeForBooking(bookingId: string): Promise<PaymentRow | null> {
    return this.db.payment.findFirst({
      where: {
        bookingId,
        type: "CHARGE",
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

  async findAndLockCharge(
    chargeId: string,
    tx: AuditTxClient,
  ): Promise<PaymentRow | null> {
    const dbTx = tx as unknown as PaymentPrismaClient;
    const rows = await dbTx.$queryRawUnsafe<PaymentRow[]>(
      `SELECT id, booking_id AS "bookingId", provider, provider_reference AS "providerReference",
              type, parent_payment_id AS "parentPaymentId", amount_minor AS "amountMinor",
              currency, status, card_brand AS "cardBrand", card_last4 AS "cardLast4",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM payments
       WHERE id = $1 AND type = 'CHARGE'
       FOR UPDATE`,
      chargeId,
    );
    return rows[0] ?? null;
  }

  async sumRefundedAmount(
    parentPaymentId: string,
    tx: AuditTxClient,
  ): Promise<bigint> {
    const dbTx = tx as unknown as PaymentPrismaClient;
    const refunds = await dbTx.payment.findMany({
      where: { parentPaymentId, type: "REFUND" },
      select: { amountMinor: true },
    });
    return refunds.reduce((sum, r) => sum + r.amountMinor, BigInt(0));
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
