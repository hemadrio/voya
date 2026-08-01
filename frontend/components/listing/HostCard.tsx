import * as React from "react";
import Image from "next/image";
import type { ListingHost } from "@/lib/api/listings.js";

interface HostCardProps {
  host: ListingHost;
}

export function HostCard({ host }: HostCardProps) {
  const joinedYear = new Date(host.joinedAt).getFullYear();

  return (
    <section aria-labelledby="host-heading">
      <h2 id="host-heading" className="mb-4 text-xl font-semibold text-neutral-900">
        About your host
      </h2>

      <div className="flex items-start gap-4">
        <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-full">
          <Image
            src={host.avatarUrl}
            alt={host.name}
            fill
            sizes="64px"
            className="object-cover"
          />
        </div>

        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-900">{host.name}</span>
            {host.verified && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800"
                title="Identity verified"
              >
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.403 12.652a3 3 0 0 0 0-5.304 3 3 0 0 0-3.751-3.751 3 3 0 0 0-5.305 0 3 3 0 0 0-3.751 3.751 3 3 0 0 0 0 5.305 3 3 0 0 0 3.751 3.751 3 3 0 0 0 5.305 0 3 3 0 0 0 3.751-3.751zm-2.546-4.46a.75.75 0 0 0-1.214-.883l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5z"
                    clipRule="evenodd"
                  />
                </svg>
                Verified
              </span>
            )}
          </div>
          <p className="text-sm text-neutral-500">
            Hosting since {joinedYear}
          </p>
          {host.responseRate > 0 && (
            <p className="mt-1 text-sm text-neutral-600">
              Responds to{" "}
              <strong>{Math.round(host.responseRate * 100)}%</strong> of messages
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
