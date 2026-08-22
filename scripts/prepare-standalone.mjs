import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const standaloneRoot = path.resolve(".next", "standalone");

await mkdir(path.join(standaloneRoot, ".next"), { recursive: true });
await cp(path.resolve(".next", "static"), path.join(standaloneRoot, ".next", "static"), { recursive: true, force: true });
await cp(path.resolve("public"), path.join(standaloneRoot, "public"), { recursive: true, force: true });

console.log("Prepared standalone server with static and public assets.");
