"use client";

import { Button } from "@/components/ui/Button.js";
import { EmptyState } from "@/components/ui/EmptyState.js";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <div className="mx-auto max-w-[80rem] px-4 py-24 sm:px-6 lg:px-8">
      <EmptyState
        title="Something went wrong"
        description={
          process.env["NODE_ENV"] !== "production"
            ? error.message
            : "An unexpected error occurred. Please try again."
        }
        action={{ label: "Try again", onClick: reset }}
      />
    </div>
  );
}
