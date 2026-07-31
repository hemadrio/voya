import * as React from "react";
import { cn } from "@/lib/utils.js";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "text" | "circular" | "rectangular" | undefined;
  width?: string | number | undefined;
  height?: string | number | undefined;
}

function Skeleton({ className, variant = "rectangular", width, height, style, ...props }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading…"
      className={cn(
        "animate-pulse bg-neutral-200",
        variant === "text" && "rounded h-4",
        variant === "circular" && "rounded-full",
        variant === "rectangular" && "rounded-md",
        className,
      )}
      style={{ width, height, ...style }}
      {...props}
    />
  );
}

export { Skeleton };
