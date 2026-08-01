"use client";

/**
 * DeleteAccountDialog — typed confirmation gating for account deletion (WO-069, AC11).
 *
 * Explains consequences, requires user to type "DELETE" before submitting.
 * POST /account/deletion is idempotent — retried submissions are safe.
 */

import { useState } from "react";
import { Modal } from "@/components/ui/Modal.js";
import { Button } from "@/components/ui/Button.js";
import { Input } from "@/components/ui/Input.js";
import { requestAccountDeletion } from "@/lib/api/account.js";
import type { DeletionResult } from "@/lib/api/account.js";
import { ApiError } from "@/lib/api/errors.js";

const CONFIRMATION_PHRASE = "DELETE";

interface DeleteAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (result: DeletionResult) => void;
}

export function DeleteAccountDialog({ open, onOpenChange, onDeleted }: DeleteAccountDialogProps) {
  const [phrase, setPhrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = phrase === CONFIRMATION_PHRASE;

  async function handleDelete() {
    if (!confirmed) return;
    setLoading(true);
    setError(null);
    try {
      const result = await requestAccountDeletion();
      onOpenChange(false);
      onDeleted(result);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Unable to submit deletion request. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setPhrase("");
      setError(null);
    }
    onOpenChange(next);
  }

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title="Delete account"
      description="This action is permanent and cannot be undone."
    >
      <div className="mt-4 space-y-4">
        <div className="rounded-md border border-error-300 bg-error-50 p-3 text-sm text-error-700">
          <p className="font-medium">Before you continue:</p>
          <ul className="mt-1 list-disc pl-4 space-y-1">
            <li>All your bookings and travel history will be permanently deleted.</li>
            <li>Active bookings cannot be cancelled after deletion — cancel them first.</li>
            <li>Your wishlist and saved preferences will be removed.</li>
            <li>Account deletion takes effect within 30 days and cannot be reversed.</li>
          </ul>
        </div>

        <div>
          <label htmlFor="del-confirm" className="mb-1 block text-sm font-medium text-neutral-700">
            Type <strong>{CONFIRMATION_PHRASE}</strong> to confirm
          </label>
          <Input
            id="del-confirm"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={CONFIRMATION_PHRASE}
            aria-describedby={error ? "del-error" : undefined}
          />
        </div>

        {error && (
          <p id="del-error" role="alert" className="text-xs text-error-600">{error}</p>
        )}

        <div className="flex gap-3 pt-1">
          {/* Default focus: keep account (safe action) */}
          <Button variant="outline" className="flex-1" onClick={() => handleOpenChange(false)} autoFocus>
            Keep account
          </Button>
          <Button
            className="flex-1 bg-error-600 hover:bg-error-700 focus-visible:ring-error-500"
            disabled={!confirmed}
            loading={loading}
            onClick={handleDelete}
          >
            Delete account
          </Button>
        </div>
      </div>
    </Modal>
  );
}
