"use client";

/**
 * CancellationDialog — idempotent cancellation with backend-sourced refund preview (WO-069, AC4–AC5).
 *
 * Flow:
 *   1. Load preview on open (POST /cancellation/preview)
 *   2. Show RefundPreview — user reads and confirms
 *   3. Submit cancel (POST /cancel with Idempotency-Key)
 *   4. On success: call onCancelled with result
 *   5. On ALREADY_CANCELLED or DEADLINE_PASSED: reconcile to server state
 *
 * Constraint: refund amounts come ONLY from the backend preview endpoint.
 */

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal.js";
import { Button } from "@/components/ui/Button.js";
import { RefundPreview } from "./RefundPreview.js";
import { previewCancellation, cancelBooking } from "@/lib/api/account.js";
import type { CancellationPreview, CancellationResult } from "@/lib/api/account.js";
import { ApiError } from "@/lib/api/errors.js";

// Stable idempotency key per dialog open (regenerated each time the dialog opens)
function newKey(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `cancel-${Date.now()}`;
}

interface CancellationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  onCancelled: (result: CancellationResult) => void;
  onConflict: (code: "ALREADY_CANCELLED" | "DEADLINE_PASSED") => void;
}

type Phase = "loading" | "preview" | "submitting" | "error";

export function CancellationDialog({
  open,
  onOpenChange,
  bookingId,
  onCancelled,
  onConflict,
}: CancellationDialogProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const idempotencyKey = useRef<string>(newKey());

  // Reset and reload preview each time the dialog opens
  useEffect(() => {
    if (!open) return;
    idempotencyKey.current = newKey();
    setPhase("loading");
    setPreview(null);
    setErrorMessage(null);

    const ctrl = new AbortController();
    previewCancellation(bookingId, ctrl.signal)
      .then((p) => {
        setPreview(p);
        setPhase("preview");
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setErrorMessage(
          err instanceof ApiError ? err.message : "Unable to load refund preview.",
        );
        setPhase("error");
      });

    return () => ctrl.abort();
  }, [open, bookingId]);

  async function handleConfirm() {
    setPhase("submitting");
    try {
      const result = await cancelBooking(bookingId, idempotencyKey.current);
      onOpenChange(false);
      onCancelled(result);
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err as ApiError & { data?: { code?: string } }).data?.code;
        if (code === "ALREADY_CANCELLED" || code === "DEADLINE_PASSED") {
          onOpenChange(false);
          onConflict(code);
          return;
        }
        setErrorMessage(err.message);
      } else {
        setErrorMessage("Unable to cancel your booking. Please try again.");
      }
      setPhase("preview"); // allow retry
    }
  }

  const isDeadlinePassed = (preview?.refundableAmount ?? 0) === 0 && preview !== null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel booking"
      description="Review your refund before confirming cancellation."
    >
      <div className="mt-4 space-y-4">
        {phase === "loading" && (
          <div
            className="flex items-center justify-center py-8 text-sm text-neutral-500"
            role="status"
            aria-live="polite"
          >
            <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" aria-hidden />
            Loading refund preview…
          </div>
        )}

        {(phase === "preview" || phase === "submitting") && preview && (
          <>
            {isDeadlinePassed && (
              <div
                role="alert"
                className="rounded-md border border-error-300 bg-error-50 px-3 py-2 text-sm text-error-700"
              >
                The free cancellation deadline has passed. This booking is non-refundable.
              </div>
            )}
            <RefundPreview preview={preview} />
            <p className="text-sm text-neutral-600">
              This action cannot be undone. Your cancellation will be processed immediately.
            </p>
          </>
        )}

        {phase === "error" && (
          <div role="alert" className="rounded-md border border-error-300 bg-error-50 px-3 py-2 text-sm text-error-700">
            {errorMessage}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          {/* Default focus: cancel (safe) action per AC constraint */}
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => onOpenChange(false)}
            autoFocus
          >
            Keep booking
          </Button>
          <Button
            variant="primary"
            className="flex-1 bg-error-600 hover:bg-error-700"
            disabled={phase !== "preview"}
            loading={phase === "submitting"}
            onClick={handleConfirm}
          >
            Confirm cancellation
          </Button>
        </div>
      </div>
    </Modal>
  );
}
