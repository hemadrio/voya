/**
 * RefusalPolicy — maps injection detections and request intent to deterministic
 * refusal messages (WO-061, AC4).
 *
 * Refusals are normal turn outcomes, not errors.  They are recorded with a
 * reason code and no user free text in labels or logs (AC9).
 *
 * Refusal reasons:
 *   prompt_disclosure    — request attempts to reveal system prompt or config.
 *   cap_modification     — request attempts to change caps or configuration.
 *   unregistered_tool    — request attempts to invoke an unregistered tool.
 *   role_redefinition    — request attempts to redefine the assistant's role.
 *   instruction_override — request attempts to override security instructions.
 *
 * Design: deterministic — same detections always produce the same refusal.
 */

import type { Detection, PatternClass } from "./InjectionScreener.js";

// ---------------------------------------------------------------------------
// Refusal reason codes
// ---------------------------------------------------------------------------

export type RefusalReason =
  | "prompt_disclosure"
  | "cap_modification"
  | "unregistered_tool"
  | "role_redefinition"
  | "instruction_override";

// ---------------------------------------------------------------------------
// Refusal messages — generic, do not echo back user text or reveal internals
// ---------------------------------------------------------------------------

const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  prompt_disclosure:
    "I'm not able to share information about my configuration or instructions. Is there something I can help you with for your travel plans?",
  cap_modification:
    "System configuration cannot be changed during a conversation. Is there something I can help you with for your travel plans?",
  unregistered_tool:
    "I can only use the travel tools available to me in this session. Is there something I can help you with for your trip?",
  role_redefinition:
    "I'm here as your travel assistant and can't take on a different role. How can I help with your travel plans?",
  instruction_override:
    "I'm not able to change my operating guidelines. How can I help with your travel plans?",
};

// ---------------------------------------------------------------------------
// Mapping from pattern class → refusal reason
// ---------------------------------------------------------------------------

const CLASS_TO_REASON: Record<PatternClass, RefusalReason> = {
  INSTRUCTION_OVERRIDE: "instruction_override",
  PROMPT_DISCLOSURE: "prompt_disclosure",
  ROLE_REDEFINITION: "role_redefinition",
  TOOL_REDEFINITION: "unregistered_tool",
};

// ---------------------------------------------------------------------------
// RefusalDecision
// ---------------------------------------------------------------------------

export type RefusalDecision =
  | { refuse: false }
  | { refuse: true; reason: RefusalReason; message: string };

// ---------------------------------------------------------------------------
// RefusalPolicy
// ---------------------------------------------------------------------------

export class RefusalPolicy {
  /**
   * Evaluate detections (and optional explicit request intent) to decide
   * whether to refuse the request.
   *
   * Only HIGH severity detections trigger a refusal by default; MEDIUM and
   * LOW are recorded in telemetry but do not refuse outright (AC3 constraint:
   * minimise false positives on legitimate travel content).
   *
   * @param detections     Detections from InjectionScreener.
   * @param requestIntent  Optional explicit intent code from the router layer
   *                       (e.g. "cap_modification") — always triggers a refusal.
   */
  evaluate(
    detections: Detection[],
    requestIntent?: "cap_modification" | "unregistered_tool",
  ): RefusalDecision {
    // Explicit intent always refused (AC4)
    if (requestIntent === "cap_modification") {
      return { refuse: true, reason: "cap_modification", message: REFUSAL_MESSAGES.cap_modification };
    }
    if (requestIntent === "unregistered_tool") {
      return { refuse: true, reason: "unregistered_tool", message: REFUSAL_MESSAGES.unregistered_tool };
    }

    // Find the highest-priority high-severity detection
    const highSeverity = detections.filter((d) => d.severity === "high");
    if (highSeverity.length === 0) return { refuse: false };

    // Prioritise by class in order of severity impact
    const priorityOrder: PatternClass[] = [
      "PROMPT_DISCLOSURE",
      "INSTRUCTION_OVERRIDE",
      "TOOL_REDEFINITION",
      "ROLE_REDEFINITION",
    ];

    for (const cls of priorityOrder) {
      const match = highSeverity.find((d) => d.patternClass === cls);
      if (match) {
        const reason = CLASS_TO_REASON[cls];
        return { refuse: true, reason, message: REFUSAL_MESSAGES[reason] };
      }
    }

    // Fallback: use the first high-severity detection
    const first = highSeverity[0];
    const reason = CLASS_TO_REASON[first.patternClass];
    return { refuse: true, reason, message: REFUSAL_MESSAGES[reason] };
  }

  /** Return the refusal message for a given reason (for testing). */
  static messageFor(reason: RefusalReason): string {
    return REFUSAL_MESSAGES[reason];
  }
}
