/**
 * BudgetedToolDispatcher — decorator over ToolDispatcher that gates every
 * dispatch through the per-turn BudgetGuard (WO-059).
 *
 * The orchestrator receives only this decorator; the raw ToolDispatcher is not
 * accessible, ensuring no code path can dispatch a tool without budget
 * accounting.
 *
 * When the guard denies a call the dispatcher returns a DispatchResult with
 * ok:false instead of throwing, matching the existing no-exception contract
 * established by ToolDispatcher.
 */

import type { ToolContext } from "../tools/ToolDescriptor.js";
import type { ToolDispatcher, DispatchResult } from "../tools/ToolDispatcher.js";
import type { BudgetGuard } from "./BudgetGuard.js";

// ---------------------------------------------------------------------------
// BudgetedToolDispatcher
// ---------------------------------------------------------------------------

export class BudgetedToolDispatcher {
  constructor(
    private readonly inner: ToolDispatcher,
    private readonly guard: BudgetGuard,
  ) {}

  async dispatch(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
    parentSignal?: AbortSignal,
  ): Promise<DispatchResult & { budgetDenied?: boolean }> {
    const preCheck = this.guard.beforeToolCall();
    if (!preCheck.allowed) {
      return {
        ok: false,
        budgetDenied: true,
        error: {
          code: "TOOL_BUDGET_EXCEEDED" as const,
          message: `Tool call denied: ${preCheck.cap} cap reached.`,
          reference: ctx.correlationId,
        },
      } as unknown as DispatchResult & { budgetDenied?: boolean };
    }

    const result = await this.inner.dispatch(name, rawInput, ctx, parentSignal);
    this.guard.afterToolCall();
    return result;
  }
}
