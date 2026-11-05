import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { autoApplyPlan, parseCreateSection, parseEditSection } from "../src/apply.ts";
import { fileSections, mapFileSections, splitPlan } from "../src/planner.ts";
import { AUTO_APPLIED, AUTO_APPLY_FAILED, buildExecutorKickoff } from "../src/prompts.ts";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const block = (search: string, replace: string) => ["````text", "<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE", "````"].join("\n");

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "mixagent-apply-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

test("parseEditSection reads blocks and the description, rejects anything unclear", () => {
	const ok = parseEditSection(`Use a template.\n\n${block("a\nb", "c")}\n\n${block("x", "")}`);
	assert.deepEqual(ok, { blocks: [{ oldText: "a\nb", newText: "c" }, { oldText: "x", newText: "" }], description: "Use a template." });
	assert.equal(parseEditSection("Just prose, no blocks."), "no SEARCH/REPLACE blocks");
	assert.equal(parseEditSection(block("a\n=======\nb", "c")), "a block with two dividers (ambiguous)");
	assert.equal(parseEditSection("<<<<<<< SEARCH\na\n=======\nb"), "an unterminated SEARCH/REPLACE block");
	assert.equal(parseEditSection(block("  ", "c")), "an empty SEARCH block");
	assert.equal(parseEditSection(`${block("a", "b")}\nAlso add:\n\`\`\`ts\nfoo();\n\`\`\``), "code outside the SEARCH/REPLACE blocks");
	assert.equal(parseEditSection(`${block("a", "<<<<<<< SEARCH")}`), "malformed SEARCH/REPLACE markers");
});

test("parseCreateSection takes the single code block as the file content", () => {
	assert.deepEqual(parseCreateSection("New helper.\n````ts\nexport const a = 1;\n````"), { content: "export const a = 1;\n", description: "New helper." });
	assert.equal(parseCreateSection("no code"), "no code block with the file content");
	assert.equal(parseCreateSection("```ts\na\n```\n```ts\nb\n```"), "more than one code block");
	assert.equal(parseCreateSection("```ts\na"), "an unterminated code block");
});

test("mapFileSections replaces sections and keeps everything else", () => {
	const plan = "## Summary\nS\n\n## Changes\n\n### `a.ts` — edit\nA\n\n### `b.ts` — create\n````md\n### `c.ts` — edit\n````\n\n## Commands\nnpm test";
	assert.deepEqual(fileSections(plan).map((s) => [s.path, s.kind]), [["a.ts", "edit"], ["b.ts", "create"]]);
	assert.equal(mapFileSections(plan, () => undefined), plan);
	assert.equal(
		mapFileSections(plan, (s) => (s.path === "a.ts" ? "### `a.ts` — edit\nDONE" : undefined)),
		"## Summary\nS\n\n## Changes\n\n### `a.ts` — edit\nDONE\n\n### `b.ts` — create\n````md\n### `c.ts` — edit\n````\n\n## Commands\nnpm test",
	);
});

test("autoApplyPlan applies exact changes and notes each outcome in the plan", async () => {
	const cwd = project({
		"src/a.ts": "const x = 1;\r\nconst y = 2;\r\n",
		"src/b.ts": "keep\n",
		"src/dup.ts": "foo\nfoo\n",
		"src/gone.ts": "bye\n",
		"src/fuzzy.ts": "const s = “q”;\n",
	});
	const plan = [
		"## Summary", "S", "", "## Changes", "",
		"### `src/a.ts` — edit", "Bump both.", "", block("const x = 1;", "const x = 10;"), "",
		"### `src/a.ts` — edit", block("const y = 2;", "const y = 20;"), "",
		"### `src/b.ts` — edit", "Find the right place and add a log call.", "",
		"### `src/dup.ts` — edit", block("foo", "bar"), "",
		"### `src/missing.ts` — edit", block("a", "b"), "",
		"### `src/new/c.ts` — create", "````ts", "export const c = 3;", "````", "",
		"### `src/gone.ts` — delete", "",
		"### `../outside.ts` — create", "````ts", "x", "````", "",
		"### `src/fuzzy.ts` — edit", block('const s = "q";', 'const s = "r";'), "",
		"## Commands", "```bash", "npm test", "```",
	].join("\n");
	const auto = await autoApplyPlan(plan, cwd);

	assert.deepEqual(auto.files.map((f) => [f.path, f.status]), [
		["src/a.ts", "applied"],
		["src/b.ts", "skipped"],
		["src/dup.ts", "failed"],
		["src/missing.ts", "failed"],
		["src/new/c.ts", "applied"],
		["src/gone.ts", "applied"],
		["../outside.ts", "skipped"],
		["src/fuzzy.ts", "skipped"],
	]);
	assert.equal(readFileSync(join(cwd, "src/a.ts"), "utf8"), "const x = 10;\r\nconst y = 20;\r\n", "both sections in one edit, CRLF kept");
	assert.equal(readFileSync(join(cwd, "src/dup.ts"), "utf8"), "foo\nfoo\n", "failed file unchanged");
	assert.equal(readFileSync(join(cwd, "src/new/c.ts"), "utf8"), "export const c = 3;\n");
	assert.ok(!existsSync(join(cwd, "src/gone.ts")));
	assert.equal(readFileSync(join(cwd, "src/fuzzy.ts"), "utf8"), "const s = “q”;\n", "no fuzzy rewrites");
	assert.match(auto.files[2].message, /Found 2 occurrences/);
	assert.match(auto.files[7].message, /does not match the file exactly/);

	const p = auto.plan;
	assert.match(p, new RegExp(`### \`src/a.ts\` — edit\nBump both.\n\n${esc(AUTO_APPLIED)}: Successfully replaced 2 block\\(s\\) in src/a.ts.\n\n### \`src/a.ts\` — edit\n${esc(AUTO_APPLIED)}`));
	assert.ok(!p.includes("const x = 10;"), "applied blocks are not repeated");
	assert.match(p, /### `src\/b.ts` — edit\nFind the right place and add a log call.\n\n### `src\/dup.ts`/, "skipped section unchanged");
	assert.match(p, new RegExp(`<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n\`\`\`\`\n\n${esc(AUTO_APPLY_FAILED)}: Found 2 occurrences`), "failed section keeps its blocks");
	assert.match(p, new RegExp(`### \`src/gone.ts\` — delete\n${esc(AUTO_APPLIED)}: Deleted src/gone.ts.`));
	assert.match(p, /## Commands\n```bash\nnpm test\n```$/);

	assert.match(buildExecutorKickoff("req", p), /already applied the sections marked "Applied by MixAgent"[\s\S]*Apply the rest of the plan now\.$/);
	assert.match(buildExecutorKickoff("req", plan), /Apply the plan now\.$/);
});

test("autoApplyPlan leaves the join's revision notes and mixed sections to the executor", async () => {
	const cwd = project({ "a.ts": "a\n", "b.ts": "b\n" });
	const plan = [
		"## Changes", "",
		"### `a.ts` — edit (S1)", block("a", "A"), "",
		"Revisions by the join planner (notes, not exact edits: `read`/`grep` the code to find the exact places, they take precedence over the blocks above):", "- also x", "",
		"### `b.ts` — edit", block("b", "B"), "",
		"### `b.ts` — delete", "",
		"## Tasks", "- T1: `a.ts` — a", "- T2: `b.ts` — b",
	].join("\n");
	const auto = await autoApplyPlan(plan, cwd);
	assert.deepEqual(auto.files.map((f) => [f.path, f.status]), [["a.ts", "skipped"], ["b.ts", "skipped"]]);
	assert.equal(auto.plan, plan);
	assert.equal(readFileSync(join(cwd, "a.ts"), "utf8"), "a\n");
});

test("fork-join tasks get the auto-applied plan's notes for their own files", async () => {
	const cwd = project({ "a.ts": "a\n", "b.ts": "b\n" });
	const plan = "## Changes\n\n### `a.ts` — edit\n" + block("a", "A") + "\n\n### `b.ts` — edit\nDo it by hand.\n\n## Tasks\n- T1: `a.ts` — a\n- T2: `b.ts` — b";
	const split = splitPlan((await autoApplyPlan(plan, cwd)).plan);
	assert.ok(split);
	assert.match(split.tasks[0].plan, new RegExp(`### \`a.ts\` — edit\n${esc(AUTO_APPLIED)}: Successfully replaced 1 block`));
	assert.match(split.tasks[1].plan, /### `b.ts` — edit\nDo it by hand\.$/);
});
