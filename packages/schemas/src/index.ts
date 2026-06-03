import { z } from "zod";

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "stopped"
]);

export const PhaseStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "stopped"
]);

export const AgentStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

export const SandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access"
]);

export const ReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

export const FindingVerdictSchema = z.enum([
  "confirmed",
  "false-positive",
  "needs-human-review"
]);

export const FindingSeveritySchema = z.enum(["blocker", "high", "medium", "low"]);

export const AgentFindingSchema = z.object({
  verdict: FindingVerdictSchema,
  severity: FindingSeveritySchema,
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([]),
  repro: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  model: z.string().optional(),
  agentId: z.string(),
  phaseId: z.string(),
  details: z.string().optional()
});

export const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  sandbox: SandboxModeSchema.default("read-only"),
  expectedTokens: z.number().int().nonnegative().optional(),
  expectedTools: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional()
});

export const PhaseDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  agents: z.array(AgentDefinitionSchema).default([])
});

export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).default("1"),
  description: z.string().min(1),
  maxConcurrency: z.number().int().positive().max(16).default(16),
  maxAgents: z.number().int().positive().max(1000).default(1000),
  phases: z.array(PhaseDefinitionSchema).min(1)
});

export const PhaseSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: PhaseStatusSchema,
  totalAgents: z.number().int().nonnegative(),
  completedAgents: z.number().int().nonnegative(),
  failedAgents: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional()
});

export const AgentSummarySchema = z.object({
  id: z.string(),
  phaseId: z.string(),
  title: z.string(),
  prompt: z.string(),
  model: z.string().optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  sandbox: SandboxModeSchema,
  status: AgentStatusSchema,
  tokens: z.number().nonnegative().default(0),
  tools: z.number().int().nonnegative().default(0),
  elapsedMs: z.number().int().nonnegative().default(0),
  result: z.string().optional(),
  rawResult: z.string().optional(),
  findings: z.array(AgentFindingSchema).optional(),
  error: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  startedAt: z.string().optional(),
  completedAt: z.string().optional()
});

export const RunTotalsSchema = z.object({
  totalAgents: z.number().int().nonnegative(),
  completedAgents: z.number().int().nonnegative(),
  failedAgents: z.number().int().nonnegative(),
  runningAgents: z.number().int().nonnegative(),
  tokens: z.number().nonnegative(),
  tools: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative()
});

export const RunSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  workflowPath: z.string(),
  cwd: z.string(),
  status: RunStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  selectedPhaseId: z.string().optional(),
  phases: z.array(PhaseSummarySchema),
  agents: z.array(AgentSummarySchema),
  totals: RunTotalsSchema,
  finalReportPath: z.string().optional(),
  error: z.string().optional()
});

export const WorkflowEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run_started"),
    runId: z.string(),
    at: z.string(),
    name: z.string()
  }),
  z.object({
    type: z.literal("run_updated"),
    runId: z.string(),
    at: z.string(),
    status: RunStatusSchema
  }),
  z.object({
    type: z.literal("phase_started"),
    runId: z.string(),
    phaseId: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("phase_completed"),
    runId: z.string(),
    phaseId: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("agent_started"),
    runId: z.string(),
    agentId: z.string(),
    phaseId: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("agent_updated"),
    runId: z.string(),
    agentId: z.string(),
    at: z.string(),
    tokens: z.number().nonnegative().optional(),
    tools: z.number().int().nonnegative().optional(),
    message: z.string().optional()
  }),
  z.object({
    type: z.literal("agent_completed"),
    runId: z.string(),
    agentId: z.string(),
    phaseId: z.string(),
    at: z.string(),
    tokens: z.number().nonnegative(),
    tools: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("agent_retried"),
    runId: z.string(),
    agentId: z.string(),
    phaseId: z.string(),
    at: z.string(),
    error: z.string()
  }),
  z.object({
    type: z.literal("agent_tool_event"),
    runId: z.string(),
    agentId: z.string(),
    at: z.string(),
    kind: z.enum(["tool", "stdout", "stderr", "file", "message"]),
    text: z.string()
  }),
  z.object({
    type: z.literal("agent_failed"),
    runId: z.string(),
    agentId: z.string(),
    phaseId: z.string(),
    at: z.string(),
    error: z.string()
  }),
  z.object({
    type: z.literal("agent_cancelled"),
    runId: z.string(),
    agentId: z.string(),
    phaseId: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("checkpoint"),
    runId: z.string(),
    at: z.string(),
    key: z.string(),
    value: z.unknown()
  }),
  z.object({
    type: z.literal("log"),
    runId: z.string(),
    at: z.string(),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string()
  }),
  z.object({
    type: z.literal("run_completed"),
    runId: z.string(),
    at: z.string(),
    finalReportPath: z.string()
  }),
  z.object({
    type: z.literal("run_failed"),
    runId: z.string(),
    at: z.string(),
    error: z.string()
  }),
  z.object({
    type: z.literal("run_paused"),
    runId: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("run_resumed"),
    runId: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("run_stopped"),
    runId: z.string(),
    at: z.string()
  }),
  z.object({
    type: z.literal("workflow_saved"),
    runId: z.string(),
    at: z.string(),
    name: z.string(),
    skillPath: z.string(),
    workflowPath: z.string()
  })
]);

export const ControlCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pause"), at: z.string() }),
  z.object({ type: z.literal("resume"), at: z.string() }),
  z.object({ type: z.literal("stop"), at: z.string() }),
  z.object({
    type: z.literal("stop-agent"),
    at: z.string(),
    agentId: z.string()
  }),
  z.object({
    type: z.literal("restart-agent"),
    at: z.string(),
    agentId: z.string()
  })
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type SandboxMode = z.infer<typeof SandboxModeSchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type AgentFinding = z.infer<typeof AgentFindingSchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type PhaseDefinition = z.infer<typeof PhaseDefinitionSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type PhaseSummary = z.infer<typeof PhaseSummarySchema>;
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type RunTotals = z.infer<typeof RunTotalsSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
export type ControlCommand = z.infer<typeof ControlCommandSchema>;
