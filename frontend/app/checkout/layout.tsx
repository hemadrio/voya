import type { Metadata } from "next";
import type { ReactNode } from "react";

// Checkout must never be indexed by search engines (AC9 constraint)
export const metadata: Metadata = {
  title: "Checkout",
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
};

export default function CheckoutLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
