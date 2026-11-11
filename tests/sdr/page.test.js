/* The parts of the Listen page (receiver.js) that have no page to them:
   where signals stand out in a line of the spectrum, and where a scan looks
   next, which is what the Scan button goes by; and what is made of the
   favourites a browser kept.

   The lines here are made as the page gets them: noise and signals as an
   FFT shows them (every bin's power scattered about its mean), a few lines
   smoothed into one.

   node tests/sdr/page.test.js */
"use strict";

const fs = require("fs"), path = require("path"), vm = require("vm");
const SDR = path.join(__dirname, "../../feed/utils/pirate-radio-ui/files/sdr/");
const { test, run, ok, equal, near, atLeast, atMost } = require("./harness.js");

// receiver.js is a page's script: it hangs what it has on window
const page = { window: {} };
vm.runInNewContext(fs.readFileSync(SDR + "receiver.js", "utf8"), page, { filename: "receiver.js" });
const pure = page.window.PirateSDR.pure, MARGIN = pure.SCAN_MARGIN;

function prng(seed) {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FLOOR = -75;      // the noise in a bin, dB

/* A line of the spectrum as the page has it after `lines` of them: n bins
   across `rate` Hz about `center`, noise at FLOOR, and on it
     { f, width, over }           a flat-topped signal (broadcast FM), `over` dB above the noise
     { f, width, over, peaked }   one with its power towards its middle (a narrow FM carrier)
   The radio's own carrier at the centre, with dc: dB above the noise. */
function line(o) {
	const n = o.n || 4096, rate = o.rate || 2400000, binHz = rate / n, base = o.center - rate / 2;
	const mean = new Float64Array(n).fill(Math.pow(10, FLOOR / 10));
	(o.signals || []).forEach(function (s) {
		const top = Math.pow(10, (FLOOR + s.over) / 10);
		for (let i = 0; i < n; i++) {
			const d = base + (i + 0.5) * binHz - s.f;
			if (s.peaked) mean[i] += top * Math.exp(-0.5 * Math.pow(d / (s.width / 4), 2));
			else if (Math.abs(d) <= s.width / 2) mean[i] += top;
		}
	});
	if (o.dc != null) for (let i = (n >> 1) - 1; i <= (n >> 1) + 1; i++) mean[i] += Math.pow(10, (FLOOR + o.dc) / 10);
	const rand = prng(o.seed || 1), avg = new Float32Array(n);
	for (let l = 0; l < (o.lines || 6); l++) {
		for (let i = 0; i < n; i++) {
			const db = 10 * Math.log10(mean[i] * -Math.log(1 - rand()) + 1e-30);
			avg[i] = l ? avg[i] + (db - avg[i]) * 0.45 : db;
		}
	}
	return avg;
}
function found(o, set) {
	const got = pure.signalsIn(line(o), o.center, o.rate || 2400000, Object.assign({ margin: MARGIN }, set));
	return got && Array.from(got);
}
function at(got) { return got.map(function (s) { return s.f; }).join(); }

const WFM = { bw: 180000, mode: "wfm", step: 100000 }, NFM = { bw: 12500, mode: "nfm", step: 12500 };

test("broadcast stations among the noise: each where it is, on the dial's steps, lowest first", function () {
	const got = found({ center: 98000000, signals: [
		{ f: 97300000, width: 150000, over: 15 }, { f: 98100000, width: 150000, over: 22 }, { f: 98900000, width: 150000, over: 12 }
	] }, WFM);
	equal(at(got), "97300000,98100000,98900000", "the stations found");
	got.forEach(function (s) { atLeast(s.over, MARGIN, "dB over the noise, at " + s.f); });
	ok(got[1].over > got[0].over && got[0].over > got[2].over, "the stronger the station, the more it is over the noise");
});

test("a station too weak to listen to is passed by", function () {
	const got = found({ center: 98000000, signals: [
		{ f: 97500000, width: 150000, over: 4 }, { f: 98500000, width: 150000, over: 14 }
	] }, WFM);
	equal(at(got), "98500000", "only the one that stands out");
});

test("noise alone holds no signal, whatever it happens to look like", function () {
	let any = 0;
	for (let seed = 1; seed <= 60; seed++) {
		any += found({ center: 433000000, seed: seed }, WFM).length;
		any += found({ center: 433000000, seed: seed + 1000 }, NFM).length;
		any += found({ center: 14200000, seed: seed + 2000, n: 16384 }, { bw: 2700, mode: "usb", step: 100 }).length;
	}
	equal(any, 0, "signals found in 180 lines of noise");
});

test("the radio's own carrier, in the middle of every line, is not a signal", function () {
	for (let seed = 1; seed <= 20; seed++) {
		equal(at(found({ center: 98000000, dc: 35, seed: seed }, WFM)), "", "wide FM, a carrier 35 dB up");
		equal(at(found({ center: 146000000, dc: 35, seed: seed }, NFM)), "", "narrow FM, a carrier 35 dB up");
	}
	// a station that is there, at the centre, still is
	equal(at(found({ center: 98000000, dc: 35, signals: [{ f: 98000000, width: 150000, over: 15 }] }, WFM)), "98000000",
		"a broadcast station at the radio's centre");
	equal(at(found({ center: 146000000, dc: 35, signals: [{ f: 146025000, width: 9000, over: 26, peaked: true }] }, NFM)), "146025000",
		"a narrow signal two channels from it");
});

test("narrow FM: channels side by side are told apart, the weaker beside the stronger too", function () {
	// 12.5 kHz apart, on steps of 12.5 kHz
	let got = found({ center: 462400000, signals: [
		{ f: 462562500, width: 9000, over: 30, peaked: true }, { f: 462575000, width: 9000, over: 25, peaked: true },
		{ f: 462712500, width: 9000, over: 24, peaked: true }
	] }, NFM);
	equal(at(got), "462562500,462575000,462712500", "the channels found");
	// 15 kHz apart, on steps of 5 kHz (as the 2 m band has them)
	got = found({ center: 146400000, signals: [
		{ f: 146520000, width: 9000, over: 24, peaked: true }, { f: 146535000, width: 9000, over: 30, peaked: true },
		{ f: 146940000, width: 9000, over: 24, peaked: true }
	] }, { bw: 12500, mode: "nfm", step: 5000 });
	equal(at(got), "146520000,146535000,146940000", "the channels found");
});

test("a signal is found at its own middle, not at the nearest step of a coarse reckoning", function () {
	// steps of 25 kHz, as broadcast FM has in places: every station on its own
	const got = found({ center: 98000000, signals: [
		{ f: 97325000, width: 150000, over: 14 }, { f: 97975000, width: 150000, over: 20 }, { f: 98650000, width: 150000, over: 11 }
	] }, { bw: 180000, mode: "wfm", step: 25000 });
	equal(at(got), "97325000,97975000,98650000", "the stations found");
	// and as near as the dial's steps allow for one that is on none of them
	const off = found({ center: 121500000, n: 8192, signals: [{ f: 121512000, width: 6000, over: 28, peaked: true }] },
		{ bw: 8000, mode: "am", step: 1000 });
	equal(off.length, 1, "signals found");
	near(off[0].f, 121512000, 1000, "the dial for a signal at 121.512 MHz, on steps of 1 kHz");
});

test("a band whose channels sit off the dial's whole steps: found on the channels", function () {
	// CB: 10 kHz apart, 5 kHz off every whole 10 kHz
	const cb = { center: 27100000, n: 8192, signals: [
		{ f: 27025000, width: 6000, over: 26, peaked: true }, { f: 27185000, width: 6000, over: 30, peaked: true }
	] };
	equal(at(found(cb, { bw: 8000, mode: "am", step: 10000, off: 5000 })), "27025000,27185000", "with the steps counted from a channel");
	equal(at(found(cb, { bw: 8000, mode: "am", step: 10000 })), "27030000,27190000", "and what whole steps would make of them");
});

test("the shoulders of a strong station are not stations", function () {
	const got = found({ center: 98000000, signals: [
		{ f: 98100000, width: 150000, over: 45 },
		{ f: 97900000, width: 70000, over: 22 }, { f: 98300000, width: 70000, over: 22 },      // its digital sidebands
		{ f: 97300000, width: 150000, over: 22 }                                                 // as strong as they are, but by itself
	] }, WFM);
	equal(at(got), "97300000,98100000", "what is found");
});

test("sideband: the dial is at the channel's edge, not its middle", function () {
	const usb = found({ center: 14200000, n: 16384, signals: [{ f: 14251350, width: 2700, over: 25 }] }, { bw: 2700, mode: "usb", step: 100 });
	equal(usb.length, 1, "upper sideband: signals found");
	// (to within a few bins: the signal's own unevenness, in so few of them, moves its middle about)
	near(usb[0].f, 14250000, 600, "the dial for a voice from 14.2500 to 14.2527 MHz");
	const lsb = found({ center: 7100000, n: 16384, signals: [{ f: 7148650, width: 2700, over: 25 }] }, { bw: 2700, mode: "lsb", step: 100 });
	equal(lsb.length, 1, "lower sideband: signals found");
	near(lsb[0].f, 7150000, 600, "the dial for a voice from 7.1473 to 7.1500 MHz");
});

test("what shows only at the very end of a line is left for the next look", function () {
	// the line's usable part ends 1.128 MHz from the centre: this station's middle is beyond it
	equal(at(found({ center: 98000000, signals: [{ f: 99100000, width: 150000, over: 30 }] }, WFM)), "", "a station half off the top");
	equal(at(found({ center: 98000000, signals: [{ f: 96900000, width: 150000, over: 30 }] }, WFM)), "", "a station half off the bottom");
	equal(at(found({ center: 98000000, signals: [{ f: 98900000, width: 150000, over: 30 }] }, WFM)), "98900000", "one that is all there, near the top");
});

test("a channel too wide a part of the span: no telling noise from signal, and it says so", function () {
	equal(pure.signalsIn(line({ center: 98000000, rate: 240000 }), 98000000, 240000, Object.assign({ margin: MARGIN }, WFM)), null,
		"wide FM in a span of 240 kHz");
	ok(Array.isArray(found({ center: 98000000, rate: 960000 }, WFM)), "wide FM in a span of 960 kHz can be scanned");
});

test("more bins to the line (the display zoomed in): the same stations", function () {
	[4096, 8192, 16384, 32768].forEach(function (n) {
		const got = found({ center: 98000000, n: n, signals: [
			{ f: 97300000, width: 150000, over: 15 }, { f: 98100000, width: 150000, over: 22 }, { f: 98900000, width: 150000, over: 12 }
		] }, WFM);
		equal(at(got), "97300000,98100000,98900000", "with " + n + " bins");
	});
});

/* A scan, run as the page runs it: the radio moved where scanStep sends
   it, with stations on the air at the frequencies given (each found
   whenever the radio takes it in). scanGo runs it until it stays on a
   signal: { f }; or until it has been all the way round with nothing found:
   { over }; or, so that a test ends, until the radio has been moved `cap`
   times without a signal: { cap, at }. With each: how often the radio was
   moved, the band the scan is in and the one it has left. */
function scanGo(s, c, o) {
	const reach = o.reach || [1000000, 6000000000], rate = o.rate || 2400000, bw = o.bw;
	let moves = 0;
	for (let guard = 0; guard < 20000; guard++) {
		const dr = [c - 0.47 * rate + bw / 2, c + 0.47 * rate - bw / 2];
		const sig = o.stations.filter(function (f) { return f >= dr[0] && f <= dr[1]; })
			.sort(function (a, b) { return a - b; }).map(function (f) { return { f: f }; });
		const r = pure.scanStep(s, dr, sig, o.step, bw, reach);
		if (r.tune != null) return { f: r.tune, moves: moves, left: s.left, band: s.band, s: s, c: c };
		if (r.over) return { over: true, moves: moves, left: s.left };
		if (r.move) {
			if (moves >= (o.cap || 60)) return { cap: true, at: s.at, moves: moves, left: s.left };
			c = pure.scanCentre(s.at, rate, -bw / 2, reach);
			moves++;
		}
	}
	return { stuck: true };
}
// From a place on the dial, to the first signal the scan stays on
function scanned(from, stations, set, more) {
	const o = Object.assign({ stations: stations }, set, more);
	return scanGo(pure.scanFrom(from, o.mode, o.step, o.reach || [1000000, 6000000000]), from - (o.rate || 2400000) / 8, o);
}
// Left to run: the signals it stays on, one after another, and how it ended if it did
function stays(from, stations, set, count, more) {
	const o = Object.assign({ stations: stations }, set, more), at = [];
	let r = scanGo(pure.scanFrom(from, o.mode, o.step, o.reach || [1000000, 6000000000]), from - (o.rate || 2400000) / 8, o);
	while (r.f != null && at.length < count) {
		at.push(r.f);
		pure.scanOn(r.s, r.f, o.step);
		r = scanGo(r.s, r.c, o);
	}
	return { at: at.join(), end: r };
}
const WIDE = { mode: "wfm", bw: 180000, step: 100000 }, NARROW = { mode: "nfm", bw: 12500, step: 25000 };

test("a scan in the FM band, listened to as FM: up to the next station, and from the last round to the first", function () {
	const on = [96900000, 100700000, 102500000];
	equal(scanned(96900000, on, WIDE).f, 100700000, "from 96.9");
	equal(scanned(100700000, on, WIDE).f, 102500000, "from 100.7");
	const round = scanned(102500000, on, WIDE);
	equal(round.f, 96900000, "from 102.5, the highest");
	ok(round.band === "FM radio" && round.left === "", "and it never left the band: " + JSON.stringify(round));
	equal(scanned(98100000, on, WIDE).f, 100700000, "from a place with no station on it");
	equal(scanned(104000000, on, WIDE).f, 96900000, "from above them all");
});

test("a band with nothing else in it is left behind: the scan goes on above it", function () {
	// 160.0 MHz is in the marine band (156 to 162.025): narrow FM, as that band is listened to
	const up = scanned(160000000, [160000000, 162550000], NARROW);
	equal(up.f, 162550000, "from the only signal in the band, to the next one above the band");
	equal(up.left, "Marine", "the band it left");
	equal(scanned(160000000, [162550000], NARROW).f, 162550000, "from a place with no signal on it, likewise");
	// nothing above either: it goes on and on up, not back where it began
	const far = scanned(160000000, [160000000], NARROW);
	ok(far.cap === true && far.left === "Marine", "nothing anywhere near: " + JSON.stringify(far));
	atLeast(far.at, 162025000 + 50 * 2000000, "how far up it had looked, sixty moves of the radio on, Hz");
	// the one station of an FM band: on, above the band (here, to an aircraft's frequency)
	const out = scanned(98100000, [98100000, 121500000], WIDE);
	ok(out.f === 121500000 && out.left === "FM radio", "the only station on FM: " + JSON.stringify(out));
	// but something else in the band keeps it there, though it lies below
	const stay = scanned(160000000, [156800000, 160000000, 162550000], NARROW);
	ok(stay.f === 156800000 && stay.left === "", "another signal in the band, below: " + JSON.stringify(stay));
});

test("the same place listened to another way is no band: the scan goes straight on up", function () {
	equal(pure.scanFrom(160000000, "nfm", 25000, [1000000, 6000000000]).band, "Marine", "160 MHz in narrow FM");
	equal(pure.scanFrom(160000000, "wfm", 100000, [1000000, 6000000000]).band, "", "160 MHz in wide FM");
	equal(pure.scanFrom(98100000, "wfm", 100000, [1000000, 6000000000]).band, "FM radio", "98.1 MHz in wide FM");
	equal(pure.scanFrom(98100000, "am", 5000, [1000000, 6000000000]).band, "", "98.1 MHz in AM");
	// in wide FM at 160 MHz: past the marine band's top without a look back at its bottom
	const up = scanned(160000000, [158000000, 171200000], WIDE);
	ok(up.f === 171200000 && up.left === "" && up.band === "", "what it found: " + JSON.stringify(up));
});

test("outside every band: on up the dial, a span at a time", function () {
	const hit = scanned(500000000, [512300000], WIDE);
	equal(hit.f, 512300000, "the next signal up");
	ok(hit.moves >= 5 && hit.moves <= 8, "the radio moved a span at a time: " + hit.moves + " moves for 12.3 MHz");
	const none = scanned(500000000, [], WIDE, { cap: 30 });
	ok(none.cap === true && none.moves === 30, "nothing there: " + JSON.stringify(none));
	atLeast(none.at, 500000000 + 29 * 1900000, "how far it had looked, Hz");
	atMost(none.at, 500000000 + 31 * 2400000, "and no further than the radio went, Hz");
});

test("a band narrower than what the radio takes in: round it without the radio moving", function () {
	const on = [162400000, 162475000, 162550000];
	const a = scanned(162550000, on, NARROW), b = scanned(162400000, on, NARROW), c = scanned(162475000, on, NARROW);
	ok(a.f === 162400000 && a.moves === 0 && a.band === "Weather radio", "from the top channel: " + JSON.stringify(a));
	ok(b.f === 162475000 && b.moves === 0, "from the bottom one: " + JSON.stringify(b));
	ok(c.f === 162550000 && c.moves === 0, "from the middle one: " + JSON.stringify(c));
});

test("left to run, a scan stays on one signal after another: round and round the band's stations", function () {
	const fm = stays(96900000, [96900000, 100700000, 102500000], WIDE, 7);
	equal(fm.at, "100700000,102500000,96900000,100700000,102500000,96900000,100700000", "where it stayed, from 96.9 MHz");
	ok(fm.end.band === "FM radio" && fm.end.left === "", "and never out of the band: " + JSON.stringify({ band: fm.end.band, left: fm.end.left }));
	// two in a band: to and fro between them
	equal(stays(160000000, [156800000, 160000000], NARROW, 4).at, "156800000,160000000,156800000,160000000", "two signals in the marine band");
});

test("left to run with a band's only signal behind it: out of the band, and on up from signal to signal", function () {
	// the marine band's one signal, then two weather channels above the band, then nothing
	const up = stays(160000000, [160000000, 162400000, 162550000], NARROW, 5, { cap: 12 });
	equal(up.at, "162400000,162550000", "where it stayed");
	ok(up.end.cap === true && up.end.left === "Marine", "and then on up, with nothing more to find: " + JSON.stringify(up.end));
	// the same with one station on FM, and aircraft above the band
	// (round the FM band first: ten moves of the radio or so, before it goes on above it)
	const fm = stays(98100000, [98100000, 121500000, 127850000], WIDE, 5, { cap: 40 });
	equal(fm.at, "121500000,127850000", "from the only station on FM");
	equal(fm.end.left, "FM radio", "the band it left");
	// and a band with nothing in it at all is left at once
	equal(stays(160000000, [162550000], NARROW, 1).at, "162550000", "from an empty marine band");
});

test("the top of what the radio tunes: round to the bottom; all the way round and nothing, and it is over", function () {
	const rtl = { reach: [24000000, 1766000000], cap: 5000 };
	const round = scanned(1765000000, [30000000], NARROW, rtl);
	ok(round.f === 30000000 && round.moves <= 6, "from just under the top: " + JSON.stringify(round));
	const none = scanned(1765000000, [], NARROW, rtl);
	ok(none.over === true, "nothing on the air at all: " + JSON.stringify(none));
});

test("the radio is moved so that where the scan has got to is just inside what it takes in", function () {
	[[WIDE, 2400000], [NARROW, 2400000], [NARROW, 240000], [WIDE, 9600000]].forEach(function (p) {
		const set = p[0], rate = p[1], at = 433000000, c = pure.scanCentre(at, rate, -set.bw / 2, [1000000, 6000000000]);
		const low = c - 0.47 * rate + set.bw / 2;
		ok(low <= at && at - low <= 0.03 * rate, set.mode + " at " + rate + ": the lowest dial frequency taken in is " + (at - low) + " Hz under it");
	});
	equal(pure.scanCentre(5999500000, 2400000, -90000, [1000000, 6000000000]), 6000000000, "and never beyond what the radio tunes");
});

test("favourites, as a browser kept them: only what makes sense comes out, along the dial", function () {
	const long = "x".repeat(200);
	const got = Array.from(pure.cleanFavs([
		null, 5, "text", { name: "no frequency", mode: "wfm" }, { name: "no such mode", f: 1e8, mode: "xyz" },
		{ name: "Weather", f: 162550000, mode: "nfm", bw: 12500, step: 25000 },
		{ name: "   ", f: 100300000.4, mode: "wfm", bw: -5, step: "big" }, { name: "the same again", f: 100300000, mode: "wfm" },
		{ name: long, f: 446000000, mode: "nfm" }, { name: "  Tower \n  north ", f: 118300000, mode: "am" }
	]));
	equal(got.map(function (v) { return v.f; }).join(), "100300000,118300000,162550000,446000000", "sorted by frequency, one of each");
	equal(got[0].name, "100.3 FM", "one with no name is called by where it is");
	ok(got[0].bw === 180000 && got[0].step === 100000, "a width and a step that make no sense become the mode's own");
	equal(got[1].name, "Tower north", "a name's spaces are tidied");
	ok(got[2].bw === 12500 && got[2].step === 25000, "what was kept whole stays as it was");
	equal(got[3].name.length, 28, "a name has its length");
	equal(pure.cleanFavs("not a list").length + pure.cleanFavs(undefined).length, 0, "and nothing at all is no favourites");
	const many = [];
	for (let i = 0; i < 300; i++) many.push({ f: 88000000 + i * 100000, mode: "wfm" });
	equal(pure.cleanFavs(many).length, 100, "a hundred at most");
});

if (require.main === module) run("receiver.js: the Listen page's own reckoning").then(function (failed) { process.exit(failed ? 1 : 0); });
else module.exports = function () { return run("receiver.js: the Listen page's own reckoning"); };
