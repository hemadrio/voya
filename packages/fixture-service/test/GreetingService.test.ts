/**
 * Fixture service unit tests (WO-084).
 *
 * Validates the Forge Shipping pipeline end-to-end:
 *   - Tests run in the build:node stage
 *   - Coverage is captured for the coverage gate
 *   - A deliberate type error (commented out below) would fail the build
 */

import { describe, it, expect } from "vitest";
import { GreetingService } from "../src/domain/GreetingService.js";

// Proof that strict-mode compilation is enforced:
// const x: any = "this would fail tsc with strict noImplicitAny"
// Uncommenting the line above MUST turn the build red.

describe("GreetingService — formal style", () => {
  const svc = new GreetingService();

  it("produces a formal greeting", () => {
    const greeting = svc.greet("Alice", "formal");
    expect(greeting.message).toBe("Good day, Alice.");
  });

  it("normalises recipientId to lowercase-hyphenated form", () => {
    const greeting = svc.greet("Bob Smith", "formal");
    expect(greeting.recipientId).toBe("bob-smith");
  });
});

describe("GreetingService — casual style", () => {
  const svc = new GreetingService();

  it("produces a casual greeting", () => {
    const greeting = svc.greet("Charlie", "casual");
    expect(greeting.message).toBe("Hey, Charlie!");
  });

  it("recipientId is lowercase for single-word names", () => {
    const greeting = svc.greet("Dana", "casual");
    expect(greeting.recipientId).toBe("dana");
  });
});

describe("GreetingService — farewell", () => {
  const svc = new GreetingService();

  it("produces a farewell message", () => {
    const greeting = svc.farewell("Eve");
    expect(greeting.message).toBe("Goodbye, Eve.");
  });

  it("sets recipientId from the provided name", () => {
    const greeting = svc.farewell("Frank Garcia");
    expect(greeting.recipientId).toBe("frank-garcia");
  });
});
