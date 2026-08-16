/**
 * Kimi Code CLI plan interception (`plannotator kimi-plan`).
 *
 * Kimi Code spawns this command as a PermissionRequest hook for ExitPlanMode:
 * the hook event arrives as JSON on stdin, the process blocks while the user
 * reviews the plan in the browser, and the decision goes back as a single JSON
 * line on stdout (exit code is always 0):
 *
 *   allow: {"hookSpecificOutput":{"permissionDecision":"allow"}}
 *   deny:  {"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"<feedback markdown>"}}
 *
 * The plan markdown lives in `display.plan` (NOT `tool_input.plan`);
 * `display.path` / `display.options` may be absent.
 */

import { buildPlanFileRule, getPlanDeniedPrompt, getPlanToolName } from "@plannotator/shared/prompts";
import type { PlannotatorConfig } from "@plannotator/shared/config";

export type KimiHookEventParse =
  // Not an ExitPlanMode request — print nothing and exit 0 (allow).
  | { kind: "passthrough" }
  // Malformed input or no usable plan — stderr message, exit 1.
  | { kind: "error"; message: string }
  | { kind: "plan"; plan: string; planPath?: string };

export function parseKimiHookEvent(inputJson: string): KimiHookEventParse {
  let event: unknown;
  try {
    event = JSON.parse(inputJson);
  } catch (e) {
    return {
      kind: "error",
      message: `Failed to parse kimi hook event from stdin: ${e instanceof Error ? e.message : e}`,
    };
  }
  if (typeof event !== "object" || event === null) {
    return { kind: "error", message: "Invalid kimi hook event: expected a JSON object" };
  }

  // The plugin's hook matcher already restricts this command to ExitPlanMode,
  // but tolerate being wired to a broader matcher: anything else passes through.
  const toolName = (event as Record<string, unknown>).tool_name;
  if (typeof toolName === "string" && toolName !== "ExitPlanMode") {
    return { kind: "passthrough" };
  }

  const display = (event as Record<string, unknown>).display;
  const displayObj =
    typeof display === "object" && display !== null
      ? (display as Record<string, unknown>)
      : undefined;

  const plan = displayObj?.plan;
  if (typeof plan !== "string" || !plan.trim()) {
    return { kind: "error", message: "No plan content in kimi hook event (display.plan missing or empty)" };
  }

  const planPath = displayObj?.path;
  return {
    kind: "plan",
    plan,
    planPath: typeof planPath === "string" && planPath ? planPath : undefined,
  };
}

export interface KimiDecisionResult {
  approved: boolean;
  feedback?: string;
}

export function buildKimiDecisionJson(
  result: KimiDecisionResult,
  planPath?: string,
  config?: PlannotatorConfig,
): string {
  if (result.approved) {
    return JSON.stringify({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  }

  const toolName = getPlanToolName("kimi");
  return JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: getPlanDeniedPrompt("kimi", config, {
        toolName,
        planFileRule: buildPlanFileRule(toolName, planPath),
        feedback: result.feedback || "Plan changes requested",
      }),
    },
  });
}
