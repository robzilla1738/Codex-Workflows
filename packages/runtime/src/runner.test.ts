import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkflow } from "./runner.js";
import { RunStore } from "./store.js";
import { validateWorkflowDefinition } from "./definition.js";
import type { WorkerAdapter } from "@codex-workflows/codex-adapter";

const tmpRoots: string[] = [];

describe("runWorkflow", () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
    tmpRoots.length = 0;
  });

  it("runs a simulated workflow and persists a summary", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-runner-"));
    tmpRoots.push(cwd);
    const workflowPath = path.join(cwd, "demo.workflow.js");
    await writeFile(
      workflowPath,
      `export default workflow({
        name:"demo",
        description:"Demo",
        maxConcurrency:2,
        phases:[{
          id:"find",
          title:"Find",
          agents:[
            {id:"a",title:"a",prompt:"A",expectedTokens:10,expectedTools:1,durationMs:1},
            {id:"b",title:"b",prompt:"B",expectedTokens:20,expectedTools:2,durationMs:1}
          ]
        }]
      });`
    );
    const summary = await runWorkflow({ cwd, workflowPath, adapter: "simulate" });
    expect(summary.status).toBe("completed");
    expect(summary.totals.completedAgents).toBe(2);
    expect(summary.totals.tokens).toBe(30);
    expect(summary.agents[0]?.findings?.[0]?.verdict).toBe("needs-human-review");
  });

  it("lets caller model controls override workflow agent defaults", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-runner-"));
    tmpRoots.push(cwd);
    const workflowPath = path.join(cwd, "models.workflow.js");
    await writeFile(
      workflowPath,
      `export default workflow({
        name:"models",
        description:"Models",
        phases:[{
          id:"find",
          title:"Find",
          agents:[
            {id:"a",title:"a",prompt:"A",model:"workflow-model",durationMs:1},
            {id:"b",title:"b",prompt:"B",model:"workflow-model",durationMs:1}
          ]
        },{
          id:"synthesize",
          title:"Synthesize",
          agents:[{id:"final",title:"final",prompt:"Final",model:"workflow-model",durationMs:1}]
        }]
      });`
    );
    const summary = await runWorkflow({
      cwd,
      workflowPath,
      adapter: "simulate",
      defaultModel: "caller-default",
      reasoningEffort: "xhigh",
      modelMap: {
        "find:b": "exact-agent",
        synthesize: "phase-model"
      }
    });
    expect(summary.agents.map((agent) => [agent.id, agent.model, agent.reasoningEffort])).toEqual([
      ["find:a", "caller-default", "xhigh"],
      ["find:b", "exact-agent", "xhigh"],
      ["synthesize:final", "phase-model", "xhigh"]
    ]);
  });

  it("retries malformed worker output once and stores validated findings", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-runner-"));
    tmpRoots.push(cwd);
    const workflowPath = path.join(cwd, "retry.workflow.js");
    await writeFile(
      workflowPath,
      `export default workflow({
        name:"retry",
        description:"Retry",
        phases:[{id:"find",title:"Find",agents:[{id:"a",title:"a",prompt:"A"}]}]
      });`
    );
    let calls = 0;
    const adapter: WorkerAdapter = {
      name: "test",
      async runWorker() {
        calls += 1;
        return {
          output:
            calls === 1
              ? "not json"
              : JSON.stringify({
                  findings: [
                    {
                      verdict: "confirmed",
                      severity: "high",
                      summary: "Confirmed bug",
                      evidence: ["file.ts:1"],
                      confidence: 0.9
                    }
                  ]
                }),
          tokens: 1,
          tools: 1,
          elapsedMs: 1
        };
      }
    };
    const summary = await runWorkflow({ cwd, workflowPath, adapter });
    expect(calls).toBe(2);
    expect(summary.status).toBe("completed");
    expect(summary.agents[0]?.findings?.[0]?.verdict).toBe("confirmed");
  });

  it("resumes with completed agents cached and reruns only restarted agents", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-runner-"));
    tmpRoots.push(cwd);
    const workflowPath = path.join(cwd, "resume.workflow.js");
    await writeFile(
      workflowPath,
      `export default workflow({
        name:"resume",
        description:"Resume",
        phases:[{id:"find",title:"Find",agents:[
          {id:"a",title:"a",prompt:"A",expectedTokens:10,durationMs:1},
          {id:"b",title:"b",prompt:"B",expectedTokens:20,durationMs:1}
        ]}]
      });`
    );
    const first = await runWorkflow({ cwd, workflowPath, adapter: "simulate", runId: "run-resume" });
    expect(first.totals.completedAgents).toBe(2);
    const store = new RunStore(cwd);
    await store.markAgentForRestart("run-resume", "find:b");
    const second = await runWorkflow({
      cwd,
      workflowPath,
      adapter: "simulate",
      runId: "run-resume",
      resume: true
    });
    expect(second.status).toBe("completed");
    expect(second.agents.find((agent) => agent.id === "find:a")?.tokens).toBe(10);
    expect(second.agents.find((agent) => agent.id === "find:b")?.status).toBe("completed");
  });

  it("cancels a selected running agent without failing the workflow", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-runner-"));
    tmpRoots.push(cwd);
    const workflowPath = path.join(cwd, "cancel.workflow.js");
    await writeFile(
      workflowPath,
      `export default workflow({
        name:"cancel",
        description:"Cancel",
        maxConcurrency:1,
        phases:[{id:"find",title:"Find",agents:[{id:"a",title:"a",prompt:"A"}]}]
      });`
    );
    const store = new RunStore(cwd);
    const adapter: WorkerAdapter = {
      name: "slow",
      async runWorker(_spec, _progress, signal) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("Worker aborted"));
            },
            { once: true }
          );
        });
        return {
          output: JSON.stringify({
            findings: [
              {
                verdict: "confirmed",
                severity: "low",
                summary: "should not complete",
                evidence: ["none"],
                confidence: 1
              }
            ]
          }),
          tokens: 1,
          tools: 1,
          elapsedMs: 1
        };
      }
    };
    const done = runWorkflow({ cwd, workflowPath, adapter, runId: "run-cancel" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await store.writeControl("run-cancel", {
      type: "stop-agent",
      at: new Date(0).toISOString(),
      agentId: "find:a"
    });
    const summary = await done;
    expect(summary.status).toBe("completed");
    expect(summary.agents[0]?.status).toBe("cancelled");
  });

  it("rejects workflows that exceed their maxAgents cap", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-runner-"));
    tmpRoots.push(cwd);
    const workflowPath = path.join(cwd, "invalid.workflow.js");
    await writeFile(
      workflowPath,
      `export default workflow({
        name:"invalid",
        description:"Invalid",
        maxAgents:1,
        phases:[{id:"find",title:"Find",agents:[
          {id:"a",title:"a",prompt:"A"},
          {id:"b",title:"b",prompt:"B"}
        ]}]
      });`
    );
    const result = await validateWorkflowDefinition(workflowPath);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("maxAgents");
  });
});
