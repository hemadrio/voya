"use client";

import * as React from "react";
import { cn } from "@/lib/utils.js";
import { useSearchContext } from "./SearchContext.js";
import type { SearchFacets } from "@/lib/api/search.js";

interface FilterPanelProps {
  facets?: SearchFacets;
  className?: string;
}

const RATING_OPTIONS = [5, 4, 3, 2] as const;

export function FilterPanel({ facets, className }: FilterPanelProps) {
  const { criteria, dispatch } = useSearchContext();

  const amenityFacetMap = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of facets?.amenities ?? []) m[a.value] = a.count;
    return m;
  }, [facets]);

  const typeFacetMap = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of facets?.types ?? []) m[t.value] = t.count;
    return m;
  }, [facets]);

  return (
    <aside
      className={cn("flex flex-col gap-6", className)}
      aria-label="Search filters"
    >
      {/* Price range */}
      <section aria-labelledby="filter-price-heading">
        <h3 id="filter-price-heading" className="mb-3 text-sm font-semibold text-neutral-800">
          Price per night
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="min-price" className="text-xs text-neutral-500">Min ($)</label>
            <input
              id="min-price"
              type="number"
              min={0}
              value={criteria.minPrice ?? ""}
              onChange={(e) =>
                dispatch({
                  type: "SET_PRICE_RANGE",
                  payload: {
                    min: e.target.value ? parseInt(e.target.value, 10) : undefined,
                    max: criteria.maxPrice,
                  },
                })
              }
              className="w-24 rounded border border-neutral-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Any"
            />
          </div>
          <span className="mt-5 text-neutral-400">–</span>
          <div className="flex flex-col gap-1">
            <label htmlFor="max-price" className="text-xs text-neutral-500">Max ($)</label>
            <input
              id="max-price"
              type="number"
              min={0}
              value={criteria.maxPrice ?? ""}
              onChange={(e) =>
                dispatch({
                  type: "SET_PRICE_RANGE",
                  payload: {
                    min: criteria.minPrice,
                    max: e.target.value ? parseInt(e.target.value, 10) : undefined,
                  },
                })
              }
              className="w-24 rounded border border-neutral-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Any"
            />
          </div>
        </div>
      </section>

      {/* Rating */}
      <section aria-labelledby="filter-rating-heading">
        <h3 id="filter-rating-heading" className="mb-3 text-sm font-semibold text-neutral-800">
          Minimum rating
        </h3>
        <div className="flex flex-col gap-2">
          {RATING_OPTIONS.map((r) => {
            const facet = facets?.ratings.find((f) => f.min === r);
            const disabled = facet?.count === 0;
            return (
              <label
                key={r}
                className={cn(
                  "flex cursor-pointer items-center gap-2 text-sm",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <input
                  type="radio"
                  name="rating"
                  value={r}
                  disabled={disabled}
                  checked={criteria.minRating === r}
                  onChange={() => dispatch({ type: "SET_RATING", payload: r })}
                  className="accent-blue-600"
                />
                {"★".repeat(r)} & up
                {facet && (
                  <span className="ml-auto text-xs text-neutral-400">({facet.count})</span>
                )}
              </label>
            );
          })}
          {criteria.minRating !== undefined && (
            <button
              type="button"
              onClick={() => dispatch({ type: "SET_RATING", payload: undefined })}
              className="text-xs text-neutral-500 underline hover:text-neutral-700 text-left"
            >
              Clear rating
            </button>
          )}
        </div>
      </section>

      {/* Amenities */}
      {(facets?.amenities?.length ?? 0) > 0 && (
        <section aria-labelledby="filter-amenities-heading">
          <h3 id="filter-amenities-heading" className="mb-3 text-sm font-semibold text-neutral-800">
            Amenities
          </h3>
          <div className="flex flex-col gap-2">
            {facets!.amenities.map((a) => {
              const checked = criteria.amenities.includes(a.value);
              const disabled = a.count === 0 && !checked;
              return (
                <label
                  key={a.value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 text-sm",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={checked}
                    onChange={() => dispatch({ type: "TOGGLE_AMENITY", payload: a.value })}
                    className="accent-blue-600"
                  />
                  {a.label}
                  <span className="ml-auto text-xs text-neutral-400">({a.count})</span>
                </label>
              );
            })}
          </div>
        </section>
      )}

      {/* Type */}
      {(facets?.types?.length ?? 0) > 0 && (
        <section aria-labelledby="filter-type-heading">
          <h3 id="filter-type-heading" className="mb-3 text-sm font-semibold text-neutral-800">
            Property type
          </h3>
          <div className="flex flex-col gap-2">
            {facets!.types.map((t) => {
              const selected = criteria.type === t.value;
              const disabled = t.count === 0 && !selected;
              return (
                <label
                  key={t.value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 text-sm",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <input
                    type="radio"
                    name="type"
                    value={t.value}
                    disabled={disabled}
                    checked={selected}
                    onChange={() =>
                      dispatch({ type: "SET_TYPE", payload: selected ? undefined : t.value })
                    }
                    className="accent-blue-600"
                  />
                  {t.value}
                  <span className="ml-auto text-xs text-neutral-400">({t.count})</span>
                </label>
              );
            })}
            {criteria.type && (
              <button
                type="button"
                onClick={() => dispatch({ type: "SET_TYPE", payload: undefined })}
                className="text-xs text-neutral-500 underline hover:text-neutral-700 text-left"
              >
                Clear type
              </button>
            )}
          </div>
        </section>
      )}

      {/* Free cancellation */}
      <section aria-labelledby="filter-cancel-heading">
        <h3 id="filter-cancel-heading" className="mb-3 text-sm font-semibold text-neutral-800">
          Cancellation
        </h3>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={criteria.freeCancellation === true}
            onChange={(e) =>
              dispatch({
                type: "SET_FREE_CANCELLATION",
                payload: e.target.checked ? true : undefined,
              })
            }
            className="accent-blue-600"
          />
          Free cancellation only
        </label>
      </section>
    </aside>
  );
}
