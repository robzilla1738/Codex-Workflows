import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultStoreRoot, RunStore } from "./store.js";
import { nowIso } from "./ids.js";

const tmpRoots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

describe("RunStore", () => {
  beforeEach(async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cwf-home-"));
    tmpRoots.push(home);
    process.env.CODEX_HOME = home;
  });

  afterEach(async () => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
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
    expect(store.root).toBe(defaultStoreRoot(cwd, "codex-home"));
    expect(existsSync(path.join(cwd, ".codex-workflows"))).toBe(false);
  });

  it("can read legacy project-scoped runs", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-store-"));
    tmpRoots.push(cwd);
    const legacy = new RunStore(cwd, { storageScope: "project" });
    const runId = "legacy-run";
    await legacy.initRun(
      {
        id: runId,
        name: "legacy",
        version: "1",
        description: "legacy",
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
      {
        name: "legacy",
        version: "1",
        description: "legacy",
        maxConcurrency: 1,
        maxAgents: 1,
        phases: [{ id: "x", title: "X", agents: [] }]
      },
      {},
      "workflow({name:'legacy'})"
    );

    const currentDefault = new RunStore(cwd);
    expect((await currentDefault.readSummary(runId)).name).toBe("legacy");
  });

  it("marks stale running agents failed when the detached runner is gone", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-store-"));
    tmpRoots.push(cwd);
    const store = new RunStore(cwd, { staleHeartbeatMs: 1 });
    const runId = "orphan-run";
    const old = new Date(Date.now() - 60_000).toISOString();
    await store.initRun(
      {
        id: runId,
        name: "orphan",
        version: "1",
        description: "orphan",
        workflowPath: "workflow.js",
        cwd,
        status: "running",
        createdAt: old,
        updatedAt: old,
        startedAt: old,
        runnerPid: 99_999_999,
        heartbeatAt: old,
        lastActivityAt: old,
        phases: [{ id: "find", title: "Find", status: "running", totalAgents: 2, completedAgents: 1, failedAgents: 0, startedAt: old }],
        agents: [
          {
            id: "find:done",
            phaseId: "find",
            title: "find:done",
            prompt: "done",
            sandbox: "read-only",
            status: "completed",
            tokens: 1,
            tools: 1,
            elapsedMs: 1,
            attempts: 1,
            completedAt: old
          },
          {
            id: "find:stuck",
            phaseId: "find",
            title: "find:stuck",
            prompt: "stuck",
            sandbox: "read-only",
            status: "running",
            tokens: 0,
            tools: 0,
            elapsedMs: 0,
            attempts: 1,
            startedAt: old
          }
        ],
        totals: {
          totalAgents: 2,
          completedAgents: 1,
          failedAgents: 0,
          runningAgents: 1,
          tokens: 1,
          tools: 1,
          elapsedMs: 0
        }
      },
      {
        name: "orphan",
        version: "1",
        description: "orphan",
        maxConcurrency: 1,
        maxAgents: 2,
        phases: [{ id: "find", title: "Find", agents: [] }]
      },
      {},
      "workflow({name:'orphan'})"
    );

    const summary = await store.readSummary(runId);
    expect(summary.status).toBe("failed");
    expect(summary.agents.find((agent) => agent.id === "find:done")?.status).toBe("completed");
    expect(summary.agents.find((agent) => agent.id === "find:stuck")?.status).toBe("failed");
    expect(summary.error).toContain("runner process");
  });
});
