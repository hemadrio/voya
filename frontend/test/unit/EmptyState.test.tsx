/**
 * Unit tests for components/ui/EmptyState.tsx
 *
 * Covers: title and description rendering, action button, icon slot.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EmptyState } from "../../components/ui/EmptyState.js";

describe("EmptyState — rendering", () => {
  it("renders the title", () => {
    render(<EmptyState title="No results found" />);
    expect(screen.getByText("No results found")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(
      <EmptyState
        title="No flights found"
        description="Try adjusting your search criteria."
      />,
    );
    expect(screen.getByText("Try adjusting your search criteria.")).toBeInTheDocument();
  });

  it("does not render description when omitted", () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.queryByText("Try adjusting")).not.toBeInTheDocument();
  });
});

describe("EmptyState — action", () => {
  it("renders action button with provided label", () => {
    render(
      <EmptyState
        title="No bookings"
        action={{ label: "Search flights", onClick: vi.fn() }}
      />,
    );
    expect(screen.getByRole("button", { name: "Search flights" })).toBeInTheDocument();
  });

  it("calls onClick when action button is clicked", async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No bookings"
        action={{ label: "Try again", onClick }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not render button when action is not provided", () => {
    render(<EmptyState title="Nothing" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("EmptyState — icon slot", () => {
  it("renders icon when provided", () => {
    render(
      <EmptyState
        title="Empty"
        icon={<svg data-testid="empty-icon" aria-hidden="true" />}
      />,
    );
    expect(screen.getByTestId("empty-icon")).toBeInTheDocument();
  });
});
