/* Test signals for the receiver's tests: IQ made by the formula (exact, in
   floating point, then rounded to the 8 bits the radio gives), and what to
   measure the audio with. Nothing here is shared with the code under test. */
"use strict";

// A small seeded generator: the tests are the same every run
function rng(seed) {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function gauss(rand) {
	let u = 0;
	while (u === 0) u = rand();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const FULL = 128;   // what the receiver calls full scale
function amp(dbfs) { return FULL * Math.pow(10, dbfs / 20); }

/* makeIQ({ rate, seconds, noise, dc, seed, parts }) -> Int8Array, I and Q in turn.
   noise: its whole power across the band, dBFS (null: none)
   dc: [i, q], added to every sample, in steps of the converter
   parts: what is on the air, each { type, offset (Hz from the centre), level (dBFS) } and
     tone   a carrier: nothing more
     fm     deviation (Hz), tones: [{ f, a }]  (a: share of the deviation)
     am     depth (0..1), f (Hz)
     keyed  a carrier there from `from` to `to` seconds
     speech an AM or bare-carrier burst pattern: see below
   A part may give gate: function (t) -> 0..1, a gain over time. */
function makeIQ(o) {
	const n = Math.round(o.rate * o.seconds), out = new Int8Array(2 * n), rand = rng(o.seed || 1);
	const sigma = o.noise == null ? 0 : amp(o.noise) / Math.SQRT2;
	const dcI = o.dc ? o.dc[0] : 0, dcQ = o.dc ? o.dc[1] : 0, parts = o.parts || [];
	for (let i = 0; i < n; i++) {
		const t = i / o.rate;
		let re = dcI, im = dcQ;
		if (sigma) {
			// (two Gaussian numbers from one pair of uniform ones: I's and Q's)
			let u = 0;
			while (u === 0) u = rand();
			const r = sigma * Math.sqrt(-2 * Math.log(u)), a = 2 * Math.PI * rand();
			re += r * Math.cos(a);
			im += r * Math.sin(a);
		}
		for (let p = 0; p < parts.length; p++) {
			const s = parts[p];
			let a = amp(s.level), ph = 2 * Math.PI * s.offset * t;
			if (s.gate) a *= s.gate(t);
			if (s.type === "fm") {
				for (let k = 0; k < s.tones.length; k++)
					ph += s.deviation * s.tones[k].a / s.tones[k].f * Math.sin(2 * Math.PI * s.tones[k].f * t);
			} else if (s.type === "am") {
				a *= 1 + s.depth * Math.cos(2 * Math.PI * s.f * t);
			}
			re += a * Math.cos(ph);
			im += a * Math.sin(ph);
		}
		const r = Math.round(re), q = Math.round(im);
		out[2 * i] = r > 127 ? 127 : r < -127 ? -127 : r;
		out[2 * i + 1] = q > 127 ? 127 : q < -127 ? -127 : q;
	}
	return out;
}

/* ---------- measuring ---------- */

// The amplitude of the tone at f in x[from..to), by correlation
function toneAmp(x, fs, f, from, to) {
	let c = 0, s = 0;
	from = from || 0;
	to = to == null ? x.length : to;
	for (let i = from; i < to; i++) {
		const w = 2 * Math.PI * f * i / fs;
		c += x[i] * Math.cos(w);
		s += x[i] * Math.sin(w);
	}
	const n = to - from;
	return 2 * Math.sqrt(c * c + s * s) / n;
}
// Signal over everything else (noise and distortion), dB: the tone at f is
// fitted and taken out, and what is left is weighed against it
function sinad(x, fs, f, from, to) {
	let c = 0, s = 0, m = 0;
	from = from || 0;
	to = to == null ? x.length : to;
	const n = to - from;
	for (let i = from; i < to; i++) {
		const w = 2 * Math.PI * f * i / fs;
		c += x[i] * Math.cos(w);
		s += x[i] * Math.sin(w);
		m += x[i];
	}
	c *= 2 / n; s *= 2 / n; m /= n;
	let rest = 0;
	for (let i = from; i < to; i++) {
		const w = 2 * Math.PI * f * i / fs, d = x[i] - m - c * Math.cos(w) - s * Math.sin(w);
		rest += d * d;
	}
	return 10 * Math.log10((c * c + s * s) / 2 / (rest / n + 1e-30));
}
function rms(x, from, to) {
	let s = 0;
	from = from || 0;
	to = to == null ? x.length : to;
	for (let i = from; i < to; i++) s += x[i] * x[i];
	return Math.sqrt(s / Math.max(1, to - from));
}
function peak(x, from, to) {
	let p = 0;
	from = from || 0;
	to = to == null ? x.length : to;
	for (let i = from; i < to; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
	return p;
}
function mean(x, from, to) {
	let s = 0;
	from = from || 0;
	to = to == null ? x.length : to;
	for (let i = from; i < to; i++) s += x[i];
	return s / Math.max(1, to - from);
}
function db(ratio) { return 20 * Math.log10(ratio + 1e-30); }

module.exports = { rng, gauss, amp, makeIQ, toneAmp, sinad, rms, peak, mean, db, FULL };
