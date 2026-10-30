import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import mixagent from "../src/index.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "mixagent-cmd-"));

let command: any;
const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
const flags: Record<string, unknown> = { "mix-planner": "anthropic/claude-opus-4-7" };
const pi: any = new Proxy(
	{},
	{
		get: (_t, key) =>
			({
				registerCommand: (name: string, c: any) => {
					if (name === "mix") command = c;
				},
				on: (event: string, h: any) => {
					handlers[event] = h;
				},
				getFlag: (name: string) => flags[name],
				getActiveTools: () => [],
			})[key as string] ?? (() => undefined),
	},
);
mixagent(pi);

const models = [
	{ provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
	{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
	{ provider: "openai", id: "gpt-5", name: "GPT-5" },
];
await handlers.session_start({}, { cwd: process.env.PI_CODING_AGENT_DIR, hasUI: false, modelRegistry: { getAvailable: () => models } });

test("/mix model <role> completes models with provider/id and name", async () => {
	const items = await command.getArgumentCompletions("model planner ");
	assert.deepEqual(items, [
		{ value: "model planner anthropic/claude-opus-4-7", label: "anthropic/claude-opus-4-7", description: "Claude Opus 4.7 (current)" },
		{ value: "model planner anthropic/claude-haiku-4-5", label: "anthropic/claude-haiku-4-5", description: "Claude Haiku 4.5" },
		{ value: "model planner openai/gpt-5", label: "openai/gpt-5", description: "GPT-5" },
	]);
});

test("model completions filter by provider/id or name, case-insensitively", async () => {
	const byName = await command.getArgumentCompletions("model scout haiku");
	assert.deepEqual(byName.map((i: any) => i.label), ["anthropic/claude-haiku-4-5"]);
	const byProvider = await command.getArgumentCompletions("model executor OpenAI/");
	assert.deepEqual(byProvider.map((i: any) => i.label), ["openai/gpt-5"]);
	assert.equal(await command.getArgumentCompletions("model scout nothing-matches"), null);
});

test("role completions are unchanged", async () => {
	const items = await command.getArgumentCompletions("model p");
	assert.deepEqual(items, [{ value: "model planner", label: "planner" }]);
});
