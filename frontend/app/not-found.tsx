"use client";

import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState.js";
import { buttonVariants } from "@/components/ui/Button.js";
import { cn } from "@/lib/utils.js";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[80rem] px-4 py-24 sm:px-6 lg:px-8">
      <div className="flex flex-col items-center gap-6">
        <EmptyState
          title="Page not found"
          description="The page you were looking for doesn't exist or has been moved."
          icon={
            <svg
              className="h-6 w-6"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />
        <Link
          href="/"
          className={cn(buttonVariants({ variant: "secondary", size: "md" }))}
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
