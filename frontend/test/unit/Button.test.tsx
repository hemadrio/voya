/**
 * Unit tests for components/ui/Button.tsx
 *
 * Covers: variant CSS classes, size classes, disabled state, loading state,
 * ARIA attributes, and keyboard operability (Enter key activation).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { Button } from "../../components/ui/Button.js";

describe("Button — variants", () => {
  it("renders with primary variant classes by default", () => {
    render(<Button>Book Now</Button>);
    const btn = screen.getByRole("button", { name: "Book Now" });
    expect(btn.className).toContain("bg-brand-600");
  });

  it("renders secondary variant", () => {
    render(<Button variant="secondary">Cancel</Button>);
    const btn = screen.getByRole("button", { name: "Cancel" });
    expect(btn.className).toContain("bg-neutral-100");
  });

  it("renders destructive variant", () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toContain("bg-error-500");
  });

  it("renders outline variant", () => {
    render(<Button variant="outline">More info</Button>);
    const btn = screen.getByRole("button", { name: "More info" });
    expect(btn.className).toContain("border-neutral-300");
  });
});

describe("Button — sizes", () => {
  it("applies sm size classes", () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole("button").className).toContain("h-8");
  });

  it("applies lg size classes", () => {
    render(<Button size="lg">Large</Button>);
    expect(screen.getByRole("button").className).toContain("h-11");
  });
});

describe("Button — disabled state", () => {
  it("is disabled when disabled prop is true", () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByRole("button", { name: "Disabled" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-disabled", "true");
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Disabled</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Button — loading state", () => {
  it("shows sr-only loading text and spinner when loading", () => {
    render(<Button loading>Submit</Button>);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("is not disabled when loading is false", () => {
    render(<Button loading={false}>Submit</Button>);
    expect(screen.getByRole("button")).not.toBeDisabled();
  });
});

describe("Button — keyboard operability", () => {
  it("fires onClick when Enter is pressed", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Confirm</Button>);
    const btn = screen.getByRole("button");
    btn.focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("fires onClick when Space is pressed", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Confirm</Button>);
    const btn = screen.getByRole("button");
    btn.focus();
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Button — forwarded ref", () => {
  it("forwards ref to the underlying button element", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<Button ref={ref}>Ref Button</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
