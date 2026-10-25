import { cp, lstat, mkdir, readlink, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { git } from "./io.js";
import { canonicalPath, piResourceContains } from "./paths.js";
import { WorkflowError } from "./types.js";
import { isNodeError } from "./utils.js";

export const WORKTREE_INCLUDE_MANIFEST = ".worktreeinclude";
export const WORKTREE_INCLUDE_MAX_FILES = 500;
export const WORKTREE_INCLUDE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

const SENSITIVE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /^id_dsa/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pkcs12$/i,
  /\.pfx$/i,
  /\.p12$/i,
];

function isSensitive(path: string): boolean {
  const parts = path.split("/");
  const fileName = parts[parts.length - 1] ?? path;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(fileName));
}

function parseGitZPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function gitWithStdin(
  cwd: string,
  args: readonly string[],
  input: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr, code: 0 });
      else rejectPromise(Object.assign(new Error(`git exited with ${String(code)}: ${stderr}`), { code, stdout, stderr }));
    });
    child.stdin.end(input);
  });
}

export function filterDirtyTreeStatus(output: string, allowedManifest = WORKTREE_INCLUDE_MANIFEST): string[] {
  const entries = output.split("\0").filter(Boolean);
  const dirty: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = entries[i + 1];
      i += 1;
      if (path !== allowedManifest && oldPath !== allowedManifest) {
        dirty.push(path);
      }
    } else if (path !== allowedManifest) {
      dirty.push(path);
    }
  }
  return dirty;
}

async function matchExcludePattern(root: string, manifestPath: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  try {
    const result = await gitWithStdin(
      root,
      ["-c", `core.excludesFile=${manifestPath}`, "check-ignore", "--no-index", "-z", "--stdin"],
      paths.map((p) => `${p}\0`).join("")
    );
    return parseGitZPaths(result.stdout);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && (error as { code?: number }).code === 1) {
      const stdout = (error as { stdout?: string }).stdout;
      return stdout ? parseGitZPaths(stdout) : [];
    }
    throw error;
  }
}

async function matchStandardIgnore(root: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  try {
    const result = await gitWithStdin(
      root,
      ["check-ignore", "-z", "--stdin"],
      paths.map((p) => `${p}\0`).join("")
    );
    return parseGitZPaths(result.stdout);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && (error as { code?: number }).code === 1) {
      const stdout = (error as { stdout?: string }).stdout;
      return stdout ? parseGitZPaths(stdout) : [];
    }
    throw error;
  }
}

export async function worktreeIncludePlan(root: string): Promise<readonly string[]> {
  const manifestPath = join(root, WORKTREE_INCLUDE_MANIFEST);
  try {
    await stat(manifestPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }

  // 1. Check for untracked but non-ignored files first (dirty tree / non-ignored validation)
  const untrackedOutput = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untrackedFiles = parseGitZPaths(untrackedOutput).filter((p) => p !== WORKTREE_INCLUDE_MANIFEST);
  const selectedUntracked = await matchExcludePattern(root, manifestPath, untrackedFiles);
  const firstUntracked = selectedUntracked[0];
  if (firstUntracked !== undefined) {
    throw new WorkflowError("WORKTREE_FAILED", `worktree include selected path that is not ignored by Git: ${firstUntracked}`);
  }

  // 2. Query tracked files (excluding manifest)
  const trackedOutput = await git(root, ["ls-files", "-z"]);
  const trackedFiles = parseGitZPaths(trackedOutput).filter((p) => p !== WORKTREE_INCLUDE_MANIFEST);
  const selectedTracked = await matchExcludePattern(root, manifestPath, trackedFiles);
  const firstTracked = selectedTracked[0];
  if (firstTracked !== undefined) {
    throw new WorkflowError("WORKTREE_FAILED", `worktree include selected tracked path: ${firstTracked}`);
  }

  // 3. Get raw candidate files matching .worktreeinclude
  const candidateOutput = await git(root, [
    "ls-files",
    "--others",
    "--ignored",
    `--exclude-from=${WORKTREE_INCLUDE_MANIFEST}`,
    "-z",
  ]);
  const candidates = parseGitZPaths(candidateOutput);

  // 4. Verify candidates are ignored by standard Git ignores
  const standardIgnored = new Set(await matchStandardIgnore(root, candidates));
  const plan: string[] = [];
  for (const candidate of candidates) {
    if (candidate === WORKTREE_INCLUDE_MANIFEST) continue;
    if (standardIgnored.has(candidate)) {
      plan.push(candidate);
    }
  }

  // 5. Include the manifest itself
  plan.push(WORKTREE_INCLUDE_MANIFEST);

  return plan.sort();
}

export async function copyWorktreeIncludes(
  root: string,
  destination: string,
  paths: readonly string[],
  options?: Readonly<{ maxFiles?: number; maxBytes?: number; onCopy?: (path: string, bytes: number) => void }>
): Promise<void> {
  const maxFiles = options?.maxFiles ?? WORKTREE_INCLUDE_MAX_FILES;
  const maxBytes = options?.maxBytes ?? WORKTREE_INCLUDE_MAX_BYTES;
  const canonicalRoot = canonicalPath(root);
  const canonicalDestination = canonicalPath(destination);

  if (paths.length > maxFiles) {
    throw new WorkflowError(
      "WORKTREE_FAILED",
      `worktree include exceeded maximum file count (${String(paths.length)} > ${String(maxFiles)})`
    );
  }

  let totalBytes = 0;

  for (const path of paths) {
    const source = join(root, ...path.split("/"));
    const target = join(destination, ...path.split("/"));

    const isManifest = path === WORKTREE_INCLUDE_MANIFEST;

    // Check collision explicitly, except for .worktreeinclude which overwrites tracked checkout copy
    if (!isManifest) {
      try {
        await lstat(target);
        throw new WorkflowError("WORKTREE_FAILED", `worktree include destination collides with existing content: ${path}`);
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }

    // Inspect source
    const sourceStat = await lstat(source);

    // Symlink source checks
    if (sourceStat.isSymbolicLink()) {
      const linkTarget = await readlink(source);
      // Reject absolute symlinks
      if (isAbsolute(linkTarget) || linkTarget.startsWith("/") || linkTarget.startsWith("\\")) {
        throw new WorkflowError("WORKTREE_FAILED", `worktree include contains unsafe absolute symlink: ${path} -> ${linkTarget}`);
      }
      // Check if relative symlink escapes source root
      const resolvedTarget = canonicalPath(resolve(dirname(source), linkTarget));
      if (!piResourceContains(canonicalRoot, resolvedTarget)) {
        throw new WorkflowError("WORKTREE_FAILED", `worktree include symlink points outside repository: ${path} -> ${linkTarget}`);
      }
    }

    // Check size limit
    totalBytes += sourceStat.size;
    if (totalBytes > maxBytes) {
      throw new WorkflowError(
        "WORKTREE_FAILED",
        `worktree include exceeded maximum total bytes (${String(totalBytes)} > ${String(maxBytes)})`
      );
    }

    // Ensure target directory exists and verify target directory does not escape destination worktree
    const targetDir = dirname(target);
    await mkdir(targetDir, { recursive: true });

    const canonicalTargetDir = canonicalPath(targetDir);
    if (!piResourceContains(canonicalDestination, canonicalTargetDir)) {
      throw new WorkflowError("WORKTREE_FAILED", `worktree include destination path escapes worktree: ${path}`);
    }

    if (isSensitive(path)) {
      throw new WorkflowError("WORKTREE_FAILED", `worktree include selected sensitive file: ${path}`);
    }

    // Copy verbatim; for manifest allow overwrite
    if (isManifest) {
      await cp(source, target, { force: true, errorOnExist: false, verbatimSymlinks: true });
    } else {
      await cp(source, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    }
    options?.onCopy?.(path, sourceStat.size);
  }
}
