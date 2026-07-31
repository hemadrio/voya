"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ResetPasswordSchema } from "@/lib/validation/auth";
import type { ResetPasswordFormValues } from "@/lib/validation/auth";
import { resetPassword } from "@/lib/auth/actions";

export default function ResetPasswordPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [expired, setExpired] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(ResetPasswordSchema),
    defaultValues: { token },
  });

  if (token === "") {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-bold text-neutral-900">Invalid link</h1>
        <p className="text-sm text-neutral-600">
          This password reset link is invalid. Please request a new one.
        </p>
        <Link href="/forgot-password" className="text-brand-600 hover:underline text-sm font-medium">
          Request new link
        </Link>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-bold text-neutral-900">Link expired</h1>
        <p className="text-sm text-neutral-600">
          This password reset link has expired. Please request a new one.
        </p>
        <Link href="/forgot-password" className="text-brand-600 hover:underline text-sm font-medium">
          Request new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-bold text-neutral-900">Password updated</h1>
        <p className="text-sm text-neutral-600">
          Your password has been changed. You can now sign in.
        </p>
        <Link href="/sign-in" className="text-brand-600 hover:underline text-sm font-medium">
          Sign in
        </Link>
      </div>
    );
  }

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    const result = await resetPassword(values);
    if (!result.ok) {
      setServerError(result.message);
      return;
    }
    if (result.data.expired) {
      setExpired(true);
      return;
    }
    setDone(true);
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Set a new password</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Choose a strong password that you don&apos;t use elsewhere.
        </p>
      </div>

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError !== null && (
          <div role="alert" className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <input type="hidden" {...register("token")} />

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-neutral-700">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            aria-describedby={errors.password !== undefined ? "password-error" : undefined}
            {...register("password")}
          />
          {errors.password !== undefined && (
            <p id="password-error" role="alert" className="mt-1 text-xs text-red-600">
              {errors.password.message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-neutral-700">
            Confirm new password
          </label>
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            aria-describedby={errors.confirmPassword !== undefined ? "confirmPassword-error" : undefined}
            {...register("confirmPassword")}
          />
          {errors.confirmPassword !== undefined && (
            <p id="confirmPassword-error" role="alert" className="mt-1 text-xs text-red-600">
              {errors.confirmPassword.message}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "Updating…" : "Update password"}
        </button>
      </form>
    </div>
  );
}
