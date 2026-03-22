#!/usr/bin/env node
// @ts-check
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ROOT_PACKAGE_PATH = join(ROOT, "package.json");
const TMP_ROOT = join(ROOT, "__tmp_pack_workspace");

/**
 * @typedef {{
 *   name: string;
 *   version: string;
 *   dir: string;
 *   packageJsonPath: string;
 *   packageJson: Record<string, unknown>;
 * }} WorkspaceInfo
 */

/**
 * @returns {WorkspaceInfo[]}
 */
function scanWorkspaces() {
  const rootPackage = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8"));
  /** @type {string[]} */
  const patterns = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
  /** @type {WorkspaceInfo[]} */
  const workspaces = [];

  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parentDir = join(ROOT, pattern.slice(0, -2));
      if (!existsSync(parentDir)) continue;

      for (const entry of readdirSync(parentDir)) {
        const dir = join(parentDir, entry);
        const packageJsonPath = join(dir, "package.json");
        if (!existsSync(packageJsonPath)) continue;
        workspaces.push(readWorkspace(packageJsonPath));
      }
      continue;
    }

    const dir = join(ROOT, pattern);
    const packageJsonPath = join(dir, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    workspaces.push(readWorkspace(packageJsonPath));
  }

  return workspaces;
}

/**
 * @param {string} packageJsonPath
 * @returns {WorkspaceInfo}
 */
function readWorkspace(packageJsonPath) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return {
    name: packageJson.name,
    version: packageJson.version,
    dir: dirname(packageJsonPath),
    packageJsonPath,
    packageJson,
  };
}

/**
 * @param {string | undefined} value
 * @param {WorkspaceInfo[]} workspaces
 * @returns {WorkspaceInfo | undefined}
 */
function resolveWorkspace(value, workspaces) {
  if (!value) return undefined;

  const normalized = value.replaceAll("\\", "/");
  return workspaces.find((workspace) => {
    const relativeDir = workspace.dir.slice(ROOT.length + 1).replaceAll("\\", "/");
    return (
      workspace.name === value || relativeDir === normalized || basename(relativeDir) === normalized
    );
  });
}

/**
 * @param {string} packageName
 * @returns {string}
 */
function toArchiveName(packageName) {
  return packageName.replace(/^@/, "").replaceAll("/", "-");
}

/**
 * @param {string} range
 * @param {string} version
 * @returns {string}
 */
function rewriteWorkspaceRange(range, version) {
  if (!range.startsWith("workspace:")) {
    return range;
  }

  const selector = range.slice("workspace:".length);
  if (selector === "" || selector === "*" || selector === undefined) {
    return version;
  }

  if (selector === "^" || selector === "~") {
    return `${selector}${version}`;
  }

  return selector;
}

/**
 * @param {Record<string, unknown>} packageJson
 * @param {Map<string, WorkspaceInfo>} workspaceByName
 * @returns {Record<string, unknown>}
 */
function rewriteWorkspacePackageJson(packageJson, workspaceByName) {
  const clone = JSON.parse(JSON.stringify(packageJson));
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = clone[field];
    if (!deps || typeof deps !== "object") continue;

    for (const [depName, depRange] of Object.entries(deps)) {
      if (typeof depRange !== "string" || !depRange.startsWith("workspace:")) continue;
      const target = workspaceByName.get(depName);
      if (!target) {
        throw new Error(`Workspace dependency "${depName}" not found while packing.`);
      }
      deps[depName] = rewriteWorkspaceRange(depRange, target.version);
    }
  }

  return clone;
}

/**
 * @param {WorkspaceInfo} workspace
 * @param {Map<string, WorkspaceInfo>} workspaceByName
 * @returns {string}
 */
function createStageDir(workspace, workspaceByName) {
  const stageDir = join(TMP_ROOT, toArchiveName(workspace.name));
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const files = Array.isArray(workspace.packageJson.files) ? workspace.packageJson.files : [];
  for (const file of files) {
    if (typeof file !== "string") continue;
    const source = join(workspace.dir, file);
    if (!existsSync(source)) continue;
    cpSync(source, join(stageDir, file), { recursive: true });
  }

  const rewrittenPackageJson = rewriteWorkspacePackageJson(workspace.packageJson, workspaceByName);
  writeFileSync(
    join(stageDir, "package.json"),
    JSON.stringify(rewrittenPackageJson, null, 2) + "\n",
    "utf8",
  );

  return stageDir;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  const target = process.argv[2];
  const workspaces = scanWorkspaces();
  const workspace = resolveWorkspace(target, workspaces);

  if (!workspace) {
    const known = workspaces
      .map((item) => `- ${item.name} (${item.dir.slice(ROOT.length + 1)})`)
      .join("\n");
    throw new Error(
      `Unknown workspace "${target ?? ""}".\nPass a package name or workspace path.\n${known}`,
    );
  }

  const workspaceByName = new Map(workspaces.map((item) => [item.name, item]));
  const artifactsDir = join(ROOT, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(TMP_ROOT, { recursive: true });

  const stageDir = createStageDir(workspace, workspaceByName);
  const archiveName = `${toArchiveName(workspace.name)}-${workspace.version}.tgz`;

  run(
    process.execPath,
    [
      join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
      "pack",
      "--pack-destination",
      artifactsDir,
    ],
    stageDir,
  );

  const emittedArchive = join(artifactsDir, archiveName);
  if (!existsSync(emittedArchive)) {
    throw new Error(`Expected archive was not generated: ${emittedArchive}`);
  }

  console.log(`Packed ${workspace.name}@${workspace.version}`);
  console.log(emittedArchive);
}

main();
