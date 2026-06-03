import { spawn } from "node:child_process";
import type { ReasoningEffort, SandboxMode } from "@codex-workflows/schemas";

export interface WorkerSpec {
  id: string;
  phaseId: string;
  title: string;
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox: SandboxMode;
  expectedTokens?: number;
  expectedTools?: number;
  durationMs?: number;
}

export interface WorkerProgress {
  tokens?: number;
  tools?: number;
  message?: string;
}

export interface WorkerResult {
  output: string;
  tokens: number;
  tools: number;
  elapsedMs: number;
}

export interface WorkerAdapter {
  readonly name: string;
  runWorker(
    spec: WorkerSpec,
    onProgress: (progress: WorkerProgress) => void,
    signal?: AbortSignal
  ): Promise<WorkerResult>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Worker aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Worker aborted"));
      },
      { once: true }
    );
  });

export class SimulatedCodexAdapter implements WorkerAdapter {
  readonly name = "simulate";

  constructor(private readonly speed = 1) {}

  async runWorker(
    spec: WorkerSpec,
    onProgress: (progress: WorkerProgress) => void,
    signal?: AbortSignal
  ): Promise<WorkerResult> {
    const started = Date.now();
    const targetTokens = spec.expectedTokens ?? 92000 + spec.id.length * 2100;
    const targetTools = spec.expectedTools ?? 60 + (spec.id.length % 40);
    const durationMs = Math.max(25, Math.floor((spec.durationMs ?? 700) / this.speed));
    const steps = 4;

    for (let step = 1; step <= steps; step += 1) {
      await sleep(durationMs / steps, signal);
      onProgress({
        tokens: Math.round((targetTokens * step) / steps),
        tools: Math.round((targetTools * step) / steps),
        message: `${spec.title}: step ${step}/${steps}`
      });
    }

    return {
      output: JSON.stringify(
        {
          findings: [
            {
              verdict: "needs-human-review",
              severity: "medium",
              summary: `Simulated review completed for ${spec.id}; live repository diff was not inspected.`,
              evidence: [
                `Agent: ${spec.id}`,
                `Model: ${spec.model ?? "default Codex model"}`,
                `Sandbox: ${spec.sandbox}`,
                `Tool budget exercised: ${targetTools} simulated tool calls`,
                "not inspected: simulated adapter does not read the live repository"
              ],
              repro: "Run this workflow with adapter=exec or adapter=sdk for real Codex worker analysis.",
              confidence: 0.35,
              details:
                "This simulated result validates orchestration, event logging, model routing, and persistence only."
            }
          ]
        },
        null,
        2
      ),
      tokens: targetTokens,
      tools: targetTools,
      elapsedMs: Date.now() - started
    };
  }
}

export class CodexExecAdapter implements WorkerAdapter {
  readonly name = "exec";

  async runWorker(
    spec: WorkerSpec,
    onProgress: (progress: WorkerProgress) => void,
    signal?: AbortSignal
  ): Promise<WorkerResult> {
    const started = Date.now();
    const args = [
      "exec",
      "--json",
      "--sandbox",
      spec.sandbox,
      "-c",
      'approval_policy="never"',
      "--cd",
      spec.cwd
    ];
    if (spec.model) {
      args.push("--model", spec.model);
    }
    if (spec.reasoningEffort) {
      args.push("-c", `model_reasoning_effort="${spec.reasoningEffort}"`);
    }
    args.push(spec.prompt);

    return new Promise<WorkerResult>((resolve, reject) => {
      const child = spawn("codex", args, {
        cwd: spec.cwd,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let finalOutput = "";
      let tokens = 0;
      let tools = 0;
      let stderr = "";

      signal?.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
          reject(new Error("Worker aborted"));
        },
        { once: true }
      );

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.trim()) {
            continue;
          }
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type === "turn.completed") {
              const usage = event.usage as Record<string, number> | undefined;
              tokens = usage
                ? (usage.input_tokens ?? 0) +
                  (usage.output_tokens ?? 0) +
                  (usage.reasoning_output_tokens ?? 0)
                : tokens;
              onProgress({ tokens });
            }
            if (event.type === "item.completed") {
              tools += 1;
              const item = event.item as Record<string, unknown> | undefined;
              if (item?.type === "agent_message" && typeof item.text === "string") {
                finalOutput = item.text;
              }
              onProgress({ tools, message: String(item?.type ?? "item.completed") });
            }
          } catch {
            finalOutput += `${line}\n`;
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `codex exec exited with code ${code}`));
          return;
        }
        resolve({
          output: finalOutput.trim() || "Codex worker completed.",
          tokens,
          tools,
          elapsedMs: Date.now() - started
        });
      });
    });
  }
}

export class CodexSdkAdapter implements WorkerAdapter {
  readonly name = "sdk";

  async runWorker(
    spec: WorkerSpec,
    onProgress: (progress: WorkerProgress) => void,
    signal?: AbortSignal
  ): Promise<WorkerResult> {
    try {
      const sdk = await import("@openai/codex-sdk");
      const started = Date.now();
      const codex = new sdk.Codex();
      const thread = codex.startThread({
        workingDirectory: spec.cwd,
        skipGitRepoCheck: true,
        model: spec.model,
        modelReasoningEffort: spec.reasoningEffort,
        sandboxMode: spec.sandbox,
        approvalPolicy: "never"
      });
      const streamed = await thread.runStreamed(spec.prompt, { signal });
      let output = "";
      let tokens = 0;
      let tools = 0;
      for await (const event of streamed.events) {
        if (signal?.aborted) {
          throw new Error("Worker aborted");
        }
        if (event.type === "turn.completed") {
          tokens =
            event.usage.input_tokens +
            event.usage.output_tokens +
            event.usage.reasoning_output_tokens;
          onProgress({ tokens });
        }
        if (event.type === "item.completed") {
          if (
            event.item.type === "command_execution" ||
            event.item.type === "mcp_tool_call" ||
            event.item.type === "web_search" ||
            event.item.type === "file_change"
          ) {
            tools += 1;
            onProgress({ tools, message: event.item.type });
          }
          if (event.item.type === "agent_message") {
            output = event.item.text;
          }
        }
      }
      return {
        output: output.trim() || "Codex SDK worker completed without a final message.",
        tokens,
        tools,
        elapsedMs: Date.now() - started
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex SDK adapter failed: ${message}`);
    }
  }
}

export const createWorkerAdapter = (name: string): WorkerAdapter => {
  if (name === "exec") {
    return new CodexExecAdapter();
  }
  if (name === "sdk") {
    return new CodexSdkAdapter();
  }
  return new SimulatedCodexAdapter();
};
