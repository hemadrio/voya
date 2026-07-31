/**
 * Unit tests for components/ui/Input.tsx
 *
 * Covers: rendering, label association, error state ARIA, hint text,
 * forwarded ref.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Input } from "../../components/ui/Input.js";

describe("Input — rendering", () => {
  it("renders an input element", () => {
    render(<Input placeholder="Enter text" />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("renders with a label associated via htmlFor", () => {
    render(<Input label="Departure airport" id="departure" />);
    const label = screen.getByText("Departure airport");
    const input = screen.getByRole("textbox");
    expect(label).toHaveAttribute("for", "departure");
    expect(input).toHaveAttribute("id", "departure");
  });
});

describe("Input — error state", () => {
  it("sets aria-invalid when error is provided", () => {
    render(<Input label="Email" error="Invalid email address" />);
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });

  it("renders error message with role=alert", () => {
    render(<Input error="Required field" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Required field");
  });

  it("does not render error when error is undefined", () => {
    render(<Input />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Input — hint text", () => {
  it("renders hint when no error is present", () => {
    render(<Input label="Password" hint="Must be at least 8 characters" />);
    expect(screen.getByText("Must be at least 8 characters")).toBeInTheDocument();
  });

  it("does not render hint when error is present", () => {
    render(<Input label="Password" hint="Hint text" error="Error text" />);
    expect(screen.queryByText("Hint text")).not.toBeInTheDocument();
    expect(screen.getByText("Error text")).toBeInTheDocument();
  });
});

describe("Input — forwarded ref", () => {
  it("forwards ref to the underlying input element", () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<Input ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});
