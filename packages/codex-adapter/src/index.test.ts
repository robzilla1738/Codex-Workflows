import { describe, expect, it } from "vitest";
import { SimulatedCodexAdapter } from "./index.js";

describe("SimulatedCodexAdapter", () => {
  it("emits progress and returns a result", async () => {
    const adapter = new SimulatedCodexAdapter(100);
    const progress: unknown[] = [];
    const result = await adapter.runWorker(
      {
        id: "agent-1",
        phaseId: "find",
        title: "find:ui",
        prompt: "Inspect UI",
        cwd: process.cwd(),
        sandbox: "read-only",
        expectedTokens: 120,
        expectedTools: 3,
        durationMs: 1
      },
      (event) => progress.push(event)
    );

    expect(progress.length).toBeGreaterThan(0);
    expect(result.tokens).toBe(120);
    expect(result.tools).toBe(3);
  });
});
