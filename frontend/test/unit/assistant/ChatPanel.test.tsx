/**
 * Component tests for the assistant chat UI (WO-062 AC11).
 *
 * Covers:
 *   - ChatComposer: renders, send on Enter, cancel button shown while streaming
 *   - MessageBubble: plain text rendering (no script injection), thinking state
 *   - ToolActivityIndicator: running/resolved/failed states
 *   - OfferCard: structured fields rendered, stale badge, re-verify affordance
 *   - No dangerouslySetInnerHTML safety check
 *
 * Uses @testing-library/react + jsdom + vitest.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { MessageBubble } from "../../../components/assistant/MessageBubble.js";
import { ToolActivityIndicator } from "../../../components/assistant/ToolActivityIndicator.js";
import { OfferCard } from "../../../components/assistant/OfferCard.js";
import { ChatComposer } from "../../../components/assistant/ChatComposer.js";
import type { TurnState, ToolActivityState, OfferCardState } from "../../../lib/assistant/chatReducer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTurn(overrides?: Partial<TurnState>): TurnState {
  return {
    turnId: "tt-001",
    clientTurnId: "ct-001",
    conversationId: "cc-001",
    userContent: "Find flights to Paris",
    assistantText: "",
    status: "streaming",
    toolActivity: [],
    offerCards: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MessageBubble — plain text safety (AC5)
// ---------------------------------------------------------------------------

describe("MessageBubble — plain text rendering", () => {
  it("renders assistant text as visible plain text", () => {
    const turn = makeTurn({
      assistantText: "Here are some options for your trip.",
      status: "complete",
    });
    render(<MessageBubble turn={turn} isActive={false} />);
    expect(screen.getByText("Here are some options for your trip.")).toBeInTheDocument();
  });

  it("renders a script tag as inert visible text — not a script element (AC5)", () => {
    const xssPayload = "<script>alert('xss')</script>";
    const turn = makeTurn({
      assistantText: xssPayload,
      status: "complete",
    });
    const { container } = render(<MessageBubble turn={turn} isActive={false} />);
    // The script text must appear as visible text
    expect(screen.getByText(xssPayload)).toBeInTheDocument();
    // No actual <script> element should be in the DOM
    expect(container.querySelectorAll("script")).toHaveLength(0);
  });

  it("shows a thinking indicator when streaming with no text yet", () => {
    const turn = makeTurn({ assistantText: "", toolActivity: [], status: "streaming" });
    render(<MessageBubble turn={turn} isActive={true} />);
    expect(screen.getByLabelText("Assistant is thinking")).toBeInTheDocument();
  });

  it("does not show thinking indicator once text arrives", () => {
    const turn = makeTurn({ assistantText: "Hello", status: "streaming" });
    render(<MessageBubble turn={turn} isActive={true} />);
    expect(screen.queryByLabelText("Assistant is thinking")).not.toBeInTheDocument();
  });

  it("shows cancelled state note when status is cancelled", () => {
    const turn = makeTurn({ assistantText: "Partial…", status: "cancelled" });
    render(<MessageBubble turn={turn} isActive={false} />);
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument();
  });

  it("shows error message and reference on error status", () => {
    const turn = makeTurn({
      assistantText: "",
      status: "error",
      error: { code: "PROVIDER_ERROR", message: "Something went wrong.", reference: "ref-001" },
    });
    render(<MessageBubble turn={turn} isActive={false} />);
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
    expect(screen.getByText(/ref-001/)).toBeInTheDocument();
  });

  it("renders the user message on the right side", () => {
    const turn = makeTurn({ userContent: "Find hotels in Rome", assistantText: "" });
    const { container } = render(<MessageBubble turn={turn} isActive={false} />);
    const userDiv = container.querySelector('[aria-label="Your message"]');
    expect(userDiv?.textContent).toBe("Find hotels in Rome");
  });
});

// ---------------------------------------------------------------------------
// ToolActivityIndicator (AC2)
// ---------------------------------------------------------------------------

describe("ToolActivityIndicator", () => {
  it("shows human-readable label for search_flights while running", () => {
    const activity: ToolActivityState = {
      toolCallId: "tc-001",
      tool: "search_flights",
      status: "running",
    };
    render(<ToolActivityIndicator activity={activity} />);
    expect(screen.getByText("Searching flights")).toBeInTheDocument();
  });

  it("shows check mark on success", () => {
    const activity: ToolActivityState = {
      toolCallId: "tc-001",
      tool: "search_flights",
      status: "success",
      summary: "Found 5 results",
    };
    render(<ToolActivityIndicator activity={activity} />);
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it("shows failure indicator on failure", () => {
    const activity: ToolActivityState = {
      toolCallId: "tc-001",
      tool: "search_hotels",
      status: "failure",
    };
    render(<ToolActivityIndicator activity={activity} />);
    expect(screen.getByText("✗")).toBeInTheDocument();
  });

  it("renders an unknown tool name as human-readable fallback", () => {
    const activity: ToolActivityState = {
      toolCallId: "tc-001",
      tool: "check_weather",
      status: "running",
    };
    render(<ToolActivityIndicator activity={activity} />);
    expect(screen.getByText(/check weather/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// OfferCard (AC3, AC4)
// ---------------------------------------------------------------------------

describe("OfferCard — fresh offer", () => {
  function freshCard(): OfferCardState {
    return {
      offerId: "offer-001",
      provenance: "AMADEUS",
      currency: "USD",
      price: 489,
      retrievedAt: Date.now() - 30_000, // 30 seconds ago
      stale: false,
      displayTitle: "LHR → JFK — Economy",
      displaySummary: "7h 30m · 1 stop",
    };
  }

  it("renders price and currency from structured payload (not from text)", () => {
    render(<OfferCard card={freshCard()} />);
    expect(screen.getByText(/USD/)).toBeInTheDocument();
    expect(screen.getByText(/489/)).toBeInTheDocument();
  });

  it("renders provider from provenance field", () => {
    render(<OfferCard card={freshCard()} />);
    expect(screen.getByText("AMADEUS")).toBeInTheDocument();
  });

  it("renders the select offer button for a fresh card", () => {
    render(<OfferCard card={freshCard()} />);
    expect(screen.getByRole("button", { name: /select offer/i })).toBeInTheDocument();
  });

  it("calls onSelect with offerId when the select button is clicked", () => {
    const onSelect = vi.fn();
    render(<OfferCard card={freshCard()} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /select offer/i }));
    expect(onSelect).toHaveBeenCalledWith("offer-001");
  });
});

describe("OfferCard — stale offer (AC4)", () => {
  function staleCard(): OfferCardState {
    return {
      offerId: "offer-002",
      provenance: "AMADEUS",
      currency: "USD",
      price: 412,
      retrievedAt: Date.now() - 10 * 60_000, // 10 minutes ago
      stale: true,
      displayTitle: "LHR → JFK — Economy (stale)",
    };
  }

  it("shows the stale warning banner", () => {
    render(<OfferCard card={staleCard()} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/re-verify/i)).toBeInTheDocument();
  });

  it("shows re-verify button instead of select for stale cards", () => {
    render(<OfferCard card={staleCard()} />);
    expect(screen.getByRole("button", { name: /re-verify price/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /select offer/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ChatComposer (AC6, AC10)
// ---------------------------------------------------------------------------

describe("ChatComposer", () => {
  it("renders the textarea and send button", () => {
    render(
      <ChatComposer isStreaming={false} onSend={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole("textbox", { name: /message input/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
  });

  it("calls onSend with trimmed content when Enter is pressed", () => {
    const onSend = vi.fn();
    render(<ChatComposer isStreaming={false} onSend={onSend} onCancel={vi.fn()} />);
    const textarea = screen.getByRole("textbox", { name: /message input/i });
    fireEvent.change(textarea, { target: { value: "  Find flights  " } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("Find flights");
  });

  it("does not submit on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<ChatComposer isStreaming={false} onSend={onSend} onCancel={vi.fn()} />);
    const textarea = screen.getByRole("textbox", { name: /message input/i });
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows cancel button while streaming", () => {
    render(<ChatComposer isStreaming={true} onSend={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: /cancel response/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(<ChatComposer isStreaming={true} onSend={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel response/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables the send button when the textarea is empty", () => {
    render(<ChatComposer isStreaming={false} onSend={vi.fn()} onCancel={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /send message/i });
    expect(btn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Safety: no dangerouslySetInnerHTML in chat components (AC5)
// ---------------------------------------------------------------------------

describe("Safety — no dangerouslySetInnerHTML", () => {
  it("assistant text with HTML markup renders as text, not as DOM nodes", () => {
    const maliciousText = '<img src="x" onerror="alert(1)"><b>bold</b>';
    const turn = makeTurn({ assistantText: maliciousText, status: "complete" });
    const { container } = render(<MessageBubble turn={turn} isActive={false} />);
    // No img element injected
    expect(container.querySelectorAll("img")).toHaveLength(0);
    // No b element injected beyond what exists in the component itself
    const bElements = container.querySelectorAll("b");
    // All b elements (if any) should not have the malicious text as innerHTML
    bElements.forEach((el) => {
      expect(el.textContent).not.toBe("bold");
    });
    // The raw string should be visible as text
    expect(screen.getByText(maliciousText)).toBeInTheDocument();
  });
});
