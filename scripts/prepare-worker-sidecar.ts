import { chmod } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");
const scriptsDir = path.join(rootDir, "src-tauri", "scripts");
const workerGoDir = path.join(rootDir, "src-tauri", "worker-go");

function runCmd(cmd: string[], cwd: string) {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, CGO_ENABLED: "0" },
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd.join(" ")}`);
  }
}

async function buildSidecar() {
  const outputName =
    process.platform === "win32" ? "worker-sidecar.exe" : "worker-sidecar";
  const outputPath = path.join(scriptsDir, outputName);

  console.log("Downloading Go modules...");
  runCmd(["go", "mod", "download"], workerGoDir);

  console.log("Building Go worker sidecar...");
  runCmd(
    ["go", "build", "-ldflags=-s -w", "-o", outputPath, "."],
    workerGoDir,
  );

  if (process.platform !== "win32") {
    await chmod(outputPath, 0o755);
  }

  console.log(`✅ Worker sidecar ready: src-tauri/scripts/${outputName}`);
}

await buildSidecar();
