import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export const nowIso = () => new Date().toISOString();

export const createRunId = (name: string) => {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${timestamp}-${safeName}-${randomBytes(3).toString("hex")}`;
};

export const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

export const resolveWorkflowPath = (cwd: string, workflowPath: string) =>
  path.isAbsolute(workflowPath) ? workflowPath : path.resolve(cwd, workflowPath);
