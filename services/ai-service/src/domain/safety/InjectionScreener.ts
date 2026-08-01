/**
 * InjectionScreener — classifies prompt injection patterns in untrusted text
 * (WO-061, AC3).
 *
 * Returns detections rather than blocking outright so legitimate travel text
 * that happens to contain words like "instructions" is not over-blocked.
 * Detection informs RefusalPolicy which decides whether to refuse.
 *
 * Pattern classes:
 *   INSTRUCTION_OVERRIDE — attempts to override/ignore previous instructions.
 *   PROMPT_DISCLOSURE    — attempts to reveal the system prompt or configuration.
 *   ROLE_REDEFINITION    — attempts to redefine the assistant's persona/role.
 *   TOOL_REDEFINITION    — attempts to define new tools or override tool behaviour.
 *
 * Recent-context awareness: the screener can consider a window of recent
 * conversation turns to detect multi-turn split payloads (AC3 edge case).
 */

// ---------------------------------------------------------------------------
// Detection types
// ---------------------------------------------------------------------------

export type PatternClass =
  | "INSTRUCTION_OVERRIDE"
  | "PROMPT_DISCLOSURE"
  | "ROLE_REDEFINITION"
  | "TOOL_REDEFINITION";

export type Severity = "high" | "medium" | "low";

export interface Detection {
  patternClass: PatternClass;
  severity: Severity;
  /** Identifier of the rule that fired (not the user text — no PII in telemetry). */
  ruleId: string;
  /** Optional trace/correlation reference for log correlation. */
  traceRef?: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface PatternRule {
  id: string;
  class: PatternClass;
  severity: Severity;
  /**
   * Pattern applied to lowercased, whitespace-normalised text.
   * Designed to minimise false positives on legitimate travel content.
   */
  pattern: RegExp;
}

// Each regex is anchored with \b where useful to reduce false positives.
// Legitimate travel phrases like "instructions for check-in" must not match.
const PATTERN_RULES: readonly PatternRule[] = [
  // -------------------------------------------------------------------------
  // INSTRUCTION_OVERRIDE
  // -------------------------------------------------------------------------
  {
    id: "IO-01",
    class: "INSTRUCTION_OVERRIDE",
    severity: "high",
    // "ignore (all|any|previous|your) instructions" variants
    pattern: /\bignore\s+(all|any|previous|your|the\s+(?:previous|above|following|prior))\s+instructions?\b/i,
  },
  {
    id: "IO-02",
    class: "INSTRUCTION_OVERRIDE",
    severity: "high",
    pattern: /\bdisregard\s+(all|any|previous|the|your)\s+instructions?\b/i,
  },
  {
    id: "IO-03",
    class: "INSTRUCTION_OVERRIDE",
    severity: "high",
    pattern: /\bforget\s+(everything|all\s+(?:your|previous)\s+instructions?|what\s+you\s+(?:were|have been)\s+told)\b/i,
  },
  {
    id: "IO-04",
    class: "INSTRUCTION_OVERRIDE",
    severity: "high",
    // "override your instructions", "override the system prompt"
    pattern: /\boverride\s+(?:your\s+)?(?:instructions?|system\s+prompt|directives?|rules?|constraints?)\b/i,
  },
  {
    id: "IO-05",
    class: "INSTRUCTION_OVERRIDE",
    severity: "high",
    pattern: /\byour\s+(?:new|updated|real|actual|true)\s+instructions?\s+are\b/i,
  },
  {
    id: "IO-06",
    class: "INSTRUCTION_OVERRIDE",
    severity: "medium",
    // "from now on", "starting now", "as of now" followed by behavioural instruction
    pattern: /\bfrom\s+(?:now|this\s+point)\s+on(?:ward)?,?\s+you\s+(?:will|must|should|shall|are\s+to)\b/i,
  },
  {
    id: "IO-07",
    class: "INSTRUCTION_OVERRIDE",
    severity: "medium",
    pattern: /\bdo\s+not\s+follow\s+(?:your|the|any|previous)\s+(?:instructions?|guidelines?|rules?)\b/i,
  },

  // -------------------------------------------------------------------------
  // PROMPT_DISCLOSURE
  // -------------------------------------------------------------------------
  {
    id: "PD-01",
    class: "PROMPT_DISCLOSURE",
    severity: "high",
    pattern: /\b(?:reveal|show|print|output|tell\s+me|what\s+(?:is|are))\s+(?:your|the)\s+system\s+prompt\b/i,
  },
  {
    id: "PD-02",
    class: "PROMPT_DISCLOSURE",
    severity: "high",
    pattern: /\b(?:what\s+(?:are|were)\s+your|tell\s+me\s+(?:your|all)\s+)\s*(?:initial\s+)?instructions?\b/i,
  },
  {
    id: "PD-03",
    class: "PROMPT_DISCLOSURE",
    severity: "high",
    pattern: /\b(?:repeat|recite|reproduce|copy|paste|display)\s+(?:your\s+)?(?:system\s+prompt|initial\s+prompt|preamble|guidelines?|configuration)\b/i,
  },
  {
    id: "PD-04",
    class: "PROMPT_DISCLOSURE",
    severity: "high",
    pattern: /\bwhat\s+(?:is\s+)?(?:your\s+)?(?:system\s+)?(?:prompt|preamble|configuration|context|setup)\b/i,
  },
  {
    id: "PD-05",
    class: "PROMPT_DISCLOSURE",
    severity: "medium",
    // "output everything above", "print everything before this"
    pattern: /\b(?:output|print|show|repeat)\s+everything\s+(?:above|before|prior\s+to)\b/i,
  },
  {
    id: "PD-06",
    class: "PROMPT_DISCLOSURE",
    severity: "medium",
    pattern: /\bcontext\s+window\s+contents?\b/i,
  },

  // -------------------------------------------------------------------------
  // ROLE_REDEFINITION
  // -------------------------------------------------------------------------
  {
    id: "RR-01",
    class: "ROLE_REDEFINITION",
    severity: "high",
    // "you are now [X]", "you are now acting as [X]"
    pattern: /\byou\s+are\s+now\s+(?:a|an|the|acting\s+as)?\s*(?!a\s+travel\s+assistant)\S/i,
  },
  {
    id: "RR-02",
    class: "ROLE_REDEFINITION",
    severity: "high",
    // "act as [X]", "pretend to be [X]", "pretend you are [X]"
    pattern: /\b(?:act\s+as|pretend\s+(?:to\s+be|you\s+are?)|roleplay\s+as|play\s+the\s+role\s+of)\s+(?!a\s+travel\s+assistant)\S/i,
  },
  {
    id: "RR-03",
    class: "ROLE_REDEFINITION",
    severity: "high",
    // "your new persona is", "your role is now"
    pattern: /\byour\s+(?:new\s+)?(?:persona|role|identity|character)\s+(?:is\s+(?:now\s+)?|has\s+changed\s+to)\b/i,
  },
  {
    id: "RR-04",
    class: "ROLE_REDEFINITION",
    severity: "medium",
    // "enter [X] mode", "switch to [X] mode"
    pattern: /\b(?:enter|switch\s+(?:to|into)|activate)\s+\S+\s+mode\b/i,
  },
  {
    id: "RR-05",
    class: "ROLE_REDEFINITION",
    severity: "medium",
    pattern: /\byou\s+have\s+no\s+(?:restrictions?|rules?|guidelines?|limits?|constraints?)\b/i,
  },

  // -------------------------------------------------------------------------
  // TOOL_REDEFINITION
  // -------------------------------------------------------------------------
  {
    id: "TR-01",
    class: "TOOL_REDEFINITION",
    severity: "high",
    // "you now have a new tool called [X]", "I am adding a tool"
    pattern: /\b(?:you\s+now\s+have\s+(?:a\s+)?(?:new\s+)?tool|i\s+am\s+adding\s+(?:a\s+)?(?:new\s+)?tool)\b/i,
  },
  {
    id: "TR-02",
    class: "TOOL_REDEFINITION",
    severity: "high",
    // "call the [external] api", "invoke the [external] function"
    pattern: /\b(?:call|invoke|use|execute)\s+(?:the\s+)?(?:external|new|following|this)\s+(?:api|function|tool|endpoint)\b/i,
  },
  {
    id: "TR-03",
    class: "TOOL_REDEFINITION",
    severity: "high",
    // "function_name() { ... }" style tool injection
    pattern: /\bfunction\s+\w+\s*\([^)]*\)\s*\{/i,
  },
  {
    id: "TR-04",
    class: "TOOL_REDEFINITION",
    severity: "medium",
    // "your tool [X] is now redefined to"
    pattern: /\byour\s+tool\s+\S+\s+(?:is\s+now\s+)?(?:redefined|overridden|updated|replaced)\b/i,
  },
  {
    id: "TR-05",
    class: "TOOL_REDEFINITION",
    severity: "medium",
    // "execute this code:", "run the following script:"
    pattern: /\b(?:execute|run|eval|evaluate)\s+(?:this\s+|the\s+following\s+)?(?:code|script|command|payload)\b/i,
  },
];

// ---------------------------------------------------------------------------
// InjectionScreener
// ---------------------------------------------------------------------------

export interface InjectionScreenerConfig {
  /**
   * Number of recent turns to concatenate with the current text for
   * multi-turn context screening (default: 2).
   */
  recentContextWindow?: number;
}

export class InjectionScreener {
  private readonly contextWindow: number;

  constructor(config: InjectionScreenerConfig = {}) {
    this.contextWindow = config.recentContextWindow ?? 2;
  }

  /**
   * Screen text for injection patterns.
   *
   * @param text          The current untrusted input.
   * @param recentContext Optional recent turns for multi-turn split detection.
   * @param traceRef      Correlation ID for the current turn (added to detections).
   */
  screen(text: string, recentContext?: string[], traceRef?: string): Detection[] {
    const detections: Detection[] = [];
    const seen = new Set<string>(); // deduplicate by rule id

    // Build context window: recent turns + current text
    const contextSlice = recentContext
      ? recentContext.slice(-this.contextWindow).join(" ") + " " + text
      : text;

    for (const rule of PATTERN_RULES) {
      if (seen.has(rule.id)) continue;
      // Test both isolated current text and context window
      if (rule.pattern.test(text) || rule.pattern.test(contextSlice)) {
        seen.add(rule.id);
        detections.push({
          patternClass: rule.class,
          severity: rule.severity,
          ruleId: rule.id,
          traceRef,
        });
      }
    }

    return detections;
  }
}
