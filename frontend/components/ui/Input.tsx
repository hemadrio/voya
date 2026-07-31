"use client";

import * as React from "react";
import { cn } from "@/lib/utils.js";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string | undefined;
  error?: string | undefined;
  hint?: string | undefined;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, id, type = "text", ...props }, ref) => {
    const inputId = id ?? (label !== undefined ? label.toLowerCase().replace(/\s+/g, "-") : undefined);
    const errorId = inputId !== undefined ? `${inputId}-error` : undefined;
    const hintId = inputId !== undefined ? `${inputId}-hint` : undefined;

    return (
      <div className="flex flex-col gap-1">
        {label !== undefined && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-neutral-700"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          type={type}
          aria-describedby={
            [errorId, hintId].filter(Boolean).join(" ") || undefined
          }
          aria-invalid={error !== undefined ? true : undefined}
          className={cn(
            "h-10 w-full rounded-md border px-3 py-2 text-sm",
            "bg-white text-neutral-900 placeholder:text-neutral-400",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
            "disabled:cursor-not-allowed disabled:opacity-50",
            error !== undefined
              ? "border-error-500 focus-visible:ring-error-500"
              : "border-neutral-300",
            className,
          )}
          {...props}
        />
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
Input.displayName = "Input";

export { Input };
