import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "./store.js";
import { nowIso } from "./ids.js";

const tmpRoots: string[] = [];

describe("RunStore", () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
    tmpRoots.length = 0;
  });

  it("appends and reads events by cursor", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-store-"));
    tmpRoots.push(cwd);
    const store = new RunStore(cwd);
    const runId = "run-1";
    await store.initRun(
      {
        id: runId,
        name: "demo",
        version: "1",
        description: "demo",
        workflowPath: "workflow.js",
        cwd,
        status: "pending",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        phases: [],
        agents: [],
        totals: {
          totalAgents: 0,
          completedAgents: 0,
          failedAgents: 0,
          runningAgents: 0,
          tokens: 0,
          tools: 0,
          elapsedMs: 0
        }
      },
      { name: "demo", version: "1", description: "demo", maxConcurrency: 1, maxAgents: 1, phases: [{ id: "x", title: "X", agents: [] }] },
      {},
      "workflow({name:'demo'})"
    );
    await store.appendEvent({
      type: "run_started",
      runId,
      at: nowIso(),
      name: "demo"
    });
    const page = await store.readEvents(runId, 0);
    expect(page.cursor).toBe(1);
    expect(page.events[0]?.type).toBe("run_started");
  });
});
