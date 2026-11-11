/* How fast the receiver is: the share of one core's time the signal
   processing (dsp.js) takes to keep up with the radio, at every sample rate
   and in every mode, with the display at its usual 4096 points and 20 lines
   a second. 100 % would be only just keeping up.

   node tests/sdr/bench.js [--strict] [--quick]

   The radio's samples are made beforehand (the simulated band, around
   98 MHz); what is timed is the processing alone, the best of three runs.
   The last columns are the display on its own (no sound), and what the
   simulated radio itself costs on top, in the web UI's demo mode.

   --strict: exit 1 when the targets (below) are missed. They are for a
   desktop computer; a slower one misses them without anything being wrong,
   so by default they are only reported. */
"use strict";

const path = require("path");
const SDR = path.join(__dirname, "../../feed/utils/pirate-radio-ui/files/sdr/");
const DSP = require(SDR + "dsp.js"), SigGen = require(SDR + "siggen.js");

const RATES = [240000, 960000, 1200000, 1920000, 2400000, 4800000, 9600000];
const MODES = ["wfm", "nfm", "am", "usb", "lsb", "cw"];
// Under these, as a share of real time
const TARGETS = [{ rate: 2400000, mode: "wfm", under: 15 }, { rate: 9600000, mode: "wfm", under: 60 }];

function now() { return Number(process.hrtime.bigint()) / 1e6; }

// The radio's samples for `seconds`, in the bridge's frames
function samples(rate, seconds) {
	const gen = new SigGen.Generator({ seed: 1, center: 98000000, rate: rate }), n = Math.min(rate / 50, 48000), frames = [];
	for (let k = 0; k < Math.round(seconds * rate / n); k++) {
		const f = new Int8Array(2 * n);
		gen.generate(f, n);
		frames.push(f);
	}
	return { frames: frames, n: n, ms: frames.length * n / rate * 1000 };
}

// Per cent of real time to process them, the best of `runs`
function time(sig, opts, runs) {
	const rx = new DSP.Receiver(opts);
	function pass() {
		const t = now();
		for (let k = 0; k < sig.frames.length; k++) rx.process(sig.frames[k], sig.n);
		return now() - t;
	}
	pass();                        // the compiler's turn
	let best = Infinity;
	for (let k = 0; k < runs; k++) best = Math.min(best, pass());
	return best / sig.ms * 100;
}

function generator(rate, seconds) {
	const gen = new SigGen.Generator({ seed: 1, center: 98000000, rate: rate }), n = Math.min(rate / 50, 48000), f = new Int8Array(2 * n);
	const frames = Math.round(seconds * rate / n);
	function pass() {
		const t = now();
		for (let k = 0; k < frames; k++) gen.generate(f, n);
		return now() - t;
	}
	pass();
	return Math.min(pass(), pass(), pass()) / (frames * n / rate * 1000) * 100;
}

function pad(s, w) { s = String(s); while (s.length < w) s = " " + s; return s; }

function bench(o) {
	o = o || {};
	const seconds = o.quick ? 0.25 : 0.5, runs = 3, rows = [], out = [];
	out.push("# the receiver's speed: per cent of one core's time to keep up with the radio");
	out.push("#   (display: 4096 points, 20 lines a second; " + process.version + ", " + require("os").cpus()[0].model.trim() + ")");
	out.push(pad("samples/s", 10) + MODES.map(function (m) { return pad(m, 7); }).join("") + pad("display only", 14) + pad("+ demo radio", 14));
	RATES.forEach(function (rate) {
		const sig = samples(rate, seconds), row = { rate: rate };
		// The dial where broadcast FM fits at every rate, a station or not
		const vfo = 98000000 + (rate === 240000 ? 15000 : rate / 8);
		MODES.forEach(function (mode) {
			row[mode] = time(sig, { rate: rate, center: 98000000, vfo: vfo, mode: mode }, runs);
		});
		row.display = time(sig, { rate: rate, center: 98000000, vfo: vfo, audio: false }, runs);
		row.demo = generator(rate, seconds);
		rows.push(row);
		out.push(pad(rate, 10) + MODES.map(function (m) { return pad(row[m].toFixed(1), 7); }).join("") + pad(row.display.toFixed(1), 14) + pad(row.demo.toFixed(1), 14));
	});
	let missed = 0;
	TARGETS.forEach(function (t) {
		const v = rows.filter(function (r) { return r.rate === t.rate; })[0][t.mode], ok = v < t.under;
		if (!ok) missed++;
		out.push("target: " + t.mode + " at " + t.rate + " samples/s under " + t.under + " %: " + v.toFixed(1) + " %  " + (ok ? "met" : "MISSED"));
	});
	// "narrow modes no more than broadcast FM": with a little slack for the timing's own noise
	const r24 = rows.filter(function (r) { return r.rate === 2400000; })[0];
	const worst = Math.max.apply(null, MODES.slice(1).map(function (m) { return r24[m]; })), okN = worst <= r24.wfm * 1.1 + 0.5;
	if (!okN) missed++;
	out.push("target: the narrow modes at 2400000 no more than wfm (" + r24.wfm.toFixed(1) + " %): " + worst.toFixed(1) + " %  " + (okN ? "met" : "MISSED"));
	return { rows: rows, missed: missed, text: out.join("\n") };
}

module.exports = { bench };

if (require.main === module) {
	const r = bench({ quick: process.argv.indexOf("--quick") >= 0 });
	console.log(r.text);
	process.exit(r.missed && process.argv.indexOf("--strict") >= 0 ? 1 : 0);
}
