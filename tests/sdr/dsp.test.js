/* The receiver's signal processing (dsp.js), against signals made by the
   formula: what is tuned comes out as it should, what is next to it stays
   out, the display says what is there, and none of it depends on how the
   samples were cut into frames.

   node tests/sdr/dsp.test.js   (ONLY=<regexp> runs the tests whose name matches) */
"use strict";

const path = require("path");
const DSP = require(path.join(__dirname, "../../feed/utils/pirate-radio-ui/files/sdr/dsp.js"));
const S = require("./sig.js");
const { test, run, ok, equal, near, atLeast, atMost } = require("./harness.js");

const RATE = 2400000, CENTER = 100e6, FS = 48000;

// A receiver, and what came out of it
function rig(opts) {
	const got = { chunks: [], lines: [], meters: [] };
	got.rx = new DSP.Receiver(Object.assign({ rate: RATE, center: CENTER }, opts, {
		onAudio: function (a) { got.chunks.push(a); },
		onFft: function (bins, center, rate) { got.lines.push({ bins: bins, center: center, rate: rate }); },
		onMeter: function (m) { got.meters.push(m); }
	}));
	// iq in frames of `frame` samples (the bridge's 20 ms unless told)
	got.feed = function (iq, frame) {
		frame = frame || Math.min(got.rx.rate / 50, 48000);
		for (let o = 0; o < iq.length; o += 2 * frame) {
			const n = Math.min(frame, (iq.length - o) / 2);
			got.rx.process(iq.subarray(o, o + 2 * n), n);
		}
		return got;
	};
	got.audio = function () {
		let n = 0, o = 0;
		got.chunks.forEach(function (c) { n += c.length; });
		const a = new Float32Array(n);
		got.chunks.forEach(function (c) { a.set(c, o); o += c.length; });
		return a;
	};
	got.level = function () { return got.meters[got.meters.length - 1].level; };
	return got;
}

// The signals the tests tune to, `off` Hz from the centre
function fm(off, level, dev, f) { return { type: "fm", offset: off, level: level, deviation: dev, tones: [{ f: f || 1000, a: 1 }] }; }
function am(off, level, f) { return { type: "am", offset: off, level: level, depth: 0.8, f: f || 1000 }; }
function tone(off, level) { return { type: "tone", offset: off, level: level }; }
function iq(parts, o) {
	o = o || {};
	return S.makeIQ({ rate: o.rate || RATE, seconds: o.seconds || 0.6, noise: o.noise === undefined ? -42 : o.noise, dc: o.dc, seed: o.seed || 7, parts: parts });
}
// A second of audio is 48000 samples; the first quarter second is left to settle
function tail(a) { return [Math.min(12000, a.length >> 1), a.length]; }
function amp(a, f) { const t = tail(a); return S.toneAmp(a, FS, f, t[0], t[1]); }
function sinad(a, f) { const t = tail(a); return S.sinad(a, FS, f, t[0], t[1]); }

/* ---------- each mode ---------- */

test("wfm: a 1 kHz tone at 75 kHz deviation, 300 kHz off centre", function () {
	const r = rig({ vfo: CENTER + 300000, mode: "wfm" }).feed(iq([fm(300000, -12, 75000)])), a = r.audio();
	equal(a.length, 0.6 * FS, "audio samples for 0.6 s");
	near(amp(a, 1000), 0.6 * 0.905, 0.03, "1 kHz amplitude");
	atLeast(sinad(a, 1000), 30, "signal over noise and distortion, dB");
	atMost(S.peak(a), 1, "peak");
	near(r.level(), -12, 1, "channel level, dBFS");
});

test("wfm: de-emphasis of 75, 50 and 0 microseconds", function () {
	const sig = iq([{ type: "fm", offset: 300000, level: -12, deviation: 75000, tones: [{ f: 1000, a: 0.4 }, { f: 10000, a: 0.4 }] }], { noise: -60 });
	const want = { 75: -12.8, 50: -9.95, 0: 0 };
	[75, 50, 0].forEach(function (us) {
		const a = rig({ vfo: CENTER + 300000, mode: "wfm", deemph: us }).feed(sig).audio();
		near(S.db(amp(a, 10000) / amp(a, 1000)), want[us], 1.2, "10 kHz against 1 kHz with " + us + " us, dB");
	});
	// and it can be changed while running
	const r = rig({ vfo: CENTER + 300000, mode: "wfm", deemph: 0 });
	r.rx.set({ deemph: 75 });
	const a = r.feed(sig).audio();
	near(S.db(amp(a, 10000) / amp(a, 1000)), -12.8, 1.2, "after set({ deemph: 75 })");
});

test("wfm: the stereo pilot at 19 kHz does not reach the audio", function () {
	const sig = iq([{ type: "fm", offset: 300000, level: -12, deviation: 75000, tones: [{ f: 1000, a: 0.8 }, { f: 19000, a: 0.1 }] }], { noise: -60 });
	const a = rig({ vfo: CENTER + 300000, mode: "wfm", deemph: 0 }).feed(sig).audio();
	atMost(S.db(amp(a, 19000) / amp(a, 1000)), -18 - 50, "pilot against the tone, dB (it went in 18 dB under it)");
});

test("nfm: a 1 kHz tone at 2.5 kHz deviation in a 12.5 kHz channel", function () {
	const r = rig({ vfo: CENTER + 300000, mode: "nfm" }).feed(iq([fm(300000, -12, 2500)])), a = r.audio();
	equal(a.length, 0.6 * FS, "audio samples");
	near(amp(a, 1000), 0.6, 0.06, "1 kHz amplitude");
	atLeast(sinad(a, 1000), 30, "signal over noise and distortion, dB");
	near(r.level(), -12, 1, "channel level, dBFS");
});

test("am: 80 % modulation, the carrier removed", function () {
	const r = rig({ vfo: CENTER + 300000, mode: "am" }).feed(iq([am(300000, -12)])), a = r.audio(), t = tail(a);
	near(amp(a, 1000), 0.8 * 0.6, 0.05, "1 kHz amplitude");
	atLeast(sinad(a, 1000), 30, "signal over noise and distortion, dB");
	atMost(Math.abs(S.mean(a, t[0], t[1])), 0.003, "DC in the audio");
	// carrier power plus the sidebands': 1 + 0.8^2 / 2
	near(r.level(), -12 + 10 * Math.log10(1.32), 1, "channel level, dBFS");
});

test("am: the AGC off, the sound follows the signal's strength", function () {
	const loud = amp(rig({ vfo: CENTER + 300000, mode: "am", agc: false }).feed(iq([am(300000, -20)])).audio(), 1000);
	const soft = amp(rig({ vfo: CENTER + 300000, mode: "am", agc: false }).feed(iq([am(300000, -30)], { noise: -60 })).audio(), 1000);
	near(S.db(loud / soft), 10, 1, "10 dB more signal, dB more sound");
	const on = amp(rig({ vfo: CENTER + 300000, mode: "am" }).feed(iq([am(300000, -30)], { noise: -60 })).audio(), 1000);
	near(on, 0.8 * 0.6, 0.05, "and with it on, the same as a strong one");
});

test("usb and lsb: a carrier 1 kHz above the dial", function () {
	const sig = iq([tone(301000, -30)], { noise: -60 });
	const u = rig({ vfo: CENTER + 300000, mode: "usb", agc: false }).feed(sig), l = rig({ vfo: CENTER + 300000, mode: "lsb", agc: false }).feed(sig);
	const au = amp(u.audio(), 1000), al = amp(l.audio(), 1000);
	near(au, Math.pow(10, -30 / 20) * 8, 0.02, "1 kHz in USB (signal x the fixed gain)");
	atLeast(sinad(u.audio(), 1000), 30, "USB: signal over noise and distortion, dB");
	atMost(S.db(al / au), -40, "the same in LSB against USB, dB");
	near(u.level(), -30, 1, "USB channel level, dBFS");
	atMost(l.level(), -30 - 40, "LSB channel level, dBFS");
});

test("usb and lsb: a carrier 1 kHz below the dial", function () {
	const sig = iq([tone(299000, -30)], { noise: -60 });
	const u = rig({ vfo: CENTER + 300000, mode: "usb", agc: false }).feed(sig), l = rig({ vfo: CENTER + 300000, mode: "lsb", agc: false }).feed(sig);
	const au = amp(u.audio(), 1000), al = amp(l.audio(), 1000);
	near(al, Math.pow(10, -30 / 20) * 8, 0.02, "1 kHz in LSB");
	atMost(S.db(au / al), -40, "the same in USB against LSB, dB");
});

test("usb: with the AGC, weak and strong come out alike", function () {
	// (noise of half a step of the converter, as a radio has: without it a
	// signal under one step would round to nothing)
	[-20, -45].forEach(function (lv) {
		const a = rig({ vfo: CENTER + 300000, mode: "usb" }).feed(iq([tone(301000, lv)], { noise: -45, seconds: 0.8 })).audio();
		near(amp(a, 1000), 0.5, 0.06, "1 kHz amplitude for a carrier at " + lv + " dBFS");
		atLeast(sinad(a, 1000), 22, "signal over noise and distortion at " + lv + " dBFS, dB");
	});
});

test("cw: a carrier on the dial sounds at the pitch", function () {
	const sig = iq([tone(300000, -30)], { noise: -60, seconds: 0.8 });
	const a = rig({ vfo: CENTER + 300000, mode: "cw" }).feed(sig).audio();
	near(amp(a, 700), 0.5, 0.06, "700 Hz amplitude");
	atLeast(sinad(a, 700), 30, "signal over noise and distortion, dB");
	const b = rig({ vfo: CENTER + 300000, mode: "cw", cwPitch: 500 }).feed(sig).audio();
	near(amp(b, 500), 0.5, 0.06, "500 Hz amplitude with cwPitch 500");
	atMost(amp(b, 700), 0.02, "and nothing left at 700 Hz");
});

/* ---------- what is next to the channel stays out ---------- */

// The channel's level with `parts` on the air and nothing else: against the
// level of the same thing tuned in. Loud, so the 8-bit samples' own noise
// (50 dB under full scale across the band) is far below what is measured.
function leak(mode, parts, opts) {
	const r = rig(Object.assign({ vfo: CENTER + 300000, mode: mode }, opts)).feed(iq(parts, { noise: null, seconds: 0.4 }));
	return r.level();
}

test("selectivity: a station 200 kHz away is 50 dB down in wfm", function () {
	const there = leak("wfm", [fm(300000, -3, 75000)]);
	near(there, -3, 1, "tuned in, dBFS");
	atMost(leak("wfm", [fm(500000, -3, 75000)]) - there, -50, "200 kHz above, dB");
	atMost(leak("wfm", [fm(100000, -3, 75000)]) - there, -50, "200 kHz below, dB");
	// and in the sound: both on the air, equally strong
	const a = rig({ vfo: CENTER + 300000, mode: "wfm" }).feed(iq([fm(300000, -9, 75000, 1000), fm(500000, -9, 75000, 400)], { noise: -60 })).audio();
	atMost(S.db(amp(a, 400) / amp(a, 1000)), -50, "the neighbour's tone against the station's, dB");
});

test("selectivity: a channel 12.5 kHz away is 50 dB down in nfm", function () {
	const there = leak("nfm", [fm(300000, -3, 2500)]);
	atMost(leak("nfm", [fm(312500, -3, 2500)]) - there, -50, "12.5 kHz above, dB");
	atMost(leak("nfm", [fm(287500, -3, 2500)]) - there, -50, "12.5 kHz below, dB");
});

test("selectivity: a station 10 kHz away is 50 dB down in am", function () {
	const there = leak("am", [am(300000, -9)]);
	atMost(leak("am", [am(310000, -9)]) - there, -50, "10 kHz above, dB");
	atMost(leak("am", [am(290000, -9)]) - there, -50, "10 kHz below, dB");
});

test("selectivity: a signal 3 kHz away is 50 dB down in usb and lsb", function () {
	// A sideband signal, as three tones across its width
	function ssb(dial, side) { return [300, 1000, 2500].map(function (f) { return tone(dial + side * f, -13); }); }
	const there = leak("usb", ssb(300000, 1));
	atMost(leak("usb", ssb(303000, 1)) - there, -50, "usb, 3 kHz above, dB");
	atMost(leak("usb", ssb(297000, 1)) - there, -50, "usb, 3 kHz below, dB");
	const thereL = leak("lsb", ssb(300000, -1));
	near(thereL, there, 1, "lsb tuned in, as usb");
	atMost(leak("lsb", ssb(303000, -1)) - thereL, -50, "lsb, 3 kHz above, dB");
	atMost(leak("lsb", ssb(297000, -1)) - thereL, -50, "lsb, 3 kHz below, dB");
});

test("selectivity: nothing folds onto the channel on the way down, at any rate", function () {
	// Each stage that divides the rate would fold whatever lies a multiple
	// of its output rate away onto the channel, did it not filter it out
	// first: a loud carrier is put at each such place in turn, the channel
	// left empty
	[240000, 960000, 2400000, 9600000].forEach(function (rate) {
		["wfm", "nfm", "usb"].forEach(function (mode) {
			const chan = mode === "wfm" && rate === 240000 ? 20000 : rate / 8, inside = mode === "wfm" ? 30000 : mode === "nfm" ? 2000 : 1000;
			const plan = rig({ rate: rate, vfo: CENTER + chan, mode: mode }).rx.describe().stages;
			let worst = -200, at = 0, tried = 0;
			plan.forEach(function (st) {
				for (let k = 1; k < st.decim; k++) {
					// (a little off any round number: the 8-bit rounding of a carrier
					// that repeats every few samples is a comb of its own)
					let off = chan + inside + 137.3 + k * st.rate / st.decim;
					off = ((off + rate / 2) % rate + rate) % rate - rate / 2;
					const r = rig({ rate: rate, vfo: CENTER + chan, mode: mode }).feed(iq([tone(off, -3)], { rate: rate, noise: null, seconds: 0.21 }));
					tried++;
					if (r.level() > worst) { worst = r.level(); at = off; }
				}
			});
			if (tried) atMost(worst, -3 - 50, mode + " at " + rate + " (" + tried + " places): worst, a carrier " + Math.round(at) + " Hz off centre, dBFS in the channel");
		});
	});
});

/* ---------- the radio's DC offset ---------- */

test("dc: the offset does not show on the display", function () {
	const r = rig({ vfo: CENTER + 600000, audio: false }).feed(iq([], { noise: -40, dc: [6, -4], seconds: 1 }));
	const n = 4096, mid = n / 2, lines = r.lines.slice(-10);
	let peak = -200;
	const all = [];
	lines.forEach(function (l) {
		for (let i = mid - 2; i <= mid + 2; i++) peak = Math.max(peak, l.bins[i]);
		for (let i = 0; i < n; i += 7) all.push(l.bins[i]);
	});
	all.sort(function (a, b) { return a - b; });
	const floor = all[all.length >> 1];
	// Left in, the offset would stand 45 dB over the noise here
	atMost(peak - floor, 8, "the middle of the display over the noise floor, dB");
});

test("dc: the offset does not leak into a channel beside it", function () {
	const plain = rig({ vfo: CENTER + 10000, mode: "nfm" }).feed(iq([], { noise: -40, seconds: 0.6 }));
	const offset = rig({ vfo: CENTER + 10000, mode: "nfm" }).feed(iq([], { noise: -40, dc: [6, -4], seconds: 0.6 }));
	near(offset.level(), plain.level(), 1, "the channel's level with the offset there, dBFS");
	const a = plain.audio(), b = offset.audio();
	near(S.db(S.rms(b, 9600) / S.rms(a, 9600)), 0, 1, "and its sound, dB");
});

/* ---------- the display ---------- */

test("fft: a full-scale tone reads 0 dBFS in its bin, lowest frequency first, at every size", function () {
	[1024, 2048, 4096, 8192, 16384, 32768].forEach(function (n) {
		[300000, -300000].forEach(function (off) {
			const r = rig({ vfo: CENTER + 600000, audio: false, fftSize: n }).feed(iq([tone(off, -0.07)], { noise: null, seconds: 0.25 }));
			const bins = r.lines[r.lines.length - 1].bins, want = n / 2 + off / (RATE / n);
			let top = 0;
			for (let i = 1; i < n; i++) if (bins[i] > bins[top]) top = i;
			equal(bins.length, n, "bins");
			equal(top, want, "the strongest bin, size " + n + ", " + off + " Hz");
			near(bins[top], 0, 1, "its level, dBFS");
		});
	});
	// between two bins it is shared, and still within a dB
	const r = rig({ vfo: CENTER + 600000, audio: false }).feed(iq([tone(300000 + RATE / 4096 / 2, -0.07)], { noise: null, seconds: 0.25 }));
	const bins = r.lines[r.lines.length - 1].bins;
	near(Math.max(bins[2560], bins[2561]), 0, 1, "half a bin off, dBFS");
});

test("fft: lines come fps times a second of signal, however it is cut up", function () {
	const sig = iq([], { noise: -40, seconds: 2 });
	[[20, 4096, 40], [7, 4096, 14], [40, 1024, 80], [5, 32768, 10]].forEach(function (c) {
		[48000, 4801, 333].forEach(function (frame) {
			const r = rig({ vfo: CENTER + 600000, audio: false, fps: c[0], fftSize: c[1] }).feed(sig, frame);
			ok(r.lines.length === c[2] || r.lines.length === c[2] - 1, c[0] + " fps, size " + c[1] + ", frames of " + frame + ": " + r.lines.length + " lines in 2 s");
		});
	});
	// a size longer than a line's worth of signal: the first lines wait for it to fill
	const slow = rig({ rate: 240000, vfo: CENTER + 60000, audio: false, fftSize: 32768 }).feed(iq([], { rate: 240000, noise: -40, seconds: 2 }));
	ok(slow.lines.length >= 36 && slow.lines.length <= 40, "32768 points at 240 ksps: " + slow.lines.length + " lines in 2 s");
});

test("fft: the noise floor is where it should be, averaged in power", function () {
	// White noise at -30 dBFS over the band: each bin holds 1/4096 of it,
	// times the window's noise bandwidth (2.0044 bins). The mean of the dB
	// values of an average of 4 is 0.57 dB under that; had the dB values (or
	// the amplitudes) been averaged instead, it would be 2.5 (or 1) dB lower.
	const r = rig({ vfo: CENTER + 600000, audio: false }).feed(iq([], { noise: -30, seconds: 2 }));
	let sum = 0, cnt = 0;
	r.lines.slice(4).forEach(function (l) {
		for (let i = 8; i < 4096; i += 3) if (Math.abs(i - 2048) > 8) { sum += l.bins[i]; cnt++; }
	});
	near(sum / cnt, -30 + 10 * Math.log10(2.0044 / 4096) - 0.57, 0.4, "mean of the bins, dBFS");
});

/* ---------- squelch, AGC, the meter ---------- */

test("squelch: opens for a signal, holds through a dip, shuts when it is gone", function () {
	// Noise, then a signal well over the line, dropping to just under it (a
	// dip the squelch rides out), then gone
	function gate(t) { return t < 0.5 ? 0 : t < 1.0 ? 1 : t < 1.5 ? Math.pow(10, -21.5 / 20) : 0; }
	const sig = iq([{ type: "fm", offset: 300000, level: -20, deviation: 2500, tones: [{ f: 1000, a: 1 }], gate: gate }], { noise: -60, seconds: 2.2 });
	const r = rig({ vfo: CENTER + 300000, mode: "nfm", squelch: -40 }), frame = 4800;
	const heard = [];   // audio samples out by the end of each 100 ms
	let total = 0, seen = 0;
	for (let o = 0; o < sig.length; o += 2 * frame) {
		r.rx.process(sig.subarray(o, o + 2 * frame), frame);
		for (; seen < r.chunks.length; seen++) total += r.chunks[seen].length;
		if ((o / (2 * frame) + 1) % 100 === 0) heard.push(total);
	}
	heard.length = 0;
	// by 100 ms steps, from what the meter said: five readings a second
	const sq = r.meters.map(function (m) { return m.squelched; });
	equal(sq.length, 11, "meter readings in 2.2 s");
	ok(sq[0] && sq[1], "shut before the signal (readings at 0.2 and 0.4 s)");
	ok(!sq[3] && !sq[4], "open with it (0.8 and 1.0 s)");
	ok(!sq[5] && !sq[6], "still open through the dip to 1.5 dB under the line (1.2 and 1.4 s)");
	ok(sq[8] && sq[9] && sq[10], "shut after it (1.8 s on)");
	// the sound: about the second it was there, and a little
	const a = r.audio();
	ok(a.length > 0.95 * FS && a.length < 1.25 * FS, "audio for the second it was open: " + (a.length / FS).toFixed(3) + " s");
	atLeast(S.toneAmp(a, FS, 1000, 4800, 19200), 0.5, "the tone, in what was let through");
	// a signal that never reaches the line does not open it
	const weak = rig({ vfo: CENTER + 300000, mode: "nfm", squelch: -40 }).feed(iq([fm(300000, -41.5, 2500)], { noise: -60 }));
	equal(weak.audio().length, 0, "audio for a signal 1.5 dB under the line");
	ok(weak.meters.every(function (m) { return m.squelched; }), "and the meter says shut");
	// null: always open
	const open = rig({ vfo: CENTER + 300000, mode: "nfm", squelch: null }).feed(iq([], { noise: -60 }));
	equal(open.audio().length, 0.6 * FS, "audio with no squelch");
});

test("squelch: can be set and lifted while running", function () {
	const sig = iq([], { noise: -50, seconds: 0.4 });
	const r = rig({ vfo: CENTER + 300000, mode: "nfm" });
	r.feed(sig);
	const before = r.audio().length;
	r.rx.set({ squelch: -30 });
	r.feed(sig);
	const during = r.audio().length - before;
	r.rx.set({ squelch: null });
	r.feed(sig);
	const after = r.audio().length - before - during;
	equal(before, 0.4 * FS, "open: all of it");
	atMost(during, 0.2 * FS, "shut: only the tail");
	atLeast(after, 0.4 * FS - 1920 - 720, "lifted: all of it again (less the piece not yet sent, and the fade in)");
});

test("agc: speech-like bursts keep their level, and the gaps do not pump", function () {
	// A carrier in sideband, on for 150 ms and off for 100, over and over
	function gate(t) { return t % 0.25 < 0.15 ? 1 : 0; }
	const sig = iq([{ type: "tone", offset: 301000, level: -25, gate: gate }], { noise: -45, seconds: 2.5 });
	const a = rig({ vfo: CENTER + 300000, mode: "usb" }).feed(sig).audio();
	const peaks = [], gaps = [];
	for (let k = 3; k < 9; k++) {
		const t0 = Math.round((k * 0.25 + 0.03) * FS), t1 = Math.round((k * 0.25 + 0.14) * FS);
		peaks.push(S.peak(a, t0, t1));
		// the gap after it, in two halves: the noise must not come up in it
		const g0 = Math.round((k * 0.25 + 0.17) * FS), gm = Math.round((k * 0.25 + 0.205) * FS), g1 = Math.round((k * 0.25 + 0.24) * FS);
		gaps.push(S.db(S.rms(a, gm, g1) / S.rms(a, g0, gm)));
	}
	peaks.forEach(function (p, i) { near(S.db(p / 0.5), 0, 1.5, "burst " + i + " peak against the target, dB"); });
	gaps.forEach(function (g, i) { atMost(Math.abs(g), 3, "gap " + i + ": noise at its end against its start, dB"); });
	atMost(S.db(S.rms(a, Math.round(1.17 * FS), Math.round(1.24 * FS)) / 0.35), -30, "the gaps stay quiet, dB under the speech");
});

test("agc: no blast when a strong signal follows silence", function () {
	function gate(t) { return t < 1.5 ? 0 : 1; }
	["usb", "cw", "am"].forEach(function (mode) {
		const part = mode === "am" ? { type: "am", offset: 300000, level: -12, depth: 0.8, f: 1000, gate: gate } :
			{ type: "tone", offset: mode === "usb" ? 301000 : 300000, level: -12, gate: gate };
		const a = rig({ vfo: CENTER + 300000, mode: mode }).feed(iq([part], { noise: -45, seconds: 2.5 })).audio();
		const steady = S.peak(a, Math.round(2.0 * FS), Math.round(2.4 * FS)), onset = S.peak(a, Math.round(1.45 * FS), Math.round(1.7 * FS));
		atMost(S.peak(a), 1, mode + ": never over full scale");
		atMost(S.db(onset / steady), mode === "am" ? 3 : 1.5, mode + ": the loudest it gets as the signal arrives, against where it settles, dB");
	});
});

test("meter: the level is the power in the channel, within a dB", function () {
	[["wfm", 0], ["nfm", 0], ["am", 0], ["usb", 1000], ["lsb", -1000], ["cw", 0]].forEach(function (c) {
		[-20, -40].forEach(function (lv) {
			const r = rig({ vfo: CENTER + 300000, mode: c[0] }).feed(iq([tone(300000 + c[1], lv)], { noise: -45 }));
			equal(r.meters.length, 3, "readings in 0.6 s");
			near(r.level(), lv, 1, c[0] + ": a carrier at " + lv + " dBFS reads, dBFS");
		});
	});
	// noise: the channel takes its share of the band
	const r = rig({ vfo: CENTER + 300000, mode: "wfm" }).feed(iq([], { noise: -30 }));
	// (its filter is flat across 180 kHz and gone by 234: about 207 kHz of noise gets through)
	near(r.level(), -30 + 10 * Math.log10(207000 / RATE), 1, "white noise in a 180 kHz channel, dBFS");
});

test("outside: a dial beyond what the radio takes in is silent, and says so", function () {
	const sig = iq([fm(300000, -12, 75000)], { seconds: 0.4 });
	const r = rig({ vfo: CENTER + 1150000, mode: "wfm" }).feed(sig);
	equal(r.audio().length, 0, "audio");
	ok(r.meters.length === 2 && r.meters.every(function (m) { return m.outside && m.level === -150 && !m.squelched; }), "meter: outside, level -150");
	equal(r.lines.length, 8, "the display carries on");
	// back inside: sound again
	r.rx.set({ vfo: CENTER + 300000 });
	r.feed(sig);
	atLeast(r.audio().length, 0.35 * FS, "audio after tuning back in");
	ok(!r.meters[r.meters.length - 1].outside, "meter: inside");
	// the edge itself: half the channel must fit
	const edge = rig({ vfo: CENTER + 1200000 - 90000, mode: "wfm" }).feed(sig);
	ok(!edge.meters[0].outside, "a channel that just fits is inside");
	const over = rig({ vfo: CENTER + 1200000 - 89000, mode: "wfm" }).feed(sig);
	ok(over.meters[0].outside, "one that does not is outside");
});

test("audio off: no sound, the display and a level read off it", function () {
	const r = rig({ vfo: CENTER + 300000, mode: "nfm", audio: false }).feed(iq([tone(300000, -20)], { noise: -70 }));
	equal(r.audio().length, 0, "audio");
	equal(r.lines.length, 12, "lines in 0.6 s");
	near(r.level(), -20, 1.5, "level, dBFS");
	ok(!r.meters[0].squelched && !r.meters[0].outside, "neither squelched nor outside");
	r.rx.set({ audio: true });
	r.feed(iq([fm(300000, -20, 2500)], { noise: -70 }));
	atLeast(r.audio().length, 0.55 * FS, "audio once it is switched on");
});

/* ---------- however the samples are cut up ---------- */

function same(a, b, what) {
	equal(a.length, b.length, what + ": length");
	let worst = 0;
	for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
	atMost(worst, 1e-6, what + ": largest difference");
}

test("chunking: frames of 48000, 4800, 1777 or 1 sample give the same output", function () {
	const cases = [
		["wfm", [fm(300000, -12, 75000)], {}],
		["nfm", [{ type: "fm", offset: 300000, level: -20, deviation: 2500, tones: [{ f: 1000, a: 1 }], gate: function (t) { return t > 0.05 && t < 0.16 ? 1 : 0; } }], { squelch: -40 }],
		["am", [am(300000, -12)], {}],
		["usb", [tone(301000, -20)], {}],
		["cw", [tone(300000, -20)], { bw: 200 }]
	];
	cases.forEach(function (c) {
		const sig = iq(c[1], { seconds: 0.24, dc: [3, -2] });
		const ref = rig(Object.assign({ vfo: CENTER + 300000, mode: c[0], fps: 25 }, c[2])).feed(sig, 48000);
		atLeast(ref.audio().length, c[0] === "nfm" ? 4000 : 0.2 * FS, c[0] + ": audio to compare");
		[4800, 1777, 1].forEach(function (frame) {
			const r = rig(Object.assign({ vfo: CENTER + 300000, mode: c[0], fps: 25 }, c[2])).feed(sig, frame);
			same(r.audio(), ref.audio(), c[0] + ", frames of " + frame + ", audio");
			equal(r.lines.length, ref.lines.length, c[0] + ", frames of " + frame + ": lines");
			for (let i = 0; i < r.lines.length; i++) same(r.lines[i].bins, ref.lines[i].bins, c[0] + ", frames of " + frame + ", line " + i);
			equal(JSON.stringify(r.meters), JSON.stringify(ref.meters), c[0] + ", frames of " + frame + ": meter");
		});
	});
});

test("a gap in the samples makes no click louder than the audio", function () {
	["wfm", "nfm", "am", "usb"].forEach(function (mode) {
		const part = mode === "wfm" ? fm(300000, -12, 75000) : mode === "nfm" ? fm(300000, -12, 2500) : mode === "am" ? am(300000, -12) : tone(301000, -20);
		const sig = iq([part], { seconds: 1 }), frame = 48000, r = rig({ vfo: CENTER + 300000, mode: mode });
		// 50 frames of 20 ms; the 25th to 27th never arrive, and the next says so
		for (let k = 0; k < 50; k++) {
			if (k >= 24 && k <= 26) continue;
			r.rx.process(sig.subarray(k * 2 * frame, (k + 1) * 2 * frame), frame, k === 27);
		}
		const a = r.audio(), cut = Math.round(24 * 0.02 * FS);
		near(a.length, 0.94 * FS, 1920, mode + ": audio samples");
		const normal = S.peak(a, Math.round(0.3 * FS), cut - 480);
		atMost(S.db(S.peak(a, cut - 480, cut + 4800) / normal), 0.5, mode + ": the loudest sample around the gap against the audio's own peak, dB");
		atLeast(S.sinad(a, FS, 1000, cut + 7200, cut + 16800), 25, mode + ": and the sound is back after it, dB");
	});
});

test("a change of centre or of rate makes no click louder than the audio", function () {
	// The station stays where it is on the air (100.3 MHz); the radio moves under it
	const r = rig({ vfo: CENTER + 300000, mode: "wfm" });
	r.feed(iq([fm(300000, -12, 75000)], { seconds: 0.5 }));
	r.rx.set({ center: CENTER + 200000 });
	r.feed(iq([fm(100000, -12, 75000)], { seconds: 0.5 }));
	r.rx.set({ rate: 1200000 });
	r.feed(iq([fm(100000, -12, 75000)], { seconds: 0.5, rate: 1200000 }));
	r.rx.set({ rate: 9600000, center: CENTER });
	r.feed(iq([fm(300000, -12, 75000)], { seconds: 0.3, rate: 9600000 }));
	const a = r.audio(), normal = S.peak(a, Math.round(0.3 * FS), Math.round(0.45 * FS));
	near(a.length, 1.8 * FS, 1920, "audio samples: 48 kHz through it all");
	atMost(S.db(S.peak(a) / normal), 0.5, "the loudest sample of all against the audio's own peak, dB");
	[0.5, 1.0, 1.5].forEach(function (t, i) {
		const from = Math.round((t + 0.1) * FS), to = Math.round((t + 0.28) * FS);
		near(S.toneAmp(a, FS, 1000, from, to), 0.6 * 0.905, 0.04, "the tone after change " + (i + 1));
	});
	// the display follows: lines carry the centre and rate they were taken at
	const last = r.lines[r.lines.length - 1];
	equal(last.center, CENTER, "last line's centre");
	equal(last.rate, 9600000, "last line's rate");
});

/* ---------- every rate, every mode ---------- */

test("every rate the radios offer, in every mode", function () {
	[240000, 960000, 1200000, 1920000, 2400000, 4800000, 9600000].forEach(function (rate) {
		// One signal for each kind of mode, spread across the band (at
		// 240 ksps broadcast FM fills it, and gets the band to itself)
		const narrow = rate === 240000 ? -95000 : -rate / 4, wide = rate === 240000 ? 15000 : rate / 4, secs = 0.45;
		const air = [fm(narrow, -18, 2500), am(narrow + 30000, -18), tone(narrow + 60000, -24)];
		const sigN = iq(air.concat(rate === 240000 ? [] : [fm(wide, -12, 75000)]), { rate: rate, seconds: secs, noise: -50 });
		const sigW = rate === 240000 ? iq([fm(wide, -12, 75000)], { rate: rate, seconds: secs, noise: -50 }) : sigN;
		[["wfm", wide, 1000, sigW], ["nfm", narrow, 1000, sigN], ["am", narrow + 30000, 1000, sigN],
			["usb", narrow + 59000, 1000, sigN], ["lsb", narrow + 61000, 1000, sigN], ["cw", narrow + 60000, 700, sigN]].forEach(function (c) {
			const r = rig({ rate: rate, vfo: CENTER + c[1], mode: c[0] }).feed(c[3]), a = r.audio();
			near(a.length, secs * FS, 1920, c[0] + " at " + rate + ": audio samples");
			atLeast(sinad(a, c[2]), 20, c[0] + " at " + rate + ": the tone over all else, dB");
			ok(!r.meters[0].outside, c[0] + " at " + rate + ": inside");
		});
	});
});

test("settings: what cannot be is refused, what is out of range is brought in", function () {
	const r = rig({ vfo: CENTER + 300000 });
	[{ rate: 2000000 }, { rate: 1152000 }, { rate: 0 }, { mode: "fm" }, { fftSize: 3000 }, { fftSize: 65536 }].forEach(function (bad) {
		let threw = false;
		try { r.rx.set(bad); } catch (e) { threw = true; }
		ok(threw, JSON.stringify(bad) + " is refused");
	});
	r.rx.set({ mode: "nfm" });
	equal(r.rx.bw, 12500, "a new mode takes its own width");
	r.rx.set({ bw: 1e6 });
	equal(r.rx.bw, 30000, "too wide: the widest");
	r.rx.set({ mode: "usb", bw: 10 });
	equal(r.rx.bw, 500, "too narrow: the narrowest");
	r.rx.set({ fps: 100, cwPitch: 5000 });
	equal(r.rx.fps, 40, "fps");
	equal(r.rx.cwPitch, 1500, "pitch");
	// the dial starts an eighth of the span right of centre when none is given
	equal(new DSP.Receiver({ rate: 2400000, center: 98e6 }).vfo, 98.3e6, "the dial when none is given");
});

if (require.main === module) run("dsp.js: the signal processing").then(function (failed) { process.exit(failed ? 1 : 0); });
else module.exports = function () { return run("dsp.js: the signal processing"); };
