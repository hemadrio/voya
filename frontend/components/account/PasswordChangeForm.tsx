"use client";

/**
 * PasswordChangeForm — current password verification, strength check, session notice (WO-069, AC10).
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/Button.js";
import { Input } from "@/components/ui/Input.js";
import { useToast } from "@/components/ui/Toast.js";
import { changePassword } from "@/lib/api/account.js";
import { ApiError } from "@/lib/api/errors.js";

const PasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain an uppercase letter")
      .regex(/[0-9]/, "Must contain a number")
      .regex(/[^A-Za-z0-9]/, "Must contain a special character"),
    confirmPassword: z.string().min(1, "Please confirm your new password"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });

type PasswordFormValues = z.infer<typeof PasswordSchema>;

export function PasswordChangeForm() {
  const [success, setSuccess] = useState(false);
  const { addToast } = useToast();

  const form = useForm<PasswordFormValues>({
    resolver: zodResolver(PasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  async function onSubmit(values: PasswordFormValues) {
    try {
      await changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      setSuccess(true);
      form.reset();
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err as ApiError & { data?: { code?: string } }).data?.code;
        if (code === "INVALID_CURRENT_PASSWORD") {
          form.setError("currentPassword", { message: "Current password is incorrect." });
          return;
        }
        addToast({ message: err.message, variant: "error" });
      } else {
        addToast({ message: "Unable to change password. Please try again.", variant: "error" });
      }
    }
  }

  if (success) {
    return (
      <div
        role="status"
        className="rounded-md border border-success-300 bg-success-50 p-4 text-sm text-success-700"
      >
        <p className="font-medium">Password changed</p>
        <p className="mt-1">
          Your password has been updated. Other active sessions have been signed out for security.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4 max-w-sm">
      <div>
        <label htmlFor="pw-current" className="mb-1 block text-sm font-medium text-neutral-700">
          Current password <span aria-hidden>*</span>
        </label>
        <Input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          aria-required="true"
          aria-invalid={!!form.formState.errors.currentPassword}
          {...form.register("currentPassword")}
        />
        {form.formState.errors.currentPassword && (
          <p role="alert" className="mt-1 text-xs text-error-600">
            {form.formState.errors.currentPassword.message}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="pw-new" className="mb-1 block text-sm font-medium text-neutral-700">
          New password <span aria-hidden>*</span>
        </label>
        <Input
          id="pw-new"
          type="password"
          autoComplete="new-password"
          aria-required="true"
          aria-invalid={!!form.formState.errors.newPassword}
          {...form.register("newPassword")}
        />
        {form.formState.errors.newPassword ? (
          <p role="alert" className="mt-1 text-xs text-error-600">
            {form.formState.errors.newPassword.message}
          </p>
        ) : (
          <p className="mt-1 text-xs text-neutral-400">
            At least 8 characters, one uppercase, one number, one special character.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="pw-confirm" className="mb-1 block text-sm font-medium text-neutral-700">
          Confirm new password <span aria-hidden>*</span>
        </label>
        <Input
          id="pw-confirm"
          type="password"
          autoComplete="new-password"
          aria-required="true"
          aria-invalid={!!form.formState.errors.confirmPassword}
          {...form.register("confirmPassword")}
        />
        {form.formState.errors.confirmPassword && (
          <p role="alert" className="mt-1 text-xs text-error-600">
            {form.formState.errors.confirmPassword.message}
          </p>
        )}
      </div>

      <Button type="submit" loading={form.formState.isSubmitting}>
        Change password
      </Button>
    </form>
  );
}
