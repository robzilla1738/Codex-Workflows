import { describe, expect, it } from "vitest";
import {
  MAX_WORKFLOW_AGENTS,
  MAX_WORKFLOW_CONCURRENCY,
  WorkflowDefinitionSchema,
  WorkflowEventSchema
} from "./index.js";

describe("schemas", () => {
  it("normalizes workflow defaults", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      name: "release-diff-review",
      description: "Review a release diff.",
      phases: [
        {
          id: "find",
          title: "Find",
          agents: [
            {
              id: "a",
              title: "a",
              prompt: "A",
              contextFrom: { phaseIds: ["find"] }
            }
          ]
        }
      ]
    });

    expect(parsed.maxConcurrency).toBe(16);
    expect(parsed.maxAgents).toBe(1000);
    expect(parsed.phases[0]?.agents[0]?.contextFrom?.mode).toBe("all");
  });

  it("allows higher explicit workflow caps without changing defaults", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      name: "deep-review",
      description: "Deep review.",
      maxConcurrency: MAX_WORKFLOW_CONCURRENCY,
      maxAgents: MAX_WORKFLOW_AGENTS,
      phases: [{ id: "find", title: "Find", agents: [] }]
    });

    expect(parsed.maxConcurrency).toBe(64);
    expect(parsed.maxAgents).toBe(2000);
    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: "too-high",
        description: "Too high.",
        maxConcurrency: MAX_WORKFLOW_CONCURRENCY + 1,
        maxAgents: MAX_WORKFLOW_AGENTS + 1,
        phases: [{ id: "find", title: "Find", agents: [] }]
      })
    ).toThrow();
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
