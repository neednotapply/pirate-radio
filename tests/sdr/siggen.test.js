/* The simulated band (siggen.js): that it is the same every time, that its
   stations are where it says they are, and that every place the Listen
   page's band buttons go has something there to hear. It is listened to
   with the receiver itself (dsp.js).

   node tests/sdr/siggen.test.js */
"use strict";

const path = require("path");
const SDR = path.join(__dirname, "../../feed/utils/pirate-radio-ui/files/sdr/");
const DSP = require(SDR + "dsp.js"), SigGen = require(SDR + "siggen.js");
const { test, run, ok, equal, near, atLeast, atMost } = require("./harness.js");

// `seconds` of the band at `center`, through a receiver: what it showed and heard
function listen(o) {
	const gen = o.gen || new SigGen.Generator({ seed: o.seed == null ? 1 : o.seed, center: o.center, rate: o.rate });
	const got = { lines: [], meters: [], audio: 0, peak: 0, gen: gen };
	const rx = new DSP.Receiver({
		rate: o.rate, center: o.center, vfo: o.vfo || o.center + o.rate / 8, mode: o.mode || "wfm", audio: o.mode !== undefined,
		onFft: function (bins) { got.lines.push(bins); },
		onMeter: function (m) { got.meters.push(m.level); },
		onAudio: function (a) {
			got.audio += a.length;
			for (let i = 0; i < a.length; i++) got.peak = Math.max(got.peak, Math.abs(a[i]));
		}
	});
	const n = Math.min(o.rate / 50, 48000), buf = new Int8Array(2 * n);
	for (let k = 0; k < Math.round(o.seconds * o.rate / n); k++) {
		gen.generate(buf, n);
		rx.process(buf, n);
		if (o.until && o.until(got)) break;
	}
	return got;
}
// The strongest bin within `half` Hz of `off` Hz from the centre, in the last line
function strength(got, rate, off, half) {
	const bins = got.lines[got.lines.length - 1], n = bins.length, df = rate / n;
	let p = -200;
	for (let i = Math.round((off - half + rate / 2) / df); i <= Math.round((off + half + rate / 2) / df); i++) p = Math.max(p, bins[i]);
	return p;
}

test("the same seed gives the same samples, however they are asked for", function () {
	function take(seed, chunk) {
		const g = new SigGen.Generator({ seed: seed, center: 98000000, rate: 2400000 }), out = new Int8Array(2 * 120000);
		for (let o = 0; o < 120000; o += chunk) g.generate(out.subarray(2 * o), Math.min(chunk, 120000 - o));
		return out;
	}
	const a = take(7, 120000), b = take(7, 777), c = take(7, 1), d = take(8, 120000);
	let ab = 0, ac = 0, ad = 0;
	for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) ab++; if (a[i] !== c[i]) ac++; if (a[i] !== d[i]) ad++; }
	equal(ab, 0, "samples that differ, 777 at a time");
	equal(ac, 0, "samples that differ, one at a time");
	atLeast(ad, a.length / 4, "samples that differ with another seed");
	let lo = 127, hi = -128;
	for (let i = 0; i < a.length; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
	ok(lo >= -127 && hi <= 127 && hi - lo > 40, "8-bit samples, using the range: " + lo + ".." + hi);
});

test("an empty stretch of band is noise at the level set, with the radio's small offset", function () {
	const g = new SigGen.Generator({ seed: 3, center: 300000000, rate: 2400000 }), n = 240000, out = new Int8Array(2 * n);
	equal(g.view().length, 0, "stations in view at 300 MHz");
	g.generate(out, n);
	let si = 0, sq = 0, p = 0;
	for (let i = 0; i < n; i++) { si += out[2 * i]; sq += out[2 * i + 1]; }
	si /= n; sq /= n;
	for (let i = 0; i < n; i++) p += (out[2 * i] - si) * (out[2 * i] - si) + (out[2 * i + 1] - sq) * (out[2 * i + 1] - sq);
	near(si, 1.2, 0.05, "the offset on I, in steps of the converter");
	near(sq, -0.8, 0.05, "the offset on Q");
	// 1.5 steps rms on each of I and Q, and the rounding's own twelfth of a step squared
	near(Math.sqrt(p / n / 2), Math.sqrt(1.5 * 1.5 + 1 / 12), 0.05, "noise, rms per component");
});

test("stations are where the band says, and move when the radio does", function () {
	const rate = 2400000;
	let got = listen({ center: 98000000, rate: rate, seconds: 0.5 });
	equal(got.gen.view().map(function (s) { return s.f / 1e6; }).sort().join(), "97.3,98.1,98.9", "in view around 98 MHz");
	const floor = strength(got, rate, -300000, 50000);
	atLeast(strength(got, rate, 100000, 60000) - floor, 25, "98.1 MHz over the noise, dB");
	atLeast(strength(got, rate, -700000, 60000) - floor, 12, "97.3 MHz over the noise, dB");
	atLeast(strength(got, rate, 900000, 60000) - floor, 12, "98.9 MHz over the noise, dB");
	atMost(strength(got, rate, 0, 3000) - floor, 6, "and no spike in the middle (the offset is taken out), dB");
	// half a megahertz up: everything is half a megahertz further left
	got = listen({ center: 98500000, rate: rate, seconds: 0.5 });
	atLeast(strength(got, rate, -400000, 60000) - strength(got, rate, 0, 50000), 25, "98.1 MHz, with the radio on 98.5");
	// a bare carrier is exactly where it should be: 100.000 MHz, seen from 99.9
	got = listen({ center: 99900000, rate: 240000, seconds: 0.6 });
	const bins = got.lines[got.lines.length - 1];
	let top = 0;
	for (let i = 1; i < bins.length; i++) if (bins[i] > bins[top]) top = i;
	near((top - bins.length / 2) * 240000 / bins.length, 100000, 120, "the carrier at 100 MHz, Hz from a centre of 99.9");
});

test("only the strongest few in view are made", function () {
	const g = new SigGen.Generator({ seed: 1, center: 98000000, rate: 9600000 }), v = g.view();
	equal(v.length, SigGen.MAX_ACTIVE, "stations made at 9.6 Msps around 98 MHz");
	const all = SigGen.BAND.filter(function (b) { return Math.abs(b.f - 98000000) < 4800000; }).map(function (b) { return b.level; }).sort(function (a, b) { return b - a; });
	atLeast(all.length, 10, "stations there are in that span");
	equal(v.map(function (s) { return s.level; }).join(), all.slice(0, SigGen.MAX_ACTIVE).join(), "and they are the strongest");
});

test("the radio's gain moves everything by as much", function () {
	const o = { center: 97800000, rate: 2400000, vfo: 98100000, mode: "wfm", seconds: 0.6 };
	const plain = listen(o), g = new SigGen.Generator({ seed: 1, center: o.center, rate: o.rate });
	g.setGain(6);
	const more = listen(Object.assign({ gen: g }, o));
	near(plain.meters[plain.meters.length - 1], -15, 1, "98.1 MHz as it is, dBFS");
	near(more.meters[more.meters.length - 1] - plain.meters[plain.meters.length - 1], 6, 0.7, "6 dB of gain, dB more signal");
});

test("every place the Listen page's band buttons go has something to hear", function () {
	// (the page's BANDS, receiver.js: where each button puts the dial, and how it listens)
	const places = [["FM radio", 98.1e6, "wfm"], ["Aircraft", 121.5e6, "am"], ["Weather radio", 162.55e6, "nfm"], ["Marine", 156.8e6, "nfm"],
		["Ham 2 m", 146.52e6, "nfm"], ["Ham 70 cm", 446e6, "nfm"], ["FRS / GMRS", 462.5625e6, "nfm"], ["433 MHz", 433.92e6, "nfm"],
		["915 MHz", 915e6, "nfm"], ["CB", 27.185e6, "am"]];
	places.forEach(function (p) {
		ok(SigGen.BAND.some(function (b) { return b.f === p[1]; }), p[0] + ": a station at " + p[1] / 1e6 + " MHz");
		// Some only come on the air now and then, and a voice has its
		// pauses: listened to until there is something (20 s at most)
		const got = listen({
			center: p[1] - 120000, rate: 960000, vfo: p[1], mode: p[2], seconds: 20,
			until: function (g) { return g.meters.length && g.meters[g.meters.length - 1] > -30 && g.audio > 24000 && g.peak > 0.1; }
		});
		atLeast(Math.max.apply(null, got.meters), -30, p[0] + ": the channel's level when it is on the air, dBFS");
		ok(got.audio > 0 && got.peak > 0.05 && got.peak <= 1, p[0] + ": sound, peak " + got.peak.toFixed(2));
	});
	// and the short waves, for the sideband and Morse modes
	[["20 m", 14.2e6, "usb"], ["40 m", 7.1e6, "lsb"], ["Morse", 14.1e6, "cw"]].forEach(function (p) {
		const got = listen({
			center: p[1] - 120000, rate: 960000, vfo: p[1], mode: p[2], seconds: 20,
			until: function (g) { return g.meters.length && g.meters[g.meters.length - 1] > -45 && g.audio > 24000; }
		});
		atLeast(Math.max.apply(null, got.meters), -45, p[0] + ": the channel's level when it is on the air, dBFS");
	});
});

if (require.main === module) run("siggen.js: the simulated band").then(function (failed) { process.exit(failed ? 1 : 0); });
else module.exports = function () { return run("siggen.js: the simulated band"); };
