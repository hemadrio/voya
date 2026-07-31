"use client";

import * as React from "react";
import { cn } from "@/lib/utils.js";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string | undefined;
  error?: string | undefined;
  description?: string | undefined;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, error, description, id, ...props }, ref) => {
    const checkboxId = id ?? (label !== undefined ? label.toLowerCase().replace(/\s+/g, "-") : undefined);
    const errorId = checkboxId !== undefined ? `${checkboxId}-error` : undefined;
    const descId = checkboxId !== undefined ? `${checkboxId}-desc` : undefined;

    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <input
            ref={ref}
            id={checkboxId}
            type="checkbox"
            role="checkbox"
            aria-describedby={
              [errorId, descId].filter(Boolean).join(" ") || undefined
            }
            aria-invalid={error !== undefined ? true : undefined}
            className={cn(
              "mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
              "disabled:cursor-not-allowed disabled:opacity-50",
              error !== undefined && "border-error-500",
              className,
            )}
            {...props}
          />
          {label !== undefined && (
            <label
              htmlFor={checkboxId}
              className="text-sm font-medium text-neutral-700 cursor-pointer"
            >
              {label}
              {description !== undefined && (
                <span id={descId} className="block text-xs font-normal text-neutral-500 mt-0.5">
                  {description}
                </span>
              )}
            </label>
          )}
        </div>
        {error !== undefined && (
          <p id={errorId} className="text-xs text-error-700 ml-6" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
