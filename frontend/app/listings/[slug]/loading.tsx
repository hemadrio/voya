import { Skeleton } from "@/components/ui/Skeleton.js";

export default function ListingLoading() {
  return (
    <main className="mx-auto max-w-7xl px-4 pb-20 pt-6 sm:px-6 lg:px-8">
      {/* Header skeleton */}
      <Skeleton variant="text" className="mb-2 h-8 w-3/4" />
      <Skeleton variant="text" className="h-4 w-1/2" />

      {/* Photo gallery skeleton */}
      <div className="mt-4 grid h-64 grid-cols-4 gap-2 sm:h-96">
        <Skeleton variant="rectangular" className="col-span-2 row-span-2 rounded-xl" />
        <Skeleton variant="rectangular" className="rounded-xl" />
        <Skeleton variant="rectangular" className="rounded-xl" />
        <Skeleton variant="rectangular" className="rounded-xl" />
        <Skeleton variant="rectangular" className="rounded-xl" />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_380px]">
        <div className="space-y-10">
          {/* Description */}
          <div>
            <Skeleton variant="text" className="mb-3 h-6 w-48" />
            <Skeleton variant="text" className="mb-2 h-4 w-full" />
            <Skeleton variant="text" className="mb-2 h-4 w-full" />
            <Skeleton variant="text" className="h-4 w-4/5" />
          </div>

          {/* Amenities */}
          <div>
            <Skeleton variant="text" className="mb-4 h-6 w-32" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} variant="text" className="h-4 w-3/4" />
              ))}
            </div>
          </div>

          {/* Host */}
          <div className="flex items-start gap-4">
            <Skeleton variant="circular" className="h-16 w-16 flex-shrink-0 rounded-full" />
            <div className="flex-1">
              <Skeleton variant="text" className="mb-2 h-5 w-32" />
              <Skeleton variant="text" className="h-4 w-48" />
            </div>
          </div>
        </div>

        {/* Booking widget skeleton */}
        <div className="hidden lg:block">
          <Skeleton variant="rectangular" className="h-96 rounded-2xl" />
        </div>
      </div>
    </main>
  );
}
