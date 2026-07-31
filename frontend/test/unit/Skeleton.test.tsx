/**
 * Unit tests for components/ui/Skeleton.tsx
 *
 * Covers: ARIA busy state, variant classes, size props.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Skeleton } from "../../components/ui/Skeleton.js";

describe("Skeleton — ARIA", () => {
  it("has role=status and aria-busy=true", () => {
    render(<Skeleton />);
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("aria-busy", "true");
    expect(el).toHaveAttribute("aria-label", "Loading…");
  });
});

describe("Skeleton — variants", () => {
  it("renders rectangular variant by default", () => {
    render(<Skeleton />);
    expect(screen.getByRole("status").className).toContain("rounded-md");
  });

  it("renders text variant", () => {
    render(<Skeleton variant="text" />);
    expect(screen.getByRole("status").className).toContain("rounded");
    expect(screen.getByRole("status").className).toContain("h-4");
  });

  it("renders circular variant", () => {
    render(<Skeleton variant="circular" />);
    expect(screen.getByRole("status").className).toContain("rounded-full");
  });
});

describe("Skeleton — size props", () => {
  it("applies width and height as inline styles", () => {
    render(<Skeleton width={200} height={40} />);
    const el = screen.getByRole("status");
    expect(el).toHaveStyle({ width: "200px", height: "40px" });
  });

  it("applies string width and height", () => {
    render(<Skeleton width="100%" height="2rem" />);
    const el = screen.getByRole("status");
    expect(el).toHaveStyle({ width: "100%", height: "2rem" });
  });
});
