import { z } from "zod";
import { identifier } from "../common/primitives.js";
import { RoleSchema } from "../common/enums.js";

export const EMAIL_INVALID_MESSAGE = "Email must be a valid email address";
export const PASSWORD_MIN_LENGTH_MESSAGE = "Password must be at least 8 characters";
export const PASSWORD_COMPLEXITY_MESSAGE =
  "Password must include at least one uppercase letter, one lowercase letter, and one number";

const PASSWORD_COMPLEXITY_PATTERN = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;

const emailSchema = z.string().trim().toLowerCase().email({ message: EMAIL_INVALID_MESSAGE });

const passwordSchema = z
  .string()
  .min(8, { message: PASSWORD_MIN_LENGTH_MESSAGE })
  .regex(PASSWORD_COMPLEXITY_PATTERN, { message: PASSWORD_COMPLEXITY_MESSAGE });

export const RegisterRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
  })
  .strict();
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, { message: "Password must not be empty" }),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z
  .object({
    refreshToken: z.string().trim().min(1),
  })
  .strict();
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = z
  .object({
    refreshToken: z.string().trim().min(1),
  })
  .strict();
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const OAuthCallbackRequestSchema = z
  .object({
    code: z.string().trim().min(1),
    state: z.string().trim().min(1),
  })
  .strict();
export type OAuthCallbackRequest = z.infer<typeof OAuthCallbackRequestSchema>;

export const AuthResponseSchema = z
  .object({
    userId: identifier,
    role: RoleSchema,
    accessToken: z.string().trim().min(1),
    expiresIn: z.number().int().positive(),
  })
  .strict();
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const ForgotPasswordRequestSchema = z
  .object({
    email: emailSchema,
  })
  .strict();
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z
  .object({
    token: z.string().trim().min(1, { message: "Token must not be empty" }),
    password: passwordSchema,
  })
  .strict();
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
