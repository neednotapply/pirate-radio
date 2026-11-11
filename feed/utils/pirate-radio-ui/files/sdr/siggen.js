/* Pirate Radio: a simulated band.

   A radio that is not there: stations at fixed frequencies on the air, so
   that tuning moves them as it would real ones, and every place the Listen
   page offers to go has something to hear. It stands in for the radio in the
   web UI's demo mode (the engine, worker.js) and in the tests' mock bridge
   (tests/sdr/mock-bridge.js), and makes what pirate-websdr sends: 8-bit I
   and Q.

     const gen = new PirateSigGen.Generator({ seed: 1 });
     gen.tune(98000000, 2400000);      // centre and sample rate, Hz
     gen.generate(out, n);             // n samples into the Int8Array out

   What is on the air (BAND, below): FM broadcast stations with a tune, a
   voice or a sweep for a programme; aircraft, in AM; weather radio, marine,
   amateur and two-way channels in narrow FM, some of them only now and then;
   sideband and Morse on the short waves; time ticks; bursts of data on the
   ISM bands; a bare carrier or two; all of it over noise, with the small
   constant offset a real radio's samples have.

   The same seed gives the same samples, however they are asked for. A
   station is one oscillator (a table of sines, stepped at the station's
   frequency), its frequency or strength changed tens of thousands of times a
   second by its programme: cheap enough to run beside the receiver itself.
   Only the strongest few in view are made (MAX_ACTIVE). */
(function (root, factory) {
	if (typeof module === "object" && module.exports) module.exports = factory();
	else root.PirateSigGen = factory();
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	const TAB_BITS = 12, TAB = 1 << TAB_BITS, SHIFT = 32 - TAB_BITS;
	const COS = new Float64Array(TAB), SIN = new Float64Array(TAB);
	for (let i = 0; i < TAB; i++) {
		COS[i] = Math.cos(2 * Math.PI * i / TAB);
		SIN[i] = Math.sin(2 * Math.PI * i / TAB);
	}
	const FULL = 128;                 // full scale, as the receiver counts it
	const MAX_ACTIVE = 6;             // stations made at once
	const UPDATE_HZ = 48000;          // how often a station's programme moves it
	const MAX_BLOCK = 256;

	// A small seeded generator of 32-bit numbers
	function prng(seed) {
		let a = seed >>> 0;
		return function () {
			a = (a + 0x6D2B79F5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return (t ^ (t >>> 14)) >>> 0;
		};
	}
	function unit(rand) { return rand() / 4294967296; }
	function between(rand, lo, hi) { return lo + (hi - lo) * unit(rand); }

	// Gaussian noise, made once: the generators read it from random places
	const NOISE_BITS = 15, NOISE_MASK = (1 << NOISE_BITS) - 1;
	const NOISE = new Float64Array(1 << NOISE_BITS);
	(function () {
		const r = prng(0x5eed);
		for (let i = 0; i < NOISE.length; i++) {
			let u = 0;
			while (u === 0) u = unit(r);
			NOISE[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * unit(r));
		}
	})();

	// A fraction of a turn per step, as an oscillator's step
	function hz(f) { return Math.round(f * 4294967296) | 0; }
	// An oscillator's phase moved on by its step: both 32-bit integers, and
	// said to be, or their sum (which wraps) would be done in floating point
	function turn(ph, inc) { return ((ph | 0) + (inc | 0)) | 0; }

	/* ---------- programmes: what a station carries, -1..1 ----------
	   Each is stepped once per block, with the block's length in seconds:
	   what does not change from block to block (an oscillator's step for a
	   note) is worked out when the note starts, not every time. */

	const NOTES = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21].map(function (n) { return Math.pow(2, n / 12); });
	const NOTE_LENGTHS = [0.16, 0.24, 0.32, 0.48];
	const BASS = [0, 5, 7, 3].map(function (n) { return Math.pow(2, n / 12) / 2; });

	// A tune: notes from a five-note scale, plucked, over a slow bass
	class Melody {
		constructor(rand) {
			this.rand = rand;
			this.root = between(rand, 196, 330);
			this.dt = 0;
			this.left = 0; this.len = 1; this.f = this.root;
			this.ph = 0; this.inc = 0; this.env = 0; this.dk = 1;
			this.bleft = 0; this.bf = this.root / 2; this.bph = 0; this.binc = 0;
		}
		step(dt) {
			let fresh = dt !== this.dt;
			this.dt = dt;
			if ((this.left -= dt) <= 0) {
				this.f = this.root * NOTES[this.rand() % NOTES.length];
				this.left = this.len = NOTE_LENGTHS[this.rand() & 3];
				this.env = 1;
				fresh = true;
			}
			if ((this.bleft -= dt) <= 0) {
				this.bleft = 0.96;
				this.bf = this.root * BASS[this.rand() & 3];
				fresh = true;
			}
			if (fresh) {
				this.inc = hz(this.f * dt);
				this.binc = hz(this.bf * dt);
				this.dk = Math.exp(-3 * dt / this.len);
			}
			this.ph = turn(this.ph, this.inc);
			this.bph = turn(this.bph, this.binc);
			this.env *= this.dk;
			return 0.55 * (0.25 + 0.75 * this.env) * (SIN[this.ph >>> SHIFT] + 0.3 * SIN[(this.ph << 1) >>> SHIFT]) +
				0.25 * SIN[this.bph >>> SHIFT];
		}
	}

	// A voice of sorts: three formants that move with each syllable, buzzed
	// at a speaking pitch, with gaps between the words
	class Talk {
		constructor(rand) {
			this.rand = rand;
			this.f0 = 500; this.f1 = 1500; this.f2 = 2500;   // the formants now, Hz: the sideband stations read them
			this.p0 = 0; this.p1 = 0; this.p2 = 0; this.i0 = 0; this.i1 = 0; this.i2 = 0;
			this.pitch = between(rand, 95, 190);
			this.pp = 0; this.pi = 0;
			this.dt = 0;
			this.left = 0;
			this.gap = false;
			this.words = 0;
			this.out = 0;                                    // the syllable's loudness now, 0..1
		}
		step(dt) {
			const rand = this.rand;
			let fresh = dt !== this.dt;
			this.dt = dt;
			if ((this.left -= dt) <= 0) {
				if (!this.gap && (this.words <= 0 || (rand() & 3) === 0)) {
					// a breath between phrases, or a short one between syllables
					this.gap = true;
					this.left = this.words <= 0 ? between(rand, 0.35, 0.9) : between(rand, 0.03, 0.08);
					if (this.words <= 0) this.words = 6 + rand() % 12;
				} else {
					this.gap = false;
					this.words--;
					this.left = between(rand, 0.11, 0.26);
					this.f0 = between(rand, 320, 820);
					this.f1 = between(rand, 950, 2100);
					this.f2 = between(rand, 2300, 3000);
					fresh = true;
				}
			}
			if (fresh) {
				this.i0 = hz(this.f0 * dt);
				this.i1 = hz(this.f1 * dt);
				this.i2 = hz(this.f2 * dt);
				this.pi = hz(this.pitch * dt);
			}
			// the loudness follows the syllables, over a few milliseconds
			const k = dt * 250;
			this.out += ((this.gap ? 0 : 1) - this.out) * (k < 1 ? k : 1);
			this.p0 = turn(this.p0, this.i0);
			this.p1 = turn(this.p1, this.i1);
			this.p2 = turn(this.p2, this.i2);
			this.pp = turn(this.pp, this.pi);
			return this.out * (0.5 * SIN[this.p0 >>> SHIFT] + 0.33 * SIN[this.p1 >>> SHIFT] + 0.17 * SIN[this.p2 >>> SHIFT]) *
				(0.65 + 0.35 * SIN[this.pp >>> SHIFT]);
		}
	}

	// A tone sweeping up through the audio band, over and over
	class Sweep {
		constructor() { this.t = 0; this.ph = 0; this.inc = 0; this.n = 0; }
		step(dt) {
			this.t += dt;
			if (this.t >= 3) this.t -= 3;
			// (its pitch is moved every 64th block: often enough to hear no steps)
			if ((this.n++ & 63) === 0) this.inc = hz(200 * Math.pow(25, this.t / 3) * dt);
			this.ph = turn(this.ph, this.inc);
			return 0.6 * SIN[this.ph >>> SHIFT];
		}
	}

	class Tone {
		constructor(f) { this.f = f; this.ph = 0; this.inc = 0; this.dt = 0; }
		step(dt) {
			if (dt !== this.dt) { this.dt = dt; this.inc = hz(this.f * dt); }
			this.ph = turn(this.ph, this.inc);
			return 0.7 * SIN[this.ph >>> SHIFT];
		}
	}

	// A time signal: a tick of 1 kHz each second, over a steady low tone
	class Ticks {
		constructor() { this.t = 0; this.ph = 0; this.lph = 0; this.inc = 0; this.linc = 0; this.dt = 0; }
		step(dt) {
			if (dt !== this.dt) { this.dt = dt; this.inc = hz(1000 * dt); this.linc = hz(500 * dt); }
			this.t += dt;
			if (this.t >= 1) this.t -= 1;
			this.ph = turn(this.ph, this.inc);
			this.lph = turn(this.lph, this.linc);
			return this.t < 0.006 ? SIN[this.ph >>> SHIFT] : this.t < 0.04 ? 0 : 0.25 * SIN[this.lph >>> SHIFT];
		}
	}

	function programme(name, rand) {
		switch (name) {
		case "talk": return new Talk(rand);
		case "sweep": return new Sweep();
		case "tone": return new Tone(1000);
		case "ticks": return new Ticks();
		default: return new Melody(rand);
		}
	}

	// On the air and off it again: `on` and `off` are [shortest, longest]
	// seconds; the strength comes up and goes down over a few milliseconds
	class Keyer {
		constructor(rand, on, off) {
			this.rand = rand; this.on = on; this.off = off;
			this.keyed = rand() % 3 !== 0;
			this.left = between(rand, 0, this.keyed ? on[1] : off[1]);
			this.g = this.keyed ? 1 : 0;
		}
		step(dt) {
			if ((this.left -= dt) <= 0) {
				this.keyed = !this.keyed;
				this.left = this.keyed ? between(this.rand, this.on[0], this.on[1]) : between(this.rand, this.off[0], this.off[1]);
			}
			const k = dt * 400;
			this.g += ((this.keyed ? 1 : 0) - this.g) * (k < 1 ? k : 1);
			return this.g;
		}
	}

	// Morse: "VVV DE DEMO", at 16 words a minute
	const MORSE = (function () {
		const code = { V: "...-", D: "-..", E: ".", M: "--", O: "---" }, units = [];
		"VVV DE DEMO   ".split("").forEach(function (ch) {
			if (ch === " ") { units.push(0, 0, 0, 0); return; }
			code[ch].split("").forEach(function (s) {
				for (let i = 0; i < (s === "-" ? 3 : 1); i++) units.push(1);
				units.push(0);
			});
			units.push(0, 0);
		});
		return units;
	})();

	/* ---------- what is on the air ----------
	   f: Hz. kind: wfm (broadcast FM), nfm, am, usb, lsb, carrier, cw,
	   ook and fsk (bursts of data). level: dBFS at the radio's usual gain.
	   prog: the programme. key: [on, off] ranges in seconds for stations
	   that come and go. */

	function fmBand() {
		// 88.5 to 107.7 MHz, every 0.8 MHz: 98.1, where the page starts, among them
		const progs = ["melody", "talk", "melody", "sweep", "melody", "talk"], out = [];
		for (let i = 0; i < 25; i++) {
			const f = (885 + 8 * i) * 100000, here = f === 98100000;
			out.push({ f: f, kind: "wfm", level: here ? -15 : -17 - (i * 7) % 16, prog: here ? "melody" : progs[i % progs.length] });
		}
		return out;
	}
	const BAND = fmBand().concat([
		{ f: 100.0e6, kind: "carrier", level: -40 },

		// AM broadcast and the short waves (a HackRF tunes from 1 MHz)
		{ f: 1.03e6, kind: "am", level: -20, prog: "melody" },
		{ f: 1.26e6, kind: "am", level: -26, prog: "talk" },
		{ f: 1.52e6, kind: "am", level: -30, prog: "melody" },
		{ f: 5.0e6, kind: "am", level: -24, prog: "ticks" },
		{ f: 7.030e6, kind: "cw", level: -28 },
		{ f: 7.100e6, kind: "lsb", level: -22, key: [[4, 9], [2, 5]] },
		{ f: 7.185e6, kind: "lsb", level: -30, key: [[3, 8], [3, 8]] },
		{ f: 10.0e6, kind: "am", level: -20, prog: "ticks" },
		{ f: 14.100e6, kind: "cw", level: -30 },
		{ f: 14.200e6, kind: "usb", level: -22, key: [[4, 9], [2, 5]] },
		{ f: 14.265e6, kind: "usb", level: -31, key: [[3, 7], [3, 9]] },
		{ f: 27.025e6, kind: "am", level: -30, prog: "talk", key: [[2, 5], [3, 9]] },
		{ f: 27.185e6, kind: "am", level: -20, prog: "talk", key: [[3, 7], [1.5, 4]] },
		{ f: 27.385e6, kind: "lsb", level: -26, key: [[3, 7], [2, 6]] },

		// Aircraft
		{ f: 118.3e6, kind: "am", level: -24, prog: "talk", key: [[2, 5], [2, 6]] },
		{ f: 119.1e6, kind: "am", level: -30, prog: "talk", key: [[2, 4], [3, 9]] },
		{ f: 120.9e6, kind: "am", level: -27, prog: "talk", key: [[2, 5], [3, 8]] },
		{ f: 121.5e6, kind: "am", level: -19, prog: "talk", key: [[3, 6], [1.5, 4]] },
		{ f: 124.35e6, kind: "am", level: -29, prog: "talk", key: [[2, 5], [4, 10]] },
		{ f: 127.85e6, kind: "am", level: -23, prog: "talk" },
		{ f: 132.65e6, kind: "am", level: -31, prog: "talk", key: [[2, 5], [3, 9]] },

		// Amateur 2 m, marine and weather radio
		{ f: 144.39e6, kind: "fsk", level: -24, shift: 1500, baud: 1200, burst: [0.4, 0.7], gap: [3, 8] },
		{ f: 145.23e6, kind: "nfm", level: -25, prog: "talk", key: [[4, 10], [3, 8]] },
		{ f: 146.52e6, kind: "nfm", level: -18, prog: "talk", key: [[4, 9], [1.5, 4]] },
		{ f: 146.94e6, kind: "nfm", level: -28, prog: "talk", key: [[3, 8], [4, 10]] },
		{ f: 147.06e6, kind: "nfm", level: -31, prog: "talk", key: [[3, 8], [4, 12]] },
		{ f: 150.0e6, kind: "carrier", level: -42 },
		{ f: 156.45e6, kind: "nfm", level: -28, prog: "talk", key: [[2, 6], [4, 12]] },
		{ f: 156.8e6, kind: "nfm", level: -19, prog: "talk", key: [[3, 7], [2, 5]] },
		{ f: 157.1e6, kind: "nfm", level: -30, prog: "talk", key: [[2, 6], [5, 12]] },
		{ f: 161.975e6, kind: "fsk", level: -27, shift: 2400, baud: 9600, burst: [0.026, 0.027], gap: [1.5, 6] },
		{ f: 162.025e6, kind: "fsk", level: -29, shift: 2400, baud: 9600, burst: [0.026, 0.027], gap: [2, 7] },
		{ f: 162.4e6, kind: "nfm", level: -30, prog: "talk" },
		{ f: 162.475e6, kind: "nfm", level: -26, prog: "talk" },
		{ f: 162.55e6, kind: "nfm", level: -17, prog: "talk" },

		// 70 cm, ISM and two-way
		{ f: 433.42e6, kind: "ook", level: -26, baud: 2000, burst: [0.05, 0.09], gap: [2.5, 7] },
		{ f: 433.92e6, kind: "ook", level: -16, baud: 2500, burst: [0.06, 0.12], gap: [0.8, 2.5] },
		{ f: 434.42e6, kind: "fsk", level: -28, shift: 20000, baud: 9600, burst: [0.03, 0.06], gap: [3, 9] },
		{ f: 440.0e6, kind: "carrier", level: -41 },
		{ f: 442.1e6, kind: "nfm", level: -27, prog: "talk", key: [[4, 10], [3, 8]] },
		{ f: 444.5e6, kind: "nfm", level: -31, prog: "talk", key: [[3, 8], [4, 10]] },
		{ f: 446.0e6, kind: "nfm", level: -18, prog: "talk", key: [[4, 9], [1.5, 4]] },
		{ f: 449.5e6, kind: "nfm", level: -29, prog: "talk", key: [[3, 8], [4, 12]] },
		{ f: 462.5625e6, kind: "nfm", level: -18, prog: "talk", key: [[3, 8], [1.5, 4]] },
		{ f: 462.6125e6, kind: "nfm", level: -27, prog: "talk", key: [[2, 6], [3, 9]] },
		{ f: 462.7125e6, kind: "nfm", level: -30, prog: "talk", key: [[2, 6], [4, 12]] },
		{ f: 467.5625e6, kind: "nfm", level: -26, prog: "talk", key: [[2, 6], [3, 9]] },
		{ f: 467.7125e6, kind: "nfm", level: -31, prog: "talk", key: [[2, 6], [4, 12]] },
		{ f: 903.9e6, kind: "fsk", level: -29, shift: 25000, baud: 4800, burst: [0.04, 0.2], gap: [2, 6] },
		{ f: 912.6e6, kind: "fsk", level: -25, shift: 25000, baud: 9600, burst: [0.03, 0.08], gap: [1.5, 5] },
		{ f: 915.0e6, kind: "fsk", level: -16, shift: 2000, baud: 2400, burst: [0.08, 0.25], gap: [0.7, 2.2] },
		{ f: 918.4e6, kind: "fsk", level: -27, shift: 25000, baud: 4800, burst: [0.04, 0.12], gap: [2, 7] },

		// Aircraft transponders: short bursts, all the time
		{ f: 1090.0e6, kind: "ook", level: -22, baud: 20000, burst: [0.0005, 0.0012], gap: [0.03, 0.25] }
	]);

	/* ---------- a station, running ---------- */

	class Station {
		constructor(def, seed) {
			this.def = def;
			this.rand = prng(seed);
			this.amp = FULL * Math.pow(10, def.level / 20);
			this.nosc = def.kind === "usb" || def.kind === "lsb" ? 3 : 1;
			const rand = this.rand;
			switch (def.kind) {
			case "wfm": case "nfm": case "am":
				this.prog = programme(def.prog, rand);
				break;
			case "usb": case "lsb":
				this.prog = new Talk(rand);
				break;
			case "ook": case "fsk":
				this.bits = rand();          // the packet: the same 32 bits, over and over
				this.left = between(rand, 0, def.gap[1]);
				this.sending = false;
				this.t = 0;
				break;
			case "cw":
				this.t = between(rand, 0, 3);
				this.g = 0;
				break;
			}
			if (def.key) this.keyer = new Keyer(rand, def.key[0], def.key[1]);
		}

		// One block on: this station's oscillators (from slot o) get their step
		// and strength for the block. `scale` is the radio's gain.
		update(gen, o, dt, off, scale) {
			const def = this.def, rate = gen.rate, inc = gen.inc, amp = gen.amp;
			const key = this.keyer ? this.keyer.step(dt) : 1, a = this.amp * scale * key;
			switch (def.kind) {
			case "wfm":
				inc[o] = hz((off + 75000 * 0.75 * this.prog.step(dt)) / rate);
				amp[o] = a;
				break;
			case "nfm":
				inc[o] = hz((off + 2500 * (key > 0.01 ? this.prog.step(dt) : 0)) / rate);
				amp[o] = a;
				break;
			case "am":
				inc[o] = hz(off / rate);
				amp[o] = a * (1 + 0.8 * (key > 0.01 ? this.prog.step(dt) : 0));
				break;
			case "usb": case "lsb": {
				// A voice's formants as three carriers beside the (absent) carrier
				const p = this.prog, side = def.kind === "usb" ? 1 : -1;
				if (key > 0.01) p.step(dt);
				const v = a * p.out;
				inc[o] = hz((off + side * p.f0) / rate);
				inc[o + 1] = hz((off + side * p.f1) / rate);
				inc[o + 2] = hz((off + side * p.f2) / rate);
				amp[o] = v * 0.6;
				amp[o + 1] = v * 0.4;
				amp[o + 2] = v * 0.25;
				break;
			}
			case "carrier":
				inc[o] = hz(off / rate);
				amp[o] = a;
				break;
			case "cw": {
				this.t += dt;
				const on = MORSE[Math.floor(this.t / 0.075) % MORSE.length], k = dt * 300;
				this.g += (on - this.g) * (k < 1 ? k : 1);
				inc[o] = hz(off / rate);
				amp[o] = a * this.g;
				break;
			}
			default: {
				// ook, fsk: packets of the station's bits, with silence between
				if ((this.left -= dt) <= 0) {
					this.sending = !this.sending;
					this.left = this.sending ? between(this.rand, def.burst[0], def.burst[1]) : between(this.rand, def.gap[0], def.gap[1]);
					this.t = 0;
				}
				this.t += dt;
				const bit = (this.bits >>> (Math.floor(this.t * def.baud) & 31)) & 1;
				if (def.kind === "ook") {
					inc[o] = hz(off / rate);
					amp[o] = this.sending && bit ? a : 0;
				} else {
					inc[o] = hz((off + (bit ? def.shift : -def.shift)) / rate);
					amp[o] = this.sending ? a : 0;
				}
			}
			}
			return o + this.nosc;
		}
	}

	/* ---------- the samples themselves ----------
	   Per sample: noise and the constant offset, each oscillator in view,
	   and rounding to the converter's 8 bits. Done two oscillators to a pass
	   (a strength of 0 for one that is not there), in as few passes over the
	   block as will do: with one or two in view, a single pass that stores
	   nothing but the result. Small functions on purpose, each one loop: the
	   compiler makes far better work of them than of one long one.

	   p: an oscillator's phase, d: its step (32-bit integers: the "| 0"s
	   say so, or their wrapping sum would be done in floating point), a: its
	   strength. n1, n2: where in the noise table this block reads. */

	function round8(v) {
		v = v > 127 ? 127 : v < -127 ? -127 : v;
		return ((v + 128.5) | 0) - 128;
	}
	// All of it in one pass: noise, two oscillators, rounded into out from o
	function whole(out, o, run, n1, n2, ns, dcI, dcQ, a1, p1, d1, a2, p2, d2) {
		p1 = p1 | 0; d1 = d1 | 0; p2 = p2 | 0; d2 = d2 | 0;
		for (let j = 0; j < run; j++) {
			const i1 = p1 >>> SHIFT, i2 = p2 >>> SHIFT;
			out[o++] = round8(NOISE[(n1 + j) & NOISE_MASK] * ns + dcI + a1 * COS[i1] + a2 * COS[i2]);
			out[o++] = round8(NOISE[(n2 + j) & NOISE_MASK] * ns + dcQ + a1 * SIN[i1] + a2 * SIN[i2]);
			p1 = (p1 + d1) | 0;
			p2 = (p2 + d2) | 0;
		}
	}
	// Noise and two oscillators, kept in re and im for more to be added
	function first(re, im, run, n1, n2, ns, dcI, dcQ, a1, p1, d1, a2, p2, d2) {
		p1 = p1 | 0; d1 = d1 | 0; p2 = p2 | 0; d2 = d2 | 0;
		for (let j = 0; j < run; j++) {
			const i1 = p1 >>> SHIFT, i2 = p2 >>> SHIFT;
			re[j] = NOISE[(n1 + j) & NOISE_MASK] * ns + dcI + a1 * COS[i1] + a2 * COS[i2];
			im[j] = NOISE[(n2 + j) & NOISE_MASK] * ns + dcQ + a1 * SIN[i1] + a2 * SIN[i2];
			p1 = (p1 + d1) | 0;
			p2 = (p2 + d2) | 0;
		}
	}
	// Two more oscillators on top
	function more(re, im, run, a1, p1, d1, a2, p2, d2) {
		p1 = p1 | 0; d1 = d1 | 0; p2 = p2 | 0; d2 = d2 | 0;
		for (let j = 0; j < run; j++) {
			const i1 = p1 >>> SHIFT, i2 = p2 >>> SHIFT;
			re[j] += a1 * COS[i1] + a2 * COS[i2];
			im[j] += a1 * SIN[i1] + a2 * SIN[i2];
			p1 = (p1 + d1) | 0;
			p2 = (p2 + d2) | 0;
		}
	}
	// The last two, and the whole rounded into out from o
	function last(re, im, run, out, o, a1, p1, d1, a2, p2, d2) {
		p1 = p1 | 0; d1 = d1 | 0; p2 = p2 | 0; d2 = d2 | 0;
		for (let j = 0; j < run; j++) {
			const i1 = p1 >>> SHIFT, i2 = p2 >>> SHIFT;
			out[o++] = round8(re[j] + a1 * COS[i1] + a2 * COS[i2]);
			out[o++] = round8(im[j] + a1 * SIN[i1] + a2 * SIN[i2]);
			p1 = (p1 + d1) | 0;
			p2 = (p2 + d2) | 0;
		}
	}

	/* ---------- the generator ---------- */

	class Generator {
		constructor(o) {
			o = o || {};
			const seed = o.seed == null ? 1 : o.seed;
			this.rand = prng(seed ^ 0x9e3779b9);
			this.noise = o.noise == null ? 1.5 : o.noise;       // rms per component, in steps of the converter
			this.dc = o.dc || [1.2, -0.8];
			this.stations = (o.emitters || BAND).map(function (def, i) { return new Station(def, seed * 7919 + i * 104729 + 1); });
			this.scale = 1;
			this.center = 0;
			this.rate = 0;
			this.active = [];
			this.ph = new Int32Array(MAX_ACTIVE * 3);
			this.inc = new Int32Array(MAX_ACTIVE * 3);
			this.amp = new Float64Array(MAX_ACTIVE * 3);
			this.on = new Int32Array(MAX_ACTIVE * 3);    // the oscillators sounding in this block
			this.non = 0;
			this.nosc = 0;
			this.re = new Float64Array(MAX_BLOCK);
			this.im = new Float64Array(MAX_BLOCK);
			this.left = 0;
			this.blk = 32;
			this.nb1 = 0;
			this.nb2 = 0;
			this.tune(o.center || 98e6, o.rate || 2400000);
		}

		// The radio's centre frequency and sample rate: which stations are in
		// view (the strongest MAX_ACTIVE of them are made)
		tune(center, rate) {
			this.center = center;
			this.rate = rate;
			this.blk = Math.max(4, Math.min(MAX_BLOCK, Math.round(rate / UPDATE_HZ)));
			this.left = 0;
			this.active = this.stations.filter(function (s) { return Math.abs(s.def.f - center) < rate / 2; })
				.sort(function (a, b) { return b.def.level - a.def.level || a.def.f - b.def.f; }).slice(0, MAX_ACTIVE);
			// (five sideband stations and a sixth would need 18 oscillators: the
			// last slot is kept empty, so the weakest then waits its turn)
			this.nosc = 0;
			for (let i = 0; i < this.active.length; i++) {
				if (this.nosc + this.active[i].nosc > this.amp.length - 1) { this.active.length = i; break; }
				this.nosc += this.active[i].nosc;
			}
			this.amp.fill(0);
		}

		// The radio's gain, in dB over its usual setting: everything comes up
		// with it, the noise too (and too much of it clips, as it would)
		setGain(db) {
			this.scale = Math.pow(10, Math.max(-60, Math.min(40, db)) / 20);
		}

		// What is in view, for the curious and the tests
		view() {
			const center = this.center;
			return this.active.map(function (s) { return { f: s.def.f, offset: s.def.f - center, kind: s.def.kind, level: s.def.level }; });
		}

		generate(out, n) {
			const re = this.re, im = this.im, ph = this.ph, inc = this.inc, amp = this.amp, on = this.on, blk = this.blk;
			const ns = this.noise * this.scale, dcI = this.dc[0], dcQ = this.dc[1];
			let o = 0;
			while (n > 0) {
				if (this.left === 0) {
					// A new block: every station in view is moved on by its
					// programme, and the oscillators that are sounding are listed
					const dt = blk / this.rate;
					let slot = 0, m = 0;
					for (let i = 0; i < this.active.length; i++) {
						const s = this.active[i];
						slot = s.update(this, slot, dt, s.def.f - this.center, this.scale);
					}
					for (let k = 0; k < this.nosc; k++) if (amp[k] !== 0) on[m++] = k;
					this.non = m;
					this.nb1 = this.rand() & NOISE_MASK;
					this.nb2 = this.rand() & NOISE_MASK;
					this.left = blk;
				}
				const run = n < this.left ? n : this.left, at = blk - this.left, n1 = this.nb1 + at, n2 = this.nb2 + at, m = this.non;
				// (slot 17 is never a station's: its strength stays 0, for the odd one out)
				const k0 = m > 0 ? on[0] : 17, k1 = m > 1 ? on[1] : 17;
				if (m <= 2) whole(out, o, run, n1, n2, ns, dcI, dcQ, amp[k0], ph[k0], inc[k0], amp[k1], ph[k1], inc[k1]);
				else {
					first(re, im, run, n1, n2, ns, dcI, dcQ, amp[k0], ph[k0], inc[k0], amp[k1], ph[k1], inc[k1]);
					let k = 2;
					for (; m - k > 2; k += 2) more(re, im, run, amp[on[k]], ph[on[k]], inc[on[k]], amp[on[k + 1]], ph[on[k + 1]], inc[on[k + 1]]);
					const ka = on[k], kb = k + 1 < m ? on[k + 1] : 17;
					last(re, im, run, out, o, amp[ka], ph[ka], inc[ka], amp[kb], ph[kb], inc[kb]);
				}
				// every oscillator has turned `run` steps, sounding or not
				for (let k = 0; k < this.nosc; k++) ph[k] = (ph[k] + Math.imul(inc[k], run)) | 0;
				o += 2 * run;
				this.left -= run;
				n -= run;
			}
		}
	}

	return { Generator: Generator, BAND: BAND, MAX_ACTIVE: MAX_ACTIVE };
});
