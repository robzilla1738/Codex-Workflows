import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflowDefinition } from "./definition.js";

const tmpRoots: string[] = [];

describe("loadWorkflowDefinition", () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
    tmpRoots.length = 0;
  });

  it("loads workflow metadata inside QuickJS", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-definition-"));
    tmpRoots.push(cwd);
    const workflowPath = path.join(cwd, "demo.workflow.js");
    await writeFile(
      workflowPath,
      `export default workflow({name:"demo",description:"Demo",phases:[{id:"find",title:"Find",agents:[]}]} );`
    );
    const loaded = await loadWorkflowDefinition(workflowPath);
    expect(loaded.definition.name).toBe("demo");
  });

  it("does not expose Node globals to workflow scripts", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cwf-definition-"));
    tmpRoots.push(cwd);
    const workflowPath = path.join(cwd, "safe.workflow.js");
    await writeFile(
      workflowPath,
      `export default workflow({name: typeof process === "undefined" ? "safe" : "unsafe",description:"Demo",phases:[{id:"find",title:"Find",agents:[]}]} );`
    );
    const loaded = await loadWorkflowDefinition(workflowPath);
    expect(loaded.definition.name).toBe("safe");
  });
});
