import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function stableId(prefix: string, ...parts: Array<string | number>): string {
  const digest = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 20);
  return `${prefix}_${digest}`;
}
