import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callUnchecked, testExtensionApi } from "./support.js";
import workflowExtension, { defineWorkflowFunction, registerWorkflowExtension, resetWorkflowRegistry, runWorkflow, WorkflowError, WorkflowRegistry, RunStore } from "../src/index.js";
import { Type } from "typebox";
import { withWorkflowFunctions, workflowRunContext } from "../src/host-runtime.js";
import { toolIdentityPath } from "../src/execution.js";
import { formatWorkflowProgress } from "../src/host-view.js";
import { listRunIds } from "../src/persistence.js";
import { loadTrajectoryRuns } from "../src/trajectory.js";
import { prepareScriptToolLoadout, scriptToolValue } from "../src/script-tools.js";
import { scriptToolReferences } from "../src/validation.js";
import type { ExtensionToolContext, ToolLoadout } from "@earendil-works/pi-coding-agent";
import type { JsonValue, PersistedRun, ToolIdentity } from "../src/index.js";

type Tool = ExtensionToolContext["tools"][number];
type Outcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
const bashSchema = { type: "object", properties: { output: { type: "string" }, exit_code: { type: "number" } }, required: ["output", "exit_code"] };
const tool = (name: string, outputSchema?: object) => ({ name, label: name, description: `${name} tool`, parameters: { type: "object" }, ...(outputSchema ? { outputSchema } : {}), execute: () => Promise.reject(new Error("unused")) }) as unknown as Tool;
const outcome = (text: string, extra: { structuredContent?: JsonValue; isError?: boolean } = {}) => ({ toolCall: {}, result: { content: [{ type: "text", text }], details: {}, ...(extra.structuredContent === undefined ? {} : { structuredContent: extra.structuredContent }) }, isError: extra.isError ?? false }) as unknown as Outcome;

void test("workflow scripts call tools keyed by scope and arguments, and stay out of withWorktree", async () => {
  const calls: Array<[string, JsonValue, ToolIdentity]> = [];
  const result = await runWorkflow(`
    const first = await tools.read({ path: "a" });
    const [second, again] = await Promise.all([tools.read({ path: "b" }), tools.read({ path: "a" })]);
    const nested = await parallel("fan", { one: () => tools.read({ path: "c" }) });
    let blocked = "";
    try { await withWorktree("tree", async () => tools.read({ path: "d" })); } catch (error) { blocked = error.code; }
    let probe = "";
    try { "read" in tools; } catch (error) { probe = error.code; }
    return { first, second, again, nested, blocked, probe, thenable: tools.then === undefined };`, null, {
    tool: async (identifier, args, _signal, identity) => { calls.push([identifier, args, identity]); return `${identifier}:${args.path as string}`; },
    worktree: async () => ({ path: "/tmp/tree", branch: "tree" }),
  }).result;
  assert.deepEqual(result, { first: "read:a", second: "read:b", again: "read:a", nested: { one: "read:c" }, blocked: "INVALID_METADATA", probe: "INVALID_METADATA", thenable: true });
  assert.deepEqual(calls.map(([, args, identity]) => [args, identity]), [[{ path: "a" }, { structuralPath: [], occurrence: 1 }], [{ path: "b" }, { structuralPath: [], occurrence: 1 }], [{ path: "a" }, { structuralPath: [], occurrence: 2 }], [{ path: "c" }, { structuralPath: ["fan", "one"], occurrence: 1 }]]);
  const identity = { structuralPath: [], occurrence: 1 };
  assert.equal(toolIdentityPath("read", { a: 1, b: { c: 2, d: 3 } }, identity), toolIdentityPath("read", { b: { d: 3, c: 2 }, a: 1 }, identity), "key order does not change the journal path");
  assert.notEqual(toolIdentityPath("read", { path: "a" }, identity), toolIdentityPath("read", { path: "b" }, identity));
  await assert.rejects(runWorkflow("return await tools.read({});").result, (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});

void test("registered function tools share argument, probing, worktree, and structural scope rules", async () => {
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Function tools", functions: {
    readTool: defineWorkflowFunction({ description: "Read", input: Type.Object({}), output: Type.String(), async run(_input, context) {
      const { read } = context.tools;
      assert.ok(read);
      const result = await read({ path: "a" });
      assert.ok(typeof result === "string");
      return result;
    } }),
    checks: defineWorkflowFunction({ description: "Check tool scopes", input: Type.Object({}), output: Type.Object({}), async run(_input, context) {
      const { read } = context.tools;
      assert.ok(read);
      for (const args of [[null], [[]], ["a"], [{}, {}]]) {
        assert.throws(() => callUnchecked(read, undefined, args), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && error.message === "tools.read takes one arguments object");
      }
      assert.throws(() => "read" in context.tools, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
      assert.equal(context.tools.then, undefined);
      assert.equal(context.tools.toJSON, undefined);
      const blocked = (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && error.message === "tools.read is unavailable inside withWorktree: session tools resolve paths against the session working directory";
      await assert.rejects(context.withWorktree("tree", () => read({})), blocked);
      await assert.rejects(context.withWorktree("tree", () => context.invoke("readTool", {})), blocked);
      await read({ path: "a" });
      await read({ path: "a" });
      await context.parallel("fan", { left: () => read({ path: "a" }), right: () => read({ path: "a" }) });
      await context.pipeline("items", { one: "a" }, { read: (path) => read({ path }) });
      await context.invoke("readTool", {});
      await context.invoke("readTool", {});
      return {};
    } }),
  } });
  const paths: string[] = [];
  const store = { replay: async () => undefined, complete: async () => {} } as unknown as RunStore;
  const controller = new AbortController();
  const run = workflowRunContext("/repo", "session", "run", { name: "tools" }, null, controller.signal);
  const bridge = withWorkflowFunctions({
    tool: async (name, args, _signal, identity) => { paths.push(toolIdentityPath(name, args, identity)); return "read"; },
    worktree: async () => ({ path: "/tmp/tree", branch: "tree" }),
  }, store, run, registry);
  await runWorkflow('await tools.read({ path: "a" }); await checks({}); return checks({});', null, bridge).result;
  assert.equal(paths.length, 15);
  assert.equal(new Set(paths).size, paths.length, "script, repeated function, nested invoke, branch, stage, and occurrence identities stay distinct");
  await assert.rejects(runWorkflow('return withWorktree("tree", () => readTool({}));', null, bridge).result, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && error.message.includes("unavailable inside withWorktree"));
  const noTools = withWorkflowFunctions({}, store, run, registry);
  await assert.rejects(runWorkflow("return readTool({});", null, noTools).result, (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});

void test("registered functions use the session tool bridge and replay partial calls on retry and resume", async (t) => {
  for (const recovery of ["retry", "resume"] as const) await t.test(recovery, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "pi-function-tools-"));
    resetWorkflowRegistry();
    t.after(() => { resetWorkflowRegistry(); rmSync(home, { recursive: true, force: true }); });
    const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ structuredContent?: unknown }> }> = [];
    workflowExtension(testExtensionApi({ registerTool: (definition) => { registered.push(definition as (typeof registered)[number]); }, getActiveTools: () => ["workflow"] }), home);
    const execute = (name: string) => { const found = registered.find((entry) => entry.name === name); assert.ok(found); return found.execute; };
    let functionCalls = 0;
    registerWorkflowExtension({ version: "1.0.0", headline: "Session tool functions", functions: {
      leaf: defineWorkflowFunction({ description: "Call text and structured tools", input: Type.Object({}), output: Type.Object({ file: Type.String(), data: Type.Unknown() }), async run(_input, context) {
        functionCalls += 1;
        const { read, retail_find } = context.tools;
        assert.ok(read && retail_find);
        const file = await read({ path: "a" });
        assert.ok(typeof file === "string");
        const data = await retail_find({ query: "a" });
        return { file, data };
      } }),
      outer: defineWorkflowFunction({ description: "Compose tools", input: Type.Object({}), output: Type.Object({ own: Type.String(), nested: Type.Unknown() }), async run(_input, context) {
        functionCalls += 1;
        const { read } = context.tools;
        assert.ok(read);
        const args = { path: "a" };
        const pending = read(args);
        args.path = "changed after the call";
        const own = await pending;
        assert.ok(typeof own === "string");
        return { own, nested: await context.invoke("leaf", {}) };
      } }),
      unknown: defineWorkflowFunction({ description: "Unknown tool", input: Type.Object({}), output: Type.Object({}), async run(_input, context) {
        const { missing } = context.tools;
        assert.ok(missing);
        await missing({});
        return {};
      } }),
    } });
    let fails = true;
    const executed: string[] = [];
    const ctx = {
      cwd: home, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" },
      tools: [tool("read"), tool("retail-find", bashSchema)],
      executeTool: async (name: string, args: Record<string, JsonValue>) => {
        executed.push(name);
        if (name === "read") {
          assert.equal(args.path, "a", "arguments are snapshotted at call time, as in the script RPC");
          return outcome(`text:${String(executed.length)}`);
        }
        if (fails && recovery === "resume") throw new WorkflowError("BUDGET_EXHAUSTED", "pause after journaled reads");
        return fails ? outcome("blocked", { isError: true }) : outcome("structured", { structuredContent: { output: "found", exit_code: 0 }, isError: true });
      },
    };
    const script = 'const inline = await tools.read({ path: "a" }); return { inline, result: await outer({}) };';
    await assert.rejects(execute("workflow")("first", { name: "function-tools", script, foreground: true }, new AbortController().signal, undefined, ctx), (error: unknown) => error instanceof WorkflowError && error.code === (recovery === "retry" ? "TOOL_FAILED" : "BUDGET_EXHAUSTED"));
    const [runId] = await listRunIds(home, "session", home, false);
    assert.ok(runId);
    const store = new RunStore(home, "session", runId, home);
    assert.equal((await store.load()).run.state, recovery === "retry" ? "failed" : "budget_exhausted");
    assert.equal(await store.replay("function/outer/1"), undefined, "the function is incomplete, so recovery must replay individual tool results");
    assert.deepEqual(executed, ["read", "read", "read", "retail-find"]);
    fails = false;
    ctx.tools = [tool("retail-find", bashSchema)];
    const result = await execute(`workflow_${recovery}`)("recovery", { runId, foreground: true }, new AbortController().signal, undefined, ctx);
    assert.deepEqual((result.structuredContent as { value: unknown }).value, { inline: "text:1", result: { own: "text:2", nested: { file: "text:3", data: { output: "found", exit_code: 0 } } } });
    assert.deepEqual(executed, ["read", "read", "read", "retail-find", "retail-find"], "all reads replay even though the recovering session no longer has read");
    assert.equal(functionCalls, 4, "both incomplete functions run again, not just a completed function replay");
    await assert.rejects(execute("workflow")("unknown", { name: "unknown-function-tool", script: "return unknown({});", foreground: true }, new AbortController().signal, undefined, ctx), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
    assert.equal((await listRunIds(home, "session", home, false)).length, recovery === "retry" ? 3 : 2, "unknown registered-function tools are checked at call time, after run creation");
  });
});

void test("static tool references are known only when the script never rebinds tools", () => {
  assert.deepEqual(scriptToolReferences("const a = await tools.read({ path: 'x' }); return agent('p', { label: 'a', tools: ['read'] }).then(() => tools.bash({ command: 'ls' }));"), ["read", "bash"]);
  assert.equal(scriptToolReferences("const tools = ['read']; return tools.map((name) => name);"), undefined);
  assert.equal(scriptToolReferences("const tools = []; return agent('p', { label: 'a', tools });"), undefined);
  assert.equal(scriptToolReferences("return 'read' in tools;"), undefined);
});

void test("script tool values and model hints follow codemode", () => {
  assert.deepEqual(scriptToolValue(tool("bash", bashSchema), outcome("ok", { structuredContent: { output: "ok", exit_code: 1 } })), { output: "ok", exit_code: 1 });
  assert.equal(scriptToolValue(tool("read"), outcome("text")), "text");
  assert.throws(() => scriptToolValue(tool("bash", bashSchema), outcome("blocked", { isError: true })), (error: unknown) => error instanceof WorkflowError && error.code === "TOOL_FAILED" && error.message === "bash: blocked");
  assert.deepEqual(scriptToolValue(tool("bash", bashSchema), outcome("partial", { structuredContent: { output: "partial", exit_code: 2, missing: undefined } as unknown as JsonValue, isError: true })), { output: "partial", exit_code: 2 }, "an error with structured content resolves, normalized as the journal stores it");
  assert.throws(() => scriptToolValue(tool("read"), outcome("x".repeat(10 * 1024 * 1024 + 1))), (error: unknown) => error instanceof WorkflowError && error.code === "TOOL_FAILED" && error.message.includes("10 MB"));
  const loadout = (declared: Tool[]) => ({ declared, callable: declared, registered: declared, getExposure: () => "direct", getNamespace: () => undefined }) as unknown as ToolLoadout;
  assert.deepEqual(prepareScriptToolLoadout(loadout([tool("read"), tool("bash", bashSchema), tool("workflow_status", bashSchema)])), { descriptions: { bash: "bash tool\n\nWorkflow scripts: `tools.bash(args)` resolves to `{ output, exit_code }`." } });
  assert.equal(prepareScriptToolLoadout(loadout([tool("codemode"), tool("bash", bashSchema)])), undefined, "codemode's own lines describe the same calls");
});

void test("the workflow tool runs script tools, shows them while in flight, and a retry replays journaled calls", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-script-tools-"));
  const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ structuredContent?: unknown }> }> = [];
  workflowExtension(testExtensionApi({ registerTool: (definition) => { registered.push(definition as (typeof registered)[number]); }, getActiveTools: () => ["workflow"] }), home);
  const execute = (name: string) => { const found = registered.find((entry) => entry.name === name); assert.ok(found); return found.execute; };
  const executed: string[] = [];
  let bashFails = true;
  const ctx = {
    cwd: home, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" },
    tools: [tool("read"), tool("bash", bashSchema), tool("workflow_status", bashSchema)],
    executeTool: async (name: string, args: { path?: string }) => {
      executed.push(name);
      if (name === "read") return outcome(`content of ${String(args.path)}`);
      return bashFails ? outcome("bash blocked", { isError: true }) : outcome("ran", { structuredContent: { output: "ran", exit_code: 0 } });
    },
  };
  await assert.rejects(execute("workflow")("unknown", { name: "unknown", script: "return tools.workflow_status({ runId: 'x' });", foreground: true }, new AbortController().signal, undefined, ctx), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL" && error.message.includes("tools.workflow_status"));
  assert.deepEqual(await listRunIds(home, "session", home, false), [], "an unknown tool fails the launch before the run exists");

  const updates: PersistedRun[] = [];
  const script = "phase('io'); const echo = await shell('printf hi', { env: { SECRET: 'value' } }); const file = await tools.read({ path: 'a.txt' }); const sh = await tools.bash({ command: 'ls' }); return { file, exit: sh.exit_code, echo: echo.stdout };";
  await assert.rejects(execute("workflow")("first", { name: "tools", script, foreground: true }, new AbortController().signal, (update: { details: { run: PersistedRun } }) => { updates.push(update.details.run); }, ctx), (error: unknown) => error instanceof WorkflowError && error.code === "TOOL_FAILED");
  assert.deepEqual(executed, ["read", "bash"]);
  const inFlight = updates.find((run) => run.activeTools?.length);
  assert.ok(inFlight);
  assert.deepEqual(inFlight.activeTools?.map(({ name }) => name), ["read"]);
  assert.match(formatWorkflowProgress(inFlight, "◇"), /◇ tools \[running\] read elapsed=/);
  assert.equal(updates.at(-1)?.activeTools, undefined);

  bashFails = false;
  const [failedRunId] = await listRunIds(home, "session", home, false);
  assert.ok(failedRunId);
  const [failed] = await loadTrajectoryRuns(home, "session", home);
  const calls = failed?.run.scriptCalls ?? [];
  assert.deepEqual(calls.map(({ kind, name, input, phase, error, output }) => ({ kind, name, input, phase, error, output })), [
    { kind: "shell", name: "shell", input: { command: "printf hi", env: ["SECRET"] }, phase: "io", error: undefined, output: { status: "available", value: { exitCode: 0, stdout: "hi", stderr: "" }, bytes: 40 } },
    { kind: "tool", name: "read", input: undefined, phase: "io", error: undefined, output: { status: "completed" } },
    { kind: "tool", name: "bash", input: undefined, phase: "io", error: { code: "TOOL_FAILED" }, output: { status: "failed", code: "TOOL_FAILED" } },
  ], "tool payloads stay private, while shell inputs and output remain recorded");
  const store = new RunStore(home, "session", failedRunId, home);
  const persisted = (await store.load()).run.scriptCalls;
  assert.deepEqual(persisted?.filter(({ kind }) => kind === "tool").map((call) => ({ input: call.input, error: call.error })), [{ input: undefined, error: undefined }, { input: undefined, error: { code: "TOOL_FAILED" } }]);
  const rawCalls: unknown = (JSON.parse(readFileSync(join(store.directory, "state.json"), "utf8")) as PersistedRun).scriptCalls;
  assert.doesNotMatch(JSON.stringify(rawCalls), /a\.txt|bash blocked|content of/);
  assert.ok(calls.every(({ startedAt, finishedAt }) => finishedAt !== undefined && finishedAt >= startedAt));
  const retried = await execute("workflow_retry")("retry", { runId: failedRunId, foreground: true }, new AbortController().signal, undefined, ctx);
  const retriedRunId = (retried.structuredContent as { runId: string }).runId;
  assert.deepEqual(retried.structuredContent, { runId: retriedRunId, parentRunId: failedRunId, state: "completed", value: { file: "content of a.txt", exit: 0, echo: "hi" } });
  assert.deepEqual(executed, ["read", "bash", "bash"], "the retry replays the journaled read and runs only the failed bash");
  const child = (await loadTrajectoryRuns(home, "session", home)).find(({ run }) => run.id === retriedRunId);
  assert.deepEqual(child?.run.scriptCalls?.map(({ name, output }) => [name, output.status]), [["bash", "completed"]], "replayed calls are not recorded again");
});

void test("script call record writes cannot change tool success or failure", async (t) => {
  for (const write of ["start", "finish"] as const) {
    for (const code of [undefined, "CANCELLED", "TOOL_FAILED"] as const) {
      await t.test(`${write} write fails, tool outcome ${code ?? "success"}`, async (t) => {
        const home = mkdtempSync(join(tmpdir(), "pi-script-call-write-failure-"));
        t.after(() => { rmSync(home, { recursive: true, force: true }); });
        const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ structuredContent?: unknown }> }> = [];
        workflowExtension(testExtensionApi({ registerTool: (definition) => { registered.push(definition as (typeof registered)[number]); }, getActiveTools: () => ["workflow"] }), home);
        const workflow = registered.find(({ name }) => name === "workflow");
        assert.ok(workflow);
        const updateState = Object.getOwnPropertyDescriptor(RunStore.prototype, "updateState")?.value as RunStore["updateState"];
        let recordWrites = 0;
        let injected = false;
        t.mock.method(RunStore.prototype, "updateState", async function (this: RunStore, update: Parameters<RunStore["updateState"]>[0]) {
          return updateState.call(this, async (run) => {
            const next = await update(run);
            if (this.cwd === home && next.scriptCalls !== run.scriptCalls) {
              recordWrites += 1;
              if (recordWrites === (write === "start" ? 1 : 2)) {
                injected = true;
                throw new Error("record write failed");
              }
            }
            return next;
          });
        });
        let executions = 0;
        const ctx = {
          cwd: home, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" }, tools: [tool("read")],
          executeTool: async () => {
            executions += 1;
            if (code) throw new WorkflowError(code, "original tool failure");
            return outcome("original tool result");
          },
        };
        const result = workflow.execute("id", { name: "write-failure", script: "return tools.read({ path: 'private' });", foreground: true }, new AbortController().signal, undefined, ctx);
        if (code) await assert.rejects(result, (error: unknown) => error instanceof WorkflowError && error.code === code && error.message.includes("original tool failure"));
        else {
          const completed = await result;
          assert.equal((completed.structuredContent as { value: unknown }).value, "original tool result");
          const [runId] = await listRunIds(home, "session", home, false);
          assert.ok(runId);
          assert.equal((await new RunStore(home, "session", runId, home).replayableOperations())[0]?.value, "original tool result");
        }
        assert.equal(injected, true);
        assert.equal(executions, 1);
      });
    }
  }
});
