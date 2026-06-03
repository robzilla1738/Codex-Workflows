import { readFile } from "node:fs/promises";
import { getQuickJS } from "quickjs-emscripten";
import {
  type WorkflowDefinition,
  WorkflowDefinitionSchema
} from "@codex-workflows/schemas";
import { hashText } from "./ids.js";

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  hash: string;
  source: string;
}

export interface WorkflowValidationResult {
  ok: boolean;
  definition?: WorkflowDefinition;
  hash?: string;
  errors: string[];
  warnings: string[];
}

const transformWorkflowSource = (source: string) =>
  source
    .replace(/export\s+default\s+workflow\s*\(/, "workflow(")
    .replace(/module\.exports\s*=\s*workflow\s*\(/, "workflow(");

export async function loadWorkflowDefinition(workflowPath: string): Promise<LoadedWorkflow> {
  const source = await readFile(workflowPath, "utf8");
  const transformed = transformWorkflowSource(source);
  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();
  let captured: unknown;

  const workflowFn = vm.newFunction("workflow", (definitionHandle) => {
    captured = vm.dump(definitionHandle);
    return definitionHandle;
  });

  vm.setProp(vm.global, "workflow", workflowFn);
  workflowFn.dispose();

  const result = vm.evalCode(`
    "use strict";
    const require = undefined;
    const process = undefined;
    const Buffer = undefined;
    const module = undefined;
    const exports = undefined;
    const global = undefined;
    const __filename = undefined;
    const __dirname = undefined;
    ${transformed}
  `);

  if (result.error) {
    const dumped = vm.dump(result.error);
    result.error.dispose();
    vm.dispose();
    throw new Error(`Workflow script failed in isolate: ${String(dumped)}`);
  }
  result.value.dispose();
  vm.dispose();

  if (!captured) {
    throw new Error("Workflow script did not call workflow({...}).");
  }

  const definition = WorkflowDefinitionSchema.parse(captured);
  const totalAgents = definition.phases.reduce((total, phase) => total + phase.agents.length, 0);
  if (totalAgents > definition.maxAgents) {
    throw new Error(
      `Workflow defines ${totalAgents} agents but maxAgents is ${definition.maxAgents}.`
    );
  }

  return {
    definition,
    hash: hashText(source),
    source
  };
}

export async function validateWorkflowDefinition(
  workflowPath: string
): Promise<WorkflowValidationResult> {
  try {
    const loaded = await loadWorkflowDefinition(workflowPath);
    return {
      ok: true,
      definition: loaded.definition,
      hash: loaded.hash,
      errors: [],
      warnings: []
    };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: []
    };
  }
}
