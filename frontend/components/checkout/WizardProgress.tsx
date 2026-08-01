"use client";

/**
 * WizardProgress — accessible step indicator for the checkout wizard (WO-068, AC2).
 *
 * Renders an ordered list with aria-current on the active step.
 * Completed steps are visually distinct and navigable via backward navigation.
 */

import { cn } from "@/lib/utils.js";
import { CHECKOUT_STEPS, STEP_LABELS } from "@/lib/validation/checkout.js";
import type { CheckoutStep } from "@/lib/validation/checkout.js";

interface WizardProgressProps {
  currentStep: CheckoutStep;
  completedSteps: CheckoutStep[];
  onStepClick?: (step: CheckoutStep) => void;
}

export function WizardProgress({
  currentStep,
  completedSteps,
  onStepClick,
}: WizardProgressProps) {
  return (
    <nav aria-label="Checkout progress">
      <ol className="flex items-center gap-0">
        {CHECKOUT_STEPS.map((step, index) => {
          const isCompleted = completedSteps.includes(step);
          const isCurrent = step === currentStep;
          const isClickable = isCompleted && onStepClick;

          return (
            <li
              key={step}
              className="flex flex-1 items-center"
              aria-current={isCurrent ? "step" : undefined}
            >
              {/* Connector line (not before first step) */}
              {index > 0 && (
                <div
                  className={cn(
                    "h-0.5 flex-1",
                    isCompleted || isCurrent ? "bg-brand-600" : "bg-neutral-200",
                  )}
                  aria-hidden="true"
                />
              )}

              <div className="flex flex-col items-center">
                <button
                  type="button"
                  onClick={isClickable ? () => onStepClick(step) : undefined}
                  disabled={!isClickable && !isCurrent}
                  aria-label={`${STEP_LABELS[step]}${isCompleted ? " (completed)" : isCurrent ? " (current)" : ""}`}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-colors",
                    isCurrent &&
                      "bg-brand-600 text-white ring-2 ring-brand-600 ring-offset-2",
                    isCompleted &&
                      !isCurrent &&
                      "bg-brand-600 text-white hover:bg-brand-700 cursor-pointer",
                    !isCompleted &&
                      !isCurrent &&
                      "bg-neutral-100 text-neutral-400 cursor-default",
                  )}
                >
                  {isCompleted && !isCurrent ? (
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M3 8l3.5 3.5L13 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <span aria-hidden="true">{index + 1}</span>
                  )}
                </button>
                <span
                  className={cn(
                    "mt-1 text-xs font-medium",
                    isCurrent ? "text-brand-700" : isCompleted ? "text-brand-600" : "text-neutral-400",
                  )}
                >
                  {STEP_LABELS[step]}
                </span>
              </div>

              {/* Connector line (not after last step) */}
              {index < CHECKOUT_STEPS.length - 1 && (
                <div
                  className={cn(
                    "h-0.5 flex-1",
                    isCompleted ? "bg-brand-600" : "bg-neutral-200",
                  )}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
