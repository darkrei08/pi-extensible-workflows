// Bench for Trajectory server and publisher load on one identical synthetic fixture: an idle-running run beside
// completed history, published by real Trajectory controllers to a server child, watched by raw fast, slow, and
// hidden viewers. Reports per-scenario CPU, process I/O, bytes, messages, JSON encode counts, and backpressure.
// Every process gets a fresh temp HOME, PI_CODING_AGENT_DIR, and TMPDIR, and the server a random port.
// Run after `npm run build --workspace=packages/core` with: node packages/core/bench/trajectory-load.mjs
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const RESERVED_PORT = 8190;
const LARGE_JSON_CHARS = 64 * 1024;
const HERDR_VARIABLES = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];
const role = process.argv[2] ?? "bench";
const argument = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function procIo() {
  try {
    const entries = readFileSync("/proc/self/io", "utf8").split("\n");
    const value = (key) => Number(entries.find((line) => line.startsWith(`${key}:`))?.split(":")[1] ?? 0);
    return { rchar: value("rchar"), wchar: value("wchar"), readBytes: value("read_bytes"), writeBytes: value("write_bytes") };
  } catch { return { rchar: 0, wchar: 0, readBytes: 0, writeBytes: 0 }; }
}

/** Counts JSON work in this process; large stringify calls are whole-state or whole-publisher encodes. */
function countJson() {
  const counts = { stringify: { calls: 0, chars: 0, large: 0 }, parse: { calls: 0, chars: 0 } };
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  JSON.stringify = function (...args) {
    const result = Reflect.apply(stringify, JSON, args);
    counts.stringify.calls += 1;
    if (typeof result === "string") { counts.stringify.chars += result.length; if (result.length >= LARGE_JSON_CHARS) counts.stringify.large += 1; }
    return result;
  };
  JSON.parse = function (...args) {
    counts.parse.calls += 1;
    if (typeof args[0] === "string") counts.parse.chars += args[0].length;
    return Reflect.apply(parse, JSON, args);
  };
  return counts;
}

function serveSnapshots(snapshot, close) {
  process.on("message", (message) => {
    if (message?.type === "snapshot") process.send({ type: "snapshot", value: { cpu: process.cpuUsage(), io: procIo(), ...snapshot() } });
    if (message?.type === "close") void close().finally(() => { process.exit(0); });
  });
}

function assertPort(port) {
  if (!Number.isSafeInteger(port) || port <= 0 || port === RESERVED_PORT) throw new Error(`Refusing Trajectory bench port ${String(port)}`);
}

async function runServer() {
  const port = Number(argument("--port"));
  const lockPath = argument("--lock");
  assertPort(port);
  const json = countJson();
  const { createTrajectoryServer } = await import("../dist/trajectory/src/server.js");
  // The fingerprint is the one a controller computes, so publishers reuse this server instead of spawning one.
  const serverPath = fileURLToPath(new URL("../dist/trajectory/src/server.js", import.meta.url));
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const fingerprint = `${hash(serverPath)}:${hash(join(dirname(serverPath), "assets/index.html"))}`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const server = createTrajectoryServer(port, lockPath, { fingerprint });
  const sockets = [];
  server.on("upgrade", (_request, socket) => {
    const stats = { remotePort: socket.remotePort, writes: 0, bytesWritten: 0, writeFalse: 0, drains: 0, bytesRead: 0 };
    sockets.push(stats);
    const write = socket.write;
    socket.write = function (chunk, ...rest) {
      const accepted = Reflect.apply(write, socket, [chunk, ...rest]);
      stats.writes += 1;
      stats.bytesWritten += chunk.length;
      if (!accepted) stats.writeFalse += 1;
      return accepted;
    };
    socket.on("drain", () => { stats.drains += 1; });
    socket.on("data", (chunk) => { stats.bytesRead += chunk.length; });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  // Live memory after a full collection, so retained encodings are not hidden by garbage awaiting collection.
  serveSnapshots(() => { globalThis.gc?.(); return { json, sockets, memory: process.memoryUsage() }; }, async () => { server.closeAllConnections(); server.close(); });
  process.send({ type: "ready" });
}

async function runPublishers() {
  const port = Number(argument("--port"));
  const agentDir = argument("--agent-dir");
  const root = argument("--root");
  const fixtures = JSON.parse(argument("--fixtures"));
  const varyIndex = Number(argument("--vary"));
  assertPort(port);
  const json = countJson();
  const { createTrajectoryController } = await import("../dist/trajectory/src/index.js");
  const { loadFixtureDescriptor, loadPublisherInput } = await import("../dist/trajectory/test/load-fixture.js");
  const sends = { states: 0, stateBytes: 0, other: 0, loadMetadata: 0 };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string" && data.startsWith("{\"type\":\"publisher:state\"")) { sends.states += 1; sends.stateBytes += Buffer.byteLength(data); }
    else sends.other += 1;
    return Reflect.apply(send, this, [data]);
  };
  const controllers = [];
  for (const { index, options } of fixtures) {
    let step = 0;
    const input = loadPublisherInput(loadFixtureDescriptor(root, index, options), { now: Date.now, ...(index === varyIndex ? { activity: () => ({ kind: "tool", text: `step ${String(step++)}` }) } : {}) });
    const loadMetadata = input.loadMetadata;
    const controller = createTrajectoryController(agentDir);
    controllers.push(controller);
    await controller.open({ ...input, port, loadMetadata: () => { sends.loadMetadata += 1; return loadMetadata(); } });
  }
  serveSnapshots(() => ({ json, sends }), async () => { await Promise.all(controllers.map((controller) => controller.close())); });
  process.send({ type: "ready" });
}

function maskedFrame(value) {
  const data = Buffer.from(value);
  const mask = Buffer.from([11, 29, 47, 61]);
  let header;
  if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  for (let index = 0; index < data.length; index += 1) data[index] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return Buffer.concat([header, mask, data]);
}

/** A raw browser: fast reads everything, slow reads at a fixed byte rate, hidden reports itself hidden like a background tab. */
async function connectViewer(port, kind, focus, slowBytesPerSecond) {
  const socket = await new Promise((resolve, reject) => {
    const candidate = createConnection(port, "127.0.0.1");
    let response = "";
    const onData = (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      candidate.off("data", onData);
      if (!response.startsWith("HTTP/1.1 101")) { candidate.destroy(); reject(new Error("Trajectory WebSocket handshake failed")); return; }
      resolve(candidate);
    };
    candidate.on("data", onData);
    candidate.once("error", reject);
    candidate.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${String(port)}\r\n\r\n`);
  });
  const stats = { kind, localPort: socket.localPort, frames: 0, stateFrames: 0, bytes: 0, parseMs: 0 };
  let buffer = Buffer.alloc(1 << 16);
  let length = 0;
  let slot = 0;
  const throttle = kind === "slow" ? setInterval(() => { slot = 0; socket.resume(); }, 100) : undefined;
  socket.on("data", (chunk) => {
    if (length + chunk.length > buffer.length) { const grown = Buffer.allocUnsafe(Math.max(buffer.length * 2, length + chunk.length)); buffer.copy(grown, 0, 0, length); buffer = grown; }
    length += chunk.copy(buffer, length);
    let start = 0;
    while (length - start >= 2) {
      let offset = start + 2;
      let size = (buffer[start + 1] ?? 0) & 0x7f;
      if (size === 126) { if (length - start < 4) break; size = buffer.readUInt16BE(start + 2); offset = start + 4; }
      else if (size === 127) { if (length - start < 10) break; size = Number(buffer.readBigUInt64BE(start + 2)); offset = start + 10; }
      if (length < offset + size) break;
      const payload = buffer.toString("utf8", offset, offset + size);
      start = offset + size;
      stats.frames += 1;
      stats.bytes += size;
      const parsedAt = performance.now();
      const value = JSON.parse(payload);
      stats.parseMs += performance.now() - parsedAt;
      if (value?.type === "state") stats.stateFrames += 1;
    }
    if (start > 0) { buffer.copy(buffer, 0, start, length); length -= start; }
    if (throttle !== undefined) { slot += chunk.length; if (slot >= slowBytesPerSecond / 10) socket.pause(); }
  });
  socket.on("error", () => undefined);
  socket.write(maskedFrame(JSON.stringify({ type: "ui:attach", visible: kind !== "hidden" })));
  socket.write(maskedFrame(JSON.stringify({ type: "ui:focus", ...(kind === "hidden" ? { publisherId: null, runId: null } : focus), visible: kind !== "hidden" })));
  return { stats, close() { if (throttle !== undefined) clearInterval(throttle); socket.destroy(); } };
}

async function availablePort() {
  for (;;) {
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    if (port !== RESERVED_PORT) return port;
  }
}

function startChild(args, env) {
  const child = fork(fileURLToPath(import.meta.url), args, { env, execArgv: [...process.execArgv, "--expose-gc"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const exited = new Promise((resolve) => { child.once("exit", resolve); });
  const next = (type, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off("message", onMessage); reject(new Error(`Timed out waiting for ${type} from ${args[0]}`)); }, timeoutMs);
    const onMessage = (message) => { if (message?.type !== type) return; clearTimeout(timer); child.off("message", onMessage); resolve(message.value); };
    child.on("message", onMessage);
    exited.then(() => { clearTimeout(timer); reject(new Error(`${args[0]} exited before ${type}`)); }, () => undefined);
  });
  return {
    ready: next("ready", 120_000),
    snapshot() { const value = next("snapshot", 30_000); child.send({ type: "snapshot" }); return value; },
    async close() { if (child.exitCode === null && child.connected) child.send({ type: "close" }); const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000); await exited; clearTimeout(timer); },
  };
}

/** Subtracts numeric leaves; arrays line up by index because no socket opens inside a measured window. */
function delta(before, after) {
  if (typeof after === "number") return after - (typeof before === "number" ? before : 0);
  if (Array.isArray(after)) return after.map((value, index) => delta(before?.[index], value));
  if (after && typeof after === "object") return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, delta(before?.[key], value)]));
  return after;
}

const SCENARIOS = {
  "clock-1pub-1fast": { publishers: 1, vary: false, viewers: ["fast"] },
  "vary-1pub-1fast": { publishers: 1, vary: true, viewers: ["fast"] },
  "vary-1pub-2fast": { publishers: 1, vary: true, viewers: ["fast", "fast"] },
  "vary-3pub-1fast": { publishers: 3, vary: true, viewers: ["fast"] },
  "vary-3pub-2fast": { publishers: 3, vary: true, viewers: ["fast", "fast"] },
  // A publisher other than the focused one changes, so every update leaves the focused publisher unchanged.
  "vary-other-3pub-2fast": { publishers: 3, vary: true, varyIndex: 1, viewers: ["fast", "fast"] },
  "vary-1pub-hidden": { publishers: 1, vary: true, viewers: ["hidden"] },
  "vary-1pub-fast-hidden": { publishers: 1, vary: true, viewers: ["fast", "hidden"] },
  "clock-3pub-2fast": { publishers: 3, vary: false, viewers: ["fast", "fast"] },
  "clock-1pub-fast-slow": { publishers: 1, vary: false, viewers: ["fast", "slow"] },
  "clock-1pub-hidden": { publishers: 1, vary: false, viewers: ["hidden"] },
  "clock-1pub-none": { publishers: 1, vary: false, viewers: [] },
};

async function runBench() {
  const seconds = Number(process.env.BENCH_SECONDS ?? 10);
  const warmupMs = Number(process.env.BENCH_WARMUP_MS ?? 3_000);
  const slowBytesPerSecond = Number(process.env.BENCH_SLOW_BPS ?? 2 * 1024 * 1024);
  const names = process.env.BENCH_SCENARIOS?.split(",") ?? Object.keys(SCENARIOS);
  const root = mkdtempSync(join(tmpdir(), "pi-workflows-traj-load-"));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !HERDR_VARIABLES.includes(name))), HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), TMPDIR: join(root, "tmp") };
  mkdirSync(env.TMPDIR, { recursive: true });
  const children = [];
  const viewers = [];
  try {
    const { LOAD_FIXTURE_DEFAULTS, writeLoadFixture } = await import("../dist/trajectory/test/load-fixture.js");
    const fixtureRoot = join(root, "fixture");
    const fixtureOptions = [{ ...LOAD_FIXTURE_DEFAULTS, runs: Number(process.env.BENCH_RUNS ?? LOAD_FIXTURE_DEFAULTS.runs) }, { ...LOAD_FIXTURE_DEFAULTS, runs: Number(process.env.BENCH_SMALL_RUNS ?? 34) }, { ...LOAD_FIXTURE_DEFAULTS, runs: Number(process.env.BENCH_SMALL_RUNS ?? 34) }];
    const fixtures = [];
    for (const [index, options] of fixtureOptions.entries()) fixtures.push(await writeLoadFixture(fixtureRoot, index, options));
    const primary = fixtures[0];
    const focus = { publisherId: createHash("sha256").update(`${primary.cwd}\n${primary.sessionId}`).digest("hex").slice(0, 16), runId: primary.activeRunId };
    const results = [];
    for (const name of names) {
      const scenario = SCENARIOS[name];
      if (!scenario) throw new Error(`Unknown scenario ${name}`);
      const port = await availablePort();
      const agentDir = join(root, `agent-${name}`);
      const server = startChild(["server", "--port", String(port), "--lock", join(agentDir, "pi-extensible-workflows", "trajectory.lock")], env);
      children.push(server);
      await server.ready;
      const publishers = startChild(["publishers", "--port", String(port), "--agent-dir", agentDir, "--root", fixtureRoot, "--vary", scenario.vary ? String(scenario.varyIndex ?? 0) : "-1", "--fixtures", JSON.stringify(fixtureOptions.slice(0, scenario.publishers).map((options, index) => ({ index, options })))], env);
      children.push(publishers);
      await publishers.ready;
      const scenarioViewers = [];
      for (const kind of scenario.viewers) scenarioViewers.push(await connectViewer(port, kind, focus, slowBytesPerSecond));
      viewers.push(...scenarioViewers);
      await delay(warmupMs);
      const before = { server: await server.snapshot(), publishers: await publishers.snapshot(), viewers: scenarioViewers.map(({ stats }) => ({ ...stats })) };
      const startedAt = performance.now();
      await delay(seconds * 1_000);
      const after = { server: await server.snapshot(), publishers: await publishers.snapshot(), viewers: scenarioViewers.map(({ stats }) => ({ ...stats })) };
      const windowMs = performance.now() - startedAt;
      const measured = delta(before, after);
      const viewerPorts = new Map(after.viewers.map((stats, index) => [stats.localPort, scenario.viewers[index]]));
      const updates = measured.publishers.sends.states;
      // Poll timers slip on a loaded host, so per-update CPU compares runs better than the rate alone.
      const cpu = (usage) => ({ userMs: Math.round(usage.user / 1_000), systemMs: Math.round(usage.system / 1_000), percentOfCore: Number(((usage.user + usage.system) / 10 / windowMs).toFixed(1)), msPerPublisherUpdate: updates ? Number(((usage.user + usage.system) / 1_000 / updates).toFixed(1)) : null });
      results.push({
        scenario: name, windowMs: Math.round(windowMs), publishers: scenario.publishers,
        publisher: { cpu: cpu(measured.publishers.cpu), io: measured.publishers.io, loadMetadataCalls: measured.publishers.sends.loadMetadata, stateSends: updates, stateBytes: measured.publishers.sends.stateBytes, otherSends: measured.publishers.sends.other, json: measured.publishers.json },
        server: {
          cpu: cpu(measured.server.cpu), io: measured.server.io, json: measured.server.json, memoryMiB: Object.fromEntries(Object.entries(after.server.memory).map(([key, bytes]) => [key, Number((bytes / 1048576).toFixed(1))])),
          largeStringifyPerPublisherUpdate: updates ? Number((measured.server.json.stringify.large / updates).toFixed(2)) : null,
          publisherBytesReceived: measured.server.sockets.filter((_, index) => !viewerPorts.has(after.server.sockets[index]?.remotePort)).reduce((total, stats) => total + stats.bytesRead, 0),
          viewerWrites: measured.server.sockets.flatMap((stats, index) => { const kind = viewerPorts.get(after.server.sockets[index]?.remotePort); return kind === undefined ? [] : [{ kind, writes: stats.writes, bytes: stats.bytesWritten, writeFalse: stats.writeFalse, drains: stats.drains }]; }),
        },
        viewers: measured.viewers.map((stats, index) => ({ kind: scenario.viewers[index], frames: stats.frames, stateFrames: stats.stateFrames, bytes: stats.bytes, parseMs: Math.round(stats.parseMs) })),
      });
      for (const viewer of scenarioViewers) viewer.close();
      await publishers.close();
      await server.close();
    }
    console.log(JSON.stringify({ config: { seconds, warmupMs, slowBytesPerSecond, fixtureRuns: fixtureOptions.map((options) => options.runs), node: process.version }, results }, null, 2));
  } finally {
    for (const viewer of viewers) viewer.close();
    for (const child of children) await child.close();
    if (process.env.BENCH_KEEP !== "1") rmSync(root, { recursive: true, force: true });
  }
}

if (role === "server") await runServer();
else if (role === "publishers") await runPublishers();
else await runBench();
