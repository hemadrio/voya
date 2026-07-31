/**
 * Audit event schemas — WO-101.
 *
 * Single source of truth for action enums, actor role, and the shared
 * AuditEvent wire shape.  Producers (booking-service, auth-service) and
 * the evidence collector share these definitions so no free-text strings
 * can diverge across services.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// BookingAction — every booking lifecycle transition
// ---------------------------------------------------------------------------

export const BookingActionSchema = z.enum([
  "BOOKING_CREATED",
  "BOOKING_PRICE_REVALIDATED",
  "BOOKING_CONFIRMED",
  "BOOKING_MODIFIED",
  "BOOKING_CANCELLED",
  "BOOKING_EXPIRED",
  "BOOKING_REFUNDED",
]);
export type BookingAction = z.infer<typeof BookingActionSchema>;

// ---------------------------------------------------------------------------
// AuthAction — every authentication and authorization event
// ---------------------------------------------------------------------------

export const AuthActionSchema = z.enum([
  "AUTH_LOGIN_SUCCESS",
  "AUTH_LOGIN_FAILURE",
  "AUTH_LOCKOUT",
  "AUTH_TOKEN_REFRESH",
  "AUTH_REFRESH_REUSE_DETECTED",
  "AUTH_LOGOUT",
  "AUTH_ACCESS_DENIED",
  "AUTH_VALIDATION_FAILURE",
  "AUTH_PASSWORD_RESET_REQUESTED",
  "AUTH_PASSWORD_RESET_COMPLETED",
  "AUTH_EMAIL_VERIFIED",
]);
export type AuthAction = z.infer<typeof AuthActionSchema>;

// ---------------------------------------------------------------------------
// AuditAction — union of all event types
// ---------------------------------------------------------------------------

export const AuditActionSchema = z.union([BookingActionSchema, AuthActionSchema]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

// ---------------------------------------------------------------------------
// ActorRole — who issued the action
// ---------------------------------------------------------------------------

export const AuditActorRoleSchema = z.enum([
  "traveler",
  "support_agent",
  "ops",
  "system",
  "anonymous",
]);
export type AuditActorRole = z.infer<typeof AuditActorRoleSchema>;

// ---------------------------------------------------------------------------
// AuditEventInput — what callers pass into AuditWriter.append
// ---------------------------------------------------------------------------

export const AuditEventInputSchema = z.object({
  /** Authenticated user or system identity (UUID or system principal name). */
  actorId: z.string().min(1).max(128),
  /** Role of the actor at the time of the event. */
  actorRole: AuditActorRoleSchema,
  /** Optional IPv4/v6 of the actor's request (hashed for anonymous actors). */
  actorIp: z.string().max(64).optional(),
  /** Action that occurred. */
  action: AuditActionSchema,
  /** Domain resource type (e.g. "booking", "session"). */
  resourceType: z.string().min(1).max(64),
  /** Domain resource identifier (UUID). */
  resourceId: z.string().min(1).max(128),
  /** State before the action (will be redacted before persistence). */
  previousState: z.unknown().optional(),
  /** State after the action (will be redacted before persistence). */
  newState: z.unknown().optional(),
  /** Correlation / trace identifier from the request context. */
  correlationId: z.string().max(128).optional(),
  /** Wall-clock time of the event; defaults to Date.now() if omitted. */
  occurredAt: z.date().optional(),
});
export type AuditEventInput = z.infer<typeof AuditEventInputSchema>;

// ---------------------------------------------------------------------------
// AuditHistoryItem — what the /history endpoint returns
// ---------------------------------------------------------------------------

export const AuditHistoryItemSchema = z.object({
  id: z.string(),
  action: AuditActionSchema,
  actorRole: AuditActorRoleSchema,
  occurredAt: z.string().datetime(),
  correlationId: z.string().optional(),
  /** Redacted change summary (no identity-document fields). */
  changeSummary: z.record(z.unknown()).optional(),
});
export type AuditHistoryItem = z.infer<typeof AuditHistoryItemSchema>;

export const AuditHistoryResponseSchema = z.object({
  items: z.array(AuditHistoryItemSchema),
});
export type AuditHistoryResponse = z.infer<typeof AuditHistoryResponseSchema>;
