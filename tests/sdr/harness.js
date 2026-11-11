/* The smallest test runner that will do: tests are registered, run in order
   (they may be async), and reported one a line, "ok - " or "FAIL - ", as the
   project's other tests are. No dependencies. */
"use strict";

const tests = [];

function test(name, fn) { tests.push({ name: name, fn: fn }); }

function fail(msg) { throw new Error(msg); }
function ok(cond, msg) { if (!cond) fail(msg || "expected true"); }
function equal(a, b, msg) { if (a !== b) fail((msg || "values differ") + ": " + a + " !== " + b); }
function near(a, want, tol, msg) {
	if (!(Math.abs(a - want) <= tol)) fail((msg || "value") + ": " + fmt(a) + ", expected " + fmt(want) + " within " + tol);
}
function atLeast(a, min, msg) { if (!(a >= min)) fail((msg || "value") + ": " + fmt(a) + ", expected at least " + min); }
function atMost(a, max, msg) { if (!(a <= max)) fail((msg || "value") + ": " + fmt(a) + ", expected at most " + max); }
function fmt(v) { return typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v); }

// Run what was registered; resolves to the number that failed
async function run(title) {
	let failed = 0;
	const only = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
	console.log("# " + title);
	for (const t of tests.splice(0)) {
		if (only && !only.test(t.name)) continue;
		const t0 = Date.now();
		try {
			await t.fn();
			console.log("ok   - " + t.name + " (" + (Date.now() - t0) + " ms)");
		} catch (e) {
			failed++;
			console.log("FAIL - " + t.name);
			console.log(String((e && e.stack) || e).split("\n").slice(0, 4).map(function (l) { return "       " + l; }).join("\n"));
		}
	}
	return failed;
}

module.exports = { test, run, ok, equal, near, atLeast, atMost, fail };
