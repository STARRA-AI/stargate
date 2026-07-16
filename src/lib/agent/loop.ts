/**
 * Bounded agent/tool loop — Phase 0 (V2 architecture).
 * Pattern: every agentic loop runs while turn < maxTurns with graceful stop.
 * Prevents unbounded Anthropic spend when the model keeps requesting tools.
 */

export const MAX_AGENT_TURNS = 12;

export const LOOP_CAP_MESSAGE =
  `I hit my internal step limit working on that (${MAX_AGENT_TURNS} tool rounds). ` +
  "Here's where I got to — tell me to continue and I'll pick it back up.";

export type AgentLoopStepResult<T> =
  | { done: true; value: T }
  | { done: false };

/**
 * Run an agentic step function up to maxTurns times.
 * Returns the first done value, or onCap() when the ceiling is hit.
 */
export async function runBoundedAgentLoop<T>(opts: {
  maxTurns?: number;
  step: (turn: number) => Promise<AgentLoopStepResult<T>>;
  onCap: (turnsUsed: number) => T | Promise<T>;
}): Promise<{ value: T; turns: number; capped: boolean }> {
  const maxTurns = opts.maxTurns ?? MAX_AGENT_TURNS;
  let turn = 0;

  while (turn < maxTurns) {
    turn += 1;
    const result = await opts.step(turn);
    if (result.done) {
      return { value: result.value, turns: turn, capped: false };
    }
  }

  const value = await opts.onCap(turn);
  return { value, turns: turn, capped: true };
}
