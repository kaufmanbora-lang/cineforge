import { spawn } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const standaloneRoot = path.resolve(".next", "standalone");

await mkdir(path.join(standaloneRoot, ".next"), { recursive: true });
await cp(path.resolve(".next", "static"), path.join(standaloneRoot, ".next", "static"), { recursive: true, force: true });
await cp(path.resolve("public"), path.join(standaloneRoot, "public"), { recursive: true, force: true });

await mkdir(path.resolve("dist"), { recursive: true });
await build({
  entryPoints: [path.resolve("src", "server", "worker", "index.ts")],
  outfile: path.resolve("dist", "worker.mjs"),
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  logLevel: "warning",
});

console.log("Prepared standalone server, production worker, and static assets.");

if (process.argv.includes("--desktop")) {
  const desktopRoot = path.resolve(".desktop-runtime", "server");
  await rm(desktopRoot, { recursive: true, force: true });
  await mkdir(desktopRoot, { recursive: true });
  for (const entry of [".next", "public", "package.json", "server.js"]) {
    await cp(path.join(standaloneRoot, entry), path.join(desktopRoot, entry), {
      recursive: true,
      force: true,
      dereference: entry === ".next",
    });
  }
  await cp(path.resolve("pnpm-workspace.yaml"), path.join(desktopRoot, "pnpm-workspace.yaml"));

  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm executable is unavailable for desktop runtime preparation.");
  await new Promise((resolve, reject) => {
    const install = spawn(process.execPath, [
      pnpmCli,
      "install",
      "--prod",
      "--config.node-linker=hoisted",
      "--lockfile=false",
    ], {
      cwd: desktopRoot,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    install.once("error", reject);
    install.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Desktop runtime install exited with ${code}.`)));
  });
  await rm(path.join(desktopRoot, "pnpm-workspace.yaml"), { force: true });
  console.log("Prepared portable Windows desktop runtime.");
}
