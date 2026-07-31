"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { resendVerification } from "@/lib/auth/actions";

export default function VerifyEmailPage() {
  const searchParams = useSearchParams();
  const status = searchParams.get("status");
  const [resendState, setResendState] = React.useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const handleResend = async () => {
    setResendState("sending");
    setErrorMessage(null);
    const result = await resendVerification();
    if (result.ok) {
      setResendState("sent");
    } else {
      setResendState("error");
      setErrorMessage(result.message);
    }
  };

  if (status === "success") {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-2xl font-bold text-neutral-900">Email verified</h1>
        <p className="text-sm text-neutral-600">
          Your email address has been verified. You can now sign in to your account.
        </p>
        <Link
          href="/sign-in"
          className="inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (status === "expired") {
    return (
      <div className="space-y-6 text-center">
        <h1 className="text-2xl font-bold text-neutral-900">Link expired</h1>
        <p className="text-sm text-neutral-600">
          This verification link has expired. Click below to request a new one.
        </p>

        {resendState === "sent" ? (
          <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-4 py-3">
            A new verification email has been sent.
          </p>
        ) : (
          <>
            {resendState === "error" && errorMessage !== null && (
              <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3">
                {errorMessage}
              </p>
            )}
            <button
              onClick={() => void handleResend()}
              disabled={resendState === "sending"}
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {resendState === "sending" ? "Sending…" : "Resend verification email"}
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 text-center">
      <h1 className="text-2xl font-bold text-neutral-900">Verify your email</h1>
      <p className="text-sm text-neutral-600">
        We sent a verification link to your email address. Please click the link to activate your account.
      </p>
      <p className="text-sm text-neutral-500">
        Didn&apos;t receive it?{" "}
        {resendState === "sent" ? (
          <span className="text-green-700">Sent! Check your inbox.</span>
        ) : (
          <button
            onClick={() => void handleResend()}
            disabled={resendState === "sending"}
            className="text-brand-600 hover:underline font-medium disabled:opacity-60"
          >
            {resendState === "sending" ? "Sending…" : "Resend it"}
          </button>
        )}
      </p>

      {resendState === "error" && errorMessage !== null && (
        <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3">
          {errorMessage}
        </p>
      )}

      <Link href="/sign-in" className="text-brand-600 hover:underline text-sm font-medium block">
        Back to sign in
      </Link>
    </div>
  );
}
