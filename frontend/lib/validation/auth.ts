/**
 * Zod validation schemas for all auth forms.
 *
 * Schemas are shared between client-side React Hook Form validation and
 * server action parsing so validation messages are byte-identical on both
 * sides of the wire.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const emailField = z
  .string({ required_error: "Email is required" })
  .trim()
  .toLowerCase()
  .email({ message: "Enter a valid email address" });

const passwordField = z
  .string({ required_error: "Password is required" })
  .min(8, { message: "Password must be at least 8 characters" })
  .max(128, { message: "Password must be at most 128 characters" })
  .regex(/[A-Z]/, { message: "Password must contain at least one uppercase letter" })
  .regex(/[0-9]/, { message: "Password must contain at least one number" });

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export const RegisterSchema = z
  .object({
    firstName: z
      .string({ required_error: "First name is required" })
      .trim()
      .min(1, { message: "First name is required" })
      .max(64, { message: "First name must be at most 64 characters" }),
    lastName: z
      .string({ required_error: "Last name is required" })
      .trim()
      .min(1, { message: "Last name is required" })
      .max(64, { message: "Last name must be at most 64 characters" }),
    email: emailField,
    password: passwordField,
    confirmPassword: z.string({ required_error: "Please confirm your password" }),
    locale: z.string().default("en"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type RegisterFormValues = z.infer<typeof RegisterSchema>;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export const LoginSchema = z.object({
  email: emailField,
  password: z
    .string({ required_error: "Password is required" })
    .min(1, { message: "Password is required" }),
});

export type LoginFormValues = z.infer<typeof LoginSchema>;

// ---------------------------------------------------------------------------
// Forgot password
// ---------------------------------------------------------------------------

export const ForgotPasswordSchema = z.object({
  email: emailField,
});

export type ForgotPasswordFormValues = z.infer<typeof ForgotPasswordSchema>;

// ---------------------------------------------------------------------------
// Reset password
// ---------------------------------------------------------------------------

export const ResetPasswordSchema = z
  .object({
    token: z.string().min(1, { message: "Reset token is missing" }),
    password: passwordField,
    confirmPassword: z.string({ required_error: "Please confirm your password" }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type ResetPasswordFormValues = z.infer<typeof ResetPasswordSchema>;
