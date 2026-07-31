/**
 * @travel/fixtures — deterministic synthetic seed data and shared test fixture factories.
 *
 * Usage:
 *   import { makeBooking, SEED_IDS, SYNTHETIC_FLIGHT_OFFER } from "@travel/fixtures";
 *
 * All exported values are obviously synthetic and safe for development,
 * staging, and test environments. NEVER use real or production-derived data.
 */

export * from "./identifiers.js";
export * from "./factories/index.js";
export * from "./payloads/index.js";
