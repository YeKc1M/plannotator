import { describe, expect, test } from "bun:test";
import { buildKimiDecisionJson, parseKimiHookEvent } from "./kimi-plan";

const baseEvent = {
  hook_event_name: "PermissionRequest",
  session_id: "sess-1",
  cwd: "/repo",
  id: "approval_1234",
  agent_id: "main",
  turn_id: 1,
  tool_call_id: "call-1",
  tool_name: "ExitPlanMode",
  action: "exit plan mode",
  client_type: "cli",
};

describe("parseKimiHookEvent", () => {
  test("extracts the plan from display.plan", () => {
    const parsed = parseKimiHookEvent(JSON.stringify({
      ...baseEvent,
      display: {
        kind: "plan_review",
        plan: "# My Plan\n\nDo the thing.",
        path: "/repo/.kimi/plans/my-plan.md",
        options: [{ label: "Looks good", description: "ship it" }],
      },
      tool_input: { options: [] },
    }));

    expect(parsed).toEqual({
      kind: "plan",
      plan: "# My Plan\n\nDo the thing.",
      planPath: "/repo/.kimi/plans/my-plan.md",
    });
  });

  test("tolerates missing display.path and display.options", () => {
    const parsed = parseKimiHookEvent(JSON.stringify({
      ...baseEvent,
      display: { kind: "plan_review", plan: "# Plan" },
    }));

    expect(parsed).toEqual({ kind: "plan", plan: "# Plan", planPath: undefined });
  });

  test("errors when display.plan is missing or blank", () => {
    for (const display of [
      undefined,
      { kind: "plan_review" },
      { kind: "plan_review", plan: "   " },
    ]) {
      const parsed = parseKimiHookEvent(JSON.stringify({ ...baseEvent, display }));
      expect(parsed.kind).toBe("error");
    }
  });

  test("passes through non-ExitPlanMode tool calls silently", () => {
    const parsed = parseKimiHookEvent(JSON.stringify({
      ...baseEvent,
      tool_name: "Bash",
    }));
    expect(parsed).toEqual({ kind: "passthrough" });
  });

  test("errors on malformed JSON instead of inventing a plan", () => {
    expect(parseKimiHookEvent("not json").kind).toBe("error");
    expect(parseKimiHookEvent("[]").kind).toBe("error");
  });
});

describe("buildKimiDecisionJson", () => {
  // Pass an empty config so loadConfig() never reads the real user config.

  test("approve emits the kimi allow shape", () => {
    expect(buildKimiDecisionJson({ approved: true }, undefined, {})).toBe(
      '{"hookSpecificOutput":{"permissionDecision":"allow"}}',
    );
  });

  test("deny carries the feedback in permissionDecisionReason", () => {
    const out = JSON.parse(buildKimiDecisionJson(
      { approved: false, feedback: "Add error handling to step 2." },
      undefined,
      {},
    ));

    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("Add error handling to step 2.");
    // The denied prompt must name the tool the agent has to call again.
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("ExitPlanMode");
  });

  test("deny references the plan file when display.path was provided", () => {
    const out = JSON.parse(buildKimiDecisionJson(
      { approved: false, feedback: "Revise." },
      "/repo/.kimi/plans/my-plan.md",
      {},
    ));

    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("/repo/.kimi/plans/my-plan.md");
  });
});
