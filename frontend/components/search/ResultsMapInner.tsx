"use client";

/**
 * ResultsMapInner — renders in client-only (no SSR) via dynamic import.
 *
 * This module must NOT be imported directly. Use ResultsMap.tsx which wraps
 * it with `next/dynamic { ssr: false }` so it is excluded from the initial bundle.
 */

import * as React from "react";
import { cn } from "@/lib/utils.js";
import { formatPrice } from "@/lib/search/params.js";
import { useSearchContext } from "./SearchContext.js";
import type { SearchResultItem } from "@/lib/api/search.js";

interface Cluster {
  id: string;
  lat: number;
  lng: number;
  count: number;
  items: SearchResultItem[];
}

function clusterItems(items: SearchResultItem[]): Cluster[] {
  // Simple grid-based clustering at a fixed zoom level
  const GRID = 0.5; // degrees
  const buckets: Record<string, SearchResultItem[]> = {};

  for (const item of items) {
    if (!item.location?.lat || !item.location?.lng) continue;
    const key = `${Math.round(item.location.lat / GRID)}_${Math.round(item.location.lng / GRID)}`;
    buckets[key] ??= [];
    buckets[key].push(item);
  }

  return Object.entries(buckets).map(([key, members]) => {
    const avgLat = members.reduce((s, m) => s + m.location.lat, 0) / members.length;
    const avgLng = members.reduce((s, m) => s + m.location.lng, 0) / members.length;
    return { id: key, lat: avgLat, lng: avgLng, count: members.length, items: members };
  });
}

interface PinProps {
  cluster: Cluster;
  containerBounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  hoveredItemId: string | null;
  selectedItemId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  currency: string;
  locale: string;
}

function Pin({ cluster, containerBounds, hoveredItemId, selectedItemId, onHover, onSelect, currency, locale }: PinProps) {
  const { minLat, maxLat, minLng, maxLng } = containerBounds;
  const latRange = maxLat - minLat || 1;
  const lngRange = maxLng - minLng || 1;

  const left = ((cluster.lng - minLng) / lngRange) * 100;
  const top = ((maxLat - cluster.lat) / latRange) * 100;

  const isActive =
    cluster.items.some((i) => i.id === hoveredItemId) ||
    cluster.items.some((i) => i.id === selectedItemId);

  const representative = cluster.items[0];
  const price = representative?.price;

  return (
    <button
      type="button"
      style={{ left: `${left}%`, top: `${top}%` }}
      className={cn(
        "absolute -translate-x-1/2 -translate-y-full cursor-pointer rounded-full border-2 border-white px-2 py-0.5 text-xs font-bold shadow transition-transform hover:scale-110 hover:z-10",
        isActive
          ? "bg-blue-600 text-white z-10 scale-110"
          : "bg-white text-neutral-800",
        cluster.count > 1 ? "rounded-xl" : "",
      )}
      aria-label={
        cluster.count === 1
          ? `${representative?.title} — ${price ? formatPrice(price.nightly, price.currency, locale) : "N/A"}`
          : `${cluster.count} properties in this area`
      }
      onMouseEnter={() => onHover(cluster.items[0]?.id ?? null)}
      onMouseLeave={() => onHover(null)}
      onClick={() => {
        if (cluster.items[0]) onSelect(cluster.items[0].id);
      }}
    >
      {cluster.count > 1
        ? `${cluster.count} places`
        : price
          ? formatPrice(price.nightly, price.currency, locale)
          : representative?.title?.slice(0, 10)}
    </button>
  );
}

export function ResultsMapInner() {
  const { data, hoveredItemId, setHoveredItemId, selectedItemId, setSelectedItemId, criteria } =
    useSearchContext();

  const items = React.useMemo(
    () => (data?.items ?? []).filter((i) => i.location?.lat && i.location?.lng),
    [data],
  );

  const clusters = React.useMemo(() => clusterItems(items), [items]);

  const bounds = React.useMemo(() => {
    if (items.length === 0)
      return { minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 };
    const lats = items.map((i) => i.location.lat);
    const lngs = items.map((i) => i.location.lng);
    const pad = 0.5;
    return {
      minLat: Math.min(...lats) - pad,
      maxLat: Math.max(...lats) + pad,
      minLng: Math.min(...lngs) - pad,
      maxLng: Math.max(...lngs) + pad,
    };
  }, [items]);

  // Scroll selected card into view
  React.useEffect(() => {
    if (selectedItemId) {
      const el = document.getElementById(`result-card-${selectedItemId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selectedItemId]);

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 text-sm text-neutral-500">
        No properties with coordinates to show on map
      </div>
    );
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-xl border border-neutral-200 bg-[#e8f0e8]"
      role="img"
      aria-label="Map of search results"
    >
      {/* Decorative grid lines */}
      <svg className="absolute inset-0 h-full w-full opacity-20" aria-hidden>
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#94a3b8" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      {/* Pins */}
      {clusters.map((cluster) => (
        <Pin
          key={cluster.id}
          cluster={cluster}
          containerBounds={bounds}
          hoveredItemId={hoveredItemId}
          selectedItemId={selectedItemId}
          onHover={setHoveredItemId}
          onSelect={(id) => setSelectedItemId(id === selectedItemId ? null : id)}
          currency={criteria.currency}
          locale={criteria.locale}
        />
      ))}

      <p className="absolute bottom-2 right-2 rounded bg-white/80 px-2 py-0.5 text-xs text-neutral-500">
        {items.length} properties
      </p>
    </div>
  );
}
