import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutoCodexAdapter, CodexExecAdapter, SimulatedCodexAdapter } from "./index.js";

const tmpRoots: string[] = [];
const originalCodexBin = process.env.CODEX_WORKFLOWS_CODEX_BIN;

describe("SimulatedCodexAdapter", () => {
  afterEach(async () => {
    if (originalCodexBin === undefined) {
      delete process.env.CODEX_WORKFLOWS_CODEX_BIN;
    } else {
      process.env.CODEX_WORKFLOWS_CODEX_BIN = originalCodexBin;
    }
    await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
    tmpRoots.length = 0;
  });

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
    expect(result.actualAdapter).toBe("simulate");
  });

  it("prefers structured codex exec JSON errors over benign stderr noise", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cwf-adapter-"));
    tmpRoots.push(root);
    const fakeCodex = path.join(root, "codex");
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        "case \" $* \" in *\" --skip-git-repo-check \"*) ;; *) echo 'missing --skip-git-repo-check' >&2; exit 2 ;; esac",
        "echo 'Reading additional input from stdin...' >&2",
        "echo '{\"type\":\"error\",\"message\":\"{\\\"error\\\":{\\\"message\\\":\\\"The model is unsupported\\\"}}\"}'",
        "echo '{\"type\":\"turn.failed\",\"error\":{\"message\":\"{\\\"error\\\":{\\\"message\\\":\\\"The model is unsupported\\\"}}\"}}'",
        "exit 1",
        ""
      ].join("\n")
    );
    await chmod(fakeCodex, 0o755);
    process.env.CODEX_WORKFLOWS_CODEX_BIN = fakeCodex;

    await expect(
      new CodexExecAdapter().runWorker(
        {
          id: "agent-1",
          phaseId: "find",
          title: "find:adapter",
          prompt: "Inspect adapter",
          cwd: root,
          sandbox: "read-only"
        },
        () => undefined
      )
    ).rejects.toThrow("The model is unsupported");
  });

  it("parses codex exec JSON usage and tool events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cwf-adapter-"));
    tmpRoots.push(root);
    const fakeCodex = path.join(root, "codex");
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        "echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\"}}'",
        "echo '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\\\"findings\\\\\":[]}\"}}'",
        "echo '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":4,\"reasoning_output_tokens\":6}}'",
        "exit 0",
        ""
      ].join("\n")
    );
    await chmod(fakeCodex, 0o755);
    process.env.CODEX_WORKFLOWS_CODEX_BIN = fakeCodex;

    const progress: unknown[] = [];
    const result = await new CodexExecAdapter().runWorker(
      {
        id: "agent-1",
        phaseId: "find",
        title: "find:adapter",
        prompt: "Inspect adapter",
        cwd: root,
        sandbox: "read-only"
      },
      (event) => progress.push(event)
    );

    expect(result.output).toBe('{"findings":[]}');
    expect(result.tokens).toBe(20);
    expect(result.tools).toBe(1);
    expect(progress).toContainEqual(expect.objectContaining({ tokens: 20 }));
    expect(progress).toContainEqual(expect.objectContaining({ tools: 1 }));
  });

  it("falls back from unavailable SDK launch to exec in auto mode", async () => {
    const sdk = {
      name: "sdk",
      async runWorker() {
        throw new Error("Codex SDK adapter failed: Unable to locate Codex CLI binaries.");
      }
    };
    const exec = {
      name: "exec",
      async runWorker() {
        return {
          output: JSON.stringify({
            findings: [
              {
                verdict: "needs-human-review",
                severity: "low",
                summary: "fallback worked",
                evidence: ["test"],
                confidence: 0.5
              }
            ]
          }),
          tokens: 1,
          tools: 0,
          elapsedMs: 1,
          actualAdapter: "exec"
        };
      }
    };
    const progress: unknown[] = [];
    const result = await new AutoCodexAdapter(sdk, exec).runWorker(
      {
        id: "agent-1",
        phaseId: "find",
        title: "find:auto",
        prompt: "Inspect adapter",
        cwd: process.cwd(),
        sandbox: "read-only"
      },
      (event) => progress.push(event)
    );

    expect(result.actualAdapter).toBe("exec");
    expect(progress).toContainEqual(
      expect.objectContaining({
        actualAdapter: "exec",
        fallbackReason: expect.stringContaining("Unable to locate Codex CLI binaries")
      })
    );
  });
});
