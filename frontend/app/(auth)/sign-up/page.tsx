"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { RegisterSchema } from "@/lib/validation/auth";
import type { RegisterFormValues } from "@/lib/validation/auth";
import { register as registerAction } from "@/lib/auth/actions";

export default function SignUpPage() {
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [verificationPending, setVerificationPending] = React.useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(RegisterSchema),
    defaultValues: { locale: "en" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    const result = await registerAction(values);
    if (!result.ok) {
      if (result.fieldErrors !== undefined) {
        for (const [field, message] of Object.entries(result.fieldErrors)) {
          setError(field as keyof RegisterFormValues, { message });
        }
      } else {
        setServerError(result.message);
      }
      return;
    }
    if (result.data.emailVerificationRequired) {
      setVerificationPending(true);
    }
  });

  if (verificationPending) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-bold text-neutral-900">Check your email</h1>
        <p className="text-sm text-neutral-600">
          We sent a verification link to your email address. Click it to activate your account.
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
        <h1 className="text-2xl font-bold text-neutral-900">Create an account</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Already have an account?{" "}
          <Link href="/sign-in" className="text-brand-600 hover:underline font-medium">
            Sign in
          </Link>
        </p>
      </div>

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {serverError !== null && (
          <div role="alert" className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="firstName" className="block text-sm font-medium text-neutral-700">
              First name
            </label>
            <input
              id="firstName"
              type="text"
              autoComplete="given-name"
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              aria-describedby={errors.firstName !== undefined ? "firstName-error" : undefined}
              {...register("firstName")}
            />
            {errors.firstName !== undefined && (
              <p id="firstName-error" role="alert" className="mt-1 text-xs text-red-600">
                {errors.firstName.message}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="lastName" className="block text-sm font-medium text-neutral-700">
              Last name
            </label>
            <input
              id="lastName"
              type="text"
              autoComplete="family-name"
              className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              aria-describedby={errors.lastName !== undefined ? "lastName-error" : undefined}
              {...register("lastName")}
            />
            {errors.lastName !== undefined && (
              <p id="lastName-error" role="alert" className="mt-1 text-xs text-red-600">
                {errors.lastName.message}
              </p>
            )}
          </div>
        </div>

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

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-neutral-700">
            Password
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
            Confirm password
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

        <input type="hidden" {...register("locale")} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isSubmitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </div>
  );
}
