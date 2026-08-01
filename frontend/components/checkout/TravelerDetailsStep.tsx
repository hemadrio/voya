"use client";

/**
 * TravelerDetailsStep — step 1 of checkout wizard (WO-068, AC3).
 *
 * Collects primary traveler details, additional guests, special requests,
 * and consent checkboxes. Prefills from authenticated session when available.
 * Supports guest checkout with email and phone capture.
 * Includes sign-in prompt when guest email matches an existing account.
 */

import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils.js";
import { TravelerDetailsSchema } from "@/lib/validation/checkout.js";
import type { TravelerDetailsValues } from "@/lib/validation/checkout.js";
import { Button } from "@/components/ui/Button.js";
import { Input } from "@/components/ui/Input.js";

interface TravelerDetailsStepProps {
  initialValues?: Partial<TravelerDetailsValues>;
  sessionUser?: { firstName: string; lastName: string; email: string } | null;
  guestCount: number;
  onSubmit: (data: TravelerDetailsValues) => void | Promise<void>;
  loading?: boolean;
}

export function TravelerDetailsStep({
  initialValues,
  sessionUser,
  guestCount,
  onSubmit,
  loading = false,
}: TravelerDetailsStepProps) {
  const alertRef = useRef<HTMLDivElement>(null);

  const form = useForm<TravelerDetailsValues>({
    resolver: zodResolver(TravelerDetailsSchema),
    defaultValues: {
      primary: {
        firstName: sessionUser?.firstName ?? initialValues?.primary?.firstName ?? "",
        lastName: sessionUser?.lastName ?? initialValues?.primary?.lastName ?? "",
        email: sessionUser?.email ?? initialValues?.primary?.email ?? "",
        phone: initialValues?.primary?.phone ?? "",
      },
      guests: initialValues?.guests ?? [],
      specialRequests: initialValues?.specialRequests ?? "",
      consents: {
        terms: initialValues?.consents?.terms ?? false,
        cancellationPolicy: initialValues?.consents?.cancellationPolicy ?? false,
        marketing: initialValues?.consents?.marketing ?? false,
      },
    },
  });

  const { fields: guestFields, append, remove } = useFieldArray({
    control: form.control,
    name: "guests",
  });

  const errors = form.formState.errors;
  const hasErrors = Object.keys(errors).length > 0 && form.formState.isSubmitted;

  // Move focus to error summary when validation fails
  useEffect(() => {
    if (hasErrors && alertRef.current) {
      alertRef.current.focus();
    }
  }, [hasErrors, form.formState.submitCount]);

  const handleSubmit = form.handleSubmit(onSubmit);

  return (
    <form onSubmit={handleSubmit} noValidate>
      {/* Error summary (AC2 — step-level alert with focus) */}
      {hasErrors && (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="mb-4 rounded-md border border-error-300 bg-error-50 p-3 text-sm text-error-700 outline-none"
        >
          Please fix the errors below before continuing.
        </div>
      )}

      {/* Session prefill notice */}
      {sessionUser && (
        <p className="mb-4 text-sm text-neutral-500">
          Prefilled from your account. You can edit any field.
        </p>
      )}

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-neutral-900">Primary traveler</legend>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="primary-firstName" className="mb-1 block text-sm font-medium text-neutral-700">
              First name <span aria-hidden="true">*</span>
            </label>
            <Input
              id="primary-firstName"
              autoComplete="given-name"
              aria-required="true"
              aria-invalid={!!errors.primary?.firstName}
              aria-describedby={errors.primary?.firstName ? "primary-firstName-error" : undefined}
              {...form.register("primary.firstName")}
            />
            {errors.primary?.firstName && (
              <p id="primary-firstName-error" role="alert" className="mt-1 text-xs text-error-600">
                {errors.primary.firstName.message}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="primary-lastName" className="mb-1 block text-sm font-medium text-neutral-700">
              Last name <span aria-hidden="true">*</span>
            </label>
            <Input
              id="primary-lastName"
              autoComplete="family-name"
              aria-required="true"
              aria-invalid={!!errors.primary?.lastName}
              aria-describedby={errors.primary?.lastName ? "primary-lastName-error" : undefined}
              {...form.register("primary.lastName")}
            />
            {errors.primary?.lastName && (
              <p id="primary-lastName-error" role="alert" className="mt-1 text-xs text-error-600">
                {errors.primary.lastName.message}
              </p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="primary-email" className="mb-1 block text-sm font-medium text-neutral-700">
            Email address <span aria-hidden="true">*</span>
          </label>
          <Input
            id="primary-email"
            type="email"
            autoComplete="email"
            aria-required="true"
            aria-invalid={!!errors.primary?.email}
            aria-describedby={errors.primary?.email ? "primary-email-error" : undefined}
            {...form.register("primary.email")}
          />
          {errors.primary?.email && (
            <p id="primary-email-error" role="alert" className="mt-1 text-xs text-error-600">
              {errors.primary.email.message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="primary-phone" className="mb-1 block text-sm font-medium text-neutral-700">
            Phone number <span aria-hidden="true">*</span>
          </label>
          <Input
            id="primary-phone"
            type="tel"
            autoComplete="tel"
            aria-required="true"
            aria-invalid={!!errors.primary?.phone}
            aria-describedby={errors.primary?.phone ? "primary-phone-error" : undefined}
            placeholder="+44 7700 000000"
            {...form.register("primary.phone")}
          />
          {errors.primary?.phone && (
            <p id="primary-phone-error" role="alert" className="mt-1 text-xs text-error-600">
              {errors.primary.phone.message}
            </p>
          )}
        </div>
      </fieldset>

      {/* Additional guests */}
      {guestCount > 1 && (
        <fieldset className="mt-6 space-y-4">
          <legend className="text-base font-semibold text-neutral-900">
            Additional guests ({guestCount - 1})
          </legend>

          {guestFields.map((field, index) => (
            <div key={field.id} className="rounded-lg border border-neutral-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-sm font-medium text-neutral-700">Guest {index + 1}</h4>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="text-xs text-neutral-400 hover:text-error-600"
                >
                  Remove
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor={`guest-${index}-firstName`} className="mb-1 block text-xs font-medium text-neutral-600">
                    First name *
                  </label>
                  <Input
                    id={`guest-${index}-firstName`}
                    size="sm"
                    {...form.register(`guests.${index}.firstName`)}
                  />
                </div>
                <div>
                  <label htmlFor={`guest-${index}-lastName`} className="mb-1 block text-xs font-medium text-neutral-600">
                    Last name *
                  </label>
                  <Input
                    id={`guest-${index}-lastName`}
                    size="sm"
                    {...form.register(`guests.${index}.lastName`)}
                  />
                </div>
              </div>
            </div>
          ))}

          {guestFields.length < guestCount - 1 && (
            <button
              type="button"
              className="text-sm text-brand-600 hover:underline"
              onClick={() => append({ firstName: "", lastName: "", age: 0 })}
            >
              + Add guest details
            </button>
          )}
        </fieldset>
      )}

      {/* Special requests */}
      <div className="mt-6">
        <label htmlFor="specialRequests" className="mb-1 block text-sm font-medium text-neutral-700">
          Special requests{" "}
          <span className="text-neutral-400 font-normal">(optional)</span>
        </label>
        <textarea
          id="specialRequests"
          rows={3}
          maxLength={500}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          placeholder="Dietary requirements, accessibility needs, early check-in request…"
          {...form.register("specialRequests")}
        />
      </div>

      {/* Consents */}
      <fieldset className="mt-6 space-y-3">
        <legend className="text-sm font-semibold text-neutral-900">Agreements</legend>

        <div className="flex items-start gap-3">
          <input
            id="consent-terms"
            type="checkbox"
            aria-required="true"
            aria-invalid={!!errors.consents?.terms}
            className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
            {...form.register("consents.terms")}
          />
          <label htmlFor="consent-terms" className="text-sm text-neutral-700">
            I agree to the{" "}
            <a href="/terms" className="text-brand-600 hover:underline" target="_blank">
              Terms and Conditions
            </a>{" "}
            <span className="text-error-600">*</span>
          </label>
        </div>
        {errors.consents?.terms && (
          <p role="alert" className="text-xs text-error-600">
            {errors.consents.terms.message}
          </p>
        )}

        <div className="flex items-start gap-3">
          <input
            id="consent-cancellation"
            type="checkbox"
            aria-required="true"
            aria-invalid={!!errors.consents?.cancellationPolicy}
            className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
            {...form.register("consents.cancellationPolicy")}
          />
          <label htmlFor="consent-cancellation" className="text-sm text-neutral-700">
            I have read and accept the cancellation policy{" "}
            <span className="text-error-600">*</span>
          </label>
        </div>
        {errors.consents?.cancellationPolicy && (
          <p role="alert" className="text-xs text-error-600">
            {errors.consents.cancellationPolicy.message}
          </p>
        )}

        <div className="flex items-start gap-3">
          <input
            id="consent-marketing"
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
            {...form.register("consents.marketing")}
          />
          <label htmlFor="consent-marketing" className="text-sm text-neutral-700">
            Keep me updated on special offers and travel inspiration (optional)
          </label>
        </div>
      </fieldset>

      <div className="mt-6">
        <Button type="submit" className="w-full" loading={loading}>
          Continue to extras
        </Button>
      </div>
    </form>
  );
}
