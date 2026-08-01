import * as React from "react";
import type { ListingPolicies } from "@/lib/api/listings.js";

interface PoliciesSectionProps {
  policies: ListingPolicies;
}

export function PoliciesSection({ policies }: PoliciesSectionProps) {
  const { cancellation, checkInFrom, checkOutBy, houseRules } = policies;

  return (
    <section aria-labelledby="policies-heading">
      <h2 id="policies-heading" className="mb-4 text-xl font-semibold text-neutral-900">
        Policies
      </h2>

      <div className="space-y-6">
        {/* Cancellation */}
        <div>
          <h3 className="mb-1 font-semibold text-neutral-800">Cancellation policy</h3>
          <p className="text-sm font-medium capitalize text-neutral-700">
            {cancellation.type.replace(/_/g, " ")}
          </p>
          <p className="mt-1 text-sm text-neutral-600">{cancellation.description}</p>
          {cancellation.deadlineHours > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              Free cancellation before {Math.floor(cancellation.deadlineHours / 24)} day
              {cancellation.deadlineHours >= 48 ? "s" : ""} prior to check-in.
            </p>
          )}
        </div>

        {/* Check-in/out */}
        <div>
          <h3 className="mb-2 font-semibold text-neutral-800">Check-in / Check-out</h3>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-neutral-500">Check-in from</dt>
              <dd className="font-medium text-neutral-800">{checkInFrom}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">Check-out by</dt>
              <dd className="font-medium text-neutral-800">{checkOutBy}</dd>
            </div>
          </dl>
        </div>

        {/* House rules */}
        {houseRules.length > 0 && (
          <div>
            <h3 className="mb-2 font-semibold text-neutral-800">House rules</h3>
            <ul className="space-y-1">
              {houseRules.map((rule) => (
                <li key={rule} className="flex items-start gap-2 text-sm text-neutral-600">
                  <span aria-hidden="true" className="mt-0.5 flex-shrink-0 text-neutral-400">
                    •
                  </span>
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
