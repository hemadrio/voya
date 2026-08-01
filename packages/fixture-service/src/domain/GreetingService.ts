/**
 * GreetingService — minimal domain service for pipeline validation (WO-084).
 *
 * Used by the Forge Shipping pipeline fixture tests to verify:
 *   - TypeScript strict-mode compilation (no any escape hatches)
 *   - Turborepo affected-graph build
 *   - Coverage gate measures domain files
 *   - Distroless image can import compiled domain code
 */

export interface Greeting {
  message: string;
  recipientId: string;
}

export type GreetingStyle = "formal" | "casual";

export class GreetingService {
  greet(name: string, style: GreetingStyle): Greeting {
    const message =
      style === "formal"
        ? `Good day, ${name}.`
        : `Hey, ${name}!`;

    return {
      message,
      recipientId: name.toLowerCase().replace(/\s+/g, "-"),
    };
  }

  farewell(name: string): Greeting {
    return {
      message: `Goodbye, ${name}.`,
      recipientId: name.toLowerCase().replace(/\s+/g, "-"),
    };
  }
}
