import Link from "next/link.js";
import { buttonVariants } from "@/components/ui/Button.js";
import { cn } from "@/lib/utils.js";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-[80rem] px-4 py-16 sm:px-6 lg:px-8">
      <div className="flex flex-col items-center gap-8 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-neutral-900 sm:text-5xl">
          Your journey starts here
        </h1>
        <p className="max-w-xl text-lg text-neutral-600">
          Search flights, hotels, and cars from hundreds of suppliers. Powered
          by AI to find the best options for your trip.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/search?tab=FLIGHT"
            className={cn(buttonVariants({ variant: "primary", size: "lg" }))}
          >
            Search Flights
          </Link>
          <Link
            href="/search?tab=HOTEL"
            className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}
          >
            Find Hotels
          </Link>
        </div>
      </div>
    </div>
  );
}
