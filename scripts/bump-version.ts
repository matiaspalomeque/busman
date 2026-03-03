#!/usr/bin/env bun
/**
 * bump-version <new-version>
 *
 * Updates the version in:
 *   - package.json
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.toml  (+ Cargo.lock via `cargo update`)
 *
 * Then creates a git commit and tag: vX.Y.Z
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const version = process.argv[2];

if (!version) {
  console.error("Usage: bun run bump-version <new-version>  (e.g. 0.2.0)");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid version "${version}". Expected format: X.Y.Z`);
  process.exit(1);
}

const tag = `v${version}`;

// --- package.json ---
const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`✓ ${pkgPath} → ${version}`);

// --- src-tauri/tauri.conf.json ---
const tauriConfPath = "src-tauri/tauri.conf.json";
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");
console.log(`✓ ${tauriConfPath} → ${version}`);

// --- src-tauri/Cargo.toml ---
// Only replace the first `version = "..."` line (the package version, not deps)
const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
const updatedCargo = cargo.replace(
  /^version = "[^"]*"/m,
  `version = "${version}"`
);
if (updatedCargo === cargo) {
  console.error(`Could not find version field in ${cargoPath}`);
  process.exit(1);
}
writeFileSync(cargoPath, updatedCargo);
console.log(`✓ ${cargoPath} → ${version}`);

// --- Cargo.lock ---
// Update Cargo.lock to reflect the new package version without a full build
const cargoLockPath = "src-tauri/Cargo.lock";
execFileSync("cargo", ["update", "-p", "busman", "--manifest-path", "src-tauri/Cargo.toml"], { stdio: "inherit" });
console.log(`✓ ${cargoLockPath} regenerated`);

// --- git commit + tag ---
execFileSync("git", ["add", pkgPath, tauriConfPath, cargoPath, cargoLockPath]);
execFileSync("git", ["commit", "-m", `chore: bump version to ${version}`]);
execFileSync("git", ["tag", tag]);

console.log(`\nDone. Commit created and tag ${tag} applied.`);
console.log(`Push with: git push && git push origin ${tag}`);
