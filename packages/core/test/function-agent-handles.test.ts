import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow, WorkflowError, WorkflowRegistry, type AgentIdentity, type JsonValue, type RunStore, type WorkflowBridge, type WorkflowFunction, type WorkflowFunctionContext } from "../src/index.js";
import { agentHandleTurnPath, agentIdentityPath } from "../src/execution.js";
import { withWorkflowFunctions, workflowRunContext } from "../src/host-runtime.js";

type Send = { readonly prompt: string; readonly options: Readonly<Record<string, JsonValue>>; readonly signal: AbortSignal; readonly identity: AgentIdentity };
type Run = (context: Readonly<WorkflowFunctionContext>, input: Readonly<Record<string, JsonValue>>) => unknown;

function fn(run: Run): WorkflowFunction {
  return { description: "test", input: { type: "object" }, output: { type: "object" }, run: (input, context) => run(context, input) };
}
/** Hosts registered functions through the real withWorkflowFunctions bridge, recording what reaches the agent bridge below it. */
function harness(functions: Readonly<Record<string, Run>>, agent?: (send: Send) => Promise<JsonValue>) {
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Handles", functions: Object.fromEntries(Object.entries(functions).map(([name, run]) => [name, fn(run)])) });
  const completed = new Map<string, JsonValue>();
  const store = {
    replay: async (path: string) => { const value = completed.get(path); return value === undefined ? undefined : { path, value }; },
    complete: async (path: string, value: JsonValue) => { completed.set(path, value); },
  } as unknown as RunStore;
  const sends: Send[] = [];
  const controller = new AbortController();
  const bridge: WorkflowBridge = {
    agent: async (prompt, options, signal, identity) => { const send = { prompt, options, signal, identity }; sends.push(send); return agent ? agent(send) : `reply:${prompt}`; },
    worktree: async (owner) => ({ path: `/worktrees/${owner}`, branch: owner }),
  };
  const wrapped = withWorkflowFunctions(bridge, store, workflowRunContext("/repo", "session", "run", { name: "handles" }, null, controller.signal), registry);
  const call = async (name: string, occurrence = 1): Promise<JsonValue> => {
    if (!wrapped.function) throw new Error("Missing function bridge");
    return wrapped.function(name, {}, controller.signal, { path: `function/${name}/${String(occurrence)}`, structuralPath: [], occurrence });
  };
  const paths = (): string[] => sends.map(({ identity }) => agentIdentityPath(identity));
  return { call, sends, paths, controller };
}
const twoTurns: Run = async (context) => {
  const dev = context.agent.create({ name: "dev" });
  return { first: await dev.send("one"), second: await dev.send("two") };
};

void test("a registered function handle sends sequential journaled turns with a scoped handle identity", async () => {
  const { call, sends, paths } = harness({ twoTurns });
  assert.deepEqual(await call("twoTurns"), { first: "reply:one", second: "reply:two" });
  assert.deepEqual(sends.map(({ identity }) => identity.turn), [1, 2]);
  const handle = sends[0]?.identity.handle;
  assert.ok(handle?.startsWith("function-handle/"));
  assert.equal(sends[1]?.identity.handle, handle);
  assert.deepEqual(sends.map(({ identity }) => identity.occurrence), [1, 2]);
  assert.deepEqual(paths(), [agentHandleTurnPath(handle ?? "", 1), agentHandleTurnPath(handle ?? "", 2)]);
  assert.equal(sends[0]?.identity.parentBreadcrumb, "twoTurns");
});

void test("handles stay collision-free across script handles, functions, repeated and nested invocations", async () => {
  const { call, paths } = harness({
    twoTurns,
    otherTurns: twoTurns,
    nested: async (context) => { await context.invoke("twoTurns", {}); await context.invoke("twoTurns", {}); await context.invoke("otherTurns", {}); return {}; },
  });
  await call("twoTurns", 1);
  await call("twoTurns", 2);
  await call("otherTurns", 1);
  await call("nested", 1);
  await call("nested", 2);
  const all = paths();
  assert.equal(all.length, 2 * 9);
  assert.equal(new Set(all).size, all.length);
  assert.ok(!all.includes(agentHandleTurnPath("dev", 1)));
  const replayRun = harness({ twoTurns });
  await replayRun.call("twoTurns", 1);
  assert.deepEqual(replayRun.paths(), all.slice(0, 2));
});

void test("a script handle cannot claim the registered-function handle namespace", async () => {
  const script = `try { agent.create({ name: "function-handle/abc/dev" }); } catch (failure) { return failure.code; } return "accepted";`;
  assert.equal(await runWorkflow(script, null, { agent: async () => "done" }).result, "INVALID_METADATA");
});

void test("parallel branches and worktree scopes get distinct handles for one name", async () => {
  const { call, sends, paths } = harness({
    scopes: async (context) => {
      await context.parallel("branches", {
        left: async () => context.agent.create({ name: "dev" }).send("left"),
        right: async () => context.agent.create({ name: "dev" }).send("right"),
      });
      await context.withWorktree("one", async () => context.agent.create({ name: "dev" }).send("wt-one"));
      await context.withWorktree("two", async () => context.agent.create({ name: "dev" }).send("wt-two"));
      return {};
    },
  });
  await call("scopes");
  assert.equal(new Set(paths()).size, 4);
  assert.deepEqual(sends.map(({ identity }) => identity.turn), [1, 1, 1, 1]);
  assert.deepEqual(sends.slice(0, 2).map(({ identity }) => identity.structuralPath.length), [2, 2]);
  assert.deepEqual(sends.slice(2).map(({ identity }) => identity.worktreeOwner?.split("/").at(-1)), ["one", "two"]);
});

void test("handle sends must stay in the creating parallel branch and worktree", async () => {
  const { call, sends } = harness({
    scope: async (context) => {
      const outer = context.agent.create({ name: "outer" });
      const codes: string[] = [];
      const code = async (send: () => Promise<JsonValue>): Promise<string> => { try { await send(); return "accepted"; } catch (error) { return error instanceof WorkflowError ? error.code : "other"; } };
      codes.push(await code(async () => (await context.parallel("branches", { left: () => outer.send("branch") })).left));
      let inner!: ReturnType<typeof context.agent.create>;
      await context.withWorktree("tree", async () => { inner = context.agent.create({ name: "inner" }); codes.push(await code(() => outer.send("in worktree"))); return null; });
      codes.push(await code(() => inner.send("outside worktree")));
      codes.push(await code(() => outer.send("same scope")));
      return { codes };
    },
  });
  assert.deepEqual(await call("scope"), { codes: ["INVALID_METADATA", "INVALID_METADATA", "INVALID_METADATA", "accepted"] });
  assert.deepEqual(sends.map(({ prompt }) => prompt), ["same scope"]);
});

void test("handle config is frozen and only supported send options are accepted", async () => {
  const { call, sends } = harness({
    options: async (context) => {
      const options = { name: "dev", label: "Developer", tools: ["read"] };
      const dev = context.agent.create(options);
      options.label = "Mutated";
      options.tools.push("write");
      const codes: string[] = [];
      for (const bad of [{ label: "Other" }, { role: "x" }, { timeoutMs: 0 }, { timeoutMs: "1" }, []]) {
        try { await dev.send("bad", bad as never); codes.push("accepted"); } catch (error) { codes.push(error instanceof WorkflowError ? error.code : "other"); }
      }
      const value = await dev.send("good", { outputSchema: { type: "string" }, timeoutMs: 5 });
      return { codes, value, frozen: Object.isFrozen(dev) };
    },
  });
  assert.deepEqual(await call("options"), { codes: ["INVALID_METADATA", "INVALID_METADATA", "INVALID_METADATA", "INVALID_METADATA", "INVALID_METADATA"], value: "reply:good", frozen: true });
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.identity.turn, 1);
  assert.deepEqual(sends[0].options, { label: "Developer", tools: ["read"], outputSchema: { type: "string" }, timeoutMs: 5 });
});

void test("agent.create validates its name, options, and uniqueness", async () => {
  const { call } = harness({
    create: async (context) => {
      const codes: string[] = [];
      const attempt = (create: () => unknown): void => { try { create(); codes.push("accepted"); } catch (error) { codes.push(error instanceof WorkflowError ? error.code : "other"); } };
      attempt(() => context.agent.create({ name: " " }));
      attempt(() => (context.agent.create as (...values: unknown[]) => unknown)());
      attempt(() => context.agent.create({ name: "dev", thinking: "high" }));
      attempt(() => context.agent.create({ name: "dev", timeoutMs: 0 }));
      attempt(() => context.agent.create({ name: "dev" }));
      attempt(() => context.agent.create({ name: "dev" }));
      return { codes };
    },
  });
  assert.deepEqual(await call("create"), { codes: ["INVALID_METADATA", "INVALID_METADATA", "INVALID_METADATA", "INVALID_METADATA", "accepted", "INVALID_METADATA"] });
});

void test("overlapping sends are rejected without disturbing the running turn", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { call, sends } = harness({
    overlap: async (context) => {
      const dev = context.agent.create({ name: "dev" });
      const first = dev.send("one");
      let code = "accepted";
      try { await dev.send("two"); } catch (error) { code = error instanceof WorkflowError ? error.code : "other"; }
      release();
      return { code, first: await first, third: await dev.send("three") };
    },
  }, async ({ prompt }) => { if (prompt === "one") await gate; return `reply:${prompt}`; });
  assert.deepEqual(await call("overlap"), { code: "INVALID_METADATA", first: "reply:one", third: "reply:three" });
  assert.deepEqual(sends.map(({ prompt, identity }) => [prompt, identity.turn]), [["one", 1], ["three", 2]]);
});

void test("a failed turn rejects only its caller and frees the handle for the next turn", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { call, sends } = harness({
      recover: async (context) => {
        const dev = context.agent.create({ name: "dev" });
        let failure = "none";
        try { await dev.send("boom"); } catch (error) { failure = error instanceof WorkflowError ? error.code : "other"; }
        return { failure, next: await dev.send("again") };
      },
    }, async ({ prompt }) => { if (prompt === "boom") throw new WorkflowError("AGENT_FAILED", "boom"); return `reply:${prompt}`; });
    assert.deepEqual(await call("recover"), { failure: "AGENT_FAILED", next: "reply:again" });
    assert.deepEqual(sends.map(({ identity }) => identity.turn), [1, 2]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

void test("a handle turn is cancelled through the function signal", async () => {
  const { call, controller } = harness({
    cancelled: async (context) => {
      const dev = context.agent.create({ name: "dev" });
      let code = "none";
      try { await dev.send("wait"); } catch (error) { code = error instanceof WorkflowError ? error.code : "other"; }
      let after = "none";
      try { await dev.send("again"); } catch (error) { after = error instanceof WorkflowError ? error.code : "other"; }
      return { code, after };
    },
  }, ({ signal }) => new Promise<JsonValue>((_resolve, reject) => {
    const cancel = (): void => { reject(new WorkflowError("CANCELLED", "cancelled")); };
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
  }));
  const running = call("cancelled");
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await running, { code: "CANCELLED", after: "CANCELLED" });
});

void test("plain function agent identities are unchanged by handles", async () => {
  const { call, sends } = harness({
    mixed: async (context) => { await context.agent("plain"); await context.agent.create({ name: "dev" }).send("handle"); await context.agent("plain again"); return {}; },
  });
  await call("mixed");
  assert.deepEqual(sends.map(({ identity }) => [identity.callSite, identity.occurrence, identity.handle ?? null]), [["function:function/mixed/1", 1, null], [`function:function/mixed/1:handle:dev`, 1, sends[1]?.identity.handle ?? null], ["function:function/mixed/1", 2, null]]);
});

void test("a handle cannot send after the function invocation that created it has finished", async () => {
  let escaped: ReturnType<WorkflowFunctionContext["agent"]["create"]> | undefined;
  const { call, sends } = harness({ leak: async (context) => { escaped = context.agent.create({ name: "dev" }); return {}; } });
  await call("leak");
  await assert.rejects(async () => escaped?.send("late"), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.equal(sends.length, 0);
});
