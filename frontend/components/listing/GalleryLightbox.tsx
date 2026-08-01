"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Image from "next/image";
import type { ListingImage } from "@/lib/api/listings.js";

interface GalleryLightboxProps {
  images: ListingImage[];
  title: string;
  initialIndex: number;
  onClose: () => void;
}

export function GalleryLightbox({
  images,
  title,
  initialIndex,
  onClose,
}: GalleryLightboxProps) {
  const [index, setIndex] = React.useState(initialIndex);

  const prev = () => setIndex((i) => (i - 1 + images.length) % images.length);
  const next = () => setIndex((i) => (i + 1) % images.length);
  const current = images[index];

  // Keyboard navigation
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Preload adjacent images only
  const prevIdx = (index - 1 + images.length) % images.length;
  const nextIdx = (index + 1) % images.length;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[1040] bg-black/90" />
        <Dialog.Content
          className="fixed inset-0 z-[1050] flex flex-col items-center justify-center focus:outline-none"
          aria-label={`Photo gallery for ${title}`}
        >
          <Dialog.Title className="sr-only">
            {title} — photo {index + 1} of {images.length}
          </Dialog.Title>

          {/* Close button */}
          <Dialog.Close
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white"
            aria-label="Close gallery"
            autoFocus
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </Dialog.Close>

          {/* Previous */}
          {images.length > 1 && (
            <button
              type="button"
              onClick={prev}
              className="absolute left-4 rounded-full bg-white/10 p-3 text-white hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white"
              aria-label="Previous photo"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}

          {/* Image */}
          <div className="relative h-[70vh] w-full max-w-4xl px-16">
            <Image
              src={current.url}
              alt={current.alt}
              fill
              sizes="(max-width: 768px) 100vw, 80vw"
              className="object-contain"
              placeholder={current.blurHash ? "blur" : "empty"}
              blurDataURL={current.blurHash || undefined}
              priority
            />
          </div>

          {/* Hidden preload for adjacent images */}
          {images.length > 1 && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={images[prevIdx].url} alt="" className="sr-only" aria-hidden="true" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={images[nextIdx].url} alt="" className="sr-only" aria-hidden="true" />
            </>
          )}

          {/* Next */}
          {images.length > 1 && (
            <button
              type="button"
              onClick={next}
              className="absolute right-4 rounded-full bg-white/10 p-3 text-white hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white"
              aria-label="Next photo"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          )}

          {/* Counter */}
          <p className="mt-3 text-sm text-white/70" aria-live="polite">
            {index + 1} / {images.length}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
