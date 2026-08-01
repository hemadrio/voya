/**
 * Reconciliation test fixtures for WO-050.
 *
 * All IDs, amounts, and references are synthetic (SYNTH-* prefix).
 * No real booking IDs, card data, or personal identifiers.
 *
 * Covers every exception kind plus the clean (no exception) scenario.
 */

import type {
  ProviderTransaction,
  LedgerRow,
  BookingState,
} from "../../src/domain/ReconciliationEngine.js";

// ---------------------------------------------------------------------------
// Synthetic constants
// ---------------------------------------------------------------------------

export const SYNTH_BOOKING_CONFIRMED   = "f0000010-0000-4000-8000-000000000001";
export const SYNTH_BOOKING_PENDING     = "f0000010-0000-4000-8000-000000000002";
export const SYNTH_BOOKING_EXPIRED     = "f0000010-0000-4000-8000-000000000003";
export const SYNTH_BOOKING_CANCELLED   = "f0000010-0000-4000-8000-000000000004";
export const SYNTH_BOOKING_PURGED      = "f0000010-0000-4000-8000-000000000005";

export const SYNTH_PI_CONFIRMED        = "pi_SYNTH_CONFIRMED_0001";
export const SYNTH_PI_PENDING          = "pi_SYNTH_PENDING_0001";
export const SYNTH_PI_EXPIRED          = "pi_SYNTH_EXPIRED_0001";
export const SYNTH_PI_CANCELLED        = "pi_SYNTH_CANCELLED_0001";
export const SYNTH_PI_ORPHAN           = "pi_SYNTH_ORPHAN_0001";
export const SYNTH_PI_AMOUNT_MISMATCH  = "pi_SYNTH_MISMATCH_0001";
export const SYNTH_PI_CURRENCY_MISMATCH= "pi_SYNTH_CURRENCY_0001";
export const SYNTH_PI_REFUND_NO_CANCEL = "pi_SYNTH_REFUND_0001";

export const SYNTH_CH_CONFIRMED        = "ch_SYNTH_CONFIRMED_0001";
export const SYNTH_CH_PENDING          = "ch_SYNTH_PENDING_0001";
export const SYNTH_CH_EXPIRED          = "ch_SYNTH_EXPIRED_0001";
export const SYNTH_CH_ORPHAN           = "ch_SYNTH_ORPHAN_0001";
export const SYNTH_CH_MISMATCH         = "ch_SYNTH_MISMATCH_0001";
export const SYNTH_CH_CURRENCY         = "ch_SYNTH_CURRENCY_0001";
export const SYNTH_RE_NO_CANCEL        = "re_SYNTH_NO_CANCEL_0001";

export const SYNTH_BT_CONFIRMED        = "bt_SYNTH_CONFIRMED_0001";
export const SYNTH_BT_PENDING          = "bt_SYNTH_PENDING_0001";
export const SYNTH_BT_EXPIRED          = "bt_SYNTH_EXPIRED_0001";
export const SYNTH_BT_ORPHAN           = "bt_SYNTH_ORPHAN_0001";
export const SYNTH_BT_MISMATCH         = "bt_SYNTH_MISMATCH_0001";
export const SYNTH_BT_CURRENCY         = "bt_SYNTH_CURRENCY_0001";
export const SYNTH_BT_REFUND           = "bt_SYNTH_REFUND_0001";

export const SYNTH_LED_CONFIRMED       = "led-00000001-0000-4000-8000-000000000001";
export const SYNTH_LED_PENDING         = "led-00000001-0000-4000-8000-000000000002";
export const SYNTH_LED_EXPIRED         = "led-00000001-0000-4000-8000-000000000003";
export const SYNTH_LED_ORPHAN          = "led-00000001-0000-4000-8000-000000000004";
export const SYNTH_LED_MISMATCH        = "led-00000001-0000-4000-8000-000000000005";
export const SYNTH_LED_CURRENCY        = "led-00000001-0000-4000-8000-000000000006";

export const PERIOD_DATE               = "2026-08-01";
export const PERIOD_EPOCH              = 1754006400; // 2026-08-01T00:00:00Z

// ---------------------------------------------------------------------------
// CLEAN scenario — one confirmed booking, one matching settlement
// ---------------------------------------------------------------------------

export const CLEAN_PROVIDER_TRANSACTIONS: ProviderTransaction[] = [
  {
    id:               SYNTH_BT_CONFIRMED,
    sourceId:         SYNTH_CH_CONFIRMED,
    type:             "charge",
    amountMinor:      49999n,
    currency:         "usd",
    bookingId:        SYNTH_BOOKING_CONFIRMED,
    paymentIntentId:  SYNTH_PI_CONFIRMED,
    settledAt:        PERIOD_EPOCH,
  },
];

export const CLEAN_LEDGER_ROWS: LedgerRow[] = [
  {
    id:               SYNTH_LED_CONFIRMED,
    bookingId:        SYNTH_BOOKING_CONFIRMED,
    type:             "CHARGE",
    providerReference: SYNTH_PI_CONFIRMED,
    amountMinor:      49999n,
    currency:         "usd",
    status:           "SUCCEEDED",
  },
];

export const CLEAN_BOOKING_STATES: BookingState[] = [
  { id: SYNTH_BOOKING_CONFIRMED, status: "CONFIRMED" },
];

// ---------------------------------------------------------------------------
// SETTLED_WITHOUT_CONFIRMATION — charge settled but booking is PENDING
// ---------------------------------------------------------------------------

export const SETTLED_WITHOUT_CONFIRMATION_TRANSACTIONS: ProviderTransaction[] = [
  {
    id:               SYNTH_BT_PENDING,
    sourceId:         SYNTH_CH_PENDING,
    type:             "charge",
    amountMinor:      29999n,
    currency:         "usd",
    bookingId:        SYNTH_BOOKING_PENDING,
    paymentIntentId:  SYNTH_PI_PENDING,
    settledAt:        PERIOD_EPOCH,
  },
];

export const SETTLED_WITHOUT_CONFIRMATION_LEDGER: LedgerRow[] = [
  {
    id:               SYNTH_LED_PENDING,
    bookingId:        SYNTH_BOOKING_PENDING,
    type:             "CHARGE",
    providerReference: SYNTH_PI_PENDING,
    amountMinor:      29999n,
    currency:         "usd",
    status:           "SUCCEEDED",
  },
];

export const SETTLED_WITHOUT_CONFIRMATION_BOOKINGS: BookingState[] = [
  { id: SYNTH_BOOKING_PENDING, status: "PENDING" },
];

// ---------------------------------------------------------------------------
// CONFIRMED_WITHOUT_SETTLEMENT — booking confirmed but no Stripe charge today
// ---------------------------------------------------------------------------

export const CONFIRMED_WITHOUT_SETTLEMENT_TRANSACTIONS: ProviderTransaction[] = [];

export const CONFIRMED_WITHOUT_SETTLEMENT_LEDGER: LedgerRow[] = [
  {
    id:               SYNTH_LED_CONFIRMED,
    bookingId:        SYNTH_BOOKING_CONFIRMED,
    type:             "CHARGE",
    providerReference: SYNTH_PI_CONFIRMED,
    amountMinor:      49999n,
    currency:         "usd",
    status:           "SUCCEEDED",
  },
];

export const CONFIRMED_WITHOUT_SETTLEMENT_BOOKINGS: BookingState[] = [
  { id: SYNTH_BOOKING_CONFIRMED, status: "CONFIRMED" },
];

// ---------------------------------------------------------------------------
// REFUND_WITHOUT_CANCELLATION — refund issued but booking is CONFIRMED (not cancelled)
// ---------------------------------------------------------------------------

export const REFUND_WITHOUT_CANCELLATION_TRANSACTIONS: ProviderTransaction[] = [
  {
    id:               SYNTH_BT_REFUND,
    sourceId:         SYNTH_RE_NO_CANCEL,
    type:             "refund",
    amountMinor:      49999n,
    currency:         "usd",
    bookingId:        SYNTH_BOOKING_CONFIRMED,
    paymentIntentId:  SYNTH_PI_REFUND_NO_CANCEL,
    settledAt:        PERIOD_EPOCH,
  },
];

export const REFUND_WITHOUT_CANCELLATION_LEDGER: LedgerRow[] = [];

export const REFUND_WITHOUT_CANCELLATION_BOOKINGS: BookingState[] = [
  { id: SYNTH_BOOKING_CONFIRMED, status: "CONFIRMED" },
];

// ---------------------------------------------------------------------------
// AMOUNT_MISMATCH — settled amount differs from ledger amount
// ---------------------------------------------------------------------------

export const AMOUNT_MISMATCH_TRANSACTIONS: ProviderTransaction[] = [
  {
    id:               SYNTH_BT_MISMATCH,
    sourceId:         SYNTH_CH_MISMATCH,
    type:             "charge",
    amountMinor:      49998n, // one cent less than ledger
    currency:         "usd",
    bookingId:        SYNTH_BOOKING_CONFIRMED,
    paymentIntentId:  SYNTH_PI_AMOUNT_MISMATCH,
    settledAt:        PERIOD_EPOCH,
  },
];

export const AMOUNT_MISMATCH_LEDGER: LedgerRow[] = [
  {
    id:               SYNTH_LED_MISMATCH,
    bookingId:        SYNTH_BOOKING_CONFIRMED,
    type:             "CHARGE",
    providerReference: SYNTH_PI_AMOUNT_MISMATCH,
    amountMinor:      49999n, // expected
    currency:         "usd",
    status:           "SUCCEEDED",
  },
];

export const AMOUNT_MISMATCH_BOOKINGS: BookingState[] = [
  { id: SYNTH_BOOKING_CONFIRMED, status: "CONFIRMED" },
];

// ---------------------------------------------------------------------------
// CURRENCY_MISMATCH — settled currency differs from ledger currency
// ---------------------------------------------------------------------------

export const CURRENCY_MISMATCH_TRANSACTIONS: ProviderTransaction[] = [
  {
    id:               SYNTH_BT_CURRENCY,
    sourceId:         SYNTH_CH_CURRENCY,
    type:             "charge",
    amountMinor:      49999n,
    currency:         "eur", // provider settled in EUR
    bookingId:        SYNTH_BOOKING_CONFIRMED,
    paymentIntentId:  SYNTH_PI_CURRENCY_MISMATCH,
    settledAt:        PERIOD_EPOCH,
  },
];

export const CURRENCY_MISMATCH_LEDGER: LedgerRow[] = [
  {
    id:               SYNTH_LED_CURRENCY,
    bookingId:        SYNTH_BOOKING_CONFIRMED,
    type:             "CHARGE",
    providerReference: SYNTH_PI_CURRENCY_MISMATCH,
    amountMinor:      49999n,
    currency:         "usd", // ledger says USD
    status:           "SUCCEEDED",
  },
];

export const CURRENCY_MISMATCH_BOOKINGS: BookingState[] = [
  { id: SYNTH_BOOKING_CONFIRMED, status: "CONFIRMED" },
];

// ---------------------------------------------------------------------------
// CONFIRMATION_AFTER_TERMINAL — charge settled for EXPIRED booking
// ---------------------------------------------------------------------------

export const CONFIRMATION_AFTER_TERMINAL_TRANSACTIONS: ProviderTransaction[] = [
  {
    id:               SYNTH_BT_EXPIRED,
    sourceId:         SYNTH_CH_EXPIRED,
    type:             "charge",
    amountMinor:      29999n,
    currency:         "usd",
    bookingId:        SYNTH_BOOKING_EXPIRED,
    paymentIntentId:  SYNTH_PI_EXPIRED,
    settledAt:        PERIOD_EPOCH,
  },
];

export const CONFIRMATION_AFTER_TERMINAL_LEDGER: LedgerRow[] = [
  {
    id:               SYNTH_LED_EXPIRED,
    bookingId:        SYNTH_BOOKING_EXPIRED,
    type:             "CHARGE",
    providerReference: SYNTH_PI_EXPIRED,
    amountMinor:      29999n,
    currency:         "usd",
    status:           "SUCCEEDED",
  },
];

export const CONFIRMATION_AFTER_TERMINAL_BOOKINGS: BookingState[] = [
  { id: SYNTH_BOOKING_EXPIRED, status: "EXPIRED" },
];

// ---------------------------------------------------------------------------
// ORPHAN_LEDGER_ROW — ledger row with no provider transaction and no booking
// ---------------------------------------------------------------------------

export const ORPHAN_LEDGER_ROW_TRANSACTIONS: ProviderTransaction[] = [];

export const ORPHAN_LEDGER_ROW_LEDGER: LedgerRow[] = [
  {
    id:               SYNTH_LED_ORPHAN,
    bookingId:        SYNTH_BOOKING_PURGED, // booking no longer in the system
    type:             "CHARGE",
    providerReference: SYNTH_PI_ORPHAN,
    amountMinor:      19999n,
    currency:         "usd",
    status:           "SUCCEEDED",
  },
];

export const ORPHAN_LEDGER_ROW_BOOKINGS: BookingState[] = [
  // SYNTH_BOOKING_PURGED intentionally absent — booking was deleted
];

// ---------------------------------------------------------------------------
// CANCELLED booking with refund — clean (no exception)
// ---------------------------------------------------------------------------

export const CANCELLED_WITH_REFUND_TRANSACTIONS: ProviderTransaction[] = [
  {
    id:               SYNTH_BT_REFUND,
    sourceId:         SYNTH_RE_NO_CANCEL,
    type:             "refund",
    amountMinor:      49999n,
    currency:         "usd",
    bookingId:        SYNTH_BOOKING_CANCELLED,
    paymentIntentId:  SYNTH_PI_REFUND_NO_CANCEL,
    settledAt:        PERIOD_EPOCH,
  },
];

export const CANCELLED_WITH_REFUND_LEDGER: LedgerRow[] = [];

export const CANCELLED_WITH_REFUND_BOOKINGS: BookingState[] = [
  { id: SYNTH_BOOKING_CANCELLED, status: "CANCELLED" },
];

// ---------------------------------------------------------------------------
// Multi-exception day — all exception kinds in one day
// ---------------------------------------------------------------------------

export const ALL_EXCEPTIONS_TRANSACTIONS: ProviderTransaction[] = [
  ...SETTLED_WITHOUT_CONFIRMATION_TRANSACTIONS,
  ...AMOUNT_MISMATCH_TRANSACTIONS,
  ...CURRENCY_MISMATCH_TRANSACTIONS,
  ...CONFIRMATION_AFTER_TERMINAL_TRANSACTIONS,
  ...REFUND_WITHOUT_CANCELLATION_TRANSACTIONS,
];

export const ALL_EXCEPTIONS_LEDGER: LedgerRow[] = [
  ...SETTLED_WITHOUT_CONFIRMATION_LEDGER,
  ...AMOUNT_MISMATCH_LEDGER,
  ...CURRENCY_MISMATCH_LEDGER,
  ...CONFIRMATION_AFTER_TERMINAL_LEDGER,
  ...ORPHAN_LEDGER_ROW_LEDGER, // ORPHAN_LEDGER_ROW comes from ledger-only fixture
];

export const ALL_EXCEPTIONS_BOOKINGS: BookingState[] = [
  { id: SYNTH_BOOKING_PENDING,    status: "PENDING" },
  { id: SYNTH_BOOKING_CONFIRMED,  status: "CONFIRMED" },
  { id: SYNTH_BOOKING_EXPIRED,    status: "EXPIRED" },
  // SYNTH_BOOKING_PURGED absent → ORPHAN_LEDGER_ROW
];
