import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
// `theme` is not re-exported from the package root; import the same module instance by path.
import { theme } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import mixagent from "../src/index.ts";

initTheme("dark");

let tool: any;
const pi: any = new Proxy({}, { get: (_t, key) => (key === "registerTool" ? (t: any) => { if (t.name === "handoff") tool = t; } : () => undefined) });
mixagent(pi);

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const render = (details: unknown, opts: { expanded: boolean; isPartial: boolean }) =>
	strip(tool.renderResult({ content: [{ type: "text", text: "fallback" }], details }, opts, theme, {}).render(80).join("\n"));

const usage = { input: 5000, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 5400, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.105 } };
const plan = "## Summary\nFriendlier greeting.\n\n## Changes\n\n### `src/greet.ts` — edit\n\n````text\n<<<<<<< SEARCH\n  return \"hello \" + name;\n=======\n  return `Hello, ${name}!`;\n>>>>>>> REPLACE\n````\n";
const done = {
	mixagent: "done",
	stage: "done",
	request: "Make the greeting friendlier\nand add a test",
	plannerModel: "anthropic/claude-opus-4-7",
	executorModel: "anthropic/claude-haiku-4-5",
	packageChars: 12000,
	plan,
	planPath: "/x/plan.md",
	planner: { usage, stopReason: "stop" },
	executor: {
		toolCalls: [{ id: "1", label: "edit {\"path\":\"src/greet.ts\"}", done: true, isError: false }],
		text: "",
		usage: { input: 3000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.004, turns: 2 },
		output: "**Done.** Updated `src/greet.ts`.",
		sessionFile: "/s/e.jsonl",
		stopReason: "stop",
	},
};

test("collapsed result shows planner/executor lines and the report, not the plan", () => {
	const out = render(done, { expanded: false, isPartial: false });
	assert.match(out, /claude-opus-4-7 plan · 1 file change\(s\)/);
	assert.match(out, /claude-haiku-4-5 executed/);
	assert.match(out, /Done\. Updated src\/greet\.ts/);
	assert.ok(!out.includes("SEARCH"));
	assert.match(out, /prompt: Make the greeting friendlier …/);
	assert.ok(!out.includes("and add a test"));
});

test("expanded result includes the full plan", () => {
	const out = render(done, { expanded: true, isPartial: false });
	assert.match(out, /<<<<<<< SEARCH/);
	assert.match(out, /prompt:/);
	assert.match(out, /and add a test/);
	assert.match(out, /saved: \/x\/plan\.md/);
	assert.match(out, /executor session: \/s\/e\.jsonl/);
});

test("partial planning and error states render", () => {
	const planning = render({ ...done, stage: "planning", planner: undefined, executor: undefined, plan: "## Summ" }, { expanded: false, isPartial: true });
	assert.match(planning, /planning…/);
	const error = render({ mixagent: "error", stage: "done", error: "planner call failed: boom" }, { expanded: false, isPartial: false });
	assert.match(error, /✗ planner call failed: boom/);
});

test("renderCall shows file count", () => {
	const out = strip(tool.renderCall({ notes: "n", files: ["a", "b"] }, theme, {}).render(80).join("\n"));
	assert.match(out, /handoff scout → planner → executor · 2 file\(s\)/);
});

test("fork-join planning shows the lead split, one line per sub-planner and the join", () => {
	const subPlans = [
		{ id: "S1", goal: "first part", files: ["a.ts"], state: "done", text: "## Summary\nS1", result: { usage, stopReason: "stop" } },
		{ id: "S2", goal: "second part", files: ["b.ts"], state: "running", text: "## Sum" },
	];
	const running = render({ ...done, stage: "subplanning", leadPlan: "## Subtasks", subPlans, plan: undefined, executor: undefined }, { expanded: false, isPartial: true });
	assert.match(running, /claude-opus-4-7 split into 2 subtask\(s\)/);
	assert.match(running, /S1 planned .*· first part/);
	assert.match(running, /S2 planning… 6 chars out/);
	const joining = render({ ...done, stage: "joining", leadPlan: "## Subtasks", subPlans, plan: "## Summary", executor: undefined }, { expanded: false, isPartial: true });
	assert.match(joining, /joining… 10 chars out/);
	const finished = render(
		{ ...done, leadPlan: "## Subtasks", subPlans: [subPlans[0], { ...subPlans[1], state: "done", result: { usage, stopReason: "stop" } }], join: { usage, stopReason: "stop" } },
		{ expanded: false, isPartial: false },
	);
	assert.match(finished, /claude-opus-4-7 join · 1 file change\(s\)/);
	assert.match(finished, /claude-haiku-4-5 executed/);
});
