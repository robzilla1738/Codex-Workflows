import path from "node:path";
import type { WorkerAdapter } from "@codex-workflows/codex-adapter";
import { createWorkerAdapter } from "@codex-workflows/codex-adapter";
import {
  type AgentActivity,
  type AgentDefinition,
  type AgentFinding,
  AgentFindingSchema,
  type AgentSummary,
  type PhaseSummary,
  type ReasoningEffort,
  type RunSummary,
  type StorageScope,
  type WorkflowDefinition
} from "@codex-workflows/schemas";
import { createRunId, nowIso, resolveWorkflowPath } from "./ids.js";
import { loadWorkflowDefinition } from "./definition.js";
import { RunStore } from "./store.js";
import { validateWorkflowModels } from "./models.js";

export interface RunWorkflowOptions {
  cwd: string;
  workflowPath: string;
  args?: unknown;
  adapter?: string | WorkerAdapter;
  runId?: string;
  defaultModel?: string;
  reasoningEffort?: ReasoningEffort;
  modelMap?: Record<string, string>;
  promptSuffix?: string;
  resume?: boolean;
  storageScope?: StorageScope;
  storeRoot?: string;
}

export interface StartedWorkflowRun {
  runId: string;
  done: Promise<RunSummary>;
}

const maxRecentActivity = 8;

const elapsed = (startedAt?: string) =>
  startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : 0;

const normalizeActivityText = (text: string) => {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 499)}…` : compact;
};

const appendActivity = (agent: AgentSummary, activity: AgentActivity[]) => {
  const normalized = activity
    .map((item) => ({
      ...item,
      text: normalizeActivityText(item.text)
    }))
    .filter((item) => item.text.length > 0);
  if (normalized.length === 0) {
    return agent.activity ?? [];
  }
  return [...(agent.activity ?? []), ...normalized].slice(-maxRecentActivity);
};

const buildTotals = (summary: RunSummary) => ({
  totalAgents: summary.agents.length,
  completedAgents: summary.agents.filter((agent) => agent.status === "completed").length,
  failedAgents: summary.agents.filter((agent) => agent.status === "failed").length,
  runningAgents: summary.agents.filter((agent) => agent.status === "running").length,
  tokens: summary.agents.reduce((total, agent) => total + agent.tokens, 0),
  tools: summary.agents.reduce((total, agent) => total + agent.tools, 0),
  elapsedMs: elapsed(summary.startedAt)
});

const refreshPhaseCounts = (summary: RunSummary) => {
  summary.agents = summary.agents.map((agent) =>
    agent.status === "running" && agent.startedAt
      ? {
          ...agent,
          elapsedMs: elapsed(agent.startedAt)
        }
      : agent
  );
  summary.phases = summary.phases.map((phase) => {
    const agents = summary.agents.filter((agent) => agent.phaseId === phase.id);
    return {
      ...phase,
      completedAgents: agents.filter((agent) => agent.status === "completed").length,
      failedAgents: agents.filter((agent) => agent.status === "failed").length
    };
  });
  summary.totals = buildTotals(summary);
};

const createInitialSummary = (
  runId: string,
  definition: WorkflowDefinition,
  workflowPath: string,
  cwd: string,
  options: Pick<
    RunWorkflowOptions,
    "adapter" | "defaultModel" | "reasoningEffort" | "modelMap" | "storageScope" | "storeRoot"
  >
): RunSummary => {
  const phases: PhaseSummary[] = definition.phases.map((phase) => ({
    id: phase.id,
    title: phase.title,
    status: "pending",
    totalAgents: phase.agents.length,
    completedAgents: 0,
    failedAgents: 0
  }));
  const agents: AgentSummary[] = definition.phases.flatMap((phase) =>
    phase.agents.map((agent) => ({
      id: `${phase.id}:${agent.id}`,
      phaseId: phase.id,
      title: `${phase.id}:${agent.title}`,
      prompt: agent.prompt,
      model: resolveAgentModel(phase.id, agent, options),
      reasoningEffort: agent.reasoningEffort ?? options.reasoningEffort,
      sandbox: agent.sandbox,
      status: "pending",
      tokens: 0,
      tools: 0,
      elapsedMs: 0,
      attempts: 0,
      activity: []
    }))
  );
  const createdAt = nowIso();
  return {
    id: runId,
    name: definition.name,
    version: definition.version,
    description: definition.description,
    workflowPath,
    cwd,
    storageScope: options.storageScope,
    storeRoot: options.storeRoot,
    requestedAdapter:
      typeof options.adapter === "string"
        ? (options.adapter as RunSummary["requestedAdapter"])
        : options.adapter?.name === "auto" ||
            options.adapter?.name === "simulate" ||
            options.adapter?.name === "exec" ||
            options.adapter?.name === "sdk"
          ? (options.adapter.name as RunSummary["requestedAdapter"])
          : undefined,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    selectedPhaseId: phases[0]?.id,
    phases,
    agents,
    totals: {
      totalAgents: agents.length,
      completedAgents: 0,
      failedAgents: 0,
      runningAgents: 0,
      tokens: 0,
      tools: 0,
      elapsedMs: 0
    }
  };
};

const resolveAgentModel = (
  phaseId: string,
  agent: AgentDefinition,
  options: Pick<RunWorkflowOptions, "defaultModel" | "modelMap">
) =>
  options.modelMap?.[`${phaseId}:${agent.id}`] ??
  options.modelMap?.[agent.id] ??
  options.modelMap?.[phaseId] ??
  options.defaultModel ??
  agent.model;

const buildWorkerPrompt = (
  definition: WorkflowDefinition,
  phaseId: string,
  agent: AgentDefinition,
  args: unknown,
  options: Pick<RunWorkflowOptions, "promptSuffix">,
  contextFindings: AgentFinding[]
) => {
  const payload = {
    workflow: definition.name,
    version: definition.version,
    phase: phaseId,
    agent: agent.id,
    args
  };
  return [
    `You are running as subagent ${phaseId}:${agent.id} inside Codex Workflows.`,
    "",
    "Task:",
    agent.prompt,
    "",
    "Workflow context:",
    JSON.stringify(payload, null, 2),
    "",
    ...(agent.contextFrom
      ? [
          "Prior phase context:",
          contextFindings.length > 0
            ? JSON.stringify(
                {
                  findings: contextFindings.map((finding, index) => ({
                    source: {
                      index: index + 1,
                      phaseId: finding.phaseId,
                      agentId: finding.agentId
                    },
                    verdict: finding.verdict,
                    severity: finding.severity,
                    summary: finding.summary,
                    evidence: finding.evidence,
                    repro: finding.repro,
                    confidence: finding.confidence,
                    details: finding.details
                  }))
                },
                null,
                2
              )
            : "No prior findings matched this agent's contextFrom selector.",
          ""
        ]
      : []),
    "Output contract:",
    "- Be concrete and adversarial.",
    "- Do not invent findings. Mark uncertain claims as needs-human-review.",
    '- If there are no findings or no assigned context to verify, return {"findings":[]}.',
    "- Return only JSON text, with this shape:",
    JSON.stringify(
      {
        findings: [
          {
            verdict: "confirmed | false-positive | needs-human-review",
            severity: "blocker | high | medium | low",
            summary: "short finding summary",
            evidence: ["file path, command, log, or explicit not inspected"],
            repro: "exact command or manual steps when available",
            confidence: 0.75,
            details: "concise rationale"
          }
        ]
      },
      null,
      2
    ),
    "- If this is a simulated run, produce realistic review-style JSON, not filler text.",
    options.promptSuffix ? ["", "Additional caller instructions:", options.promptSuffix].join("\n") : ""
  ]
    .filter(Boolean)
    .join("\n");
};

const extractJsonText = (text: string) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
};

const parseAgentFindings = (
  raw: string,
  agentId: string,
  phaseId: string,
  model?: string
): AgentFinding[] => {
  const parsed = JSON.parse(extractJsonText(raw)) as unknown;
  const findings = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : undefined;
  if (!findings) {
    throw new Error("Worker output did not include a findings array.");
  }
  return findings.map((finding) =>
    AgentFindingSchema.parse({
      ...(finding as Record<string, unknown>),
      agentId,
      phaseId,
      model: (finding as { model?: unknown }).model ?? model
    })
  );
};

const collectContextFindings = (
  summary: RunSummary,
  agent: AgentDefinition,
  agentIndex: number,
  phaseAgentCount: number
) => {
  const contextFrom = agent.contextFrom;
  if (!contextFrom) {
    return [];
  }
  const verdicts = contextFrom.verdicts ? new Set(contextFrom.verdicts) : undefined;
  const findings = summary.agents
    .filter((item) => contextFrom.phaseIds.includes(item.phaseId))
    .flatMap((item) => item.findings ?? [])
    .filter((finding) => !verdicts || verdicts.has(finding.verdict));
  const maxFindings = contextFrom.maxFindings;
  if (contextFrom.mode === "by-index") {
    const size = maxFindings ?? 1;
    return findings.slice(agentIndex * size, agentIndex * size + size);
  }
  if (contextFrom.mode === "round-robin") {
    const assigned = findings.filter((_, index) => index % Math.max(1, phaseAgentCount) === agentIndex);
    return maxFindings ? assigned.slice(0, maxFindings) : assigned;
  }
  return maxFindings ? findings.slice(0, maxFindings) : findings;
};

async function mapLimit<T>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<void>
) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await run(items[index] as T, index);
    }
  });
  await Promise.all(workers);
}

export class WorkflowStoppedError extends Error {
  constructor() {
    super("Workflow stopped");
  }
}

export class WorkflowRunner {
  private summaryLock: Promise<void> = Promise.resolve();

  constructor(private readonly store: RunStore) {}

  async start(options: RunWorkflowOptions): Promise<StartedWorkflowRun> {
    const cwd = path.resolve(options.cwd);
    const workflowPath = resolveWorkflowPath(cwd, options.workflowPath);
    const loaded = await loadWorkflowDefinition(workflowPath);
    const runId = options.runId ?? createRunId(loaded.definition.name);
    const done = this.run({ ...options, cwd, workflowPath, runId });
    return {
      runId,
      done
    };
  }

  async run(options: RunWorkflowOptions): Promise<RunSummary> {
    const cwd = path.resolve(options.cwd);
    const workflowPath = resolveWorkflowPath(cwd, options.workflowPath);
    const loaded = await loadWorkflowDefinition(workflowPath);
    const runId = options.runId ?? createRunId(loaded.definition.name);
    await validateWorkflowModels(loaded.definition, {
      adapter:
        typeof options.adapter === "string"
          ? options.adapter
          : options.adapter?.name ?? "auto",
      defaultModel: options.defaultModel,
      modelMap: options.modelMap
    });
    const adapter =
      typeof options.adapter === "string" || options.adapter === undefined
        ? createWorkerAdapter(options.adapter ?? "auto")
        : options.adapter;
    let summary = options.resume
      ? await this.store.readSummary(runId)
      : createInitialSummary(runId, loaded.definition, workflowPath, cwd, options);

    if (!options.resume) {
      await this.store.initRun(summary, loaded.definition, options.args ?? {}, loaded.source, {
        adapter: typeof options.adapter === "string" ? options.adapter : options.adapter?.name,
        requestedAdapter:
          typeof options.adapter === "string" || options.adapter === undefined
            ? options.adapter ?? "auto"
            : options.adapter?.name,
        defaultModel: options.defaultModel,
        reasoningEffort: options.reasoningEffort,
        modelMap: options.modelMap,
        promptSuffix: options.promptSuffix
      });
      await this.store.clearControl(runId);
      await this.store.appendEvent({
        type: "run_started",
        runId,
        at: nowIso(),
        name: loaded.definition.name
      });
    } else {
      summary = await this.mutateSummary(runId, (current) => {
        current.status = "running";
        current.completedAt = undefined;
        current.error = undefined;
        for (const agent of current.agents) {
          if (["failed", "cancelled", "running"].includes(agent.status)) {
            agent.status = "pending";
            agent.error = undefined;
            agent.completedAt = undefined;
          }
        }
        for (const phase of current.phases) {
          if (phase.status !== "completed") {
            phase.status = "pending";
            phase.completedAt = undefined;
          }
        }
      });
      const control = await this.store.readControl(runId);
      if (control?.type === "resume" || control?.type === "restart-agent") {
        await this.store.clearControl(runId);
      }
      await this.store.appendEvent({ type: "run_resumed", runId, at: nowIso() });
    }

    const heartbeatTimer = setInterval(() => {
      void this.touchRun(runId);
    }, 2000);
    try {
      const startedAt = nowIso();
      summary = {
        ...summary,
        status: "running",
        startedAt,
        runnerPid: process.pid,
        heartbeatAt: startedAt,
        lastActivityAt: startedAt
      };
      refreshPhaseCounts(summary);
      await this.store.writeSummary(summary);

      for (const phase of loaded.definition.phases) {
        await this.throwIfStopped(summary.id);
        await this.waitIfPaused(summary);
        summary = await this.startPhase(summary, phase.id);
        await mapLimit(phase.agents, loaded.definition.maxConcurrency, async (agent, agentIndex) => {
          const existing = (await this.store.readSummary(summary.id)).agents.find(
            (item) => item.id === `${phase.id}:${agent.id}`
          );
          if (existing?.status === "completed") {
            return;
          }
          await this.runAgent(
            summary,
            loaded.definition,
            phase.id,
            agent,
            agentIndex,
            phase.agents.length,
            adapter,
            options
          );
          summary = await this.store.readSummary(summary.id);
        });
        summary = await this.completePhase(summary, phase.id);
      }

      summary = await this.completeRun(summary);
      return summary;
    } catch (error) {
      if (error instanceof WorkflowStoppedError) {
        summary = await this.store.readSummary(runId);
        summary.status = "stopped";
        summary.completedAt = nowIso();
        summary.lastActivityAt = summary.completedAt;
        refreshPhaseCounts(summary);
        await this.store.writeSummary(summary);
        await this.store.appendEvent({ type: "run_stopped", runId, at: nowIso() });
        await this.store.clearControl(runId);
        return summary;
      }
      const message = error instanceof Error ? error.message : String(error);
      summary = await this.store.readSummary(runId);
      summary.status = "failed";
      summary.error = message;
      summary.completedAt = nowIso();
      summary.lastActivityAt = summary.completedAt;
      refreshPhaseCounts(summary);
      await this.store.writeSummary(summary);
      await this.store.appendEvent({ type: "run_failed", runId, at: nowIso(), error: message });
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async startPhase(summary: RunSummary, phaseId: string) {
    const at = nowIso();
    const next = await this.mutateSummary(summary.id, (current) => {
      current.lastActivityAt = at;
      current.selectedPhaseId = phaseId;
      current.phases = current.phases.map((phase) =>
        phase.id === phaseId ? { ...phase, status: "running", startedAt: at } : phase
      );
    });
    await this.store.appendEvent({
      type: "phase_started",
      runId: next.id,
      phaseId,
      at
    });
    return next;
  }

  private async completePhase(summary: RunSummary, phaseId: string) {
    const at = nowIso();
    const next = await this.mutateSummary(summary.id, (current) => {
      current.lastActivityAt = at;
      const failed = current.agents.some(
        (agent) => agent.phaseId === phaseId && agent.status === "failed"
      );
      current.phases = current.phases.map((phase) =>
        phase.id === phaseId
          ? {
              ...phase,
              status: failed ? "failed" : "completed",
              completedAt: at
            }
          : phase
      );
    });
    await this.store.appendEvent({
      type: "phase_completed",
      runId: next.id,
      phaseId,
      at
    });
    return next;
  }

  private async runAgent(
    summary: RunSummary,
    definition: WorkflowDefinition,
    phaseId: string,
    agentDefinition: AgentDefinition,
    agentIndex: number,
    phaseAgentCount: number,
    adapter: WorkerAdapter,
    options: RunWorkflowOptions
  ) {
    await this.throwIfStopped(summary.id);
    await this.waitIfPaused(summary);
    const agentId = `${phaseId}:${agentDefinition.id}`;
    const startedAt = nowIso();
    const model = resolveAgentModel(phaseId, agentDefinition, options);
    const contextSummary = await this.store.readSummary(summary.id);
    const contextFindings = collectContextFindings(
      contextSummary,
      agentDefinition,
      agentIndex,
      phaseAgentCount
    );
    const workerSpec = {
      id: agentId,
      phaseId,
      title: agentDefinition.title,
      prompt: buildWorkerPrompt(
        definition,
        phaseId,
        agentDefinition,
        options.args ?? {},
        options,
        contextFindings
      ),
      cwd: contextSummary.cwd,
      model,
      reasoningEffort: agentDefinition.reasoningEffort ?? options.reasoningEffort,
      sandbox: agentDefinition.sandbox,
      expectedTokens: agentDefinition.expectedTokens,
      expectedTools: agentDefinition.expectedTools,
      durationMs: agentDefinition.durationMs
    };
    let next = await this.mutateSummary(summary.id, (current) => {
      current.lastActivityAt = startedAt;
      current.agents = current.agents.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              prompt: workerSpec.prompt,
              status: "running",
              startedAt,
              lastActivityAt: startedAt,
              lastMessage: "started",
              activity: [{ at: startedAt, kind: "event", text: "started" }]
            }
          : agent
      );
    });
    await this.store.writeAgentPrompt(next.id, agentId, workerSpec.prompt);
    await this.store.appendEvent({
      type: "agent_started",
      runId: next.id,
      phaseId,
      agentId,
      at: startedAt
    });
    let lastRawOutput = "";
    const abortController = new AbortController();
    let cancelledByStopAgent = false;
    const controlTimer = setInterval(() => {
      void (async () => {
        const control = await this.store.readControl(summary.id);
        if (control?.type === "stop") {
          abortController.abort();
        }
        if (control?.type === "stop-agent" && control.agentId === agentId) {
          cancelledByStopAgent = true;
          await this.store.clearControl(summary.id);
          abortController.abort();
        }
      })();
    }, 250);

    let selectedAdapter = adapter.name === "auto" ? "" : adapter.name;
    try {
      let result: Awaited<ReturnType<WorkerAdapter["runWorker"]>> | undefined;
      let findings: AgentFinding[] | undefined;
      let validationError = "";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        result = await adapter.runWorker(
          {
            ...workerSpec,
            prompt:
              attempt === 1
                ? workerSpec.prompt
                : `${workerSpec.prompt}\n\nPrevious output was invalid: ${validationError}\nReturn valid JSON text only.`
          },
          async (progress) => {
            const at = nowIso();
            const progressActivity = (
              Array.isArray(progress.activity)
                ? progress.activity
                : progress.activity
                  ? [progress.activity]
                  : []
            ).map((item) => ({
              at,
              kind: item.kind,
              text: item.text
            }));
            if (progressActivity.length === 0 && progress.message) {
              progressActivity.push({ at, kind: "message", text: progress.message });
            }
            const activityMessage = progressActivity.at(-1)?.text;
            if (progress.actualAdapter && progress.actualAdapter !== selectedAdapter) {
              selectedAdapter = progress.actualAdapter;
              progressActivity.push({
                at,
                kind: "adapter",
                text: progress.fallbackReason
                  ? `adapter selected: ${progress.actualAdapter} (${progress.fallbackReason})`
                  : `adapter selected: ${progress.actualAdapter}`
              });
              await this.store.appendEvent({
                type: "adapter_selected",
                runId: summary.id,
                agentId,
                at,
                requestedAdapter:
                  adapter.name === "auto" ||
                  adapter.name === "simulate" ||
                  adapter.name === "exec" ||
                  adapter.name === "sdk"
                    ? adapter.name
                    : "auto",
                actualAdapter: progress.actualAdapter,
                fallbackReason: progress.fallbackReason
              });
            }
            const current = await this.mutateSummary(summary.id, (draft) => {
              draft.heartbeatAt = at;
              draft.lastActivityAt = at;
              if (progress.actualAdapter) {
                draft.actualAdapter = progress.actualAdapter;
              }
              draft.agents = draft.agents.map((agent) =>
                agent.id === agentId
                  ? {
                      ...agent,
                      tokens: progress.tokens ?? agent.tokens,
                      tools: progress.tools ?? agent.tools,
                      actualAdapter: progress.actualAdapter ?? agent.actualAdapter,
                      lastActivityAt: at,
                      lastMessage:
                        progress.message ??
                        activityMessage ??
                        (progress.tokens !== undefined
                          ? "token usage updated"
                          : progress.tools !== undefined
                            ? "tool usage updated"
                            : agent.lastMessage),
                      attempts: attempt,
                      activity: appendActivity(agent, progressActivity)
                    }
                  : agent
              );
            });
            await this.store.appendEvent({
              type: "agent_updated",
              runId: current.id,
              agentId,
              at,
              tokens: progress.tokens,
              tools: progress.tools,
              message: progress.message,
              activity: progressActivity.length > 0 ? progressActivity : undefined
            });
            for (const activity of progressActivity) {
              await this.store.appendEvent({
                type: "agent_tool_event",
                runId: current.id,
                agentId,
                at: activity.at,
                kind: activity.kind,
                text: activity.text
              });
            }
          },
          abortController.signal
        );
        lastRawOutput = result.output;
        if (result.actualAdapter && result.actualAdapter !== selectedAdapter) {
          const at = nowIso();
          selectedAdapter = result.actualAdapter;
          await this.store.appendEvent({
            type: "adapter_selected",
            runId: next.id,
            agentId,
            at,
            requestedAdapter:
              adapter.name === "auto" ||
              adapter.name === "simulate" ||
              adapter.name === "exec" ||
              adapter.name === "sdk"
                ? adapter.name
                : "auto",
            actualAdapter: result.actualAdapter,
            fallbackReason: result.fallbackReason
          });
        }
        try {
          findings = parseAgentFindings(result.output, agentId, phaseId, model);
          break;
        } catch (error) {
          validationError = error instanceof Error ? error.message : String(error);
          await this.store.appendEvent({
            type: "agent_retried",
            runId: next.id,
            agentId,
            phaseId,
            at: nowIso(),
            error: validationError
          });
        }
      }
      if (!result || !findings) {
        throw new Error(`Worker result validation failed after retry: ${validationError}`);
      }
      let completedAgent: AgentSummary | undefined;
      const completedAt = nowIso();
      next = await this.mutateSummary(summary.id, (current) => {
        current.heartbeatAt = completedAt;
        current.lastActivityAt = completedAt;
        if (result.actualAdapter ?? selectedAdapter) {
          current.actualAdapter = result.actualAdapter ?? selectedAdapter;
        }
        current.agents = current.agents.map((agent) => {
          if (agent.id !== agentId) {
            return agent;
          }
          completedAgent = {
            ...agent,
            status: "completed",
            tokens: result.tokens,
            tools: result.tools,
            elapsedMs: result.elapsedMs,
            actualAdapter: result.actualAdapter ?? selectedAdapter ?? agent.actualAdapter,
            result: result.output,
            rawResult: result.output,
            findings,
            completedAt,
            lastActivityAt: completedAt,
            lastMessage: "completed",
            activity: appendActivity(agent, [{ at: completedAt, kind: "event", text: "completed" }])
          };
          return completedAgent;
        });
      });
      if (completedAgent) {
        await this.store.writeAgentResult(next.id, completedAgent);
      }
      await this.store.appendEvent({
        type: "agent_completed",
        runId: next.id,
        phaseId,
        agentId,
        at: completedAt,
        tokens: result.tokens,
        tools: result.tools,
        elapsedMs: result.elapsedMs
      });
    } catch (error) {
      if (!cancelledByStopAgent) {
        const control = await this.store.readControl(summary.id);
        if (control?.type === "stop") {
          clearInterval(controlTimer);
          throw new WorkflowStoppedError();
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = nowIso();
      next = await this.mutateSummary(summary.id, (current) => {
        current.heartbeatAt = completedAt;
        current.lastActivityAt = completedAt;
        if (selectedAdapter) {
          current.actualAdapter = selectedAdapter;
        }
        current.agents = current.agents.map((agent) =>
          agent.id === agentId
            ? {
                ...agent,
                status: cancelledByStopAgent ? "cancelled" : "failed",
                error: cancelledByStopAgent ? undefined : message,
                actualAdapter: selectedAdapter || agent.actualAdapter,
                rawResult: lastRawOutput || agent.rawResult,
                completedAt,
                lastActivityAt: completedAt,
                lastMessage: cancelledByStopAgent ? "cancelled" : message,
                activity: appendActivity(agent, [
                  {
                    at: completedAt,
                    kind: cancelledByStopAgent ? "event" : "error",
                    text: cancelledByStopAgent ? "cancelled" : message
                  }
                ])
              }
            : agent
        );
      });
      await this.store.appendEvent(
        cancelledByStopAgent
          ? {
              type: "agent_cancelled",
              runId: next.id,
              phaseId,
              agentId,
              at: completedAt
            }
          : {
              type: "agent_failed",
              runId: next.id,
              phaseId,
              agentId,
              at: completedAt,
              error: message
            }
      );
    } finally {
      clearInterval(controlTimer);
    }
  }

  private async completeRun(summary: RunSummary) {
    const next = await this.store.readSummary(summary.id);
    refreshPhaseCounts(next);
    const completedAt = nowIso();
    next.status = next.totals.failedAgents > 0 ? "failed" : "completed";
    next.completedAt = completedAt;
    next.heartbeatAt = completedAt;
    next.lastActivityAt = completedAt;
    const markdown = this.buildFinalReport(next);
    const finalReportPath = await this.store.writeFinalReport(next.id, markdown);
    next.finalReportPath = finalReportPath;
    await this.store.writeSummary(next);
    await this.store.appendEvent({
      type: "run_completed",
      runId: next.id,
      at: nowIso(),
      finalReportPath
    });
    return next;
  }

  private buildFinalReport(summary: RunSummary) {
    const completed = summary.agents.filter((agent) => agent.status === "completed").length;
    const failed = summary.agents.filter((agent) => agent.status === "failed").length;
    const findings = summary.agents.flatMap((agent) => agent.findings ?? []);
    const confirmed = findings.filter((finding) => finding.verdict === "confirmed");
    const needsReview = findings.filter((finding) => finding.verdict === "needs-human-review");
    const falsePositive = findings.filter((finding) => finding.verdict === "false-positive");
    const modelCounts = new Map<string, number>();
    for (const agent of summary.agents) {
      const model = agent.model ?? "default";
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    }
    const lines = [
      `# ${summary.name}`,
      "",
      summary.description,
      "",
      `- Status: ${summary.status}`,
      `- Agents: ${completed}/${summary.agents.length} completed`,
      `- Failed: ${failed}`,
      `- Tokens: ${Math.round(summary.totals.tokens).toLocaleString()}`,
      `- Tools: ${summary.totals.tools.toLocaleString()}`,
      `- Models: ${Array.from(modelCounts.entries())
        .map(([model, count]) => `${model} (${count})`)
        .join(", ")}`,
      `- Requested adapter: ${summary.requestedAdapter ?? "auto"}`,
      `- Actual adapter: ${summary.actualAdapter ?? "n/a"}`,
      `- Confirmed findings: ${confirmed.length}`,
      `- Needs human review: ${needsReview.length}`,
      `- False positives filtered: ${falsePositive.length}`,
      "",
      "## Executive Summary",
      "",
      failed > 0
        ? `${failed} agent(s) failed. Review failed agent details before trusting this report.`
        : confirmed.length > 0
          ? `${confirmed.length} confirmed finding(s) survived workflow validation.`
          : "No confirmed findings survived validation. Review needs-human-review items before treating the run as clean.",
      "",
      "## Confirmed Findings",
      "",
      ...(confirmed.length
        ? confirmed.map(
            (finding, index) =>
              `${index + 1}. [${finding.severity}] ${finding.summary}\n   Evidence: ${finding.evidence.join("; ")}${finding.repro ? `\n   Repro: ${finding.repro}` : ""}`
          )
        : ["None."]),
      "",
      "## Needs Human Review",
      "",
      ...(needsReview.length
        ? needsReview.map(
            (finding, index) =>
              `${index + 1}. [${finding.severity}] ${finding.summary}\n   Evidence: ${finding.evidence.join("; ")}${finding.repro ? `\n   Repro: ${finding.repro}` : ""}`
          )
        : ["None."]),
      "",
      "## Phase Results",
      ""
    ];
    for (const phase of summary.phases) {
      lines.push(
        `### ${phase.title}`,
        "",
        `Status: ${phase.status}. Agents: ${phase.completedAgents}/${phase.totalAgents} completed, ${phase.failedAgents} failed.`,
        ""
      );
      for (const agent of summary.agents.filter((item) => item.phaseId === phase.id)) {
        lines.push(
          `#### ${agent.title}`,
          "",
          `- Status: ${agent.status}${agent.error ? ` (${agent.error})` : ""}`,
          `- Model: ${agent.model ?? "default"}`,
          `- Adapter: ${agent.actualAdapter ?? "n/a"}`,
          `- Reasoning: ${agent.reasoningEffort ?? "default"}`,
          `- Tokens: ${Math.round(agent.tokens).toLocaleString()}`,
          `- Tools: ${agent.tools.toLocaleString()}`,
          ""
        );
        if (agent.findings?.length) {
          for (const finding of agent.findings) {
            lines.push(
              `- [${finding.verdict}/${finding.severity}] ${finding.summary}`,
              `  Evidence: ${finding.evidence.join("; ")}`,
              finding.repro ? `  Repro: ${finding.repro}` : "",
              ""
            );
          }
        } else if (agent.result) {
          lines.push(agent.result.split("\n").slice(0, 18).join("\n"), "");
        }
      }
      lines.push("");
    }
    return `${lines.join("\n")}\n`;
  }

  private async throwIfStopped(runId: string) {
    const control = await this.store.readControl(runId);
    if (control?.type === "stop") {
      throw new WorkflowStoppedError();
    }
  }

  private async waitIfPaused(summary: RunSummary) {
    let control = await this.store.readControl(summary.id);
    if (control?.type !== "pause") {
      return;
    }
    let next = await this.store.readSummary(summary.id);
    next.status = "paused";
    refreshPhaseCounts(next);
    await this.store.writeSummary(next);
    await this.store.appendEvent({ type: "run_paused", runId: summary.id, at: nowIso() });
    while (control?.type === "pause") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      control = await this.store.readControl(summary.id);
      if (control?.type === "stop") {
        throw new WorkflowStoppedError();
      }
    }
    if (control?.type === "resume") {
      await this.store.clearControl(summary.id);
    }
    next = await this.store.readSummary(summary.id);
    next.status = "running";
    refreshPhaseCounts(next);
    await this.store.writeSummary(next);
    await this.store.appendEvent({ type: "run_resumed", runId: summary.id, at: nowIso() });
  }

  private async touchRun(runId: string) {
    await this.mutateSummary(runId, (summary) => {
      if (summary.status !== "running" && summary.status !== "paused") {
        return;
      }
      summary.runnerPid = process.pid;
      summary.heartbeatAt = nowIso();
    }).catch(() => undefined);
  }

  private async mutateSummary(
    runId: string,
    mutate: (summary: RunSummary) => void
  ): Promise<RunSummary> {
    const task = this.summaryLock.then(async () => {
      const summary = await this.store.readSummary(runId);
      mutate(summary);
      refreshPhaseCounts(summary);
      await this.store.writeSummary(summary);
      return summary;
    });
    this.summaryLock = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }
}

export async function runWorkflow(options: RunWorkflowOptions) {
  const store = new RunStore(path.resolve(options.cwd), {
    storageScope: options.storageScope,
    storeRoot: options.storeRoot
  });
  const runner = new WorkflowRunner(store);
  return runner.run(options);
}
