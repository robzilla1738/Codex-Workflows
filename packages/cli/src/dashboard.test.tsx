import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { RunSummary } from "@codex-workflows/schemas";
import { DashboardFrame } from "./dashboard.js";

const fixture: RunSummary = {
  id: "run-1",
  name: "release-diff-review-v2",
  version: "1",
  description:
    "Exhaustive adversarial review of v1.1.2...main for Harness v1.2.0",
  workflowPath: "workflows/release-diff-review.workflow.js",
  cwd: process.cwd(),
  status: "running",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
  startedAt: new Date(Date.now() - 39 * 60 * 1000).toISOString(),
  selectedPhaseId: "find",
  phases: [
    { id: "find", title: "Find", status: "running", totalAgents: 14, completedAgents: 11, failedAgents: 0 },
    { id: "verify", title: "Verify", status: "completed", totalAgents: 94, completedAgents: 94, failedAgents: 0 },
    { id: "probe", title: "Probe", status: "pending", totalAgents: 0, completedAgents: 0, failedAgents: 0 },
    { id: "synthesize", title: "Synthesize", status: "pending", totalAgents: 0, completedAgents: 0, failedAgents: 0 }
  ],
  agents: [
    {
      id: "find:reflow-engine",
      phaseId: "find",
      title: "find:reflow-engine",
      prompt: "Review reflow engine",
      model: "Codex",
      sandbox: "read-only",
      status: "completed",
      tokens: 109000,
      tools: 91,
      elapsedMs: 740000,
      attempts: 1
    },
    {
      id: "find:concurrency",
      phaseId: "find",
      title: "find:concurrency",
      prompt: "Review concurrency",
      model: "Codex",
      sandbox: "read-only",
      status: "running",
      tokens: 0,
      tools: 95,
      elapsedMs: 554000,
      attempts: 1,
      startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      lastActivityAt: new Date(Date.now() - 15 * 1000).toISOString(),
      lastMessage: "command_execution"
    }
  ],
  totals: {
    totalAgents: 108,
    completedAgents: 105,
    failedAgents: 0,
    runningAgents: 1,
    tokens: 247500,
    tools: 186,
    elapsedMs: 2387000
  }
};

describe("DashboardFrame", () => {
  it("renders the screenshot-like terminal frame", () => {
    const { lastFrame } = render(<DashboardFrame summary={fixture} width={132} />);
    expect(lastFrame()).toContain("release-diff-review-v2");
    expect(lastFrame()).toContain("Find");
    expect(lastFrame()).toContain("find:reflow-engine");
    expect(lastFrame()).toContain("tok");
  });

  it("shows pending token metrics and activity for running agents", () => {
    const { lastFrame } = render(
      <DashboardFrame
        summary={fixture}
        width={88}
        selectedPhaseId="find"
        selectedAgentId="find:concurrency"
      />
    );
    expect(lastFrame()).toContain("tok pending");
    expect(lastFrame()).toContain("idle");
    expect(lastFrame()).toContain("command_execution");
  });
});
