import { z } from "zod";
import { identifier } from "../common/primitives.js";
import { RoleSchema } from "../common/enums.js";

export { InternalActorContextSchema } from "./actorContext.js";
export type { InternalActorContext } from "./actorContext.js";

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
    /**
     * Opaque refresh token for non-browser clients that cannot use cookies.
     * Browser clients deliver the token via HttpOnly cookie; this field is
     * therefore optional — when absent the route extracts from the cookie.
     */
    refreshToken: z.string().trim().min(1).optional(),
  })
  .strict();
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** 200 response for a successful token refresh. */
export const RefreshResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
  /**
   * New opaque refresh token for non-browser clients.
   * Browser clients receive the rotated token as a Set-Cookie header instead.
   */
  refreshToken: z.string().optional(),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

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

export const VerifyEmailRequestSchema = z
  .object({
    token: z.string().trim().min(1, { message: "Token must not be empty" }),
  })
  .strict();
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

export const ResendVerificationRequestSchema = z
  .object({
    email: emailSchema,
  })
  .strict();
export type ResendVerificationRequest = z.infer<typeof ResendVerificationRequestSchema>;

/** Generic 202 registration/resend response — identical for all branches (enumeration-safe). */
export const RegistrationAcceptedSchema = z.object({
  message: z.string(),
});
export type RegistrationAccepted = z.infer<typeof RegistrationAcceptedSchema>;

export const REGISTRATION_ACCEPTED_MESSAGE =
  "If the address is valid you will receive a verification email.";

/** 200 response for successful email verification. */
export const VerifyEmailResponseSchema = z.object({
  verified: z.literal(true),
});
export type VerifyEmailResponse = z.infer<typeof VerifyEmailResponseSchema>;

/** Sanitized user profile returned in the login response. */
export const LoginUserProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  roles: z.array(z.string()),
  emailVerified: z.boolean(),
});
export type LoginUserProfile = z.infer<typeof LoginUserProfileSchema>;

/** 200 response for successful login. */
export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
  user: LoginUserProfileSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
