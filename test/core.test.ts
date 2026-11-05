import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assembleJoinPlan,
	countPlanChanges,
	parseNeedContext,
	parseSubtasks,
	plannerContent,
	splitPlan,
} from "../src/planner.ts";
import { findWriteReason } from "../src/safety.ts";
import {
	applyDiscards,
	buildPlannerPackage,
	currentCycleStart,
	extractCycle,
	labelCycleSteps,
	type Msg,
	pruneFinishedCycles,
	resolveDiscard,
} from "../src/transcript.ts";

const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
const call = (id: string, name: string, args: Record<string, any>, stopReason = "toolUse"): Msg => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	stopReason,
});
const result = (id: string, toolName: string, text: string, details?: any): Msg => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	content: [{ type: "text", text }],
	isError: false,
	details,
});
const answer = (text: string): Msg => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });

const finishedCycle: Msg[] = [
	user("rename foo to bar"),
	call("a", "bash", { command: "rg -n foo src" }),
	result("a", "bash", "src/x.ts:1:foo()"),
	call("b", "read", { path: "src/x.ts" }),
	result("b", "read", "export function foo() {}"),
	call("h", "handoff", { notes: "foo in x.ts", files: ["src/x.ts"] }),
	result("h", "handoff", "Plan applied", { mixagent: "done" }),
];

test("extractCycle collects only the current cycle", () => {
	const msgs = [...finishedCycle, user("now add a test"), call("c", "find", { pattern: "*.test.ts" }), result("c", "find", "test/x.test.ts")];
	assert.equal(currentCycleStart(msgs), finishedCycle.length);
	const cycle = extractCycle(msgs);
	assert.deepEqual(cycle.requests, ["now add a test"]);
	assert.equal(cycle.steps.length, 1);
	assert.equal(cycle.steps[0].toolName, "find");
});

test("extractCycle starts after a plain assistant answer", () => {
	const msgs = [user("hi"), answer("hello"), user("fix bug"), call("a", "ls", {}), result("a", "ls", "src")];
	assert.deepEqual(extractCycle(msgs).requests, ["fix bug"]);
});

test("extractCycle records planner need-context rounds", () => {
	const msgs = [
		user("do x"),
		call("h1", "handoff", { notes: "n" }),
		result("h1", "handoff", "need Y", { mixagent: "need_context" }),
		call("a", "read", { path: "y.ts" }),
		result("a", "read", "y"),
	];
	const cycle = extractCycle(msgs);
	assert.deepEqual(cycle.plannerRequests, ["need Y"]);
	assert.equal(cycle.steps.length, 1);
});

test("package dedupes repeated calls and reads of attached files", () => {
	const cycle = extractCycle([
		user("task"),
		call("a", "bash", { command: "rg foo" }),
		result("a", "bash", "old"),
		call("b", "bash", { command: "rg foo" }),
		result("b", "bash", "new"),
		call("c", "read", { path: "./src/x.ts" }),
		result("c", "read", "READ_CONTENT"),
	]);
	const pkg = buildPlannerPackage({
		cycle,
		notes: "notes here",
		files: [{ path: "src/x.ts", content: "FULL_FILE" }],
		cwd: "/repo",
		maxToolOutputChars: 1000,
		maxFileChars: 1000,
		maxPackageChars: 100_000,
		maxImages: 0,
	}).text;
	assert.match(pkg, /# User request\n\ntask/);
	assert.match(pkg, /notes here/);
	assert.ok(!pkg.includes("old"), "older duplicate call removed");
	assert.ok(pkg.includes("new"));
	assert.ok(!pkg.includes("READ_CONTENT"), "read of attached file removed");
	assert.match(pkg, /```ts\nFULL_FILE\n```/);
});

test("package keeps reads that reach into the lines cut from a truncated key file", () => {
	// 100 lines of 10 chars; maxFileChars 300 keeps the first 210 and the last 90 chars, so lines 22-91 are cut.
	const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i + 1).padStart(4, "0")}`);
	const range = (from: number, to: number) => lines.slice(from - 1, to).join("\n");
	const read = (id: string, args: Record<string, any>, output: string): Msg[] => [
		call(id, "read", { path: "src/a.ts", ...args }),
		result(id, "read", output),
	];
	const cycle = extractCycle([
		user("task"),
		...read("a", { offset: 1, limit: 21 }, `${range(1, 21)}\n\n[79 more lines in file. Use offset=22 to continue.]`),
		...read("b", { offset: 50, limit: 5 }, range(50, 54)),
		...read("c", {}, `${range(1, 10)}\n\n[Showing lines 1-10 of 100. Use offset=11 to continue.]`),
		...read("d", { offset: 88, limit: 10 }, range(88, 97)),
		...read("e", { offset: 92 }, range(92, 100)),
	]);
	const pkg = buildPlannerPackage({
		cycle,
		notes: "",
		files: [{ path: "src/a.ts", content: lines.join("\n") }],
		cwd: "/repo",
		maxToolOutputChars: 1e4,
		maxFileChars: 300,
		maxPackageChars: 1e5,
		maxImages: 0,
	}).text;
	assert.match(pkg, /line 0021\n\n… \[699 chars omitted\] …\n\nline 0092/, "key file keeps lines 1-21 and 92-100");
	const kept = [...pkg.matchAll(/^## \d+\. (.+)$/gm)].map((m) => m[1]);
	assert.deepEqual(kept, ["read src/a.ts (offset 50, limit 5)", "read src/a.ts (offset 88, limit 10)"]);
});

test("package fences survive content containing backticks", () => {
	const cycle = extractCycle([user("t"), call("a", "bash", { command: "cat r.md" }), result("a", "bash", "```js\nx\n```")]);
	const pkg = buildPlannerPackage({ cycle, notes: "", files: [], cwd: "/", maxToolOutputChars: 1e4, maxFileChars: 1e4, maxPackageChars: 1e5, maxImages: 0 }).text;
	assert.match(pkg, /````\n```js\nx\n```\n````/);
});

test("pruneFinishedCycles drops scout exploration but keeps handoff", () => {
	const msgs = [...finishedCycle, user("next"), call("c", "ls", {}), result("c", "ls", "src")];
	const pruned = pruneFinishedCycles(msgs);
	const toolNames = pruned.filter((m) => m.role === "toolResult").map((m) => m.toolName);
	assert.deepEqual(toolNames, ["handoff", "ls"], "current cycle untouched");
	assert.equal(pruned.length, msgs.length - 4);
});

test("pruneFinishedCycles leaves non-mix runs alone", () => {
	const msgs = [user("q"), call("a", "read", { path: "x" }), result("a", "read", "x"), answer("done")];
	assert.equal(pruneFinishedCycles(msgs), msgs);
});

const discardCycle = (): Msg[] => {
	const msgs: Msg[] = [
		user("fix the parser"),
		call("a", "grep", { pattern: "parse" }),
		result("a", "grep", "node_modules/x/parse.js:1: NOISE"),
		call("b", "read", { path: "src/parser.ts" }),
		result("b", "read", "export function parse() {}"),
	];
	const { discarded } = resolveDiscard(msgs, [1]);
	return [
		...msgs,
		{ role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "toolCall", id: "d", name: "discard", arguments: { ids: [1] } }], stopReason: "toolUse" },
		result("d", "discard", "Discarded #1.", { discarded, reason: "vendored code" }),
	];
};

test("labelCycleSteps numbers the current cycle's tool results", () => {
	const msgs = [...finishedCycle, user("next"), call("c", "ls", {}), result("c", "ls", "src")];
	const labeled = labelCycleSteps(msgs);
	assert.equal(labeled.slice(0, finishedCycle.length).every((m, i) => m === msgs[i]), true, "finished cycle untouched");
	assert.deepEqual(labeled[labeled.length - 1].content[0], { type: "text", text: "[#1]" });
});

test("resolveDiscard rejects unknown and unfinished steps", () => {
	const msgs = [user("x"), call("a", "ls", {}), result("a", "ls", "src"), call("b", "ls", { path: "src" })];
	assert.deepEqual(resolveDiscard(msgs, [1, 2, 3]), { discarded: [{ toolCallId: "a", ref: 1 }], invalid: [2, 3] });
});

test("applyDiscards replaces discarded results and removes the discard call", () => {
	const msgs = discardCycle();
	const out = applyDiscards(labelCycleSteps(msgs));
	assert.equal(out.length, msgs.length - 2, "discard call and result removed");
	assert.ok(!out.some((m) => m.role === "toolResult" && m.toolName === "discard"));
	assert.deepEqual(out[2].content, [{ type: "text", text: "[#1 discarded: vendored code]" }]);
	assert.equal(out[4].content[0].text, "[#2]", "kept result still labeled");
	assert.equal(applyDiscards(finishedCycle), finishedCycle, "no discards: unchanged");
});

test("package replaces discarded steps with a note", () => {
	const cycle = extractCycle(discardCycle());
	assert.equal(cycle.steps.length, 2);
	const pkg = buildPlannerPackage({ cycle, notes: "", files: [], cwd: "/", maxToolOutputChars: 1e4, maxFileChars: 1e4, maxPackageChars: 1e5, maxImages: 0 }).text;
	assert.ok(!pkg.includes("NOISE"), "discarded output dropped");
	assert.match(pkg, /grep "parse"\n\n\[discarded by the scout as irrelevant: vendored code\]/);
	assert.match(pkg, /export function parse/);
	assert.ok(!pkg.includes("Discarded #1"), "discard call not packaged");
});

const img = (data: string) => ({ type: "image", data, mimeType: "image/png" });
const imageCycle = () =>
	extractCycle([
		{ role: "user", content: [{ type: "text", text: "match this mockup" }, img("USER_IMG")] },
		call("a", "read", { path: "shot.png" }),
		{ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, img("READ_IMG")], isError: false },
	]);
const pack = (cycle: ReturnType<typeof extractCycle>, maxImages: number, files: any[] = []) =>
	buildPlannerPackage({ cycle, notes: "", files, cwd: "/", maxToolOutputChars: 1e4, maxFileChars: 1e4, maxPackageChars: 1e5, maxImages });

test("package attaches user, read and key-file images in reference order", () => {
	const pkg = pack(imageCycle(), 10, [{ path: "logo.png", image: img("FILE_IMG") }]);
	assert.deepEqual(pkg.images.map((i) => i.data), ["USER_IMG", "READ_IMG", "FILE_IMG"]);
	assert.deepEqual(pkg.images.map((i) => i.label), ["attached by the user", "step 1: read shot.png", "key file logo.png"]);
	assert.match(pkg.text, /## Images attached by the user\n\n\[image 1\]/);
	assert.match(pkg.text, /Read image file \[image\/png\]\n```\n\n\[image 2\]/);
	assert.match(pkg.text, /## `logo.png`\n\n\[image 3\]/);
	assert.ok(!pkg.text.includes("USER_IMG"), "image data is not inlined in the text");

	const content = plannerContent(pkg);
	assert.deepEqual(content.map((c) => c.type), ["text", "text", "image", "text", "image", "text", "image"]);
	assert.equal(content[3].type === "text" && content[3].text, "[image 2] step 1: read shot.png:");
});

test("package omits images over the limit or when the planner cannot see them", () => {
	const one = pack(imageCycle(), 1);
	assert.equal(one.images.length, 1);
	assert.match(one.text, /\[image omitted\]/);
	const none = pack(imageCycle(), 0);
	assert.equal(none.images.length, 0);
	assert.ok(!none.text.includes("[image 1]"));
});

test("bash guard allows read-only commands", () => {
	for (const cmd of [
		"rg -n 'foo > bar' src",
		"grep -rn foo . 2>/dev/null | head -50",
		"git log --oneline -5 && git diff HEAD~1",
		"find . -name '*.ts' -not -path './node_modules/*'",
		"ls -la src 2>&1",
		"cat package.json",
	]) {
		assert.equal(findWriteReason(cmd), undefined, cmd);
	}
});

test("bash guard blocks writes", () => {
	for (const cmd of [
		"rm -rf dist",
		"echo hi > file.txt",
		"cat a >> b",
		"sed -i 's/a/b/' x.ts",
		"git checkout main",
		"npm install lodash",
		"mv a b",
		"ls 2> errors.log",
	]) {
		assert.ok(findWriteReason(cmd), cmd);
	}
});

test("parseNeedContext only triggers without changes", () => {
	assert.equal(parseNeedContext("## Need context\n- read foo.ts"), "- read foo.ts");
	assert.equal(parseNeedContext("## Summary\nx\n## Changes\n### `a.ts` — edit"), undefined);
	assert.equal(parseNeedContext("## Summary\nx\n## Need context\n- y\n## Answer\nz"), undefined);
});

test("splitPlan splits file sections by task and ignores headings inside fences", () => {
	const plan = [
		"## Summary", "S", "", "## Changes", "",
		"### `a.ts` — edit", "````text", "<<<<<<< SEARCH", "## not a heading", "=======", "x", ">>>>>>> REPLACE", "````", "",
		"### `b.md` — create", "````markdown", "### `c.ts` — edit", "````", "",
		"### `c.ts` — delete", "",
		"## Tasks", "- T1: `a.ts` — do a", "- T2: `./b.md`, `c.ts` — do b and c", "",
		"## Commands", "```bash", "npm test", "```",
	].join("\n");
	const split = splitPlan(plan);
	assert.ok(split);
	assert.deepEqual(split.tasks.map((t) => [t.id, t.goal, t.files]), [["T1", "do a", ["a.ts"]], ["T2", "do b and c", ["b.md", "c.ts"]]]);
	assert.match(split.tasks[0].plan, /## Summary\nS/);
	assert.match(split.tasks[0].plan, /## Task T1 \(1 of 2\)/);
	assert.match(split.tasks[0].plan, /## not a heading/, "fenced lines stay in their file section");
	assert.ok(!split.tasks[0].plan.includes("b.md") && !split.tasks[0].plan.includes("npm test"));
	assert.match(split.tasks[1].plan, /### `c.ts` — delete/);
	assert.ok(!split.tasks[1].plan.includes("a.ts"));
	assert.match(split.joinPlan ?? "", /`a.ts`, `b.md`, `c.ts`/);
	assert.match(split.joinPlan ?? "", /npm test/);
});

test("splitPlan falls back to one executor for invalid or missing tasks", () => {
	const changes = "## Changes\n\n### `a.ts` — edit\nx\n### `b.ts` — edit\ny\n";
	assert.equal(splitPlan(changes), undefined, "no Tasks section");
	assert.equal(splitPlan(`${changes}\n## Tasks\n- T1: \`a.ts\`, \`b.ts\` — all`), undefined, "single task");
	assert.equal(splitPlan(`${changes}\n## Tasks\n- T1: \`a.ts\` — a\n- T2: \`c.ts\` — c`), undefined, "b.ts unassigned");
	assert.equal(splitPlan(`${changes}\n## Tasks\n- T1: \`a.ts\` — a\n- T2: \`a.ts\`, \`b.ts\` — b`), undefined, "a.ts in two tasks");
	const ok = splitPlan(`${changes}\n## Tasks\n- T1: \`a.ts\` — a\n- T2: \`b.ts\` — b`);
	assert.equal(ok?.tasks.length, 2);
	assert.equal(ok?.joinPlan, undefined, "no commands: no join executor");
	assert.equal(splitPlan(`${changes}\n## Tasks\n- T1: \`a.ts\` — a\n- T1: \`b.ts\` — b`), undefined, "duplicate task ids");
});

test("splitPlan: backticks in goals are not files; shared Changes notes reach every task", () => {
	const plan = "## Changes\nKeep the API stable.\n\n### `a.ts` — edit\nx\n### `b.ts` — edit\ny\n\n## Tasks\n- T1: `a.ts` — rename `foo` to `bar`\n- T2: `b.ts` — b";
	const split = splitPlan(plan);
	assert.ok(split);
	assert.deepEqual(split.tasks[0].files, ["a.ts"]);
	assert.equal(split.tasks[0].goal, "rename `foo` to `bar`");
	assert.ok(split.tasks.every((t) => t.plan.includes("Keep the API stable.")));
});

test("parseSubtasks reads the lead split only when it has no file changes", () => {
	const lead = "## Summary\nS\n\n## Design\nD\n\n## Subtasks\n- S1: `a.ts`, `b.ts` — use `x`\n- S2: `b.ts` — two\n- S2: `c.ts` — dup";
	assert.deepEqual(parseSubtasks(lead), [
		{ id: "S1", goal: "use `x`", files: ["a.ts", "b.ts"] },
		{ id: "S2", goal: "two", files: ["b.ts"] },
	]);
	assert.equal(parseSubtasks("## Changes\n### `a.ts` — edit\nx\n## Subtasks\n- S1: `a.ts` — a"), undefined, "a full plan is not a split");
	assert.equal(parseSubtasks("## Summary\nx"), undefined);
});

test("assembleJoinPlan appends the join's revision notes to the sub-plans' file sections", () => {
	const s1 = "## Summary\nS1.\n\n## Changes\n\n### `a.ts` — edit\nA-BLOCK\n\n### `b.ts` — create\nB-BODY\n\n## Commands\nnpm test";
	const s2 = "## Changes\n\n### `./a.ts` — edit\nA2-BLOCK";
	const join =
		"## Summary\nAll.\n\n## Revisions\n### `./a.ts`\n- use `foo`\n\n````text\n### `x.ts`\n````\n### `new.ts` — create\n- export `foo`\n### `b.ts`\n\n" +
		"## Tasks\n- T1: `a.ts`, `new.ts` — a\n- T2: `b.ts` — b\n\n## Commands\n```bash\nnpm test\n```";
	const plan = assembleJoinPlan(join, [
		{ id: "S1", plan: s1 },
		{ id: "S2", plan: s2 },
	]);
	assert.equal(
		plan,
		"## Summary\nAll.\n\n## Changes\n\n### `a.ts` — edit (S1)\nA-BLOCK\n\n### `./a.ts` — edit (S2)\nA2-BLOCK\n\n" +
			"Revisions by the join planner (notes, not exact edits: `read`/`grep` the code to find the exact places, they take precedence over the blocks above):\n" +
			"- use `foo`\n\n````text\n### `x.ts`\n````\n\n" +
			"### `b.ts` — create (S1)\nB-BODY\n\n### `new.ts` — create\n" +
			"Revisions by the join planner (notes, not exact edits: `read`/`grep` the code to find the exact places):\n- export `foo`\n\n" +
			"## Tasks\n- T1: `a.ts`, `new.ts` — a\n- T2: `b.ts` — b\n\n## Commands\n```bash\nnpm test\n```",
		"sections grouped by file, notes after them, empty notes and headings in fences ignored",
	);
	assert.equal(countPlanChanges(plan), 4);
	const split = splitPlan(plan);
	assert.match(split?.tasks[0].plan ?? "", /A2-BLOCK[\s\S]*use `foo`[\s\S]*export `foo`/);
	assert.doesNotMatch(split?.tasks[1].plan ?? "", /foo/);
});

test("assembleJoinPlan uses a join that wrote its own Changes as is", () => {
	const join = "## Changes\n\n### `a.ts` — edit\nJOIN-BLOCK";
	assert.equal(assembleJoinPlan(join, [{ id: "S1", plan: "## Changes\n\n### `a.ts` — edit\nA-BLOCK" }]), join);
});

test("plannerContent appends role instructions after the package and images", () => {
	const content = plannerContent({ text: "PKG", images: [{ type: "image", data: "x", mimeType: "image/png", label: "l" }] }, "EXTRA");
	assert.deepEqual(content.map((c) => (c.type === "text" ? c.text : "img")), ["PKG", "[image 1] l:", "img", "EXTRA"]);
});

test("countPlanChanges counts file sections", () => {
	const plan = "## Changes\n\n### `a.ts` — edit\n...\n### `b.ts` - create\n...\n### `c.ts` — delete\n";
	assert.equal(countPlanChanges(plan), 3);
});
