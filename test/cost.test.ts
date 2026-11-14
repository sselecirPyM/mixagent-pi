import assert from "node:assert/strict";
import { test } from "node:test";
import { addCall, type CallCost, formatCostLines, summarizeCalls } from "../src/cost.ts";

const call = (role: CallCost["role"], label: string, model: string, cost: number, calls = 1): CallCost => ({
	role,
	label,
	model,
	calls,
	input: 1000 * calls,
	output: 100 * calls,
	cacheRead: 500 * calls,
	cacheWrite: 0,
	cost,
});

test("addCall sums calls with the same role, label and model", () => {
	const calls: CallCost[] = [];
	addCall(calls, call("scout", "session", "a/small", 0.01));
	addCall(calls, call("scout", "session", "a/small", 0.02));
	addCall(calls, call("planner", "lead", "b/big", 0.5));
	addCall(calls, call("planner", "lead", "b/big", 0.25)); // a second handoff (need-context round)
	addCall(calls, call("planner", "S1", "b/big", 0.3, 2)); // retried once
	assert.equal(calls.length, 3);
	assert.deepEqual(
		calls.map((c) => [c.label, c.calls, c.input, Number(c.cost.toFixed(4))]),
		[
			["session", 2, 2000, 0.03],
			["lead", 2, 2000, 0.75],
			["S1", 2, 2000, 0.3],
		],
	);
});

test("addCall skips empty entries (e.g. a sub-planner aborted before it started)", () => {
	const calls: CallCost[] = [];
	addCall(calls, { ...call("planner", "S2", "b/big", 0, 0), input: 0, output: 0, cacheRead: 0 });
	assert.equal(calls.length, 0);
});

test("summarizeCalls totals per role and overall", () => {
	const calls = [call("scout", "session", "a/small", 0.01, 3), call("planner", "lead", "b/big", 0.5), call("executor", "T1", "a/small", 0.02, 4), call("executor", "T2", "a/small", 0.03, 2)];
	const { total, byRole } = summarizeCalls(calls);
	assert.equal(total.calls, 10);
	assert.equal(Number(total.cost.toFixed(4)), 0.56);
	assert.equal(byRole.executor?.calls, 6);
	assert.equal(byRole.executor?.input, 6000);
	assert.equal(byRole.main, undefined);
});

test("formatCostLines lists each role with its models, then the total", () => {
	const lines = formatCostLines([call("main", "session", "g/argon", 0.4, 5)]);
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^ {2}main {5}5 call\(s\) · 7\.5k in \(2\.5k cached\) \/ 500 out · \$0\.400 {2}\[g\/argon\]$/);
	assert.match(lines[1], /^ {2}total/);
});
