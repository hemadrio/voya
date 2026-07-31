import type { Metadata } from "next";
import type { ReactNode } from "react";

// Account/profile pages must never be indexed (AC9 constraint)
export const metadata: Metadata = {
  title: "My Profile",
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
};

export default function ProfileLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
