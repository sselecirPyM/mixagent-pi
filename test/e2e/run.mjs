// End-to-end check of the MixAgent pipeline inside a real pi process, using the scripted mock provider.
// Usage: node test/e2e/run.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const cli = join(root, "node_modules/@mariozechner/pi-coding-agent/dist/cli.js");

const work = mkdtempSync(join(tmpdir(), "mixagent-e2e-"));
const project = join(work, "project");
const agentDir = join(work, "agent");
const sessions = join(work, "sessions");
const log = join(work, "mock.log");
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(project, "src/greet.ts"), 'export function greet(name: string) {\n  return "hello " + name;\n}\n');
writeFileSync(
	join(agentDir, "mixagent.json"),
	JSON.stringify({
		scoutModel: "mock/scout",
		plannerModel: "mock/planner",
		executorModel: "mock/executor",
		planDir: join(work, "plans"),
	}),
);

const run = spawnSync(
	process.execPath,
	[
		cli,
		"--no-extensions",
		"-e",
		join(here, "mock-provider.ts"),
		"-e",
		join(root, "src/index.ts"),
		"--model",
		"mock/scout",
		"--session-dir",
		sessions,
		"-p",
		"Make the greeting friendlier",
	],
	{ cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MOCK_LOG: log }, encoding: "utf8", timeout: 120_000 },
);
console.log("--- pi stdout ---\n" + run.stdout);
if (run.stderr.trim()) console.log("--- pi stderr ---\n" + run.stderr);
assert.equal(run.status, 0, "pi exited with an error");

const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
console.log("--- model calls ---");
for (const c of calls) console.log(`${c.model.padEnd(9)} msgs=${c.messages} tools=[${c.tools.join(",")}]`);

const scout = calls.filter((c) => c.model === "scout");
const planner = calls.filter((c) => c.model === "planner");
const executor = calls.filter((c) => c.model === "executor");
assert.equal(scout.length, 3, "scout: exploration + handoff + (print mode only) relay of the report");
assert.ok(scout.every((c) => c.scoutPrompt), "scout gets scout instructions");
assert.deepEqual([...scout[0].tools].sort(), ["bash", "discard", "find", "grep", "handoff", "ls", "read"]);
assert.equal(planner.length, 1, "exactly one planner call");
assert.ok(planner[0].plannerPrompt && planner[0].tools.length === 0 && planner[0].messages === 1, "planner: one tool-less message");
assert.match(planner[0].firstUser, /Make the greeting friendlier/);
assert.match(planner[0].firstUser, /grep -rn greet src/, "scout tool call included");
assert.match(planner[0].firstUser, /return "hello " \+ name;/, "attached file included");
assert.equal(executor.length, 2, "executor: edit call + final report");
assert.ok(executor[0].executorPrompt && !executor[0].scoutPrompt, "executor runs with executor prompt only");
assert.equal(executor[0].messages, 1, "executor starts in a fresh session");
assert.ok(executor[0].tools.includes("edit") && !executor[0].tools.includes("handoff"));

const source = readFileSync(join(project, "src/greet.ts"), "utf8");
assert.match(source, /return `Hello, \$\{name\}!`;/, "executor applied the plan");
assert.equal(readdirSync(join(work, "plans")).length, 1, "plan markdown saved");

const sessionFiles = readdirSync(sessions).filter((f) => f.endsWith(".jsonl"));
const headers = sessionFiles.map((f) => JSON.parse(readFileSync(join(sessions, f), "utf8").split("\n")[0]));
assert.ok(headers.some((h) => h.parentSession), "executor session linked to parent session");

assert.match(run.stdout, /Executor done/, "print mode shows the executor report");
console.log(`\nprint-mode run OK\n--- final greet.ts ---\n${source}`);

// --- Second run: RPC mode, two prompts in one session -> finished scout cycle is pruned. ---
writeFileSync(log, "");
const rpc = spawn(
	process.execPath,
	[cli, "--no-extensions", "-e", join(here, "mock-provider.ts"), "-e", join(root, "src/index.ts"), "--model", "mock/scout", "--session-dir", sessions, "--mode", "rpc"],
	{ cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MOCK_LOG: log } },
);
let buffer = "";
const waiters = [];
rpc.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let nl;
	while ((nl = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, nl).replace(/\r$/, "");
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		const event = JSON.parse(line);
		const i = waiters.findIndex((w) => w.match(event));
		if (i >= 0) waiters.splice(i, 1)[0].resolve(event);
	}
});
const send = (message, match = (e) => e.type === "agent_end") =>
	Promise.race([
		new Promise((resolve) => {
			waiters.push({ match, resolve });
			rpc.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
		}),
		new Promise((_, rej) => setTimeout(() => rej(new Error(`rpc timeout: ${message}`)), 60_000)),
	]);
const notify = (re) => (e) => e.type === "extension_ui_request" && e.method === "notify" && re.test(e.message);
await send("First request");
await send("Second request");
await send("/mix off", notify(/MixAgent disabled/));
const callsBeforeOff = readFileSync(log, "utf8").trim().split("\n").length;
await send("Third request (mix off)");
const status = await send("/mix status", notify(/MixAgent: off/));
const modelList = await send("/mix model", notify(/Available models/));
const select = await send("/mix model planner", (e) => e.type === "extension_ui_request" && e.method === "select");
const picked = new Promise((resolve) => waiters.push({ match: notify(/MixAgent planner model/), resolve }));
rpc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: select.id, value: select.options.find((o) => o.startsWith("mock/planner")) })}\n`);
const pickedNotice = await picked;
rpc.kill();

const allRpcCalls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const rpcCalls = allRpcCalls.slice(0, callsBeforeOff);
const offCalls = allRpcCalls.slice(callsBeforeOff);
assert.ok(offCalls.length > 0 && offCalls.every((c) => !c.scoutPrompt && !c.tools.includes("handoff")), "/mix off restores normal pi");
assert.ok(!offCalls.some((c) => c.model === "planner"), "no planner call when mix is off");
console.log(`/mix off OK; status: ${JSON.stringify(status.message)}`);
assert.match(modelList.message, /mock\/planner · Mock planner {2}← planner/, "/mix model lists models and marks role assignments");
console.log(`/mix model OK: ${JSON.stringify(modelList.message)}`);
assert.ok(select.options.includes("mock/planner · Mock planner"), "/mix model <role> picker shows provider/id and name");
assert.match(pickedNotice.message, /MixAgent planner model: mock\/planner /, "picked label maps back to provider/id");
console.log(`/mix model planner OK: ${JSON.stringify(select.options)}`);
const scouts = rpcCalls.filter((c) => c.model === "scout");
assert.equal(scouts.length, 4, "two scout calls per cycle");
// Cycle 2 first call: [user, assistant(handoff), toolResult(handoff), user] — exploration of cycle 1 pruned.
assert.deepEqual(scouts[2].roles, ["user", "assistant", "toolResult", "user"], "finished cycle pruned");
assert.equal(rpcCalls.filter((c) => c.model === "planner").length, 2);
console.log(`rpc two-prompt run OK, cycle-2 scout context: [${scouts[2].roles.join(", ")}]`);

// --- Third run: the scout discards an irrelevant search result. ---
writeFileSync(log, "");
const noisy = spawnSync(
	process.execPath,
	[cli, "--no-extensions", "-e", join(here, "mock-provider.ts"), "-e", join(root, "src/index.ts"), "--model", "mock/scout", "--session-dir", sessions, "-p", "noisy: Make the greeting friendlier"],
	{ cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MOCK_LOG: log }, encoding: "utf8", timeout: 120_000 },
);
assert.equal(noisy.status, 0, `noisy run failed: ${noisy.stderr}`);
const noisyCalls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const noisyScout = noisyCalls.filter((c) => c.model === "scout");
assert.equal(noisyScout.length, 5, "scout: noise + discard + grep + handoff + relay");
assert.deepEqual(noisyScout[1].toolResults, ["bash:[#1]NOISE_OUTPUT\n"], "results are numbered while scouting");
assert.deepEqual(noisyScout[2].roles, ["user", "assistant", "toolResult"], "discard call not in context");
assert.deepEqual(noisyScout[2].toolResults, ["bash:[#1 discarded: noise]"], "discarded result replaced");
const noisyPlanner = noisyCalls.find((c) => c.model === "planner");
assert.ok(!noisyPlanner.firstUser.includes("```\nNOISE_OUTPUT"), "discarded output not packaged");
assert.match(noisyPlanner.firstUser, /echo NOISE_OUTPUT\n\n\[discarded by the scout as irrelevant: noise\]/);
assert.match(noisyPlanner.firstUser, /grep -rn greet src/);
console.log("discard run OK");

// --- Fourth run: an image read by the scout reaches the planner as an image block. ---
writeFileSync(log, "");
writeFileSync(join(project, "shot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const shot = spawnSync(
	process.execPath,
	[cli, "--no-extensions", "-e", join(here, "mock-provider.ts"), "-e", join(root, "src/index.ts"), "--model", "mock/scout", "--session-dir", sessions, "-p", "Match the screenshot in shot.png"],
	{ cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MOCK_LOG: log }, encoding: "utf8", timeout: 120_000 },
);
assert.equal(shot.status, 0, `image run failed: ${shot.stderr}`);
const shotPlanner = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((c) => c.model === "planner");
assert.equal(shotPlanner.messages, 1, "planner still gets a single message");
assert.equal(shotPlanner.images, 1, "planner sees the image");
assert.match(shotPlanner.firstUser, /read shot\.png[\s\S]*\[image 1\]/);
console.log("image run OK");

// --- Fifth run: lead planner splits -> 2 sub-planners -> join planner, which splits execution into tasks
// -> parallel executors + one join executor. ---
writeFileSync(log, "");
const fork = spawnSync(
	process.execPath,
	[cli, "--no-extensions", "-e", join(here, "mock-provider.ts"), "-e", join(root, "src/index.ts"), "--model", "mock/scout", "--session-dir", sessions, "-p", "fork: Add two files"],
	{ cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MOCK_LOG: log }, encoding: "utf8", timeout: 120_000 },
);
assert.equal(fork.status, 0, `fork run failed: ${fork.stderr}`);
const forkCalls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const forkExec = forkCalls.filter((c) => c.model === "executor");
const forkPlanner = forkCalls.filter((c) => c.model === "planner");
assert.equal(forkPlanner.length, 4, "lead + 2 sub-planners + join");
assert.ok(forkPlanner.every((c) => c.plannerPrompt && c.tools.length === 0 && c.messages === 1), "every planner call: one tool-less message");
assert.equal(new Set(forkPlanner.map((c) => c.systemPrompt)).size, 1, "same system prompt for every planner call (prompt cache)");
assert.ok(forkPlanner.every((c) => c.firstUser.includes("fork: Add two files")), "every planner call gets the package");
assert.deepEqual(
	forkPlanner.slice(1, 3).map((c) => c.lastUser.match(/subtask (S\d)/)?.[1]).sort(),
	["S1", "S2"],
	"one sub-planner per subtask",
);
assert.match(forkPlanner[3].lastUser, /BEGIN plan S1[\s\S]*BEGIN plan S2/, "join planner sees both sub-plans");
assert.ok(forkExec.some((c) => c.firstUser.includes("## Task T1") && c.firstUser.includes("— create (S1)\n````text\nT1\n````")), "S1's file section used as written");
assert.ok(forkExec.some((c) => c.firstUser.includes("## Task T2") && c.firstUser.includes("Revisions by the join planner") && c.firstUser.includes('exactly "T2"')), "join revision note follows S2's section");
assert.equal(forkExec.length, 6, "two task executors + one join executor, two calls each");
assert.equal(forkExec.filter((c) => c.messages === 1).length, 3, "three fresh executor sessions");
assert.ok(forkExec.some((c) => c.firstUser.includes("## Task T1") && !c.firstUser.includes("src/T2.txt")), "task sub-plan holds only its own files");
assert.ok(forkExec.some((c) => c.firstUser.includes("## Already applied") && c.firstUser.includes("echo joined")), "join executor runs the commands");
assert.equal(readFileSync(join(project, "src/T1.txt"), "utf8"), "T1");
assert.equal(readFileSync(join(project, "src/T2.txt"), "utf8"), "T2");
console.log("fork-join run OK");

// --- Sixth run: fork-join with failing subtasks. Sub-planner S2 answers empty once and task executor T2 errors
// once; each is retried and the run completes. ---
writeFileSync(log, "");
rmSync(join(project, "src/T1.txt"));
rmSync(join(project, "src/T2.txt"));
const flaky = spawnSync(
	process.execPath,
	[cli, "--no-extensions", "-e", join(here, "mock-provider.ts"), "-e", join(root, "src/index.ts"), "--model", "mock/scout", "--session-dir", sessions, "-p", "fork: flaky: Add two files"],
	{ cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MOCK_LOG: log }, encoding: "utf8", timeout: 120_000 },
);
assert.equal(flaky.status, 0, `flaky run failed: ${flaky.stderr}`);
const flakyCalls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const flakyPlanner = flakyCalls.filter((c) => c.model === "planner");
const flakyExec = flakyCalls.filter((c) => c.model === "executor");
assert.equal(flakyPlanner.length, 5, "lead + 2 sub-planners + 1 retry of S2 + join");
assert.equal(flakyPlanner.filter((c) => /subtask S2/.test(c.lastUser)).length, 2, "S2 retried once after an empty response");
const t2 = flakyExec.filter((c) => c.messages === 1 && c.firstUser.includes("## Task T2"));
assert.equal(t2.length, 2, "T2 executor retried once in a fresh session");
assert.match(t2[1].firstUser, /a previous attempt at this task failed \(mock executor failure\)/, "retry kickoff names the previous error");
assert.ok(flakyExec.some((c) => c.firstUser.includes("## Already applied")), "join executor runs after the retried task succeeds");
assert.equal(readFileSync(join(project, "src/T1.txt"), "utf8"), "T1");
assert.equal(readFileSync(join(project, "src/T2.txt"), "utf8"), "T2");
console.log("retry run OK");

console.log(`\nE2E OK (${work})`);
