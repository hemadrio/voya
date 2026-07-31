import * as React from "react";
import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-neutral-50">
      <header className="h-16 border-b border-neutral-200 bg-white flex items-center px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="font-bold text-brand-700 text-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
          aria-label="TravelPlatform home"
        >
          TravelPlatform
        </Link>
      </header>
      <main className="flex-1 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
