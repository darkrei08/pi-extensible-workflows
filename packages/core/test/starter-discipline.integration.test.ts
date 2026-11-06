import assert from "node:assert/strict";
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { specRedGreen } from "../starter/spec-red-green.js";
import { closureGate } from "../starter/closure-gate.js";
import type { ShellResult, WorkflowFunctionContext, WorkflowWorktreeReference } from "../src/index.js";

// --- Spec document used across scenarios ---

const specDoc = [
  "## Specs",
  "S1: The marker file must contain DONE",
  "",
  "## Tasks",
  "T1 Spec: S1",
].join("\n");

// Trivial test runner: exits 0 when src.txt contains "DONE", exits 1 otherwise.
const testScript = `
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
try {
  const content = readFileSync(join(__dirname, "src.txt"), "utf8");
  process.exit(content.trim() === "DONE" ? 0 : 1);
} catch { process.exit(1); }
`;

// --- Helpers: real git repo setup ---

function gitInDir(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

function initRepo(root: string): void {
  gitInDir(root, "init -b main");
  writeFileSync(join(root, "spec.md"), specDoc);
  writeFileSync(join(root, "check.js"), testScript);
  writeFileSync(join(root, "src.txt"), "NOT_DONE");
  gitInDir(root, "add -A");
  gitInDir(root, "commit -m init");
}

// --- Helpers: shell and context ---

// Runs a shell command in `dir`, recording it in `calls`.
function runInDir(dir: string, command: string, calls: string[], timeoutMs = 120_000): Promise<ShellResult> {
  calls.push(command);
  return new Promise<ShellResult>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" } });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("shell timeout")); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: Buffer.concat(chunks).toString("utf8"), stderr: Buffer.concat(errChunks).toString("utf8") });
    });
  });
}

// --- Real context builder ---

type ReusedWorktree = { path: string; branch: string };

function buildContext(
  repoRoot: string,
  opts: {
    checkpointReturn?: boolean;
    agentFn?: (prompt: string, opts: Record<string, unknown>, worktreePath: string) => Promise<unknown>;
    reusedWorktrees?: Record<string, ReusedWorktree>;
  } = {},
): { context: WorkflowFunctionContext; calls: string[]; worktreePaths: string[] } {
  const calls: string[] = [];
  const worktreePaths: string[] = [];
  // Track the active worktree cwd for shell calls.
  let activeCwd: string = repoRoot;

  const shellFn = async (command: string, options?: { timeoutMs?: number }): Promise<ShellResult> =>
    runInDir(activeCwd, command, calls, options?.timeoutMs);

  const withWorktreeFn = async <R>(name: string, callback: (ref: WorkflowWorktreeReference) => R | Promise<R>): Promise<R> => {
    const reused = opts.reusedWorktrees?.[name];
    if (reused) {
      const prev = activeCwd;
      activeCwd = reused.path;
      try {
        return await callback(reused);
      } finally {
        activeCwd = prev;
      }
    }
    const branch = `wt-${name}`;
    const wtPath = join(repoRoot, ".worktrees", name);
    mkdirSync(join(repoRoot, ".worktrees"), { recursive: true });
    gitInDir(repoRoot, `worktree add -b ${branch} ${wtPath}`);
    worktreePaths.push(wtPath);
    const prev = activeCwd;
    activeCwd = wtPath;
    try {
      return await callback({ path: wtPath, branch });
    } finally {
      activeCwd = prev;
      // Clean up worktree
      gitInDir(repoRoot, `worktree remove --force ${wtPath}`);
      const idx = worktreePaths.indexOf(wtPath);
      if (idx >= 0) worktreePaths.splice(idx, 1);
    }
  };

  const checkpointFn = async (): Promise<boolean> => {
    calls.push("checkpoint");
    return opts.checkpointReturn ?? true;
  };

  const agentFn = async (prompt: string, options?: Record<string, unknown>): Promise<unknown> => {
    calls.push("agent");
    if (opts.agentFn) return opts.agentFn(prompt, options ?? {}, activeCwd);
    return { verdicts: [] };
  };

  const context = {
    shell: shellFn,
    withWorktree: withWorktreeFn,
    checkpoint: checkpointFn,
    agent: Object.assign(agentFn, { create: () => { throw new Error("unused"); } }),
  } as unknown as WorkflowFunctionContext;

  return { context, calls, worktreePaths };
}

// --- Scenario helpers ---

function assertNoLeftoverWorktrees(repoRoot: string): void {
  const list = gitInDir(repoRoot, "worktree list --porcelain");
  const worktreeLines = list.split("\n").filter((l) => l.startsWith("worktree "));
  // Only the main worktree should remain.
  assert.equal(worktreeLines.length, 1, `Expected 1 worktree (main), got: ${list}`);
}

// NOTE: a missing git leaves the scenarios to fail naturally; the flag only records availability.
const gitAvailable = spawnSync("git", ["--version"]).status === 0;

void describe("starter discipline integration", () => {
  let scenarioRoot: string;

  before(() => {
    // Without git the scenarios fail on their own; this only records availability.
    if (!gitAvailable) return;
  });

  after(() => {
    if (scenarioRoot && existsSync(scenarioRoot)) rmSync(scenarioRoot, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Scenario 1: specRedGreen happy path — RED before writer, GREEN after
  // --------------------------------------------------------------------------
  void test("specRedGreen happy path: RED fails, writer fixes, GREEN passes", async () => {
    scenarioRoot = mkdtempSync(join(tmpdir(), "disc-1-"));
    initRepo(scenarioRoot);
    const { context, calls, worktreePaths } = buildContext(scenarioRoot, {
      agentFn: async (prompt, _opts, worktreePath) => {
        // Assert the prompt mentions the spec path and the requirement id
        assert.match(prompt, /spec\.md/, "prompt must name the spec path");
        assert.match(prompt, /S1/, "prompt must name requirement S1");
        // The writer edits the source file so GREEN will pass
        writeFileSync(join(worktreePath, "src.txt"), "DONE");
        return {
          verdicts: [
            { requirementId: "S1", verdict: "pass", evidence: ["wrote DONE to src.txt"] },
          ],
        };
      },
    });

    const result = await specRedGreen.run(
      {
        specPath: "spec.md",
        worktree: "happypath",
        redCommand: "node check.js",
        greenCommand: "node check.js",
        timeoutMs: 30_000,
      },
      context,
    );

    assert.equal(result.ok, true, `expected ok but got problems: ${JSON.stringify(result.problems)}`);
    assert.equal(result.requirements, 1);
    assert.equal(result.verdicts.length, 1);
    assert.equal(result.verdicts[0]?.requirementId, "S1");
    assert.deepEqual(result.problems, []);

    // Prove RED ran before the writer: calls order is [cat spec, checkpoint, RED command, agent, GREEN command]
    const catIdx = calls.indexOf("cat -- 'spec.md'");
    const redIdx = calls.indexOf("node check.js");
    const agentIdx = calls.indexOf("agent");
    const greenIdx = calls.lastIndexOf("node check.js");
    assert.ok(catIdx >= 0, "cat must appear");
    assert.ok(redIdx >= 0 && redIdx < agentIdx, "RED must run before agent");
    assert.ok(agentIdx < greenIdx, "agent must run before GREEN");

    assert.equal(worktreePaths.length, 0, "worktree must be cleaned up");
    assertNoLeftoverWorktrees(scenarioRoot);
  });

  // --------------------------------------------------------------------------
  // Scenario 2: closureGate digest pinning — match, then mismatch after edit
  // --------------------------------------------------------------------------
  void test("closureGate: pinned digest matches, then mismatches after extra edit", async () => {
    scenarioRoot = mkdtempSync(join(tmpdir(), "disc-2-"));
    initRepo(scenarioRoot);
    const { context } = buildContext(scenarioRoot);

    // First call: get the digest of a clean worktree
    const first = await closureGate.run({ worktree: "closure1" }, context);
    assert.equal(first.ok, true, `first gate should pass: ${JSON.stringify(first.problems)}`);
    assert.ok(first.digest, "digest must be non-empty");
    assert.ok(first.head, "head must be non-empty");

    // Second call with the pinned digest and no changes — must match
    const second = await closureGate.run(
      { worktree: "closure2", expectedDigest: first.digest },
      context,
    );
    assert.equal(second.ok, true, `pinned digest must match on identical tree: ${JSON.stringify(second.problems)}`);
    assert.equal(second.digest, first.digest);

    // Now make an extra tracked edit in a manually-created worktree
    const wtPath = join(scenarioRoot, ".worktrees", "closure3");
    mkdirSync(join(scenarioRoot, ".worktrees"), { recursive: true });
    gitInDir(scenarioRoot, `worktree add -b wt-closure3 ${wtPath}`);
    // Make a committed change so HEAD advances and the digest changes
    writeFileSync(join(wtPath, "src.txt"), "MODIFIED");
    gitInDir(wtPath, "add src.txt");
    gitInDir(wtPath, "commit -m extra-edit");

    // Build a context that reuses the existing worktree instead of creating a new one
    const ctx3 = buildContext(scenarioRoot, {
      reusedWorktrees: { closure3: { path: wtPath, branch: "wt-closure3" } },
    }).context;

    const third = await closureGate.run(
      { worktree: "closure3", expectedDigest: first.digest },
      ctx3,
    );

    assert.equal(third.ok, false, "digest must mismatch after extra edit");
    assert.notEqual(third.digest, first.digest);
    // The problem must name both digests
    const digestProblem = third.problems.find((p) => p.includes("does not match"));
    assert.ok(digestProblem, "must have a digest mismatch problem");
    assert.ok(digestProblem.includes(first.digest), "problem must name the expected digest");
    assert.ok(digestProblem.includes(third.digest), "problem must name the computed digest");

    // Clean up worktree
    gitInDir(scenarioRoot, `worktree remove --force ${wtPath}`);
    assertNoLeftoverWorktrees(scenarioRoot);
  });

  // --------------------------------------------------------------------------
  // Scenario 3: dirty tracked tree without pinned digest → ok: false
  // --------------------------------------------------------------------------
  void test("closureGate: dirty tracked tree without expectedDigest fails naming the path", async () => {
    scenarioRoot = mkdtempSync(join(tmpdir(), "disc-3-"));
    initRepo(scenarioRoot);

    // We need a worktree where the file is modified but not committed (tracked change).
    // Build a context that will set up the worktree, then we modify it inside the callback.
    // But closureGate calls withWorktree itself. So we need to pre-stage the dirt.
    // Strategy: create the worktree manually, modify a tracked file, then build a context
    // whose withWorktree reuses the existing worktree.
    const wtPath = join(scenarioRoot, ".worktrees", "dirty1");
    mkdirSync(join(scenarioRoot, ".worktrees"), { recursive: true });
    gitInDir(scenarioRoot, `worktree add -b wt-dirty1 ${wtPath}`);
    // Dirty modification (tracked but uncommitted)
    writeFileSync(join(wtPath, "src.txt"), "DIRTY CHANGE");

    // Build a context whose withWorktree reuses the pre-existing worktree
    const context = buildContext(scenarioRoot, {
      reusedWorktrees: { dirty1: { path: wtPath, branch: "wt-dirty1" } },
    }).context;

    const result = await closureGate.run({ worktree: "dirty1" }, context);

    assert.equal(result.ok, false);
    const trackedProblem = result.problems.find((p) => p.includes("Tracked modifications without a pinned expectedDigest"));
    assert.ok(trackedProblem, `expected tracked-modification problem, got: ${JSON.stringify(result.problems)}`);
    assert.ok(trackedProblem.includes("src.txt"), "problem must name the dirty path");

    // Cleanup
    gitInDir(scenarioRoot, `worktree remove --force ${wtPath}`);
    assertNoLeftoverWorktrees(scenarioRoot);
  });

  // --------------------------------------------------------------------------
  // Scenario 4: untracked file — refused without allowedUntracked, accepted with it
  // --------------------------------------------------------------------------
  void test("closureGate: untracked file refused then accepted with allowedUntracked", async () => {
    scenarioRoot = mkdtempSync(join(tmpdir(), "disc-4-"));
    initRepo(scenarioRoot);

    const wtPath = join(scenarioRoot, ".worktrees", "untracked1");
    mkdirSync(join(scenarioRoot, ".worktrees"), { recursive: true });
    gitInDir(scenarioRoot, `worktree add -b wt-untracked1 ${wtPath}`);
    // Add an untracked file
    writeFileSync(join(wtPath, "extra.log"), "untracked content");

    const mkCtx = () =>
      buildContext(scenarioRoot, {
        reusedWorktrees: { untracked1: { path: wtPath, branch: "wt-untracked1" } },
      }).context;

    // Without allowedUntracked — must fail naming the file
    const refused = await closureGate.run({ worktree: "untracked1" }, mkCtx());
    assert.equal(refused.ok, false);
    const untrackedProblem = refused.problems.find((p) => p.includes("Untracked path is not allowed"));
    assert.ok(untrackedProblem, `expected untracked problem, got: ${JSON.stringify(refused.problems)}`);
    assert.ok(untrackedProblem.includes("extra.log"), "problem must name the untracked file");

    // With allowedUntracked — must pass
    const accepted = await closureGate.run({ worktree: "untracked1", allowedUntracked: ["extra.log"] }, mkCtx());
    assert.equal(accepted.ok, true, `expected ok with allowedUntracked, got: ${JSON.stringify(accepted.problems)}`);

    // Cleanup
    gitInDir(scenarioRoot, `worktree remove --force ${wtPath}`);
    assertNoLeftoverWorktrees(scenarioRoot);
  });
});
