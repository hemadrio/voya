/**
 * axe-core accessibility test setup.
 *
 * Provides a configureAxe() helper for component tests and a
 * runAxe() helper that fails on serious or critical violations.
 *
 * Usage in a Vitest component test:
 *
 *   import { render } from "@testing-library/react";
 *   import { runAxe } from "@/test/setup/axe";
 *   import { MyComponent } from "@/components/MyComponent";
 *
 *   it("has no accessibility violations", async () => {
 *     const { container } = render(<MyComponent />);
 *     await runAxe(container);
 *   });
 *
 * Playwright per-route axe scan (using @axe-core/playwright):
 *
 *   import { checkA11y } from "axe-playwright";
 *   test("home has no violations", async ({ page }) => {
 *     await page.goto("/");
 *     await checkA11y(page, undefined, {
 *       detailedReport: true,
 *       detailedReportOptions: { html: true },
 *     });
 *   });
 */

import { expect } from "vitest";

// Lazy-load axe-core to avoid bundling it in production tests that don't use it
async function getAxe() {
  const { default: axe } = await import("axe-core");
  return axe;
}

/**
 * Run axe-core against a DOM container and fail the test if any serious
 * or critical violations are found.
 *
 * Serious = rule failures with impact "serious"
 * Critical = rule failures with impact "critical"
 *
 * @param container - The DOM element to scan (usually render().container)
 * @param options   - Optional axe RunOptions (e.g. { rules: { 'color-contrast': { enabled: true } } })
 */
export async function runAxe(
  container: Element,
  options?: Parameters<typeof import("axe-core").default.run>[1],
): Promise<void> {
  const axe = await getAxe();

  const results = await axe.run(container, {
    rules: {
      // Enforce WCAG 2.1 AA relevant rules
      "color-contrast": { enabled: true },
      "aria-required-attr": { enabled: true },
      "aria-valid-attr": { enabled: true },
      "button-name": { enabled: true },
      "form-field-multiple-labels": { enabled: true },
      "image-alt": { enabled: true },
      "label": { enabled: true },
      "landmark-one-main": { enabled: true },
      "page-has-heading-one": { enabled: true },
      "region": { enabled: true },
    },
    ...options,
  });

  const criticalOrSerious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );

  if (criticalOrSerious.length > 0) {
    const summary = criticalOrSerious
      .map(
        (v) =>
          `[${v.impact}] ${v.id}: ${v.description}\n  ${v.nodes
            .slice(0, 3)
            .map((n) => `  Node: ${n.html}`)
            .join("\n  ")}`,
      )
      .join("\n\n");

    expect.fail(
      `Found ${criticalOrSerious.length} axe violation(s):\n\n${summary}`,
    );
  }
}
