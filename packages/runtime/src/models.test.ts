import { describe, expect, it } from "vitest";
import {
  collectWorkflowModels,
  ModelValidationError,
  parseCodexModelCatalog,
  validateRequestedModels
} from "./models.js";

describe("model validation", () => {
  it("parses codex debug model catalog output without retaining prompt metadata", () => {
    const models = parseCodexModelCatalog(
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.4-mini",
            base_instructions: "do not copy this",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }]
          }
        ]
      })
    );

    expect(models).toEqual([
      { slug: "gpt-5.4-mini", supportedReasoningLevels: ["low", "high"] }
    ]);
    expect(JSON.stringify(models)).not.toContain("do not copy this");
  });

  it("suggests full Codex model slugs for shorthand names", async () => {
    const previous = process.env.CODEX_WORKFLOWS_MODEL_CATALOG;
    process.env.CODEX_WORKFLOWS_MODEL_CATALOG = JSON.stringify({
      models: [{ slug: "gpt-5.4-mini" }, { slug: "gpt-5.5" }]
    });
    try {
      await expect(validateRequestedModels(["5.4-mini"])).rejects.toMatchObject({
        issues: [{ model: "5.4-mini", suggestion: "gpt-5.4-mini" }]
      } satisfies Partial<ModelValidationError>);
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_WORKFLOWS_MODEL_CATALOG;
      } else {
        process.env.CODEX_WORKFLOWS_MODEL_CATALOG = previous;
      }
    }
  });

  it("ignores bundled display label Codex while collecting real model requests", () => {
    const models = collectWorkflowModels(
      {
        name: "demo",
        version: "1",
        description: "demo",
        maxConcurrency: 1,
        maxAgents: 2,
        phases: [
          {
            id: "find",
            title: "Find",
            agents: [
              { id: "a", title: "A", prompt: "A", model: "Codex", sandbox: "read-only" },
              {
                id: "b",
                title: "B",
                prompt: "B",
                model: "gpt-5.5",
                sandbox: "read-only"
              }
            ]
          }
        ]
      },
      {}
    );

    expect(models).toEqual(["gpt-5.5"]);
  });
});
