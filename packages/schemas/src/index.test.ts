import { describe, expect, it } from "vitest";
import { WorkflowDefinitionSchema, WorkflowEventSchema } from "./index.js";

describe("schemas", () => {
  it("normalizes workflow defaults", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      name: "release-diff-review",
      description: "Review a release diff.",
      phases: [{ id: "find", title: "Find", agents: [] }]
    });

    expect(parsed.maxConcurrency).toBe(16);
    expect(parsed.maxAgents).toBe(1000);
  });

  it("validates event discriminators", () => {
    expect(
      WorkflowEventSchema.parse({
        type: "run_started",
        runId: "run_1",
        at: new Date(0).toISOString(),
        name: "demo"
      }).type
    ).toBe("run_started");
  });
});
