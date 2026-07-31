"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Drawer } from "@/components/ui/Drawer.js";

export interface NavItem {
  label: string;
  href: string;
}

export interface MobileNavDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navItems: ReadonlyArray<NavItem>;
}

function MobileNavDrawer({ open, onOpenChange, navItems }: MobileNavDrawerProps) {
  const pathname = usePathname();

  React.useEffect(() => {
    if (open) {
      onOpenChange(false);
    }
  }, [pathname]);

  React.useEffect(() => {
    if (!open) return;
    function handleResize() {
      if (window.innerWidth >= 768) {
        onOpenChange(false);
      }
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [open, onOpenChange]);

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Navigation"
      side="left"
    >
      <nav aria-label="Mobile navigation">
        <ul className="flex flex-col gap-1" role="list">
          {navItems.map((item) => {
            const isCurrent = pathname === item.href;
            return (
              <li key={item.href}>
                <a
                  href={item.href}
                  aria-current={isCurrent ? "page" : undefined}
                  title={item.label}
                  className={[
                    "block rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isCurrent
                      ? "bg-brand-50 text-brand-700"
                      : "text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900",
                  ].join(" ")}
                  onClick={() => onOpenChange(false)}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </Drawer>
  );
}

export { MobileNavDrawer };
