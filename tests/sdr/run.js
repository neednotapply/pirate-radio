/* Everything there is to check about the receiver in the browser, in one go:

     node tests/sdr/run.js [--no-bench] [--strict]

   dsp.test.js     the signal processing, against signals made by the formula
   siggen.test.js  the simulated band the demo and the mock bridge play
   engine.test.js  the engine, in demo mode and against a mock of the bridge
   bench.js        how fast it is (reported; a failure only with --strict, or
                   when it could not keep up with the radio at all)

   Node 20, nothing else: no packages. Exits 1 if anything failed.
   ONLY=<regexp> runs the tests whose name matches. To try the Listen page
   against a radio that is not there: node tests/sdr/mock-bridge.js */
"use strict";

(async function () {
	const strict = process.argv.indexOf("--strict") >= 0, t0 = Date.now();
	let failed = 0;
	// (one after the other: each file's tests are registered as it loads)
	failed += await require("./dsp.test.js")();
	console.log("");
	failed += await require("./siggen.test.js")();
	console.log("");
	failed += await require("./engine.test.js")();
	if (process.argv.indexOf("--no-bench") < 0 && !process.env.ONLY) {
		console.log("");
		const b = require("./bench.js").bench({ quick: true });
		console.log(b.text);
		const wfm = b.rows.filter(function (r) { return r.rate === 2400000; })[0].wfm;
		if (wfm >= 100) { console.log("FAIL - the receiver cannot keep up with 2.4 Msps on this machine"); failed++; }
		else if (strict && b.missed) { console.log("FAIL - " + b.missed + " speed target(s) missed"); failed++; }
	}
	console.log("");
	console.log((failed ? "FAILED: " + failed : "all passed") + " (" + Math.round((Date.now() - t0) / 1000) + " s)");
	process.exit(failed ? 1 : 0);
})().catch(function (e) {
	console.error(e);
	process.exit(1);
});
