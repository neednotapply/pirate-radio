/* Everything there is to check about the Bluetooth page in the browser:

     node tests/bt/run.js

   scanner.test.js  the page's own reckoning (bt/scanner.js, with the names
                    in bt/names.js): what it makes of the records the
                    router's pirate-bluetooth hands on

   Node 20, nothing else: no packages. Exits 1 if anything failed.
   ONLY=<regexp> runs the tests whose name matches. The router's side
   (pirate-bluetooth, against tests/fakebt) is in tests/rootfs-test.sh. */
"use strict";

(async function () {
	const t0 = Date.now();
	const failed = await require("./scanner.test.js")();
	console.log("");
	console.log((failed ? "FAILED: " + failed : "all passed") + " (" + Math.round((Date.now() - t0) / 1000) + " s)");
	process.exit(failed ? 1 : 0);
})().catch(function (e) {
	console.error(e);
	process.exit(1);
});
