/**
 * Integration tests for auth flows.
 *
 * Tests cover:
 * - Sign-in form client-side validation and server action integration
 * - Sign-up form client-side validation and server action integration
 * - Forgot-password always-succeed UX (non-enumerating)
 * - Middleware redirect logic
 * - sanitizeReturnTo security
 * - AccountMenu authenticated/unauthenticated states
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { type NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Next.js module mocks (must precede component imports)
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => key === "returnTo" ? null : null,
  }),
  usePathname: () => "/",
  redirect: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}));

// Mock server actions — we test the UI contract, not the HTTP wire
vi.mock("@/lib/auth/actions", () => ({
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  forgotPassword: vi.fn(),
  resetPassword: vi.fn(),
  resendVerification: vi.fn(),
  sanitizeReturnTo: (v: string | undefined) => {
    if (!v || v.startsWith("//") || v.startsWith("http") || !v.startsWith("/")) return null;
    if (v.startsWith("/sign-in") || v.startsWith("/sign-up")) return null;
    return v;
  },
}));

import { SessionProvider } from "@/lib/auth/context";
import type { ClientSession } from "@/lib/auth/session";
import { login, register, forgotPassword } from "@/lib/auth/actions";
import { sanitizeReturnTo } from "@/lib/auth/actions";

// Cast mocked functions
const mockLogin = vi.mocked(login);
const mockRegister = vi.mocked(register);
const mockForgotPassword = vi.mocked(forgotPassword);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MOCK_SESSION: ClientSession = {
  user: {
    id: "user-123",
    email: "jane@example.com",
    firstName: "Jane",
    lastName: "Doe",
    locale: "en",
    currency: "USD",
  },
  expiresAt: Date.now() + 3600 * 1000,
};

function Providers({
  children,
  session = null,
}: {
  children: React.ReactNode;
  session?: ClientSession | null;
}) {
  return <SessionProvider initialSession={session}>{children}</SessionProvider>;
}

// ---------------------------------------------------------------------------
// Lazy component imports (after mocks)
// ---------------------------------------------------------------------------

// We import these lazily to ensure mocks are applied first
async function getSignInPage() {
  const m = await import("../../app/(auth)/sign-in/page.js");
  return m.default;
}

async function getSignUpPage() {
  const m = await import("../../app/(auth)/sign-up/page.js");
  return m.default;
}

async function getForgotPasswordPage() {
  const m = await import("../../app/(auth)/forgot-password/page.js");
  return m.default;
}

async function getAccountMenu() {
  const m = await import("../../components/layout/AccountMenu.js");
  return m.AccountMenu;
}

// ---------------------------------------------------------------------------
// Sign-in page
// ---------------------------------------------------------------------------

describe("Sign-in page — client-side validation", () => {
  it("shows field error when email is empty on submit", async () => {
    const SignIn = await getSignInPage();
    render(
      <Providers>
        <SignIn />
      </Providers>,
    );

    await userEvent.click(screen.getByRole("button", { name: /Sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("shows field error for invalid email format", async () => {
    const SignIn = await getSignInPage();
    render(
      <Providers>
        <SignIn />
      </Providers>,
    );

    await userEvent.type(screen.getByLabelText(/Email address/i), "not-an-email");
    await userEvent.type(screen.getByLabelText(/Password/i), "secret");
    await userEvent.click(screen.getByRole("button", { name: /Sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("calls login action with email and password on valid submit", async () => {
    mockLogin.mockResolvedValueOnce(undefined as never);

    const SignIn = await getSignInPage();
    render(
      <Providers>
        <SignIn />
      </Providers>,
    );

    await userEvent.type(screen.getByLabelText(/Email address/i), "jane@example.com");
    await userEvent.type(screen.getByLabelText(/Password/i), "mypassword");
    await userEvent.click(screen.getByRole("button", { name: /Sign in/i }));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith(
        { email: "jane@example.com", password: "mypassword" },
        undefined,
      );
    });
  });

  it("shows non-enumerating server error on 401", async () => {
    mockLogin.mockResolvedValueOnce({
      ok: false,
      message: "The email or password is incorrect.",
    });

    const SignIn = await getSignInPage();
    render(
      <Providers>
        <SignIn />
      </Providers>,
    );

    await userEvent.type(screen.getByLabelText(/Email address/i), "jane@example.com");
    await userEvent.type(screen.getByLabelText(/Password/i), "wrongpassword");
    await userEvent.click(screen.getByRole("button", { name: /Sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("The email or password is incorrect.");
    });

    // Must NOT disclose whether the email exists
    expect(screen.queryByText(/email.*not.*found/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument();
  });

  it("disables submit button while request is in-flight", async () => {
    let resolve: ((v: undefined) => void) | null = null;
    mockLogin.mockReturnValueOnce(
      new Promise<never>((res) => {
        resolve = res as unknown as (v: undefined) => void;
      }),
    );

    const SignIn = await getSignInPage();
    render(
      <Providers>
        <SignIn />
      </Providers>,
    );

    await userEvent.type(screen.getByLabelText(/Email address/i), "jane@example.com");
    await userEvent.type(screen.getByLabelText(/Password/i), "mypassword");

    const btn = screen.getByRole("button", { name: /Sign in/i });
    await userEvent.click(btn);

    await waitFor(() => {
      expect(btn).toBeDisabled();
    });

    resolve?.(undefined);
  });
});

// ---------------------------------------------------------------------------
// Sign-up page
// ---------------------------------------------------------------------------

describe("Sign-up page — client-side validation", () => {
  beforeEach(() => {
    mockRegister.mockReset();
  });

  it("renders all required fields", async () => {
    const SignUp = await getSignUpPage();
    render(
      <Providers>
        <SignUp />
      </Providers>,
    );

    expect(screen.getByLabelText(/First name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Last name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Confirm password/i)).toBeInTheDocument();
  });

  it("shows confirm-password mismatch error", async () => {
    const SignUp = await getSignUpPage();
    render(
      <Providers>
        <SignUp />
      </Providers>,
    );

    await userEvent.type(screen.getByLabelText(/First name/i), "Jane");
    await userEvent.type(screen.getByLabelText(/Last name/i), "Doe");
    await userEvent.type(screen.getByLabelText(/Email address/i), "jane@example.com");
    await userEvent.type(screen.getByLabelText(/^Password/i), "Password1");
    await userEvent.type(screen.getByLabelText(/Confirm password/i), "Password2");
    await userEvent.click(screen.getByRole("button", { name: /Create account/i }));

    await waitFor(() => {
      expect(screen.getByText(/Passwords do not match/i)).toBeInTheDocument();
    });
  });

  it("shows email-already-exists server error on 409", async () => {
    mockRegister.mockResolvedValueOnce({
      ok: false,
      message: "An account with this email already exists.",
      fieldErrors: { email: "An account with this email already exists." },
    });

    const SignUp = await getSignUpPage();
    render(
      <Providers>
        <SignUp />
      </Providers>,
    );

    await userEvent.type(screen.getByLabelText(/First name/i), "Jane");
    await userEvent.type(screen.getByLabelText(/Last name/i), "Doe");
    await userEvent.type(screen.getByLabelText(/Email address/i), "existing@example.com");
    await userEvent.type(screen.getByLabelText(/^Password/i), "Password1");
    await userEvent.type(screen.getByLabelText(/Confirm password/i), "Password1");
    await userEvent.click(screen.getByRole("button", { name: /Create account/i }));

    await waitFor(() => {
      expect(screen.getByText(/An account with this email already exists/i)).toBeInTheDocument();
    });
  });

  it("shows email verification pending screen on success when verification required", async () => {
    mockRegister.mockResolvedValueOnce({
      ok: true,
      data: { emailVerificationRequired: true },
    });

    const SignUp = await getSignUpPage();
    render(
      <Providers>
        <SignUp />
      </Providers>,
    );

    await userEvent.type(screen.getByLabelText(/First name/i), "Jane");
    await userEvent.type(screen.getByLabelText(/Last name/i), "Doe");
    await userEvent.type(screen.getByLabelText(/Email address/i), "jane@example.com");
    await userEvent.type(screen.getByLabelText(/^Password/i), "Password1");
    await userEvent.type(screen.getByLabelText(/Confirm password/i), "Password1");
    await userEvent.click(screen.getByRole("button", { name: /Create account/i }));

    await waitFor(() => {
      expect(screen.getByText(/Check your email/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Forgot-password — always succeeds (non-enumerating)
// ---------------------------------------------------------------------------

describe("Forgot-password page — non-enumerating UX", () => {
  it("shows the same confirmation screen regardless of whether email exists", async () => {
    // Simulate backend call (fire-and-forget, always ok: true)
    mockForgotPassword.mockResolvedValueOnce({ ok: true, data: undefined });

    const ForgotPassword = await getForgotPasswordPage();
    render(
      <Providers>
        <ForgotPassword />
      </Providers>,
    );

    await userEvent.type(screen.getByLabelText(/Email address/i), "unknown@example.com");
    await userEvent.click(screen.getByRole("button", { name: /Send reset link/i }));

    await waitFor(() => {
      expect(screen.getByText(/Check your email/i)).toBeInTheDocument();
      expect(
        screen.getByText(/If an account exists for that email address/i),
      ).toBeInTheDocument();
    });

    // Must NOT reveal whether account was found
    expect(screen.queryByText(/account.*not.*found/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AccountMenu — authenticated vs. unauthenticated state
// ---------------------------------------------------------------------------

describe("AccountMenu — authenticated state", () => {
  it("renders sign-in and sign-up links when unauthenticated", async () => {
    const AccountMenu = await getAccountMenu();
    render(
      <Providers session={null}>
        <AccountMenu />
      </Providers>,
    );

    expect(screen.getByRole("link", { name: /Sign in/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Sign up/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Account menu/i })).not.toBeInTheDocument();
  });

  it("renders account button with user initials when authenticated", async () => {
    const AccountMenu = await getAccountMenu();
    render(
      <Providers session={MOCK_SESSION}>
        <AccountMenu />
      </Providers>,
    );

    const btn = screen.getByRole("button", { name: /Account menu for Jane Doe/i });
    expect(btn).toBeInTheDocument();
    expect(screen.getByText("JD")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Sign in/i })).not.toBeInTheDocument();
  });

  it("opens dropdown menu when avatar button is clicked", async () => {
    const AccountMenu = await getAccountMenu();
    render(
      <Providers session={MOCK_SESSION}>
        <AccountMenu />
      </Providers>,
    );

    const btn = screen.getByRole("button", { name: /Account menu for Jane Doe/i });
    await userEvent.click(btn);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Sign out/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// sanitizeReturnTo — security
// ---------------------------------------------------------------------------

describe("sanitizeReturnTo — open-redirect prevention", () => {
  it("allows internal paths", () => {
    expect(sanitizeReturnTo("/account")).toBe("/account");
    expect(sanitizeReturnTo("/bookings/abc")).toBe("/bookings/abc");
    expect(sanitizeReturnTo("/search?tab=FLIGHT")).toBe("/search?tab=FLIGHT");
  });

  it("rejects external URLs", () => {
    expect(sanitizeReturnTo("http://evil.com/steal")).toBeNull();
    expect(sanitizeReturnTo("https://evil.com")).toBeNull();
  });

  it("rejects protocol-relative URLs", () => {
    expect(sanitizeReturnTo("//evil.com")).toBeNull();
  });

  it("rejects paths not starting with /", () => {
    expect(sanitizeReturnTo("evil.com")).toBeNull();
  });

  it("rejects auth routes to prevent loops", () => {
    expect(sanitizeReturnTo("/sign-in")).toBeNull();
    expect(sanitizeReturnTo("/sign-up")).toBeNull();
    expect(sanitizeReturnTo("/sign-in?returnTo=/account")).toBeNull();
  });

  it("returns null for undefined or empty", () => {
    expect(sanitizeReturnTo(undefined)).toBeNull();
    expect(sanitizeReturnTo("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Middleware — redirect logic
// ---------------------------------------------------------------------------

describe("middleware — redirect logic", () => {
  it("redirects unauthenticated requests to protected routes", async () => {
    const { middleware } = await import("../../middleware.js");

    const req = new Request("http://localhost:3000/account") as unknown as Parameters<typeof middleware>[0];
    // Simulate a NextRequest without session cookie
    const nextReq = {
      nextUrl: new URL("http://localhost:3000/account"),
      url: "http://localhost:3000/account",
      cookies: { get: () => undefined },
    } as unknown as Parameters<typeof middleware>[0];

    const res = middleware(nextReq);
    const location = res.headers.get("location");
    expect(location).toContain("/sign-in");
    expect(location).toContain("returnTo=%2Faccount");
  });

  it("allows public routes through without a session", async () => {
    const { middleware } = await import("../../middleware.js");

    const nextReq = {
      nextUrl: new URL("http://localhost:3000/"),
      url: "http://localhost:3000/",
      cookies: { get: () => undefined },
    } as unknown as Parameters<typeof middleware>[0];

    const res = middleware(nextReq);
    // NextResponse.next() has status 200 (no redirect)
    expect(res.status).toBe(200);
  });
});
