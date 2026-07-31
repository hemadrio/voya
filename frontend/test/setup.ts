/**
 * Vitest global test setup.
 *
 * Starts a MSW in-process server before all tests and resets handler state
 * between tests so each test has an isolated HTTP boundary.
 */

import { beforeAll, afterEach, afterAll } from "vitest";
import { setupServer } from "msw/node";

export const mswServer = setupServer();

// "warn" rather than "error" so existing tests that stub fetch directly
// (vi.stubGlobal) don't fail on the unhandled-request check.
beforeAll(() => mswServer.listen({ onUnhandledRequest: "warn" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
