/**
 * Unit tests for components/ui/Badge.tsx
 *
 * Covers: variant classes, custom className, default variant.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Badge } from "../../components/ui/Badge.js";

describe("Badge — default variant", () => {
  it("renders with brand background by default", () => {
    render(<Badge>New</Badge>);
    const badge = screen.getByText("New");
    expect(badge.className).toContain("bg-brand-600");
  });
});

describe("Badge — variants", () => {
  it("renders secondary variant", () => {
    render(<Badge variant="secondary">Beta</Badge>);
    expect(screen.getByText("Beta").className).toContain("bg-neutral-100");
  });

  it("renders success variant", () => {
    render(<Badge variant="success">Confirmed</Badge>);
    expect(screen.getByText("Confirmed").className).toContain("bg-success-50");
  });

  it("renders warning variant", () => {
    render(<Badge variant="warning">Expiring soon</Badge>);
    expect(screen.getByText("Expiring soon").className).toContain("bg-warning-50");
  });

  it("renders error variant", () => {
    render(<Badge variant="error">Cancelled</Badge>);
    expect(screen.getByText("Cancelled").className).toContain("bg-error-50");
  });

  it("renders outline variant", () => {
    render(<Badge variant="outline">Draft</Badge>);
    expect(screen.getByText("Draft").className).toContain("border-neutral-300");
  });
});

describe("Badge — custom className", () => {
  it("merges custom className", () => {
    render(<Badge className="ml-2">Tag</Badge>);
    expect(screen.getByText("Tag").className).toContain("ml-2");
  });
});
