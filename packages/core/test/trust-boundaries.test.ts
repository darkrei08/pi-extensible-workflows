import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { RPC_LIMIT_BYTES, RunStore, createLaunchSnapshot, runWorkflow, WorkflowError } from "../src/index.js";
import { listRunIds } from "../src/persistence.js";


import { executeShellCommand } from "../src/execution.js";




void test("workflow JavaScript cannot cross filesystem, network, or process boundaries", async () => {
  const run = runWorkflow(`const escape = (() => { try { globalThis.constructor.constructor("return require('node:fs')")(); return "escaped"; } catch { return "blocked"; } })(); return { process: typeof process, require: typeof require, fetch: typeof fetch, websocket: typeof WebSocket, escape };`);
  assert.deepEqual(await run.result, { process: "undefined", require: "undefined", fetch: "undefined", websocket: "undefined", escape: "blocked" });
});

void test("forged worktree metadata cannot redirect cleanup", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-worktree-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", repo, "branch", "keep-me"]);

  const store = new RunStore(repo, "session", "run", home);
  await store.create({ id: "run", workflowName: "trust", cwd: repo, sessionId: "session", state: "running", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "trust" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] }));
  const owned = await store.worktree("worker");
  writeFileSync(join(store.directory, "worktrees.json"), JSON.stringify([{ ...owned, path: repo, cwd: repo, branch: "keep-me" }]));

  await assert.rejects(store.delete(true), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  assert.equal(existsSync(repo), true);
  assert.equal(existsSync(owned.path), true);
  assert.doesNotThrow(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", "keep-me"], { stdio: "ignore" }));
});

void test("accepted shell stays host-trusted while oversized RPC results are never journaled", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-shell-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-shell-cwd-"));
  const marker = join(cwd, "shell-marker");
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } };
  const trustedScript = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "host-trusted");process.stdout.write("trusted");process.stderr.write("diagnostic");process.exit(7)`;
  const trustedCommand = `${process.execPath} -e ${JSON.stringify(trustedScript)}`;
  const trusted = await workflow.execute("id", { name: "trusted-shell", script: `return await shell(${JSON.stringify(trustedCommand)});`, foreground: true }, new AbortController().signal, undefined, context);
  assert.deepEqual(JSON.parse(trusted.content[0]?.text ?? "null"), { exitCode: 7, stdout: "trusted", stderr: "diagnostic" });
  assert.equal(readFileSync(marker, "utf8"), "host-trusted");

  const oversizedHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-shell-large-"));
  const oversizedCwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-shell-large-cwd-"));
  const oversizedMarker = join(oversizedCwd, "shell-marker");
  const oversizedTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof oversizedTools)[number]) { oversizedTools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), oversizedHome, undefined, undefined, oversizedHome);
  const oversizedWorkflow = oversizedTools.find(({ name }) => name === "workflow");
  assert.ok(oversizedWorkflow);
  const oversizedScript = `require("node:fs").writeFileSync(${JSON.stringify(oversizedMarker)}, "ran");process.stdout.write("x".repeat(${String(RPC_LIMIT_BYTES - 32)}))`;
  const oversizedCommand = `${process.execPath} -e ${JSON.stringify(oversizedScript)}`;
  await assert.rejects(oversizedWorkflow.execute("id", { name: "oversized-shell", script: `return await shell(${JSON.stringify(oversizedCommand)});`, foreground: true }, new AbortController().signal, undefined, { cwd: oversizedCwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  assert.equal(readFileSync(oversizedMarker, "utf8"), "ran");
  const [runId] = await listRunIds(oversizedCwd, "session", oversizedHome);
  assert.ok(runId);
  const journal = JSON.parse(readFileSync(join(new RunStore(oversizedCwd, "session", runId, oversizedHome).directory, "journal.json"), "utf8")) as { completed: Record<string, unknown> };
  assert.deepEqual(journal.completed, {});
});
void test("rejects oversized raw shell output and terminates its process group", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-raw-shell-limit-"));
  const survivor = join(cwd, "survivor");
  const survivorScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(survivor)}, "survived"), 500);`;
  const script = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(survivorScript)}], { stdio: "ignore" }); process.stdout.write("x".repeat(${String(RPC_LIMIT_BYTES + 1)})); setTimeout(() => {}, 10_000);`;
  const command = `${process.execPath} -e ${JSON.stringify(script)}`;
  await assert.rejects(executeShellCommand(command, {}, new AbortController().signal, cwd), (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(existsSync(survivor), false);
});
void test("pre-aborted shell launch cancels without leaving a child process group", { skip: process.platform === "win32", timeout: 5_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-pre-aborted-shell-"));
  const parentPid = join(cwd, "parent.pid");
  const childPid = join(cwd, "child.pid");
  const survivor = join(cwd, "survivor");
  const survivorScript = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); setTimeout(() => fs.writeFileSync(${JSON.stringify(survivor)}, "survived"), 250); setInterval(() => {}, 1_000);`;
  const script = `const fs = require("node:fs"); const { spawn } = require("node:child_process"); fs.writeFileSync(${JSON.stringify(parentPid)}, String(process.pid)); spawn(process.execPath, ["-e", ${JSON.stringify(survivorScript)}], { stdio: "ignore" }); setInterval(() => {}, 1_000);`;
  const command = `${process.execPath} -e ${JSON.stringify(script)}`;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeShellCommand(command, {}, controller.signal, cwd), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(existsSync(survivor), false);
  for (const pidPath of [parentPid, childPid]) {
    if (!existsSync(pidPath)) continue;
    const pid = Number(readFileSync(pidPath, "utf8"));
    assert.throws(() => process.kill(-pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  }
});

void test("shell with artifact mode preserves small results below threshold unchanged", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-artifact-small-"));
  const command = `${process.execPath} -e "process.stdout.write('hello stdout'); process.stderr.write('hello stderr')"`;
  const result = await executeShellCommand(command, { artifact: true }, new AbortController().signal, cwd);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello stdout");
  assert.equal(result.stderr, "hello stderr");
  assert.equal(result.stdoutEvidence, undefined);
  assert.equal(result.stderrEvidence, undefined);
  assert.equal(result.evidence, undefined);
});

void test("shell with artifact mode offloads above-threshold stdout to evidence store", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-artifact-large-"));
  const store = new RunStore(cwd, "session", "run", cwd);
  await store.create({ id: "run", workflowName: "test", cwd, sessionId: "session", state: "running", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return 1", args: null, metadata: { name: "test" }, settings: { concurrency: 1 }, models: [], tools: [], agentConfigurations: {}, schemas: [] }));
  const outputLength = RPC_LIMIT_BYTES + 1024;
  const script = `process.stdout.write("A".repeat(${String(outputLength)}))`;
  const command = `${process.execPath} -e ${JSON.stringify(script)}`;
  const result = await executeShellCommand(command, { artifact: true }, new AbortController().signal, cwd, store);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(result.stdoutBytes, outputLength);
  assert.ok(result.stdoutEvidence);
  assert.equal(result.evidence, result.stdoutEvidence);
  assert.match(result.stdoutEvidence.ref, /^ref:sha256:[0-9a-f]{16}$/);
  assert.equal(result.stdoutEvidence.bytes, outputLength);
  assert.ok(existsSync(result.stdoutEvidence.path));
  const content = readFileSync(result.stdoutEvidence.path, "utf8");
  assert.equal(content.length, outputLength);
  assert.equal(content[0], "A");
  assert.equal(content[content.length - 1], "A");
  await store.validateEvidence();
});

void test("shell with artifact mode preserves non-zero exit code with evidence", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-artifact-nonzero-"));
  const script = `process.stdout.write("FAIL".repeat(500)); process.exit(42)`;
  const command = `${process.execPath} -e ${JSON.stringify(script)}`;
  const result = await executeShellCommand(command, { artifact: true, artifactThresholdBytes: 100 }, new AbortController().signal, cwd);
  assert.equal(result.exitCode, 42);
  assert.equal(result.stdout, "");
  assert.ok(result.stdoutEvidence);
  assert.equal(result.stdoutBytes, 2000);
  assert.equal(readFileSync(result.stdoutEvidence.path, "utf8"), "FAIL".repeat(500));
});

void test("shell with artifact mode offloads above-threshold stderr to evidence store", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-artifact-stderr-"));
  const script = `process.stderr.write("ERR".repeat(500)); process.stdout.write("ok")`;
  const command = `${process.execPath} -e ${JSON.stringify(script)}`;
  const result = await executeShellCommand(command, { artifact: true, artifactThresholdBytes: 100 }, new AbortController().signal, cwd);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "");
  assert.ok(result.stderrEvidence);
  assert.equal(result.evidence, result.stderrEvidence);
  assert.equal(result.stderrBytes, 1500);
  assert.equal(readFileSync(result.stderrEvidence.path, "utf8"), "ERR".repeat(500));
});

void test("shell with artifact mode preserves Unicode integrity and hash", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-artifact-unicode-"));
  const unicodePayload = "🚀 Unicode \u2603 \u{1F389} \u{1F984} 測試 ";
  const repeatCount = 200;
  const script = `process.stdout.write(${JSON.stringify(unicodePayload)}.repeat(${String(repeatCount)}))`;
  const command = `${process.execPath} -e ${JSON.stringify(script)}`;
  const result = await executeShellCommand(command, { artifact: true, artifactThresholdBytes: 100 }, new AbortController().signal, cwd);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdoutEvidence);
  const expectedContent = unicodePayload.repeat(repeatCount);
  const expectedBytes = Buffer.byteLength(expectedContent, "utf8");
  assert.equal(result.stdoutBytes, expectedBytes);
  assert.equal(result.stdoutEvidence.bytes, expectedBytes);
  const readContent = readFileSync(result.stdoutEvidence.path, "utf8");
  assert.equal(readContent, expectedContent);
});

void test("shell with artifact mode cleans up temporary files on cancellation", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-artifact-cancel-"));
  const evidenceDir = join(cwd, "evidence");
  const script = `setInterval(() => process.stdout.write("X".repeat(1000)), 50);`;
  const command = `${process.execPath} -e ${JSON.stringify(script)}`;
  const controller = new AbortController();
  const promise = executeShellCommand(command, { artifact: true, artifactThresholdBytes: 100 }, controller.signal, cwd, evidenceDir);
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await assert.rejects(promise, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const files = existsSync(evidenceDir) ? readdirSync(evidenceDir) : [];
  assert.deepEqual(files.filter((f) => f.startsWith(".tmp")), [], "no leftover temporary files after cancellation");
});
