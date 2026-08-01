"use client";

import * as React from "react";
import Image from "next/image";
import type { ListingImage } from "@/lib/api/listings.js";
import { GalleryLightbox } from "./GalleryLightbox.js";

interface PhotoGalleryProps {
  images: ListingImage[];
  title: string;
}

export function PhotoGallery({ images, title }: PhotoGalleryProps) {
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);

  if (images.length === 0) {
    return (
      <div
        className="flex h-64 items-center justify-center rounded-xl bg-neutral-100 text-neutral-400"
        aria-label="No photos available"
      >
        <span className="text-lg">No photos available</span>
      </div>
    );
  }

  const [hero, ...rest] = images;

  return (
    <>
      <div className="relative grid h-64 grid-cols-4 gap-2 overflow-hidden rounded-xl sm:h-96">
        {/* Hero image — 2 columns wide */}
        <button
          type="button"
          className="relative col-span-2 row-span-2 overflow-hidden"
          onClick={() => setLightboxIndex(0)}
          aria-label={`View photo 1 of ${images.length}: ${hero.alt}`}
        >
          <Image
            src={hero.url}
            alt={hero.alt}
            fill
            sizes="(max-width: 640px) 100vw, 50vw"
            className="object-cover transition-transform duration-200 hover:scale-105"
            placeholder={hero.blurHash ? "blur" : "empty"}
            blurDataURL={hero.blurHash || undefined}
            priority
          />
        </button>

        {/* Remaining thumbnails — up to 4 */}
        {rest.slice(0, 4).map((img, idx) => (
          <button
            key={img.url}
            type="button"
            className="relative overflow-hidden"
            onClick={() => setLightboxIndex(idx + 1)}
            aria-label={`View photo ${idx + 2} of ${images.length}: ${img.alt}`}
          >
            <Image
              src={img.url}
              alt={img.alt}
              fill
              sizes="25vw"
              className="object-cover transition-transform duration-200 hover:scale-105"
              placeholder={img.blurHash ? "blur" : "empty"}
              blurDataURL={img.blurHash || undefined}
            />
            {/* "Show all" overlay on the last visible thumb */}
            {idx === 3 && images.length > 5 && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
                <span className="text-sm font-semibold">+{images.length - 5} photos</span>
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Show all photos button when only hero is visible */}
      {images.length > 1 && (
        <button
          type="button"
          className="mt-2 text-sm font-semibold underline"
          onClick={() => setLightboxIndex(0)}
        >
          Show all {images.length} photos
        </button>
      )}

      {lightboxIndex !== null && (
        <GalleryLightbox
          images={images}
          title={title}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
