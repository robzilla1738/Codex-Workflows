import { spawn } from "node:child_process";
import type { AgentDefinition, WorkflowDefinition } from "@codex-workflows/schemas";

export interface CodexModelCatalogEntry {
  slug: string;
  supportedReasoningLevels: string[];
}

export interface ModelValidationIssue {
  model: string;
  suggestion?: string;
}

export class ModelValidationError extends Error {
  constructor(readonly issues: ModelValidationIssue[], readonly validModels: string[]) {
    super(
      [
        "Unsupported Codex worker model requested.",
        ...issues.map((issue) =>
          issue.suggestion
            ? `- ${issue.model} is not available. Did you mean ${issue.suggestion}?`
            : `- ${issue.model} is not available.`
        ),
        `Available models: ${validModels.join(", ")}`
      ].join("\n")
    );
  }
}

export const parseCodexModelCatalog = (raw: string): CodexModelCatalogEntry[] => {
  const parsed = JSON.parse(raw) as { models?: unknown };
  if (!Array.isArray(parsed.models)) {
    throw new Error("codex debug models did not return a models array.");
  }
  return parsed.models
    .map((model) => {
      const entry = model as {
        slug?: unknown;
        supported_reasoning_levels?: Array<{ effort?: unknown }>;
      };
      if (typeof entry.slug !== "string" || !entry.slug) {
        return null;
      }
      return {
        slug: entry.slug,
        supportedReasoningLevels: Array.isArray(entry.supported_reasoning_levels)
          ? entry.supported_reasoning_levels
              .map((level) => level.effort)
              .filter((effort): effort is string => typeof effort === "string")
          : []
      };
    })
    .filter((entry): entry is CodexModelCatalogEntry => entry !== null);
};

const readCodexModelCatalog = (timeoutMs = 10_000) =>
  new Promise<CodexModelCatalogEntry[]>((resolve, reject) => {
    if (process.env.CODEX_WORKFLOWS_MODEL_CATALOG) {
      try {
        resolve(parseCodexModelCatalog(process.env.CODEX_WORKFLOWS_MODEL_CATALOG));
      } catch (error) {
        reject(error);
      }
      return;
    }
    const child = spawn(process.env.CODEX_WORKFLOWS_CODEX_BIN ?? "codex", ["debug", "models"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out while running codex debug models."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `codex debug models exited with code ${code}`));
        return;
      }
      try {
        resolve(parseCodexModelCatalog(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });

const suggestModel = (model: string, validModels: string[]) => {
  const prefixed = model.startsWith("gpt-") ? model : `gpt-${model}`;
  if (validModels.includes(prefixed)) {
    return prefixed;
  }
  const lower = model.toLowerCase();
  return validModels.find((valid) => valid.toLowerCase().endsWith(lower));
};

const resolveAgentModel = (
  phaseId: string,
  agent: AgentDefinition,
  options: {
    defaultModel?: string;
    modelMap?: Record<string, string>;
  }
) =>
  options.modelMap?.[`${phaseId}:${agent.id}`] ??
  options.modelMap?.[agent.id] ??
  options.modelMap?.[phaseId] ??
  options.defaultModel ??
  agent.model;

export const collectWorkflowModels = (
  definition: WorkflowDefinition,
  options: {
    defaultModel?: string;
    modelMap?: Record<string, string>;
  }
) => {
  const models = new Set<string>();
  for (const phase of definition.phases) {
    for (const agent of phase.agents) {
      const model = resolveAgentModel(phase.id, agent, options);
      if (model && model !== "Codex") {
        models.add(model);
      }
    }
  }
  return Array.from(models);
};

export const validateRequestedModels = async (models: string[]) => {
  const uniqueModels = Array.from(new Set(models.filter(Boolean)));
  if (uniqueModels.length === 0) {
    return;
  }
  const catalog = await readCodexModelCatalog();
  const validModels = catalog.map((entry) => entry.slug).sort();
  const issues = uniqueModels
    .filter((model) => !validModels.includes(model))
    .map((model) => ({ model, suggestion: suggestModel(model, validModels) }));
  if (issues.length > 0) {
    throw new ModelValidationError(issues, validModels);
  }
};

export const validateWorkflowModels = async (
  definition: WorkflowDefinition,
  options: {
    adapter?: string;
    defaultModel?: string;
    modelMap?: Record<string, string>;
  }
) => {
  if (!options.adapter || options.adapter === "simulate") {
    return;
  }
  await validateRequestedModels(collectWorkflowModels(definition, options));
};
