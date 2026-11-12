/* The parts of the Listen page (receiver.js) that have no page to them:
   the noise in a line of the spectrum; the signals in it, each as wide as
   it is, and where a scan looks next, which is what the Scan button goes
   by; the squelch that sets itself by the same noise; the lines as they
   are kept to measure on; and what is made of the favourites a browser
   kept.

   The lines here are made as the page has them: noise and signals as an
   FFT shows them (every bin's power scattered about its mean, as with one
   FFT to a line, which is the most scattered a line gets), a second of
   them averaged into one, as power; or, where a test says so, a few of
   them eased into one.

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

/* What is on the air, for a line of n bins across `rate` Hz about `center`:
   the mean power in each bin. Noise at FLOOR, and on it
     { f, width, over }           a flat-topped signal (broadcast FM, over a second), `over` dB above the noise
     { f, width, over, peaked }   one with its power towards its middle (a narrow FM carrier; or,
                                  made wide, a hump of noise from the things about an aerial)
     { f, width, over, moving }   broadcast FM as it is from moment to moment: all the power of the
                                  flat-topped one, in a lump 12 kHz across that is somewhere else in
                                  the station's width for every FFT (`rand` says where)
   The radio's own carrier at the centre, with dc: dB above the noise. */
function air(o, rand) {
	const n = o.n || 4096, rate = o.rate || 2400000, binHz = rate / n, base = o.center - rate / 2;
	const mean = new Float64Array(n).fill(Math.pow(10, FLOOR / 10));
	(o.signals || []).forEach(function (s) {
		const top = Math.pow(10, (FLOOR + s.over) / 10), sigma = 3000;
		const at = s.moving ? s.f + (rand() - 0.5) * (s.width - 4 * sigma) : s.f;
		for (let i = 0; i < n; i++) {
			const d = base + (i + 0.5) * binHz - at;
			if (s.moving) mean[i] += top * s.width / (sigma * Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * Math.pow(d / sigma, 2));
			else if (s.peaked) mean[i] += top * Math.exp(-0.5 * Math.pow(d / (s.width / 4), 2));
			else if (Math.abs(d) <= s.width / 2) mean[i] += top;
		}
	});
	if (o.dc != null) for (let i = (n >> 1) - 1; i <= (n >> 1) + 1; i++) mean[i] += Math.pow(10, (FLOOR + o.dc) / 10);
	return mean;
}
// One line of it: the power in each bin as one FFT shows it (or, of something moving, the mean of four)
function shot(mean, rand) {
	const p = new Float64Array(mean.length);
	for (let i = 0; i < p.length; i++) p[i] = mean[i] * -Math.log(1 - rand());
	return p;
}
function shotOf(o, rand) {
	if (!(o.signals || []).some(function (s) { return s.moving; })) return shot(o.mean || (o.mean = air(o)), rand);
	const p = new Float64Array(o.n || 4096);
	for (let k = 0; k < 4; k++) {
		const one = shot(air(o, rand), rand);
		for (let i = 0; i < p.length; i++) p[i] += one[i] / 4;
	}
	return p;
}
/* A line as the page has it to tell signals by: a second of lines (as many
   as a scan's long look goes by, unless told), averaged. */
function line(o) {
	const rand = prng(o.seed || 1), count = o.lines || pure.SCAN_LONG, avg = new Float64Array(o.n || 4096);
	for (let l = 0; l < count; l++) {
		const p = shotOf(o, rand);
		for (let i = 0; i < avg.length; i++) avg[i] += p[i] / count;
	}
	return avg;
}
// And as it has it for a quick look: a few lines, eased
function glance(o) {
	const rand = prng(o.seed || 1), avg = shotOf(o, rand);
	for (let l = 1; l < pure.SCAN_LINES; l++) {
		const p = shotOf(o, rand);
		for (let i = 0; i < avg.length; i++) avg[i] += (p[i] - avg[i]) * 0.45;
	}
	return avg;
}
// A line as the page gets it for its picture: a byte a bin, half a dB to a step
function bytes(p) {
	const q = new Uint8Array(p.length);
	for (let i = 0; i < p.length; i++) q[i] = Math.max(0, Math.min(255, (10 * Math.log10(p[i] + 1e-30) + 127.5) * 2 + 0.5));
	return q;
}
function dB(x) { return 10 * Math.log10(x); }
// What the engine's meter makes of a channel: all the power in it, less what the display's window adds
function level(pow, center, rate, f, bw) {
	const binHz = rate / pow.length, base = center - rate / 2;
	let s = 0;
	for (let i = Math.round((f - bw / 2 - base) / binHz); i < Math.round((f + bw / 2 - base) / binHz); i++) s += pow[i];
	return dB(s / pure.WINDOW_BINS);
}
function signals(pow, o, set) { return pure.signalsIn(pow, o.center, o.rate || 2400000, Object.assign({ margin: MARGIN }, set)); }
function found(o, set) { return signals(line(o), o, set); }
function at(got) { return got.map(function (s) { return s.f; }).join(); }

const WFM = { bw: 180000, mode: "wfm", step: 100000 }, NFM = { bw: 12500, mode: "nfm", step: 12500 };
const AM = { bw: 8000, mode: "am", step: 5000 };

test("broadcast stations among the noise: each where it is, on the dial's steps, lowest first, as wide as it is", function () {
	const got = found({ center: 98000000, signals: [
		{ f: 97300000, width: 150000, over: 15 }, { f: 98100000, width: 150000, over: 22 }, { f: 98900000, width: 150000, over: 12 }
	] }, WFM);
	equal(at(got), "97300000,98100000,98900000", "the stations found");
	got.forEach(function (s) {
		atLeast(s.over, MARGIN, "dB over the noise, at " + s.f);
		near(s.lo, s.f - 75000, 15000, "where the one at " + s.f + " begins");
		near(s.hi, s.f + 75000, 15000, "where it ends");
	});
	ok(got[1].over > got[0].over && got[0].over > got[2].over, "the stronger the station, the more it is over the noise");
	equal(got.cut, null, "of any that runs off the top of the line");
});

test("a station too weak to listen to is passed by", function () {
	const got = found({ center: 98000000, signals: [
		{ f: 97500000, width: 150000, over: 4 }, { f: 98500000, width: 150000, over: 14 }
	] }, WFM);
	equal(at(got), "98500000", "only the one that stands out");
});

test("a weak station that can still be heard is stopped on", function () {
	// 7 dB over the noise in its channel: on the real radio the squelch let one such through,
	// and a scan that wanted 8 dB went past it
	for (let seed = 1; seed <= 20; seed++) {
		const got = found({ center: 100000000, seed: seed, signals: [
			{ f: 100300000, width: 150000, over: 6.8 }, { f: 100700000, width: 150000, over: 15 }
		] }, WFM);
		equal(at(got), "100300000,100700000", "the stations found");
		near(got[0].over, 7, 1, "dB the weak one is over the noise");
	}
});

test("noise alone holds no signal, whatever it happens to look like: not at a glance, not in a second of it", function () {
	let any = 0, glances = 0;
	for (let seed = 1; seed <= 60; seed++) {
		any += found({ center: 433000000, seed: seed }, WFM).length;
		any += found({ center: 433000000, seed: seed + 1000 }, NFM).length;
		any += found({ center: 14200000, seed: seed + 2000, n: 16384 }, { bw: 2700, mode: "usb", step: 100 }).length;
		if (pure.anythingIn(glance({ center: 433000000, seed: seed }), 2400000, 180000, MARGIN - 2)) glances++;
		if (pure.anythingIn(glance({ center: 433000000, seed: seed + 1000 }), 2400000, 12500, MARGIN - 2)) glances++;
		if (pure.anythingIn(glance({ center: 121000000, seed: seed + 3000 }), 2400000, 8000, MARGIN - 2)) glances++;
	}
	equal(any, 0, "signals found in 180 lines of noise");
	equal(glances, 0, "quick looks at noise that took it for something, of 180");
});

test("at a glance: something is there, when a signal that would count is", function () {
	for (let seed = 1; seed <= 20; seed++) {
		ok(pure.anythingIn(glance({ center: 100000000, seed: seed, signals: [{ f: 100300000, width: 150000, over: 6.8 }] }), 2400000, 180000, MARGIN - 2),
			"a weak broadcast station, 7 dB over the noise");
		ok(pure.anythingIn(glance({ center: 462400000, seed: seed, signals: [{ f: 462562500, width: 9000, over: 14, peaked: true }] }), 2400000, 12500, MARGIN - 2),
			"a narrow signal 8 dB over the noise in its channel");
	}
	equal(pure.anythingIn(glance({ center: 98000000, rate: 240000 }), 240000, 180000, MARGIN - 2), null, "a channel too wide for the line");
});

test("the radio's own carrier, in the middle of every line, is not a signal", function () {
	for (let seed = 1; seed <= 20; seed++) {
		equal(at(found({ center: 98000000, dc: 35, seed: seed }, WFM)), "", "wide FM, a carrier 35 dB up");
		equal(at(found({ center: 146000000, dc: 35, seed: seed }, NFM)), "", "narrow FM, a carrier 35 dB up");
		equal(pure.anythingIn(glance({ center: 146000000, dc: 35, seed: seed }), 2400000, 12500, MARGIN - 2), false, "narrow FM, at a glance");
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
	ok(got[0].hi <= got[1].f && got[1].lo >= got[0].f, "the first ends, and the second begins, between the two");
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
	// (and one a little off its channel, as a CB set can be, is on the channel still: not on the whole step beside it)
	equal(at(found({ center: 27100000, n: 8192, signals: [{ f: 27027500, width: 6000, over: 26, peaked: true }] },
		{ bw: 8000, mode: "am", step: 10000, off: 5000 })), "27025000", "a signal 2.5 kHz above a channel");
	// (with whole steps each sits between two, 5 kHz from either, and 8 kHz about a step holds
	// next to nothing of it: the dial goes to the channel all the same, on AM's own steps of 5 kHz)
	equal(at(found(cb, { bw: 8000, mode: "am", step: 10000 })), "27025000,27185000", "with the steps counted from nought");
});

test("a step wider than the channel: the dial goes where the signal is heard, not to a step that misses it", function () {
	// 12.5 kHz of narrow FM on steps of 25 kHz, as the weather and marine bands have them: a
	// carrier 10 kHz above a step (a television station's pilot, on 180.31 MHz)
	const tv = { center: 180000000, signals: [{ f: 180310000, width: 2000, over: 30, peaked: true }] }, coarse = { bw: 12500, mode: "nfm", step: 25000 };
	const got = found(tv, coarse), pow = line(tv);
	equal(at(got), "180312500", "the dial: on narrow FM's own steps of 12.5 kHz");
	near(got[0].mid, 180310000, 600, "where the signal's middle is said to be, Hz");
	atLeast(level(pow, tv.center, 2400000, got[0].f, 12500) - level(pow, tv.center, 2400000, 180300000, 12500), 15,
		"dB more in the channel there than in the one on the nearest 25 kHz step");
	atLeast(level(pow, tv.center, 2400000, got[0].f, 12500), squelchAt(pow, tv.center, 2400000, got[0].f, 12500),
		"the level there, against the squelch that sets itself");
	atMost(level(pow, tv.center, 2400000, 180300000, 12500), squelchAt(pow, tv.center, 2400000, 180300000, 12500),
		"and on the step, where the dial went before: the level, against that squelch");
	// one that a step's channel does hold stays on the step
	equal(at(found({ center: 180000000, signals: [{ f: 180303000, width: 2000, over: 30, peaked: true }] }, coarse)), "180300000", "a carrier 3 kHz above a step");
	// 8 kHz of AM on steps of 25 kHz, as the aircraft band has them: on AM's own steps of 5 kHz
	equal(at(found({ center: 123500000, n: 8192, signals: [{ f: 123836000, width: 1500, over: 30, peaked: true }] }, { bw: 8000, mode: "am", step: 25000 })),
		"123835000", "a carrier 11 kHz above a step, in AM");
	// between two of the mode's own steps, where the channel on either holds half of it: on a whole kHz
	equal(at(found({ center: 151000000, signals: [{ f: 151156000, width: 9000, over: 24, peaked: true }] }, NFM)), "151156000",
		"a narrow FM signal 6 kHz above a step of 12.5 kHz");
	// (4 kHz from one, most of it is in that step's channel: there it stays)
	equal(at(found({ center: 151000000, signals: [{ f: 151154000, width: 9000, over: 24, peaked: true }] }, NFM)), "151150000",
		"one 4 kHz above a step of 12.5 kHz");
	// and a broadcast station found a little off its step is on its step still
	equal(at(found({ center: 98000000, signals: [{ f: 98112000, width: 150000, over: 15 }] }, WFM)), "98100000", "a station 12 kHz off its step, in wide FM");
});

test("the shoulders of a strong station are not stations", function () {
	const got = found({ center: 98000000, signals: [
		{ f: 98100000, width: 150000, over: 45 },
		{ f: 97900000, width: 70000, over: 22 }, { f: 98300000, width: 70000, over: 22 },      // its digital sidebands
		{ f: 97300000, width: 150000, over: 22 }                                                 // as strong as they are, but by itself
	] }, WFM);
	equal(at(got), "97300000,98100000", "what is found");
});

test("a narrow signal beside a broadcast station does not count for what the station puts in its channel", function () {
	// The radio's own carrier at 100.8 MHz, on the skirt of a station at 100.7: seen on the real one.
	// Wide FM's channel about the carrier holds half the station
	for (let seed = 1; seed <= 10; seed++) {
		const o = { center: 100400000, seed: seed, signals: [{ f: 100700000, width: 150000, over: 20 }, { f: 100800000, width: 2400, over: 22, peaked: true }] };
		equal(at(found(o, WFM)), "100700000", "listening in wide FM");
		equal(at(found(o, AM)), "100700000,100800000", "and 8 kHz at a time, where the carrier is a signal of its own");
	}
});

test("sideband: the dial is at the channel's edge, not its middle", function () {
	const usb = found({ center: 14200000, n: 16384, signals: [{ f: 14251350, width: 2700, over: 25 }] }, { bw: 2700, mode: "usb", step: 100 });
	equal(usb.length, 1, "upper sideband: signals found");
	// (to within a few bins: the signal's own unevenness, in so few of them, moves its middle about)
	near(usb[0].f, 14250000, 600, "the dial for a voice from 14.2500 to 14.2527 MHz");
	near(usb[0].hi - usb[0].lo, 2700, 1500, "how wide it is");
	ok(usb[0].lo < usb[0].f + 600 && usb[0].hi > usb[0].f - 600, "its ends are given as the dial is: about the dial frequency");
	const lsb = found({ center: 7100000, n: 16384, signals: [{ f: 7148650, width: 2700, over: 25 }] }, { bw: 2700, mode: "lsb", step: 100 });
	equal(lsb.length, 1, "lower sideband: signals found");
	near(lsb[0].f, 7150000, 600, "the dial for a voice from 7.1473 to 7.1500 MHz");
});

test("what runs off the end of a line is left for another look: and where it begins, or ends, is said", function () {
	// the line's usable part ends 1.128 MHz from the centre: this station's middle is beyond it
	let got = found({ center: 98000000, signals: [{ f: 99100000, width: 150000, over: 30 }] }, WFM);
	equal(at(got), "", "a station half off the top");
	near(got.cut, 99025000, 15000, "where it begins");
	equal(got.cutLow, null, "and nothing runs off the bottom");
	got = found({ center: 98000000, signals: [{ f: 96900000, width: 150000, over: 30 }] }, WFM);
	equal(at(got), "", "a station half off the bottom");
	equal(got.cut, null, "and it is not at the top");
	near(got.cutLow, 96975000, 15000, "where it ends");
	got = found({ center: 98000000, signals: [{ f: 98900000, width: 150000, over: 30 }] }, WFM);
	equal(at(got), "98900000", "one that is all there, near the top");
	ok(got.cut === null && got.cutLow === null, "nothing runs off: " + got.cut + ", " + got.cutLow);
	// 8 kHz at a time, the same station is as wide as ever: off the top all the same
	got = found({ center: 98000000, signals: [{ f: 99100000, width: 150000, over: 30 }] }, AM);
	equal(at(got), "", "listened to as AM");
	near(got.cut, 99025000, 15000, "where it begins");
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

test("a broadcast station is one signal, as wide as it is, however it is listened to", function () {
	for (let seed = 1; seed <= 20; seed++) {
		const o = { center: 98000000, seed: seed, signals: [{ f: 98300000, width: 150000, over: 20 }, { f: 97400000, width: 150000, over: 9 }] };
		[WFM, NFM, AM, { bw: 2700, mode: "usb", step: 100 }].forEach(function (set) {
			const got = found(o, set), shift = set.mode === "usb" ? -1350 : 0;
			equal(got.length, 2, "signals found, listening in " + set.mode);
			near(got[1].f, 98300000 + shift, Math.max(set.step, 10000), "the dial for the strong one, in " + set.mode);
			near(got[1].lo, 98225000 + shift, 12000, "where it begins");
			near(got[1].hi, 98375000 + shift, 12000, "where it ends");
			near(got[0].f, 97400000 + shift, Math.max(set.step, 15000), "the dial for the weak one, in " + set.mode);
		});
	}
});

test("a station's carrier moves with its sound: lumps at a glance, one signal in a second of it", function () {
	let lumpy = 0;
	for (let seed = 1; seed <= 20; seed++) {
		const o = { center: 100000000, seed: seed, signals: [{ f: 100300000, width: 150000, over: 14, moving: true }] };
		// a fifth of a second: something is there, but what is not to be told
		ok(pure.anythingIn(glance(o), 2400000, 8000, MARGIN - 2), "at a glance, something is there");
		if (signals(glance(o), o, AM).length !== 1) lumpy++;
		// a second: the station
		[AM, NFM, WFM].forEach(function (set) {
			const got = found(o, set);
			equal(got.length, 1, "signals in a second of it, listening in " + set.mode);
			near(got[0].f, 100300000, 20000, "the dial for it");
			atLeast(got[0].hi - got[0].lo, 90000, "Hz wide");
			atMost(got[0].hi - got[0].lo, 190000, "Hz wide");
		});
	}
	atLeast(lumpy, 12, "glances, of 20, in which it looked like anything but one signal");
});

/* What an aerial picks up from the things about it comes in humps: here one
   8 dB up at its middle, most of it within 400 kHz. On the real radio (a
   HackRF beside the router, 88 to 137 MHz) there was one every 750 kHz. A
   hump is not to be told from a signal as wide: it is one, and a scan stops
   on it once. */
const HUMP = { f: 121900000, width: 800000, over: 8, peaked: true };

test("a hump of noise is one wide signal: stopped on once, at its middle, if it stands out enough", function () {
	for (let seed = 1; seed <= 20; seed++) {
		const got = found({ center: 122000000, seed: seed, signals: [HUMP] }, AM);
		equal(got.length, 1, "signals in a line with a hump 8 dB up in it");
		near(got[0].f, 121900000, 60000, "the dial for it");
		atLeast(got[0].hi - got[0].lo, 300000, "Hz wide");
		equal(found({ center: 122000000, seed: seed, signals: [{ f: 121900000, width: 800000, over: 3, peaked: true }] }, AM).length, 0,
			"signals in a line with a hump 5 dB up");
	}
});

test("a carrier on something wide: one signal with it, and the dial on the carrier if that is what stands out", function () {
	for (let seed = 1; seed <= 10; seed++) {
		// a carrier 4 dB over the hump it is on: the hump, at its middle
		let got = found({ center: 122000000, seed: seed, signals: [HUMP, { f: 122050000, width: 6000, over: 14, peaked: true }] }, AM);
		equal(got.length, 1, "signals, of a hump and a carrier that barely shows on it");
		near(got[0].f, 121900000, 60000, "the dial: the hump's middle");
		// one 18 dB over it: still one signal, as wide as the hump, and the dial on the carrier
		got = found({ center: 122000000, seed: seed, signals: [HUMP, { f: 122050000, width: 6000, over: 26, peaked: true }] }, AM);
		equal(at(got), "122050000", "of a hump and a carrier that stands well out of it");
		atLeast(got[0].hi - got[0].lo, 300000, "Hz wide");
		// and the same listening to a broadcast station 8 kHz at a time, its carrier strong in a quiet passage
		got = found({ center: 98000000, seed: seed, signals: [{ f: 98300000, width: 150000, over: 12 }, { f: 98300000, width: 3000, over: 30, peaked: true }] }, AM);
		equal(at(got), "98300000", "of a station with a strong carrier at its middle");
		near(got[0].hi - got[0].lo, 150000, 25000, "Hz wide");
	}
});

test("the noise beside a channel: what the line holds there, the signals looked past", function () {
	const center = 122000000, rate = 2400000, floor = Math.pow(10, FLOOR / 10);
	for (let seed = 1; seed <= 10; seed++) {
		const pow = line({ center: center, seed: seed, signals: [HUMP,
			{ f: 121900000, width: 6000, over: 30, peaked: true }, { f: 122900000, width: 6000, over: 30, peaked: true },
			{ f: 122925000, width: 6000, over: 30, peaked: true }] });
		near(dB(pure.noiseAt(pow, center, rate, 122900000, 8000).beside / floor), 0, 1.5, "in the clear, a strong signal in the channel and another beside it (dB over the floor)");
		near(dB(pure.noiseAt(pow, center, rate, 121900000, 8000).beside / floor), 8.6, 1.5, "in the middle of the hump, a strong signal in the channel");
		near(dB(pure.noiseAt(pow, center, rate, 122400000, 8000).beside / floor), 0.4, 1.5, "on the hump's skirt");
		near(dB(pure.noiseAt(pow, center, rate, 130000000, 8000).beside / floor), 0, 1.5, "for a channel that is not in the line: the whole line's");
		near(dB(pure.noiseAt(pow, center, rate, 121900000, 8000).line / floor), 0, 1.5, "the whole line's, hump and signals looked past");
	}
	// Broadcast FM: six channels either side is the whole line, and the stations in it are looked past
	const fm = line({ center: 98000000, signals: [{ f: 97300000, width: 150000, over: 30 }, { f: 98100000, width: 150000, over: 40 },
		{ f: 98500000, width: 150000, over: 25 }, { f: 98900000, width: 150000, over: 30 }] });
	near(dB(pure.noiseAt(fm, 98000000, rate, 98100000, 180000).beside / floor), 0, 1, "beside the strongest of four stations");
});

// The squelch that sets itself, as the page sets it: by the noise beside the channel, or the whole line's where that is less
function squelchAt(pow, center, rate, f, bw) {
	const noise = pure.noiseAt(pow, center, rate, f, bw);
	return pure.squelchFor(Math.min(noise.beside, noise.line), bw, rate / pow.length);
}

test("what a scan stops on opens the squelch that sets itself; noise alone does not", function () {
	const rate = 2400000;
	let stops = 0, weakest = Infinity;
	function tried(o, set, empty) {
		const pow = line(o), got = signals(pow, o, set);
		got.forEach(function (s) {
			atLeast(level(pow, o.center, rate, s.f, set.bw), squelchAt(pow, o.center, rate, s.f, set.bw),
				"the level of a channel the scan stops on (" + s.f + ", " + s.over.toFixed(1) + " dB over), against its squelch");
			stops++;
			weakest = Math.min(weakest, s.over);
		});
		// and a channel with nothing in it stays shut, by a good 3 dB
		atMost(level(pow, o.center, rate, empty, set.bw), squelchAt(pow, o.center, rate, empty, set.bw) - 3, "the level of an empty channel, against its squelch");
	}
	for (let seed = 1; seed <= 12; seed++) {
		// stations and carriers from just under what counts to well over it
		[4.5, 5.5, 6, 6.5, 7.5, 10].forEach(function (over, i) {
			tried({ center: 98000000, seed: 10 * seed + i, signals: [{ f: 97700000, width: 150000, over: over }] }, WFM, 98600000);
			tried({ center: 462400000, seed: 100 * seed + i, signals: [{ f: 462562500, width: 9000, over: over + 6, peaked: true }] }, NFM, 462800000);
			tried({ center: 98000000, seed: 1000 * seed + i, signals: [{ f: 98300000, width: 150000, over: over + 2 }] }, AM, 98900000);
		});
	}
	atLeast(stops, 100, "channels the scan stopped on, of 216 lines");
	atMost(weakest, MARGIN + 1, "dB over the noise of the weakest of them (some were at the margin)");
});

test("the squelch that sets itself shuts out only what is no more than noise anywhere on the line", function () {
	const rate = 2400000;
	for (let seed = 1; seed <= 10; seed++) {
		// A broadcast station listened to as AM, 8 kHz of it: beside the channel is more of the station. It is heard (badly)
		const fm = line({ center: 98000000, seed: seed, signals: [{ f: 98300000, width: 150000, over: 20 }] });
		atLeast(level(fm, 98000000, rate, 98295000, 8000), squelchAt(fm, 98000000, rate, 98295000, 8000) + 10, "the level of 8 kHz inside a broadcast station, against its squelch");
		// The middle of a hump of noise 8 dB up: heard too
		const hump = line({ center: 122000000, seed: seed, signals: [HUMP] });
		atLeast(level(hump, 122000000, rate, 121900000, 8000), squelchAt(hump, 122000000, rate, 121900000, 8000) + 1, "the level in the middle of a hump of noise, against its squelch");
		// and noise that is like the noise everywhere stays shut out
		atMost(level(hump, 122000000, rate, 122900000, 8000), squelchAt(hump, 122000000, rate, 122900000, 8000) - 3, "the level of a channel in the clear");
	}
});

test("lines that come after the radio has moved can hold what it heard before: they are not measured on", function () {
	// A strong station was 700 kHz above the radio's centre. The radio moves 2 MHz up, to where there
	// is a weaker one 300 kHz above its centre. For two lines the old one still shows where it had been
	// on the screen; and again for two lines half a second later, as the HackRF's driver has it
	const o = { center: 100000000, signals: [{ f: 100300000, width: 150000, over: 12 }] };
	const was = air({ center: 98000000, signals: [{ f: 98700000, width: 150000, over: 30 }] }), is = air(o);
	const rand = prng(7), power = new pure.PowerLine(), naive = new Float64Array(4096);
	function old(l) { return l < 2 || l === 9 || l === 10; }
	let lines = 0, glanced = 0;
	// (it had been where it was for a good while)
	for (let l = 0; l < 60; l++) power.take(bytes(shot(was, rand)), l === 0);
	ok(power.settled(pure.SCAN_LINES) && power.averaged(pure.SCAN_LONG), "a radio that has stayed put can be looked at, both ways");
	equal(at(signals(power.long, { center: 98000000 }, WFM)), "98700000", "the station, before the move");
	for (;;) {
		const p = shot(old(lines) ? was : is, rand);
		power.take(bytes(p), lines === 0);
		if (lines >= 3 && lines < 23) for (let i = 0; i < naive.length; i++) naive[i] += p[i] / 20;
		lines++;
		if (!glanced && power.settled(pure.SCAN_LINES)) {
			glanced = lines;
			ok(pure.anythingIn(power.pow, 2400000, 180000, MARGIN - 2), "the quick look, " + lines + " lines after the move: something is here");
		}
		if (power.averaged(pure.SCAN_LONG)) break;
		ok(lines < 100, "the long look comes");
	}
	equal(glanced, pure.SETTLE_LINES + pure.SCAN_LINES, "lines after a move before the quick look");
	equal(lines, pure.GUARD_LINES + pure.SCAN_LONG, "lines after a move before the long one");
	equal(at(signals(power.long, o, WFM)), "100300000", "the signals after the move");
	// (the second from the fourth line on would still hold the station of before the move, as one at 100.7 MHz)
	equal(at(signals(naive, o, WFM)), "100300000,100700000", "what the lines 4 to 23 after the move, averaged, would show");
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
			c = pure.scanCentre(s.at, rate, s.dir < 0 ? bw / 2 : -bw / 2, reach, s.dir);
			moves++;
		}
	}
	return { stuck: true };
}
// From a place on the dial, to the first signal the scan stays on (up the dial; down it, with dir: -1)
function scanned(from, stations, set, more) {
	const o = Object.assign({ stations: stations }, set, more);
	return scanGo(pure.scanFrom(from, o.mode, o.step, o.reach || [1000000, 6000000000], o.dir), from - (o.rate || 2400000) / 8, o);
}
// Left to run: the signals it stays on, one after another, and how it ended if it did
function stays(from, stations, set, count, more) {
	const o = Object.assign({ stations: stations }, set, more), at = [];
	let r = scanGo(pure.scanFrom(from, o.mode, o.step, o.reach || [1000000, 6000000000], o.dir), from - (o.rate || 2400000) / 8, o);
	while (r.f != null && at.length < count) {
		at.push(r.f);
		pure.scanOn(r.s, r.f, o.step, undefined, undefined, o.bw);
		r = scanGo(r.s, r.c, o);
	}
	return { at: at.join(), end: r };
}
const WIDE = { mode: "wfm", bw: 180000, step: 100000 }, NARROW = { mode: "nfm", bw: 12500, step: 25000 }, DOWN = { dir: -1 };

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
	// (once round the band, and on from its top: not up through it again)
	atMost(out.moves, 22, "moves of the radio, from the only station on FM to one above the band");
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
	// two channels side by side, 15 kHz apart and 12.5 kHz listened to: each a stop, to and fro
	equal(stays(146000000, [146520000, 146535000], { mode: "nfm", bw: 12500, step: 5000 }, 3).at, "146520000,146535000,146520000", "two channels side by side on 2 m");
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

test("a band's only signal at its very top: left behind with the band, not stopped on again", function () {
	// 162.55 MHz: the weather band's top channel, and where the page goes to listen to that band
	const up = scanned(162550000, [162550000, 168000000], NARROW);
	ok(up.f === 168000000 && up.left === "Weather radio", "from the one weather station, with a signal above the band: " + JSON.stringify({ f: up.f, left: up.left }));
	const none = scanned(162550000, [162550000], NARROW, { cap: 12 });
	ok(none.cap === true && none.left === "Weather radio", "and with nothing above: " + JSON.stringify(none));
	// come to from below, and stayed on: the same
	equal(stays(162400000, [162550000, 168000000], NARROW, 4, { cap: 12 }).at, "162550000,168000000", "where a scan from the band's bottom stayed");
	// begun on it, as the page begins a scan on a signal: on from where the signal ends
	const reach = [1000000, 6000000000], dr = [161300000, 163500000], s = pure.scanFrom(162550000, "nfm", 25000, reach);
	const sig = [{ f: 162550000, lo: 162544000, hi: 162556000 }];
	pure.scanOn(s, 162550000, 25000, 162556000);
	let r, tries = 0;
	do { r = pure.scanStep(s, dr, sig, 25000, 12500, reach); } while (r.look && ++tries < 6);
	ok(r.move === true && r.tune == null, "the step after the looks: " + JSON.stringify(r));
	equal(s.left, "Weather radio", "the band it left");
	atLeast(s.at, 162556000, "where it looks from next, Hz");
	// but with another weather station on the air it stays in the band
	const two = scanned(162550000, [162400000, 162550000], NARROW);
	ok(two.f === 162400000 && two.left === "" && two.band === "Weather radio", "with a second weather station: " + JSON.stringify({ f: two.f, left: two.left, band: two.band }));
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

test("on from a signal: the next is looked for above where it ends, not in the rest of it", function () {
	const reach = [1000000, 6000000000], dr = [98900000, 101100000];
	// Listening 8 kHz at a time in the FM band (no band of the page's is listened to that way): two stations
	const sig = [{ f: 100300000, lo: 100225000, hi: 100375000 }, { f: 100700000, lo: 100610000, hi: 100790000 }];
	const s = pure.scanFrom(100000000, "am", 5000, reach);
	let r = pure.scanStep(s, dr, sig, 5000, 8000, reach);
	equal(r.tune, 100300000, "the first signal up");
	equal(r.hi, 100375000, "and where it ends");
	pure.scanOn(s, r.tune, 5000, r.hi);
	equal(s.at, 100375000, "where the scan goes on from");
	// (the next look may make two of the first station, or put its end a little higher: it is behind all the same)
	r = pure.scanStep(s, dr, [{ f: 100270000, lo: 100225000, hi: 100310000 }, { f: 100345000, lo: 100310000, hi: 100382000 }, sig[1]], 5000, 8000, reach);
	equal(r.tune, 100700000, "the next stop");
	// with no end given (none known), on from half a step up, as before
	pure.scanOn(s, 100700000, 5000);
	equal(s.at, 100702500, "from a signal whose end is not known");
	// begun on a station, off its middle: on from its end
	const t = pure.scanFrom(100250000, "am", 5000, reach);
	pure.scanOn(t, 100250000, 5000, 100375000);
	equal(pure.scanStep(t, dr, sig, 5000, 8000, reach).tune, 100700000, "the first stop of a scan begun inside the first station");
	equal(t.from, 100250000, "where its round is counted from");
});

test("a carrier between two of the dial's steps is one signal, on whichever step a look puts it: not stopped on twice", function () {
	const reach = [1000000, 6000000000], dr = [436300000, 438500000];
	// 437.5025 MHz or so, on steps of 5 kHz: on the step below it in one look, on the step above in the next
	const down = { f: 437500000, mid: 437502400, lo: 437501000, hi: 437503600 }, up = { f: 437505000, mid: 437502600, lo: 437501200, hi: 437504200 };
	const next = { f: 437600000, mid: 437600100, lo: 437598800, hi: 437601300 };
	const s = pure.scanFrom(436500000, "nfm", 5000, reach);
	let r = pure.scanStep(s, dr, [down, next], 5000, 12500, reach);
	equal(r.tune, 437500000, "the first stop");
	ok(r.lo === down.lo && r.hi === down.hi, "and where the signal begins and ends: " + JSON.stringify(r));
	pure.scanOn(s, r.tune, 5000, r.hi, r.lo);
	equal(pure.scanStep(s, dr, [up, next], 5000, 12500, reach).tune, 437600000, "the stop after, the carrier found on the step above this time");
	// (a signal of its own on that step is another matter)
	const t = pure.scanFrom(436500000, "nfm", 5000, reach), other = { f: 437505000, mid: 437505200, lo: 437503900, hi: 437506400 };
	pure.scanOn(t, 437500000, 5000, down.hi, down.lo);
	equal(pure.scanStep(t, dr, [other, next], 5000, 12500, reach).tune, 437505000, "a second carrier, 3 kHz above the first");
	// A scan begun with the dial on the step under the carrier: the dial is not in the carrier, as
	// narrow as that is, but the dial's channel holds it. On, from where it ends
	const u = pure.scanFrom(437500000, "nfm", 5000, reach);
	pure.scanBegun(u, [up, next], 437500000, 5000, 12500);
	equal(pure.scanStep(u, dr, [up, next], 5000, 12500, reach).tune, 437600000, "the first stop of a scan begun with that carrier in the dial's channel");
	// (begun 20 kHz under it, the carrier is a stop like any other)
	const w = pure.scanFrom(437480000, "nfm", 5000, reach);
	pure.scanBegun(w, [up, next], 437480000, 5000, 12500);
	equal(pure.scanStep(w, dr, [up, next], 5000, 12500, reach).tune, 437505000, "the first stop of a scan begun 20 kHz under it");
	// begun inside something wide, the dial off its middle: on from its end, as before
	const x = pure.scanFrom(100250000, "am", 5000, reach), fm = [{ f: 100300000, mid: 100298000, lo: 100225000, hi: 100375000 }, { f: 100700000, mid: 100701000, lo: 100610000, hi: 100790000 }];
	pure.scanBegun(x, fm, 100250000, 5000, 8000);
	equal(pure.scanStep(x, [98900000, 101100000], fm, 5000, 8000, reach).tune, 100700000, "the first stop of a scan begun inside a broadcast station");
	// Two carriers 7 kHz apart, each a signal (437.4979 and 437.5047 MHz, as a HackRF makes them). 12.5 kHz at a
	// time, both are in the channel at the first stop: a stop on the second, a step up, would be the same to hear
	const a = { f: 437500000, mid: 437497900, lo: 437495600, hi: 437501500 }, b = { f: 437505000, mid: 437504700, lo: 437501500, hi: 437506700 };
	const y = pure.scanFrom(436500000, "nfm", 5000, reach);
	r = pure.scanStep(y, dr, [a, b, next], 5000, 12500, reach);
	equal(r.tune, 437500000, "the first of two carriers 7 kHz apart");
	pure.scanOn(y, r.tune, 5000, r.hi, r.lo, 12500);
	equal(pure.scanStep(y, dr, [a, b, next], 5000, 12500, reach).tune, 437600000, "the stop after: not the second carrier, which the channel at the first held");
	// (5 kHz at a time, the second is not in the first one's channel: a stop of its own)
	const z = pure.scanFrom(436500000, "nfm", 5000, reach);
	pure.scanOn(z, 437500000, 5000, a.hi, a.lo, 5000);
	equal(pure.scanStep(z, dr, [a, b, next], 5000, 5000, reach).tune, 437505000, "the second carrier, when the channel is 5 kHz wide");
	// (and a carrier 10 kHz up is outside the 12.5 kHz listened to: a stop of its own)
	const c = { f: 437510000, mid: 437509800, lo: 437508600, hi: 437511000 }, q = pure.scanFrom(436500000, "nfm", 5000, reach);
	pure.scanOn(q, 437500000, 5000, a.hi, a.lo, 12500);
	equal(pure.scanStep(q, dr, [a, c, next], 5000, 12500, reach).tune, 437510000, "a carrier 10 kHz above the first");
	// The 433 MHz band (433.05 to 434.79 MHz, steps of 5 kHz) with one signal in it, 434.4025 MHz or so. Stayed on,
	// on the step above it; round the band, where a look puts it on the step below: the same signal, and the band is left
	const above = { f: 434405000, mid: 434402600, lo: 434401200, hi: 434404000 }, below = { f: 434400000, mid: 434402400, lo: 434401000, hi: 434403800 };
	const v = pure.scanFrom(433920000, "nfm", 5000, reach), band = [433000000, 435200000];
	r = pure.scanStep(v, band, [above], 5000, 12500, reach);
	equal(r.tune, 434405000, "the band's one signal");
	pure.scanOn(v, r.tune, 5000, r.hi, r.lo);
	let tries = 0;
	do { r = pure.scanStep(v, band, [below], 5000, 12500, reach); } while (r.look && ++tries < 6);
	ok(r.tune == null && v.left === "433 MHz", "round the band, with that signal found a step lower: " + JSON.stringify({ r: r, left: v.left }));
});

test("a signal that runs off the top of what the radio takes in: the next look begins under it", function () {
	const reach = [1000000, 6000000000], dr = [96962000, 99038000], s = pure.scanFrom(97000000, "wfm", 100000, [87500000, 108000000]);
	// a station from 99.025 MHz up, most of it beyond the line's end
	const sig = [];
	sig.cut = 99025000;
	let r = pure.scanStep(s, dr, sig, 100000, 180000, reach);
	ok(r.move, "the radio is to move");
	equal(s.at, 99025000 - 180000, "to where the look after begins: a channel under the station");
	// and with one found under it in the same look, that one first
	const one = [{ f: 98100000, lo: 98025000, hi: 98175000 }], u = pure.scanFrom(97000000, "wfm", 100000, [87500000, 108000000]);
	one.cut = 99025000;
	equal(pure.scanStep(u, dr, one, 100000, 180000, reach).tune, 98100000, "a station that is all there, under it");
	// A signal that fills the line and more is not waited for: on, a span at a time
	const wide = [], w = pure.scanFrom(97000000, "wfm", 100000, [87500000, 108000000]);
	wide.cut = 97100000;
	r = pure.scanStep(w, dr, wide, 100000, 180000, reach);
	ok(r.move, "the radio is to move");
	equal(w.at, dr[1] - 90000, "from half a channel under the top, as with nothing there");
});

test("a scan down the dial: to the next station under, and from the lowest round to the highest", function () {
	const on = [96900000, 100700000, 102500000];
	equal(scanned(102500000, on, WIDE, DOWN).f, 100700000, "down from 102.5");
	equal(scanned(100700000, on, WIDE, DOWN).f, 96900000, "down from 100.7");
	const round = scanned(96900000, on, WIDE, DOWN);
	equal(round.f, 102500000, "down from 96.9, the lowest");
	ok(round.band === "FM radio" && round.left === "", "and it never left the band: " + JSON.stringify({ band: round.band, left: round.left }));
	equal(scanned(98100000, on, WIDE, DOWN).f, 96900000, "from a place with no station on it");
	equal(scanned(90000000, on, WIDE, DOWN).f, 102500000, "from under them all");
	// of several in what the radio takes in, the nearest under where the scan has got to
	const reach = [1000000, 6000000000], s = pure.scanFrom(101000000, "wfm", 100000, reach, -1);
	equal(s.dir, -1, "the way it is going");
	equal(pure.scanStep(s, [98900000, 101100000], [{ f: 99500000 }, { f: 100300000 }, { f: 100700000 }], 100000, 180000, reach).tune, 100700000,
		"the first stop down from 101.0, with three stations in what the radio takes in");
	// (and a scan is one going up, unless it is said to go down)
	equal(pure.scanFrom(101000000, "wfm", 100000, reach).dir, 1, "the way a scan goes when none is given");
	// left to run: round and round the band's stations, the other way
	equal(stays(96900000, on, WIDE, 6, DOWN).at, "102500000,100700000,96900000,102500000,100700000,96900000", "where it stayed, down from 96.9 MHz");
	equal(stays(160000000, [156800000, 160000000], NARROW, 4, DOWN).at, "156800000,160000000,156800000,160000000", "two signals in the marine band");
});

test("a scan down the dial leaves a band with nothing else in it, and goes on below it", function () {
	// the marine band's one signal, and a carrier under the band
	const down = scanned(160000000, [152030000, 160000000], NARROW, DOWN);
	ok(down.f === 152030000 && down.left === "Marine", "from the only signal in the marine band: " + JSON.stringify({ f: down.f, left: down.left }));
	// (once round the band, and on from its bottom: not down through it again)
	const fm = scanned(98100000, [80000000, 98100000], WIDE, DOWN);
	ok(fm.f === 80000000 && fm.left === "FM radio", "the only station on FM, going down: " + JSON.stringify({ f: fm.f, left: fm.left }));
	atMost(fm.moves, 19, "moves of the radio, from the only station on FM to one under the band");
	// the weather band's bottom channel, the only one on the air: not stopped on again as the band is left
	const w = scanned(162400000, [160000000, 162400000], NARROW, DOWN);
	ok(w.f === 160000000 && w.left === "Weather radio", "from the one weather station, at the band's bottom: " + JSON.stringify({ f: w.f, left: w.left }));
	// but another in the band keeps the scan there, though it lies above
	const stay = scanned(162400000, [162400000, 162550000], NARROW, DOWN);
	ok(stay.f === 162550000 && stay.left === "" && stay.band === "Weather radio", "with a second weather station: " + JSON.stringify({ f: stay.f, left: stay.left, band: stay.band }));
	// left to run with a band's only signal behind it: out of the band, and on down from signal to signal
	const run = stays(160000000, [150000000, 152030000, 160000000], NARROW, 5, Object.assign({ cap: 12 }, DOWN));
	equal(run.at, "152030000,150000000", "where it stayed");
	ok(run.end.cap === true && run.end.left === "Marine", "and then on down, with nothing more to find: " + JSON.stringify(run.end));
	// the bottom of what the radio tunes: round to the top; all the way round and nothing, and it is over
	const rtl = { reach: [24000000, 1766000000], cap: 5000, dir: -1 };
	const round = scanned(25000000, [1700000000], NARROW, rtl);
	ok(round.f === 1700000000 && round.moves <= 40, "from just over the bottom: " + JSON.stringify({ f: round.f, moves: round.moves }));
	ok(scanned(25000000, [], NARROW, rtl).over === true, "nothing on the air at all");
});

test("a scan down the dial goes on from where a signal begins, and waits for one that runs off the bottom", function () {
	const reach = [1000000, 6000000000], dr = [98900000, 101100000];
	// Listening 8 kHz at a time in the FM band: two stations
	const sig = [{ f: 100300000, lo: 100225000, hi: 100375000 }, { f: 100700000, lo: 100610000, hi: 100790000 }];
	const s = pure.scanFrom(101000000, "am", 5000, reach, -1);
	let r = pure.scanStep(s, dr, sig, 5000, 8000, reach);
	equal(r.tune, 100700000, "the first signal down");
	equal(r.lo, 100610000, "and where it begins");
	pure.scanOn(s, r.tune, 5000, r.hi, r.lo, 8000);
	equal(s.at, 100610000, "where the scan goes on from");
	// (the next look may make two of that station: it is behind all the same)
	r = pure.scanStep(s, dr, [sig[0], { f: 100655000, lo: 100602000, hi: 100700000 }, { f: 100745000, lo: 100700000, hi: 100790000 }], 5000, 8000, reach);
	equal(r.tune, 100300000, "the next stop");
	// begun on a station, off its middle: on from where it begins
	const t = pure.scanFrom(100750000, "am", 5000, reach, -1);
	pure.scanBegun(t, sig, 100750000, 5000, 8000);
	equal(pure.scanStep(t, dr, sig, 5000, 8000, reach).tune, 100300000, "the first stop of a scan down, begun inside the upper station");
	// A station most of which is under the end of the line (it ends at 96.975 MHz): the radio is to move, to a channel over it
	const u = pure.scanFrom(99000000, "wfm", 100000, [87500000, 108000000], -1), low = [];
	low.cutLow = 96975000;
	r = pure.scanStep(u, [96962000, 99038000], low, 100000, 180000, reach);
	ok(r.move, "the radio is to move");
	equal(u.at, 96975000 + 180000, "to where the look after begins: a channel over the station");
	// (what runs off the top is nothing to a scan going down; nor what runs off the bottom to one going up)
	const v = pure.scanFrom(99000000, "wfm", 100000, [87500000, 108000000], -1), high = [];
	high.cut = 99025000;
	pure.scanStep(v, [96962000, 99038000], high, 100000, 180000, reach);
	equal(v.at, 96962000 + 90000, "a scan down, with a station off the top: on from half a channel over the bottom");
	const x = pure.scanFrom(97000000, "wfm", 100000, [87500000, 108000000]);
	pure.scanStep(x, [96962000, 99038000], low, 100000, 180000, reach);
	equal(x.at, 99038000 - 90000, "a scan up, with a station off the bottom: on from half a channel under the top");
	// The radio moved for a scan going down: where the scan has got to is just inside the top of what it takes in
	[[WIDE, 2400000], [NARROW, 2400000], [NARROW, 240000], [WIDE, 9600000]].forEach(function (p) {
		const set = p[0], rate = p[1], at = 433000000, c = pure.scanCentre(at, rate, set.bw / 2, reach, -1);
		const high = c + 0.47 * rate - set.bw / 2;
		ok(high >= at && high - at <= 0.03 * rate, set.mode + " at " + rate + ": the highest dial frequency taken in is " + (high - at) + " Hz over it");
	});
	equal(pure.scanCentre(1200000, 2400000, 90000, reach, -1), 1000000, "and never beyond what the radio tunes");
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
