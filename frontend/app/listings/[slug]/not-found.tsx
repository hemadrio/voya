import Link from "next/link";

export default function ListingNotFound() {
  return (
    <main className="flex min-h-[50vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-2 text-3xl font-bold text-neutral-900">Listing not found</h1>
      <p className="mb-6 text-neutral-600">
        This listing may have been removed or the link may be incorrect.
      </p>
      <Link
        href="/search"
        className="rounded-xl bg-rose-600 px-6 py-3 text-sm font-semibold text-white hover:bg-rose-700"
      >
        Browse listings
      </Link>
    </main>
  );
}
