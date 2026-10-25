// Synthetic Trajectory load fixture: one idle-running run beside completed history, shaped like a long-lived session.
// Content is generated, never copied from real runs. Shared by trajectory-load.test.ts and bench/trajectory-load.mjs.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowBudgetRuntime } from "../../src/budget.js";
import { RunStore, type PersistedRun } from "../../src/persistence.js";
import { createTrajectoryRunMetadataLoader, trajectoryRunUsage, type TrajectoryPublisherInput } from "../../src/trajectory.js";
import type { AgentActivity, LaunchSnapshot } from "../../src/types.js";
import { createLaunchSnapshot } from "../../src/utils.js";

export type LoadFixtureOptions = { readonly runs: number; readonly agentsPerRun: number; readonly systemPromptBytes: number; readonly promptBytes: number; readonly attemptErrorBytes: number; readonly timingEntries: number; readonly scriptBytes: number; readonly events: number };
/** Sized after a copied 102-run session: about 9 MB of run state, 4.55 MB system prompts, 1.57 MB prompts, 1.35 MB attempt details. */
export const LOAD_FIXTURE_DEFAULTS: LoadFixtureOptions = { runs: 102, agentsPerRun: 6, systemPromptBytes: 7_400, promptBytes: 2_560, attemptErrorBytes: 1_220, timingEntries: 12, scriptBytes: 3_000, events: 12 };
export type LoadFixture = { readonly root: string; readonly cwd: string; readonly home: string; readonly sessionId: string; readonly activeRunId: string; readonly varyingAgentId: string; readonly options: LoadFixtureOptions };

const BASE_TIME = 1_760_000_000_000;
const WORDS = ["agent", "verify", "the", "workflow", "output", "must", "review", "tool", "result", "schema", "phase", "before", "report", "evidence", "\"quoted\"", "path/to/file.ts", "with", "and", "only", "changes"];
const TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "workflow", "agent", "shell"];

/** Deterministic prose with newlines and quotes, so JSON escaping costs stay representative. */
export function fixtureText(seed: number, bytes: number): string {
  let state = (seed >>> 0) || 1;
  let text = "";
  while (text.length < bytes) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    text += `${WORDS[state % WORDS.length] ?? "word"}${state % 13 === 0 ? ".\n" : " "}`;
  }
  return text.slice(0, bytes);
}

export function loadFixtureDescriptor(root: string, index: number, options: LoadFixtureOptions = LOAD_FIXTURE_DEFAULTS): LoadFixture {
  return { root, cwd: join(root, `project-${String(index)}`), home: join(root, "home"), sessionId: `load-session-${String(index)}`, activeRunId: runId(0), varyingAgentId: agentId(0, options.agentsPerRun - 1), options };
}

function runId(index: number): string { return `run-${String(index).padStart(4, "0")}`; }
function agentId(run: number, agent: number): string { return `${runId(run)}:agent-${String(agent)}`; }
function transcriptPath(fixture: LoadFixture, run: number, agent: number): string { return join(fixture.root, "transcripts", fixture.sessionId, runId(run), `agent-${String(agent)}.jsonl`); }

/** Run 0 is running with its last agent active; every other run is finished history. */
export function loadFixtureRuns(fixture: LoadFixture): { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }[] {
  const { options } = fixture;
  const model = { provider: "fixture", model: "fixture-model" };
  const result: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }[] = [];
  for (let run = 0; run < options.runs; run += 1) {
    const startedAt = BASE_TIME - run * 3_600_000;
    const active = run === 0;
    const agents = [];
    for (let agent = 0; agent < options.agentsPerRun; agent += 1) {
      const seed = run * 1_000 + agent;
      const running = active && agent === options.agentsPerRun - 1;
      const attempts = 1 + (seed % 3);
      const accounting = { input: 10_000 + seed, output: 2_000 + agent, cacheRead: 40_000, cacheWrite: 3_000, cost: 0.25 };
      const path = transcriptPath(fixture, run, agent);
      agents.push({
        id: agentId(run, agent), name: `agent-${String(agent)}`, label: `worker ${String(agent)}`, path: `phase/${String(agent)}`,
        state: running ? "running" : run % 17 === 5 && agent === 0 ? "failed" : "completed",
        model, requestedModel: "fixture/fixture-model", tools: TOOLS, toolDefinitions: TOOLS.map((name) => ({ name, description: fixtureText(seed + name.length, 80) })),
        attempts, startedAt: startedAt + agent * 60_000, ...(running ? {} : { durationMs: 45_000 + agent * 1_000 }),
        systemPrompt: fixtureText(seed * 7 + 1, options.systemPromptBytes), prompt: fixtureText(seed * 7 + 2, options.promptBytes),
        attemptDetails: Array.from({ length: attempts }, (_, index) => ({
          attempt: index + 1, transport: "local",
          session: { transport: "local", sessionId: `native-${String(seed)}-${String(index)}`, locator: { sessionFile: path } },
          setup: { cwd: fixture.cwd, hookNames: [], model, tools: TOOLS },
          ...(index + 1 < attempts ? { error: { code: "AGENT_FAILED", message: fixtureText(seed * 7 + 3 + index, options.attemptErrorBytes) } } : {}),
          accounting,
        })),
        accounting,
      });
    }
    const state = active ? "running" : run % 17 === 5 ? "failed" : "completed";
    const value = {
      id: runId(run), workflowName: `load-workflow-${String(run % 7)}`, cwd: fixture.cwd, sessionId: fixture.sessionId, state, agentSessions: [], agents,
      phase: "work", phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "work", afterAgent: 1 }],
      events: Array.from({ length: options.events }, (_, index) => ({ type: "log", message: fixtureText(run * 100 + index, 80), timestamp: startedAt + index * 1_000 })),
      usage: { tokens: 120_000 + run, costUsd: 1.5, durationMs: active ? 600_000 : 300_000 + run, agentLaunches: options.agentsPerRun },
    } as unknown as PersistedRun;
    const snapshot = createLaunchSnapshot({ script: fixtureText(run + 17, options.scriptBytes), args: null, metadata: { name: value.workflowName }, settings: { concurrency: 4 }, models: ["fixture/fixture-model"], tools: TOOLS, agentConfigurations: {}, schemas: [] });
    result.push({ run: value, snapshot });
  }
  return result;
}

function transcriptBody(run: number, agent: number, timingEntries: number): string {
  const lines = [JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: fixtureText(run * 31 + agent, 400) }] } })];
  for (let index = 0; index < timingEntries; index += 1) {
    const startedAt = BASE_TIME - run * 3_600_000 + agent * 60_000 + index * 2_000;
    lines.push(JSON.stringify({ type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: `call-${String(run)}-${String(agent)}-${String(index)}`, toolName: TOOLS[index % TOOLS.length], startedAt, completedAt: startedAt + 900, durationMs: 900, isError: false } }));
  }
  return `${lines.join("\n")}\n`;
}

export async function writeLoadFixture(root: string, index: number, options: LoadFixtureOptions = LOAD_FIXTURE_DEFAULTS): Promise<LoadFixture> {
  const fixture = loadFixtureDescriptor(root, index, options);
  await mkdir(fixture.cwd, { recursive: true });
  for (const [run, { run: value, snapshot }] of loadFixtureRuns(fixture).entries()) {
    await mkdir(join(fixture.root, "transcripts", fixture.sessionId, runId(run)), { recursive: true });
    for (let agent = 0; agent < options.agentsPerRun; agent += 1) await writeFile(transcriptPath(fixture, run, agent), transcriptBody(run, agent, options.timingEntries), "utf8");
    await new RunStore(fixture.cwd, fixture.sessionId, value.id, fixture.home).create(value, snapshot);
  }
  return fixture;
}

export type LoadPublisherOptions = { readonly now: () => number; readonly activity?: () => AgentActivity | undefined };
/** Publisher input over the real metadata loader, overlaid like the host: live budget usage on the active run and one agent's live activity. */
export function loadPublisherInput(fixture: LoadFixture, options: LoadPublisherOptions): TrajectoryPublisherInput {
  const budget = new WorkflowBudgetRuntime(undefined, 1, { tokens: 120_000, costUsd: 1.5, durationMs: 600_000, agentLaunches: fixture.options.agentsPerRun }, [], { now: options.now });
  const overlay = (run: PersistedRun): PersistedRun => {
    if (run.id !== fixture.activeRunId) return run;
    const activity = options.activity?.();
    const agents = activity === undefined ? run.agents : run.agents.map((agent) => agent.id === fixture.varyingAgentId ? { ...agent, activity } : agent);
    return { ...run, agents, state: "running", usage: trajectoryRunUsage("running", budget.usage, run.usage) };
  };
  const loadRunsMetadata = createTrajectoryRunMetadataLoader(fixture.cwd, fixture.sessionId, fixture.home, overlay);
  return { cwd: fixture.cwd, sessionId: fixture.sessionId, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: await loadRunsMetadata(), subagents: [] }), handleAction: async () => undefined };
}
