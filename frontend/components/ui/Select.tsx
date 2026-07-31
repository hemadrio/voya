"use client";

import * as React from "react";
import { cn } from "@/lib/utils.js";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean | undefined;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  options?: ReadonlyArray<SelectOption> | undefined;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, hint, id, options, children, ...props }, ref) => {
    const selectId = id ?? (label !== undefined ? label.toLowerCase().replace(/\s+/g, "-") : undefined);
    const errorId = selectId !== undefined ? `${selectId}-error` : undefined;
    const hintId = selectId !== undefined ? `${selectId}-hint` : undefined;

    return (
      <div className="flex flex-col gap-1">
        {label !== undefined && (
          <label
            htmlFor={selectId}
            className="text-sm font-medium text-neutral-700"
          >
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          aria-describedby={
            [errorId, hintId].filter(Boolean).join(" ") || undefined
          }
          aria-invalid={error !== undefined ? true : undefined}
          className={cn(
            "h-10 w-full rounded-md border px-3 py-2 text-sm",
            "bg-white text-neutral-900",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
            "disabled:cursor-not-allowed disabled:opacity-50",
            error !== undefined
              ? "border-error-500 focus-visible:ring-error-500"
              : "border-neutral-300",
            className,
          )}
          {...props}
        >
          {options !== undefined
            ? options.map((opt) => (
                <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                  {opt.label}
                </option>
              ))
            : children}
        </select>
        {error !== undefined && (
          <p id={errorId} className="text-xs text-error-700" role="alert">
            {error}
          </p>
        )}
        {hint !== undefined && error === undefined && (
          <p id={hintId} className="text-xs text-neutral-500">
            {hint}
          </p>
        )}
      </div>
    );
  },
);
Select.displayName = "Select";

export { Select };
