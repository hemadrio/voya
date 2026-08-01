"use client";

/**
 * Password & security page (WO-069, AC10–AC11).
 */

import { useState } from "react";
import { PasswordChangeForm } from "@/components/account/PasswordChangeForm.js";
import { DeleteAccountDialog } from "@/components/account/DeleteAccountDialog.js";
import type { DeletionResult } from "@/lib/api/account.js";

export default function SecurityPage() {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletionResult, setDeletionResult] = useState<DeletionResult | null>(null);

  function handleDeleted(result: DeletionResult) {
    setDeletionResult(result);
  }

  return (
    <>
      <h1 className="mb-6 text-xl font-bold text-neutral-900">Password &amp; security</h1>

      <section aria-labelledby="pw-section" className="mb-8">
        <h2 id="pw-section" className="mb-3 text-base font-semibold text-neutral-800">
          Change password
        </h2>
        <PasswordChangeForm />
      </section>

      <section aria-labelledby="delete-section" className="border-t border-neutral-200 pt-8">
        <h2 id="delete-section" className="mb-1 text-base font-semibold text-error-700">
          Delete account
        </h2>
        <p className="mb-3 text-sm text-neutral-600">
          Permanently delete your account and all associated data. This cannot be undone.
        </p>

        {deletionResult ? (
          <div
            role="status"
            className="rounded-md border border-warning-300 bg-warning-50 p-4 text-sm text-warning-700"
          >
            <p className="font-medium">Account deletion requested</p>
            <p className="mt-1">
              Your account will be permanently deleted on{" "}
              {new Date(deletionResult.effectiveAt).toLocaleDateString("en-GB", {
                day: "numeric", month: "long", year: "numeric",
              })}
              . Contact support if you change your mind before then.
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="rounded-md border border-error-300 px-3 py-2 text-sm font-medium text-error-600 hover:bg-error-50"
          >
            Delete my account
          </button>
        )}
      </section>

      <DeleteAccountDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={handleDeleted}
      />
    </>
  );
}
