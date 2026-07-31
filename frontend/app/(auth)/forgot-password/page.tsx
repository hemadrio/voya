"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { ForgotPasswordSchema } from "@/lib/validation/auth";
import type { ForgotPasswordFormValues } from "@/lib/validation/auth";
import { forgotPassword } from "@/lib/auth/actions";

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(ForgotPasswordSchema),
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    const result = await forgotPassword(values);
    if (!result.ok) {
      setServerError(result.message);
      return;
    }
    setSubmitted(true);
  });

  if (submitted) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-bold text-neutral-900">Check your email</h1>
        <p className="text-sm text-neutral-600">
          If an account exists for that email address, we&apos;ve sent a password reset link.
        </p>
        <Link href="/sign-in" className="text-brand-600 hover:underline text-sm font-medium">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Reset your password</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Enter the email you used to register and we&apos;ll send you a reset link.
        </p>
      </div>

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError !== null && (
          <div role="alert" className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-neutral-700">
            Email address
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            aria-describedby={errors.email !== undefined ? "email-error" : undefined}
            {...register("email")}
          />
          {errors.email !== undefined && (
            <p id="email-error" role="alert" className="mt-1 text-xs text-red-600">
              {errors.email.message}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "Sending…" : "Send reset link"}
        </button>
      </form>

      <p className="text-center text-sm text-neutral-600">
        <Link href="/sign-in" className="text-brand-600 hover:underline font-medium">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
