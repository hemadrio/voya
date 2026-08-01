/**
 * Wishlist page (WO-069, AC8).
 */

export const dynamic = "force-dynamic";

import { listWishlist } from "@/lib/api/account.js";
import { WishlistGrid } from "@/components/account/WishlistGrid.js";

export default async function WishlistPage() {
  let items: Awaited<ReturnType<typeof listWishlist>>["items"] = [];
  try {
    const result = await listWishlist();
    items = result.items;
  } catch {
    // Degrade gracefully — empty grid
  }

  return (
    <>
      <h1 className="mb-4 text-xl font-bold text-neutral-900">Wishlist</h1>
      <WishlistGrid initialItems={items} />
    </>
  );
}
