/**
 * Unit tests for currency utilities and API client locale propagation.
 */

import { describe, it, expect } from "vitest";
import {
  isSupportedCurrency,
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  CURRENCY_LABELS,
} from "../../lib/i18n/currency.js";
import { formatMoney } from "../../lib/i18n/format.js";
import { PRICED_RESPONSE_USD, PRICED_RESPONSE_EUR } from "../fixtures/i18n.js";

describe("isSupportedCurrency", () => {
  it("returns true for supported currencies", () => {
    for (const cur of SUPPORTED_CURRENCIES) {
      expect(isSupportedCurrency(cur)).toBe(true);
    }
  });

  it("returns false for unsupported currencies", () => {
    expect(isSupportedCurrency("XYZ")).toBe(false);
    expect(isSupportedCurrency("")).toBe(false);
    expect(isSupportedCurrency("usd")).toBe(false); // case-sensitive
  });

  it("default currency is supported", () => {
    expect(isSupportedCurrency(DEFAULT_CURRENCY)).toBe(true);
  });
});

describe("CURRENCY_LABELS", () => {
  it("has a label for every supported currency", () => {
    for (const cur of SUPPORTED_CURRENCIES) {
      expect(CURRENCY_LABELS[cur]).toBeDefined();
      expect(CURRENCY_LABELS[cur].length).toBeGreaterThan(0);
    }
  });

  it("includes currency code in label", () => {
    for (const [code, label] of Object.entries(CURRENCY_LABELS)) {
      expect(label).toContain(code);
    }
  });
});

describe("currency price fixtures", () => {
  it("USD fixture has USD currency", () => {
    expect(PRICED_RESPONSE_USD.currency).toBe("USD");
    for (const result of PRICED_RESPONSE_USD.results) {
      expect(result.price.currency).toBe("USD");
    }
  });

  it("EUR fixture has EUR currency", () => {
    expect(PRICED_RESPONSE_EUR.currency).toBe("EUR");
    for (const result of PRICED_RESPONSE_EUR.results) {
      expect(result.price.currency).toBe("EUR");
    }
  });

  it("same offer has different amounts in USD vs EUR", () => {
    const usd = PRICED_RESPONSE_USD.results[0]?.price.total ?? 0;
    const eur = PRICED_RESPONSE_EUR.results[0]?.price.total ?? 0;
    expect(usd).not.toBe(eur);
  });

  it("formatMoney renders USD price correctly", () => {
    const price = PRICED_RESPONSE_USD.results[0]?.price.nightly ?? 0;
    const result = formatMoney(price, "USD", "en");
    expect(result).toMatch(/\$/);
  });

  it("formatMoney renders EUR price correctly", () => {
    const price = PRICED_RESPONSE_EUR.results[0]?.price.nightly ?? 0;
    const result = formatMoney(price, "EUR", "en");
    expect(result).toMatch(/€/);
  });
});
