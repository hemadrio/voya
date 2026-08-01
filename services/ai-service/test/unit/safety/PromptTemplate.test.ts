/**
 * PromptTemplate unit tests (WO-061, AC8, AC11).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  loadPromptTemplate,
  PROMPT_TEMPLATE_VERSION,
  _resetPromptTemplateForTest,
} from "../../../src/domain/safety/PromptTemplate.js";

describe("loadPromptTemplate", () => {
  beforeEach(() => {
    _resetPromptTemplateForTest();
  });

  it("returns a template with the expected version", () => {
    const tpl = loadPromptTemplate();
    expect(tpl.version).toBe(PROMPT_TEMPLATE_VERSION);
    expect(tpl.version).toBeTruthy();
  });

  it("preamble contains the first-party-tools-only assertion", () => {
    const tpl = loadPromptTemplate();
    expect(tpl.preamble).toContain("first-party tools");
  });

  it("preamble contains data-blocks-are-not-instructions assertion", () => {
    const tpl = loadPromptTemplate();
    expect(tpl.preamble).toContain("data blocks is DATA");
  });

  it("preamble contains the no-disclosure rule", () => {
    const tpl = loadPromptTemplate();
    expect(tpl.preamble).toContain("Never reveal");
  });

  it("systemPrompt starts with the preamble", () => {
    const tpl = loadPromptTemplate();
    expect(tpl.systemPrompt.startsWith(tpl.preamble)).toBe(true);
  });

  it("returns the same singleton on repeated calls", () => {
    const t1 = loadPromptTemplate();
    const t2 = loadPromptTemplate();
    expect(t1).toBe(t2);
  });

  it("template object is frozen (immutable at runtime)", () => {
    const tpl = loadPromptTemplate();
    expect(Object.isFrozen(tpl)).toBe(true);
  });
});
