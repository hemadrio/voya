"use client";

/**
 * ModificationDialog — date/guest modification request with price diff preview (WO-069, AC6).
 *
 * Flow:
 *   1. User inputs new dates/guests
 *   2. Preview is fetched (POST /modification/preview)
 *   3. Price difference (from backend) is shown
 *   4. User confirms → POST /modification
 *   5. Resulting pending_modification status surfaced
 *
 * Constraint: price differences come ONLY from the backend preview endpoint.
 */

import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Modal } from "@/components/ui/Modal.js";
import { Button } from "@/components/ui/Button.js";
import { Input } from "@/components/ui/Input.js";
import { previewModification, requestModification } from "@/lib/api/account.js";
import type { ModificationPreview, ModificationResult } from "@/lib/api/account.js";
import { ApiError } from "@/lib/api/errors.js";

const ModificationSchema = z.object({
  checkIn: z.string().min(1, "Check-in date is required"),
  checkOut: z.string().min(1, "Check-out date is required"),
  adults: z.number({ coerce: true }).int().min(1).max(20),
});

type ModificationFormValues = z.infer<typeof ModificationSchema>;

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency, minimumFractionDigits: 2,
  }).format(Math.abs(amount));
}

interface ModificationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  currentCheckIn: string;
  currentCheckOut: string;
  currentAdults: number;
  onModified: (result: ModificationResult) => void;
}

type Phase = "form" | "preview" | "submitting" | "conflict";

export function ModificationDialog({
  open,
  onOpenChange,
  bookingId,
  currentCheckIn,
  currentCheckOut,
  currentAdults,
  onModified,
}: ModificationDialogProps) {
  const [phase, setPhase] = useState<Phase>("form");
  const [preview, setPreview] = useState<ModificationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lastFormValues = useRef<ModificationFormValues | null>(null);

  const form = useForm<ModificationFormValues>({
    resolver: zodResolver(ModificationSchema),
    defaultValues: {
      checkIn: currentCheckIn,
      checkOut: currentCheckOut,
      adults: currentAdults,
    },
  });

  async function handlePreview(values: ModificationFormValues) {
    setPreviewLoading(true);
    setErrorMessage(null);
    lastFormValues.current = values;
    try {
      const result = await previewModification(bookingId, {
        checkIn: values.checkIn,
        checkOut: values.checkOut,
        guests: { adults: values.adults, children: 0, infants: 0 },
      });

      if (!result.available) {
        setPhase("conflict");
        setPreview(result);
      } else {
        setPreview(result);
        setPhase("preview");
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err as ApiError & { data?: { code?: string } }).data?.code;
        if (code === "DATES_UNAVAILABLE") {
          setPhase("conflict");
          return;
        }
        setErrorMessage(err.message);
      } else {
        setErrorMessage("Unable to check availability. Please try again.");
      }
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleConfirm() {
    if (!lastFormValues.current) return;
    setPhase("submitting");
    try {
      const result = await requestModification(bookingId, {
        checkIn: lastFormValues.current.checkIn,
        checkOut: lastFormValues.current.checkOut,
        guests: { adults: lastFormValues.current.adults, children: 0, infants: 0 },
      });
      onOpenChange(false);
      onModified(result);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : "Unable to submit modification.",
      );
      setPhase("preview");
    }
  }

  const priceDiff = preview?.priceDifference;
  const diffSign = priceDiff && priceDiff.amount > 0 ? "+" : "−";
  const diffColor = priceDiff && priceDiff.amount > 0 ? "text-error-600" : "text-success-700";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Modify booking"
      description="Request a change to your dates or guest count."
    >
      <div className="mt-4 space-y-4">
        {(phase === "form" || phase === "conflict") && (
          <form onSubmit={form.handleSubmit(handlePreview)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">
                  New check-in
                </label>
                <Input type="date" size="sm" {...form.register("checkIn")} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-neutral-600">
                  New check-out
                </label>
                <Input type="date" size="sm" {...form.register("checkOut")} />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">Adults</label>
              <Input type="number" size="sm" min={1} max={20} {...form.register("adults", { valueAsNumber: true })} />
            </div>

            {phase === "conflict" && (
              <div role="alert" className="rounded-md border border-error-300 bg-error-50 px-3 py-2 text-sm text-error-700">
                These dates are not available. Please choose different dates.
              </div>
            )}

            {errorMessage && (
              <div role="alert" className="rounded-md border border-error-300 bg-error-50 px-3 py-2 text-sm text-error-700">
                {errorMessage}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)} type="button">
                Cancel
              </Button>
              <Button className="flex-1" type="submit" loading={previewLoading}>
                Check availability
              </Button>
            </div>
          </form>
        )}

        {(phase === "preview" || (phase as string) === "submitting") && preview && (
          <>
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm">
              <h3 className="mb-2 font-semibold text-neutral-900">Modification summary</h3>
              <dl className="space-y-1.5">
                <div className="flex justify-between">
                  <dt className="text-neutral-600">New check-in</dt>
                  <dd>{lastFormValues.current?.checkIn}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-600">New check-out</dt>
                  <dd>{lastFormValues.current?.checkOut}</dd>
                </div>
                {priceDiff && (
                  <div className="flex justify-between border-t border-neutral-200 pt-1.5">
                    <dt className="text-neutral-600">
                      {priceDiff.amount > 0 ? "Additional charge" : "Refund"}
                    </dt>
                    <dd className={`font-semibold ${diffColor}`}>
                      {diffSign}{fmt(priceDiff.amount, priceDiff.currency)}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="font-medium text-neutral-700">New total</dt>
                  <dd className="font-bold">{fmt(preview.newTotal, priceDiff?.currency ?? "GBP")}</dd>
                </div>
              </dl>
            </div>

            <p className="text-xs text-neutral-500">
              Modifications are subject to host confirmation. Your original booking remains active until confirmed.
            </p>

            <div className="flex gap-3 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setPhase("form")} type="button">
                Back
              </Button>
              <Button
                className="flex-1"
                loading={phase === "submitting"}
                onClick={handleConfirm}
                type="button"
              >
                Request modification
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
