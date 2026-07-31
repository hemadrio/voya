"use server";

/**
 * Server actions for auth — the only place tokens are exchanged and cookies set.
 *
 * Token material never passes through the browser; the cookie is httpOnly.
 * All actions return an ActionResult discriminated union so client form
 * components can surface field errors or redirect on success without
 * knowing about backend HTTP status codes.
 */

import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { getSession, setSession, clearSession } from "./session";
import {
  RegisterSchema,
  LoginSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
} from "@/lib/validation/auth";
import type {
  RegisterFormValues,
  LoginFormValues,
  ForgotPasswordFormValues,
  ResetPasswordFormValues,
} from "@/lib/validation/auth";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;

export interface ActionSuccess<T = void> {
  readonly ok: true;
  readonly data: T;
}

export interface ActionFailure {
  readonly ok: false;
  readonly message: string;
  readonly fieldErrors?: FieldErrors;
  readonly code?: string;
}

export type ActionResult<T = void> = ActionSuccess<T> | ActionFailure;

// ---------------------------------------------------------------------------
// Backend shapes
// ---------------------------------------------------------------------------

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl?: string;
    locale: string;
    currency: string;
  };
}

interface RegisterResponse {
  userId: string;
  emailVerificationRequired: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  // Some backends include user info when immediately issuing tokens
  user?: {
    id?: string;
    locale?: string;
    currency?: string;
    avatarUrl?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API = env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "");

async function apiFetch<T>(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; body: unknown }> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = res.headers.get("content-type")?.includes("application/json")
      ? await res.json()
      : null;
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, status: res.status, body: data };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

interface BackendError {
  error?: { message?: string; fieldErrors?: Record<string, string> };
  message?: string;
}

function toFailure(status: number, body: unknown): ActionFailure {
  const err = body as BackendError | null;
  const message = err?.error?.message ?? err?.message ?? "Something went wrong. Please try again.";
  const fieldErrors = err?.error?.fieldErrors;
  if (status === 429) {
    return { ok: false, message: "Too many requests. Please wait and try again.", code: "RATE_LIMITED" };
  }
  if (status === 423) {
    return { ok: false, message: "Your account is temporarily locked. Please try again later.", code: "LOCKED" };
  }
  return { ok: false, message, ...(fieldErrors !== undefined ? { fieldErrors } : {}) };
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

export async function login(
  values: LoginFormValues,
  returnTo?: string,
): Promise<ActionResult> {
  const parsed = LoginSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Please fix the form errors before submitting.",
      fieldErrors: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  const result = await apiFetch<LoginResponse>("/auth/login", {
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (!result.ok) {
    // Non-enumerating — never reveal whether email exists
    if (result.status === 401) {
      return { ok: false, message: "The email or password is incorrect." };
    }
    return toFailure(result.status, result.body);
  }

  const { accessToken, refreshToken, expiresIn, user } = result.data;

  await setSession({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
      locale: user.locale,
      currency: user.currency,
    },
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  const destination = sanitizeReturnTo(returnTo) ?? "/account";
  redirect(destination);
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export async function register(values: RegisterFormValues): Promise<ActionResult<{ emailVerificationRequired: boolean }>> {
  const parsed = RegisterSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Please fix the form errors before submitting.",
      fieldErrors: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  const result = await apiFetch<RegisterResponse>("/auth/register", {
    email: parsed.data.email,
    password: parsed.data.password,
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    locale: parsed.data.locale,
  });

  if (!result.ok) {
    if (result.status === 409) {
      return {
        ok: false,
        message: "An account with this email already exists.",
        fieldErrors: { email: "An account with this email already exists." },
      };
    }
    return toFailure(result.status, result.body);
  }

  const { emailVerificationRequired, accessToken, refreshToken, expiresIn } = result.data;

  if (!emailVerificationRequired && accessToken !== undefined && refreshToken !== undefined && expiresIn !== undefined) {
    // Build session from form values + response — register response doesn't include
    // a full user object in the base contract, so we use the submitted form data.
    const { userId, user: extraUserData } = result.data;
    await setSession({
      user: {
        id: extraUserData?.id ?? userId,
        email: parsed.data.email,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        locale: extraUserData?.locale ?? parsed.data.locale,
        currency: extraUserData?.currency ?? "USD",
        ...(extraUserData?.avatarUrl !== undefined ? { avatarUrl: extraUserData.avatarUrl } : {}),
      },
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    // Redirect to account after successful immediate session
    redirect("/account");
  }

  return { ok: true, data: { emailVerificationRequired } };
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

export async function logout(): Promise<void> {
  // Read refresh token server-side — tokens never come from the client
  const session = await getSession();
  if (session !== null) {
    // Best-effort backend revocation — don't block session clear on failure
    void apiFetch("/auth/logout", { refreshToken: session.refreshToken });
  }
  await clearSession();
  redirect("/");
}

// ---------------------------------------------------------------------------
// forgotPassword
// ---------------------------------------------------------------------------

export async function forgotPassword(
  values: ForgotPasswordFormValues,
): Promise<ActionResult> {
  const parsed = ForgotPasswordSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Please enter a valid email address.",
      fieldErrors: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  // Always succeed regardless of whether email exists — prevents enumeration
  void apiFetch("/auth/password/forgot", { email: parsed.data.email });

  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// resetPassword
// ---------------------------------------------------------------------------

export async function resetPassword(
  values: ResetPasswordFormValues,
): Promise<ActionResult<{ expired: boolean }>> {
  const parsed = ResetPasswordSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Please fix the form errors before submitting.",
      fieldErrors: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join("."), i.message]),
      ),
    };
  }

  const result = await apiFetch("/auth/password/reset", {
    token: parsed.data.token,
    password: parsed.data.password,
  });

  if (!result.ok) {
    if (result.status === 410) {
      return { ok: true, data: { expired: true } };
    }
    return toFailure(result.status, result.body);
  }

  return { ok: true, data: { expired: false } };
}

// ---------------------------------------------------------------------------
// resendVerification
// ---------------------------------------------------------------------------

export async function resendVerification(): Promise<ActionResult> {
  const result = await apiFetch("/auth/email/verify/resend", {});
  if (!result.ok) return toFailure(result.status, result.body);
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// sanitizeReturnTo — reject external origins and protocol-relative URLs
// ---------------------------------------------------------------------------

export function sanitizeReturnTo(returnTo: string | undefined): string | null {
  if (returnTo === undefined || returnTo === "") return null;
  // Reject anything that looks like an external URL
  if (returnTo.startsWith("//") || returnTo.startsWith("http://") || returnTo.startsWith("https://")) {
    return null;
  }
  // Must start with /
  if (!returnTo.startsWith("/")) return null;
  // Reject auth routes as redirect destinations (loop prevention)
  if (returnTo.startsWith("/sign-in") || returnTo.startsWith("/sign-up")) return null;
  return returnTo;
}
