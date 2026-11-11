/* Pirate Radio: the receiver's signal processing.

   What turns the radio's raw samples (8-bit I and Q, as pirate-websdr sends
   them) into a spectrum line and into sound. No I/O and no dependencies: the
   engine (worker.js) feeds it and takes what comes out, and Node runs this
   same file for the tests (tests/sdr/). The contract with the page is in
   feed/utils/pirate-websdr/DESIGN.md.

   The work, per sample of input, in the order it is done:

     DC      the radio's constant offset (a HackRF's spike in the middle of the
             display), measured a millisecond at a time and taken off;
     FFT     a few windowed FFTs for every line of the display, averaged in
             power: only as many as the display needs, not every sample;
     mixer   the channel being listened to is moved to 0 Hz;
     chain   and brought down to a low rate in stages, each stage a short
             filter that only has to keep the channel clean: the cheap ones
             run at the high rates, the sharp one at the low rate;
     demod   FM, AM or sideband, at 240, 48 or 12 kHz;
     audio   de-emphasis, AGC, squelch, and out at 48 kHz.

   Every sample rate the radios offer is a whole multiple of 240 kHz (and so
   of the audio's 48 kHz), so all of this is whole-number decimation: nothing
   is resampled. A rate that is not is refused.

   Everything keeps its state from one call to the next and works by counting
   samples, never by the clock: the same signal gives the same output however
   it is cut into frames.

   The arithmetic is in doubles (Float64Array) throughout: JavaScript's
   numbers are doubles, and converting to and from 32-bit floats at every
   load and store costs more than the memory saves. */
(function (root, factory) {
	if (typeof module === "object" && module.exports) module.exports = factory();
	else root.PirateDSP = factory();
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	const AUDIO_RATE = 48000;
	const CHUNK = 1920;          // audio leaves 40 ms at a time
	const MIN_CHUNK = 960;       // and never less than 20 ms
	const FLOOR_DB = -150;       // "nothing there", as a level

	// What can be listened to: the channel's width as it starts and its
	// limits, and the rate the demodulator runs at
	const MODES = {
		wfm: { bw: 180000, min: 50000, max: 200000, rate: 240000 },
		nfm: { bw: 12500, min: 5000, max: 30000, rate: 48000 },
		am: { bw: 8000, min: 2000, max: 20000, rate: 48000 },
		usb: { bw: 2700, min: 500, max: 5000, rate: 12000 },
		lsb: { bw: 2700, min: 500, max: 5000, rate: 12000 },
		cw: { bw: 500, min: 50, max: 2000, rate: 12000 }
	};

	const ATTEN = 62;            // dB a channel's filter is down outside the channel
	const ATTEN_KEEP = 56;       // dB the stages before it are down where they would fold onto it
	const SSB_LOW = 200;         // Hz from the dial to where a sideband's filter starts (its -6 dB point)
	const OUT_GAIN = 0.6;        // full modulation comes out at this, leaving headroom
	const MANUAL_GAIN = 8;       // am/ssb/cw with the AGC off: this much, whatever the signal
	const FM_DEVIATION = 75000;  // broadcast FM's full deviation
	const DC_ALPHA = 1 / 32;     // the DC estimate follows the last ~30 ms
	const SQ_HYST = 2;           // dB under the squelch's line before it shuts again
	const SQ_HOLD = 10;          // and for this many 10 ms blocks
	const FFT_BUDGET = 400000;   // FFT points a second the display may cost
	const FFT_MAX_AVG = 8;       // FFTs averaged into one line, at most
	const BH_ENBW = 2.0044;      // the FFT window's noise bandwidth, in bins

	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
	function clampBw(mode, bw) { const m = MODES[mode]; return clamp(Math.round(bw), m.min, m.max); }

	// A channel's filter: all of the signal to `pass`, none of it from `stop`
	// (Hz from the channel's middle). Broadcast FM is kept whole across its
	// width. For the rest the width is where the filter is half-way down
	// (-6 dB), as a receiver's filter is usually given: what a channel that
	// wide is spaced for then stays out of it.
	function edges(mode, bw) {
		if (mode === "wfm") return { pass: bw / 2, stop: bw / 2 + 0.15 * bw };
		const tw = mode === "usb" || mode === "lsb" ? 300 : mode === "cw" ? Math.max(0.3 * bw, 60) : Math.max(0.2 * bw, 600);
		const pass = Math.max(bw / 2 - tw / 2, 0.2 * bw);
		return { pass: pass, stop: pass + tw };
	}

	/* ---------- filter design: windowed sinc, Kaiser window ---------- */

	function besselI0(x) {
		const q = x * x / 4;
		let sum = 1, term = 1;
		for (let k = 1; k < 60; k++) {
			term *= q / (k * k);
			sum += term;
			if (term < 1e-13 * sum) break;
		}
		return sum;
	}
	function kaiserBeta(atten) {
		if (atten > 50) return 0.1102 * (atten - 8.7);
		if (atten >= 21) return 0.5842 * Math.pow(atten - 21, 0.4) + 0.07886 * (atten - 21);
		return 0;
	}
	// Taps for a transition `df` wide (as a fraction of the sample rate)
	function kaiserLength(df, atten) {
		return Math.max(3, Math.ceil((atten - 7.95) / (14.36 * df)) + 1);
	}
	function kaiserWindow(n, beta) {
		const w = new Float64Array(n), d = besselI0(beta), m = (n - 1) / 2;
		for (let i = 0; i < n; i++) {
			const r = m ? (i - m) / m : 0;
			w[i] = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / d;
		}
		return w;
	}
	// A low-pass: n taps, cutoff fc (a fraction of the sample rate), gain 1 at 0 Hz
	function lowpass(n, fc, beta) {
		const h = new Float64Array(n), w = kaiserWindow(n, beta), m = (n - 1) / 2;
		let sum = 0;
		for (let i = 0; i < n; i++) {
			const t = i - m;
			h[i] = (t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)) * w[i];
			sum += h[i];
		}
		for (let i = 0; i < n; i++) h[i] /= sum;
		return h;
	}
	// A half-band low-pass (cutoff a quarter of the sample rate): every other
	// tap is zero and the middle one is a half, so only the taps 1, 3, 5...
	// away from the middle are returned. n is 3, 7, 11...
	function halfband(n, beta) {
		const k = (n + 1) >> 2, w = kaiserWindow(n, beta), m = (n - 1) >> 1, c = new Float64Array(k);
		let sum = 0;
		for (let j = 0; j < k; j++) {
			const t = 2 * j + 1;
			c[j] = Math.sin(Math.PI * t / 2) / (Math.PI * t) * w[m + t];
			sum += 2 * c[j];
		}
		for (let j = 0; j < k; j++) c[j] *= 0.5 / sum;
		return c;
	}

	/* ---------- FFT: in place, on input already in bit-reversed order ----------
	   Two stages of butterflies at a time (radix 4): half the passes over the
	   data of the plain radix-2 loop, and about twice as fast here. */

	class FFT {
		constructor(n) {
			this.n = n;
			this.rev = new Uint16Array(n);
			this.cos = new Float64Array(n >> 1);
			this.sin = new Float64Array(n >> 1);
			let bits = 0;
			while ((1 << bits) < n) bits++;
			for (let i = 0; i < n; i++) {
				let r = 0;
				for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
				this.rev[i] = r;
			}
			for (let i = 0; i < n >> 1; i++) {
				this.cos[i] = Math.cos(2 * Math.PI * i / n);
				this.sin[i] = Math.sin(2 * Math.PI * i / n);
			}
		}
		transform(re, im) {
			const n = this.n, cos = this.cos, sin = this.sin;
			// The first two stages have no multiplications in them
			for (let i = 0; i < n; i += 4) {
				const ar = re[i] + re[i + 1], ai = im[i] + im[i + 1], br = re[i] - re[i + 1], bi = im[i] - im[i + 1];
				const cr = re[i + 2] + re[i + 3], ci = im[i + 2] + im[i + 3], dr = re[i + 2] - re[i + 3], di = im[i + 2] - im[i + 3];
				re[i] = ar + cr; im[i] = ai + ci;
				re[i + 2] = ar - cr; im[i + 2] = ai - ci;
				re[i + 1] = br + di; im[i + 1] = bi - dr;
				re[i + 3] = br - di; im[i + 3] = bi + dr;
			}
			let size = 16;
			for (; size <= n; size <<= 2) {
				// The stages of size/2 and of size, in one pass
				const q = size >> 2, step = n / size;
				for (let i = 0; i < n; i += size) {
					for (let j = 0; j < q; j++) {
						const i0 = i + j, i1 = i0 + q, i2 = i1 + q, i3 = i2 + q, k1 = j * step;
						const c2 = cos[2 * k1], s2 = sin[2 * k1], c1 = cos[k1], s1 = sin[k1];
						let tr = re[i1] * c2 + im[i1] * s2, ti = im[i1] * c2 - re[i1] * s2;
						const a0r = re[i0] + tr, a0i = im[i0] + ti, a1r = re[i0] - tr, a1i = im[i0] - ti;
						tr = re[i3] * c2 + im[i3] * s2; ti = im[i3] * c2 - re[i3] * s2;
						const a2r = re[i2] + tr, a2i = im[i2] + ti, a3r = re[i2] - tr, a3i = im[i2] - ti;
						tr = a2r * c1 + a2i * s1; ti = a2i * c1 - a2r * s1;
						re[i0] = a0r + tr; im[i0] = a0i + ti;
						re[i2] = a0r - tr; im[i2] = a0i - ti;
						// The other pair's twiddle is a quarter turn on: (c, s) becomes (-s, c)
						tr = a3i * c1 - a3r * s1; ti = -a3r * c1 - a3i * s1;
						re[i1] = a1r + tr; im[i1] = a1i + ti;
						re[i3] = a1r - tr; im[i3] = a1i - ti;
					}
				}
			}
			if (size >> 1 === n) {
				// An odd number of stages: the last one on its own
				const half = n >> 1;
				for (let j = 0; j < half; j++) {
					const c = cos[j], s = sin[j], l = j + half;
					const tr = re[l] * c + im[l] * s, ti = im[l] * c - re[l] * s;
					re[l] = re[j] - tr; im[l] = im[j] - ti;
					re[j] += tr; im[j] += ti;
				}
			}
		}
	}

	// The display's window: Blackman-Harris, whose skirts stay under what 8-bit
	// samples can show. Scaled so a full-scale tone comes out of the FFT as 1.
	function fftWindow(n) {
		const w = new Float64Array(n);
		let sum = 0;
		for (let i = 0; i < n; i++) {
			const t = 2 * Math.PI * i / n;
			w[i] = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
			sum += w[i];
		}
		for (let i = 0; i < n; i++) w[i] /= sum * 128;
		return w;
	}

	/* ---------- filters that run ----------
	   Each keeps its own delay line: whoever comes before writes its output
	   straight after what is already there (at .fill) and says how many
	   samples that was; nothing is copied between stages. The taps are the
	   same from either end, so one multiplication does for two samples. */

	// What is left in a delay line after its outputs are taken: moved to the front
	function keepTail(f, pos, total) {
		if (pos < total) {
			f.re.copyWithin(0, pos, total);
			f.im.copyWithin(0, pos, total);
			f.fill = total - pos;
			f.pos = 0;
		} else {
			f.fill = 0;
			f.pos = pos - total;
		}
	}

	// Complex samples, real symmetric taps, one output for every `decim` inputs
	class FirDecimator {
		constructor(taps, decim, maxIn) {
			const n = taps.length;
			this.n = n;
			this.d = decim;
			this.half = n >> 1;
			this.h = Float64Array.from(taps.subarray(0, this.half));
			this.mid = n & 1 ? taps[this.half] : 0;
			this.re = new Float64Array(n + maxIn + 8);
			this.im = new Float64Array(n + maxIn + 8);
			this.out = null;
			this.reset();
		}
		reset() {
			this.re.fill(0);
			this.im.fill(0);
			this.fill = this.n - 1;
			this.pos = 0;
		}
		run(count) {
			const n = this.n, d = this.d, half = this.half, h = this.h, mid = this.mid;
			const re = this.re, im = this.im, out = this.out, ore = out.re, oim = out.im;
			const total = this.fill + count, last = total - n, w0 = out.fill;
			let w = w0, pos = this.pos;
			for (; pos <= last; pos += d) {
				const e = pos + n - 1;
				let ar = mid * re[pos + half], ai = mid * im[pos + half], k = 0;
				for (; k + 1 < half; k += 2) {
					const c0 = h[k], c1 = h[k + 1], a = pos + k, b = e - k;
					ar += c0 * (re[a] + re[b]) + c1 * (re[a + 1] + re[b - 1]);
					ai += c0 * (im[a] + im[b]) + c1 * (im[a + 1] + im[b - 1]);
				}
				if (k < half) {
					const a = pos + k, b = e - k;
					ar += h[k] * (re[a] + re[b]);
					ai += h[k] * (im[a] + im[b]);
				}
				ore[w] = ar;
				oim[w] = ai;
				w++;
			}
			keepTail(this, pos, total);
			return w - w0;
		}
	}

	// The same for a half-band filter, halving the rate: its zero taps are skipped
	class HalfbandDecimator {
		constructor(coefs, maxIn) {
			this.k = coefs.length;
			this.c = Float64Array.from(coefs);
			this.n = 4 * this.k - 1;
			this.m = 2 * this.k - 1;
			this.d = 2;
			this.re = new Float64Array(this.n + maxIn + 8);
			this.im = new Float64Array(this.n + maxIn + 8);
			this.out = null;
			this.reset();
		}
		reset() {
			this.re.fill(0);
			this.im.fill(0);
			this.fill = this.n - 1;
			this.pos = 0;
		}
		run(count) {
			const n = this.n, m = this.m, k = this.k, c = this.c;
			const re = this.re, im = this.im, out = this.out, ore = out.re, oim = out.im;
			const total = this.fill + count, last = total - n, w0 = out.fill;
			let w = w0, pos = this.pos;
			for (; pos <= last; pos += 2) {
				const mid = pos + m;
				let ar = 0.5 * re[mid], ai = 0.5 * im[mid];
				for (let j = 0, a = mid - 1, b = mid + 1; j < k; j++, a -= 2, b += 2) {
					const t = c[j];
					ar += t * (re[a] + re[b]);
					ai += t * (im[a] + im[b]);
				}
				ore[w] = ar;
				oim[w] = ai;
				w++;
			}
			keepTail(this, pos, total);
			return w - w0;
		}
	}

	// Real samples (FM's audio, still at 240 kHz) down to 48 kHz
	class FirDecimatorReal {
		constructor(taps, decim, maxIn) {
			const n = taps.length;
			this.n = n;
			this.d = decim;
			this.half = n >> 1;
			this.h = Float64Array.from(taps.subarray(0, this.half));
			this.mid = n & 1 ? taps[this.half] : 0;
			this.buf = new Float64Array(n + maxIn + 8);
			this.reset();
		}
		reset() {
			this.buf.fill(0);
			this.fill = this.n - 1;
			this.pos = 0;
		}
		// `count` new samples are at buf[fill...]; the output goes to out[at...]
		run(count, out, at) {
			const n = this.n, d = this.d, half = this.half, h = this.h, buf = this.buf, mid = this.mid;
			const total = this.fill + count, last = total - n;
			let w = at, pos = this.pos;
			for (; pos <= last; pos += d) {
				const e = pos + n - 1;
				let a0 = mid * buf[pos + half], a1 = 0, k = 0;
				for (; k + 1 < half; k += 2) {
					const a = pos + k, b = e - k;
					a0 += h[k] * (buf[a] + buf[b]);
					a1 += h[k + 1] * (buf[a + 1] + buf[b - 1]);
				}
				if (k < half) a0 += h[k] * (buf[pos + k] + buf[e - k]);
				out[w++] = a0 + a1;
			}
			if (pos < total) {
				buf.copyWithin(0, pos, total);
				this.fill = total - pos;
				this.pos = 0;
			} else {
				this.fill = 0;
				this.pos = pos - total;
			}
			return w - at;
		}
	}

	// One sideband: a low-pass moved off to one side of 0 Hz (so its taps are
	// complex), and only the real part of what comes out, which is the audio
	class SidebandFilter {
		constructor(proto, shift, maxIn) {
			const n = proto.length;
			this.n = n;
			this.d = 1;
			this.gr = new Float64Array(n);
			this.gi = new Float64Array(n);
			for (let j = 0; j < n; j++) {
				const k = n - 1 - j, ph = 2 * Math.PI * shift * k;
				this.gr[j] = proto[k] * Math.cos(ph);
				this.gi[j] = proto[k] * Math.sin(ph);
			}
			this.re = new Float64Array(n + maxIn + 8);
			this.im = new Float64Array(n + maxIn + 8);
			this.out = null;
			this.reset();
		}
		reset() {
			this.re.fill(0);
			this.im.fill(0);
			this.fill = this.n - 1;
			this.pos = 0;
		}
		run(count) {
			const n = this.n, gr = this.gr, gi = this.gi, re = this.re, im = this.im;
			const out = this.out, ore = out.re, total = this.fill + count, last = total - n, w0 = out.fill;
			let w = w0, pos = this.pos;
			for (; pos <= last; pos++) {
				let a0 = 0, a1 = 0, k = 0;
				for (; k + 1 < n; k += 2) {
					const p = pos + k;
					a0 += gr[k] * re[p] - gi[k] * im[p];
					a1 += gr[k + 1] * re[p + 1] - gi[k + 1] * im[p + 1];
				}
				if (k < n) a0 += gr[k] * re[pos + k] - gi[k] * im[pos + k];
				ore[w++] = a0 + a1;
			}
			keepTail(this, pos, total);
			return w - w0;
		}
	}

	// Audio at 12 kHz up to 48 kHz
	class Interpolator {
		constructor(taps, up, maxIn) {
			this.up = up;
			this.p = taps.length / up;
			this.ph = [];
			for (let q = 0; q < up; q++) {
				const t = new Float64Array(this.p);
				for (let j = 0; j < this.p; j++) t[j] = up * taps[j * up + q];
				this.ph.push(t);
			}
			this.x = new Float64Array(this.p + maxIn + 8);
			this.reset();
		}
		reset() {
			this.x.fill(0);
		}
		run(inp, count, out) {
			const p = this.p, up = this.up, x = this.x, ph = this.ph;
			let o = 0;
			for (let i = 0; i < count; i++) x[p - 1 + i] = inp[i];
			for (let i = 0; i < count; i++) {
				const cur = p - 1 + i;
				for (let q = 0; q < up; q++) {
					const t = ph[q];
					let a = 0;
					for (let j = 0; j < p; j++) a += t[j] * x[cur - j];
					out[o++] = a;
				}
			}
			x.copyWithin(0, count, count + p - 1);
			return o;
		}
	}

	class Biquad {
		constructor(b0, b1, b2, a1, a2) {
			this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
			this.z1 = 0; this.z2 = 0;
		}
		static lowpass(fs, f, q) {
			const w = 2 * Math.PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
			return new Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
		}
		static highpass(fs, f, q) {
			const w = 2 * Math.PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
			return new Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
		}
		reset() { this.z1 = 0; this.z2 = 0; }
		run(buf, n) {
			const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
			let z1 = this.z1, z2 = this.z2;
			for (let i = 0; i < n; i++) {
				const x = buf[i], y = b0 * x + z1;
				z1 = b1 * x - a1 * y + z2;
				z2 = b2 * x - a2 * y;
				buf[i] = y;
			}
			this.z1 = z1; this.z2 = z2;
		}
	}

	// The angle of (x, y), to within two millionths of a radian: FM's
	// discriminator asks for one per sample, and Math.atan2 is three times the work
	function atan2(y, x) {
		const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, hi = ax > ay ? ax : ay;
		if (hi === 0) return 0;
		const a = (ax > ay ? ay : ax) / hi, s = a * a;
		let r = a * (0.99997726 + s * (-0.33262347 + s * (0.19354346 + s * (-0.11643287 + s * (0.05265332 + s * -0.01172120)))));
		if (ay > ax) r = 1.5707963267948966 - r;
		if (x < 0) r = 3.141592653589793 - r;
		return y < 0 ? -r : r;
	}

	// A one-pole low-pass's coefficient for a time constant, and what it lets
	// through of a tone at f
	function onePole(fs, seconds) { return 1 - Math.exp(-1 / (seconds * fs)); }
	function onePoleGain(a, fs, f) {
		const w = 2 * Math.PI * f / fs, r = 1 - a;
		return a / Math.sqrt(1 - 2 * r * Math.cos(w) + r * r);
	}

	/* ---------- AGC ----------
	   For sideband and Morse. It looks a few milliseconds ahead of what it
	   lets out, so the gain is already down when something loud arrives (no
	   blast after a silence); it then holds, and gives the gain back slowly,
	   so the gaps in speech do not pump the noise up. */

	const AGC_TARGET = 0.5;
	const AGC_FLOOR = AGC_TARGET / 3000;      // 70 dB of gain at most

	class Agc {
		constructor(fs) {
			this.look = Math.max(2, Math.round(0.004 * fs));
			this.dl = new Float64Array(this.look);
			this.hang = Math.round(0.3 * fs);
			this.decay = Math.pow(10, -30 / 20 / fs);        // then 30 dB a second
			this.fall = 1 - Math.exp(-12 / this.look);       // down within the look-ahead
			this.rise = onePole(fs, 0.02);
			this.reset();
		}
		reset() {
			this.dl.fill(0);
			this.p = 0;
			this.env = AGC_FLOOR;
			this.gain = AGC_TARGET / AGC_FLOOR;
			this.left = 0;
		}
		run(buf, n) {
			const dl = this.dl, look = this.look, hang = this.hang, decay = this.decay, fall = this.fall, rise = this.rise;
			let p = this.p, env = this.env, gain = this.gain, left = this.left;
			for (let i = 0; i < n; i++) {
				const x = buf[i], a = x < 0 ? -x : x;
				if (a >= env) { env = a; left = hang; }
				else if (left > 0) left--;
				else { env *= decay; if (env < AGC_FLOOR) env = AGC_FLOOR; }
				const want = AGC_TARGET / env;
				gain += (want - gain) * (want < gain ? fall : rise);
				const y = dl[p] * gain;
				dl[p] = x;
				if (++p === look) p = 0;
				buf[i] = y > 1 ? 1 : y < -1 ? -1 : y;
			}
			this.p = p; this.env = env; this.gain = gain; this.left = left;
		}
	}

	/* ---------- AM's detector ----------
	   The envelope, less the carrier, over the carrier: so the sound is as
	   loud as the modulation is deep, however strong the station (AM's own
	   AGC, off the carrier, which the gaps in speech do not move). The carrier
	   is followed slowly, except when the envelope leaps past anything
	   modulation could do: a station keying up, caught within the few
	   milliseconds this too looks ahead. */

	const AM_FLOOR = 1e-4;

	class AmDetector {
		constructor(fs) {
			this.look = Math.max(2, Math.round(0.004 * fs));
			this.dl = new Float64Array(this.look);
			this.fast = 1 - Math.exp(-12 / this.look);
			this.slow = onePole(fs, 0.05);
			this.hp = Biquad.highpass(fs, 100, Math.SQRT1_2);
			this.reset();
		}
		reset() {
			this.dl.fill(0);
			this.p = 0;
			this.c = AM_FLOOR;
			this.hp.reset();
		}
		run(buf, n, agc) {
			const dl = this.dl, look = this.look, fast = this.fast, slow = this.slow, hp = this.hp;
			const b0 = hp.b0, b1 = hp.b1, b2 = hp.b2, a1 = hp.a1, a2 = hp.a2;
			let p = this.p, c = this.c, z1 = hp.z1, z2 = hp.z2;
			for (let i = 0; i < n; i++) {
				const e = buf[i];
				c += (e - c) * (e > 1.9 * c ? fast : slow);
				if (c < AM_FLOOR) c = AM_FLOOR;
				const x = dl[p];
				dl[p] = e;
				if (++p === look) p = 0;
				const y = b0 * x + z1;
				z1 = b1 * x - a1 * y + z2;
				z2 = b2 * x - a2 * y;
				const v = agc ? y / c : y * MANUAL_GAIN;
				buf[i] = (v > 1 ? 1 : v < -1 ? -1 : v) * OUT_GAIN;
			}
			this.p = p; this.c = c; hp.z1 = z1; hp.z2 = z2;
		}
	}

	/* ---------- planning the way down ----------
	   From the radio's rate to the demodulator's, the rate is divided in
	   stages (by 2 and by 5: all it ever takes). A stage only has to keep
	   clean what will still be there at the end, so the early ones, with the
	   whole band between that and what would fold onto it, are a handful of
	   taps; the last one, or a filter after it, cuts the channel out. Every
	   order of the stages is costed, and the cheapest is built. */

	function primeFactors(d) {
		const f = [];
		for (let p = 2; d > 1;) {
			if (d % p === 0) { f.push(p); d /= p; }
			else p++;
		}
		return f;
	}
	function orderings(list) {
		const out = [], used = new Array(list.length).fill(false), cur = [];
		list = list.slice().sort(function (a, b) { return a - b; });
		(function go() {
			if (cur.length === list.length) { out.push(cur.slice()); return; }
			for (let i = 0; i < list.length; i++) {
				if (used[i] || (i > 0 && list[i] === list[i - 1] && !used[i - 1])) continue;
				used[i] = true; cur.push(list[i]);
				go();
				used[i] = false; cur.pop();
			}
		})();
		return out;
	}
	// One stage, not yet designed: from rate r, by `decim`, flat to `lo`, `atten` dB down by `hi`
	function stageSpec(r, decim, lo, hi, atten) {
		let n = kaiserLength((hi - lo) / r, atten);
		if (decim === 2 && Math.abs(lo + hi - r / 2) < 1e-6 * r) {
			while (n % 4 !== 3) n++;
			return { rate: r, decim: 2, halfband: true, n: n, lo: lo, hi: hi, atten: atten, cost: r / 2 * ((n + 1) / 4 * 1.5 + 1) };
		}
		if (!(n & 1)) n++;
		return { rate: r, decim: decim, halfband: false, n: n, lo: lo, hi: hi, atten: atten, cost: r / decim * n * 0.75 };
	}
	// pass: the channel's edge. stop: where it must be gone; 0 when a filter
	// after the chain does the selecting, and the chain only keeps `pass` clean.
	function planChain(rateIn, rateOut, pass, stop) {
		const d = Math.round(rateIn / rateOut);
		// What a stage with output rate `out` keeps clean. All of the channel's
		// skirt, to be sure; but where what would fold onto the skirt lies in
		// the last tenth of the stage's own way down (and so is all but gone
		// already), only the channel: that is fewer taps, where there are most.
		function guard(out) { return stop ? Math.min(stop, Math.max(pass, (stop - 0.1 * out) / 0.8)) : pass; }
		let best = null;
		if (d === 1) best = { stages: stop ? [stageSpec(rateIn, 1, pass, stop, ATTEN)] : [], cost: 0 };
		else orderings(primeFactors(d)).forEach(function (order) {
			const stages = [];
			let r = rateIn, cost = 0;
			for (let i = 0; i < order.length; i++) {
				const out = r / order[i], last = i === order.length - 1, g = guard(out), fits = out - g > g * 1.02;
				const keep = fits ? stageSpec(r, order[i], g, out - g, ATTEN_KEEP) : null;
				if (last && stop) {
					// The last stage can cut the channel out itself, or leave
					// that to a filter after it: whichever is less work
					const self = stageSpec(r, order[i], pass, stop, ATTEN), after = stageSpec(out, 1, pass, stop, ATTEN);
					if (!keep || self.cost <= keep.cost + after.cost) { stages.push(self); cost += self.cost; }
					else { stages.push(keep, after); cost += keep.cost + after.cost; }
				} else {
					if (!keep) return;
					stages.push(keep);
					cost += keep.cost;
				}
				r = out;
			}
			if (!best || cost < best.cost) best = { stages: stages, cost: cost };
		});
		if (!best) throw new Error("no way from " + rateIn + " to " + rateOut + " Hz for a channel this wide");
		return best.stages;
	}
	function buildStage(s, maxIn) {
		const beta = kaiserBeta(s.atten);
		if (s.halfband) return new HalfbandDecimator(halfband(s.n, beta), maxIn);
		return new FirDecimator(lowpass(s.n, (s.lo + s.hi) / 2 / s.rate, beta), s.decim, maxIn);
	}

	/* ---------- the mixer's oscillator: a table of cosines and sines ----------
	   Side by side (one cache line gives both), and scaled by 1/128, so the
	   samples come out of the mixer as fractions of full scale. 8192 steps
	   to the turn puts its spurs 78 dB down: under what 8 bits can hold. */

	const NCO_BITS = 13, NCO_SHIFT = 32 - NCO_BITS;
	const NCO = new Float64Array(2 << NCO_BITS);
	for (let i = 0; i < 1 << NCO_BITS; i++) {
		NCO[2 * i] = Math.cos(2 * Math.PI * i / (1 << NCO_BITS)) / 128;
		NCO[2 * i + 1] = Math.sin(2 * Math.PI * i / (1 << NCO_BITS)) / 128;
	}

	// The mixer: n samples of x (I and Q, 8 bits each) from byte `off`, the
	// radio's DC taken off, turned by the oscillator, into re and im from w.
	// The samples are added up on the way (into sums), for the next measure
	// of the DC. Returns the oscillator's phase after them.
	// (A function of its own, and the "| 0"s: the compiler then keeps the
	// phase and its step as the 32-bit integers they are. Left to guess, it
	// does their wrapping sum in floating point, at twice the time.)
	function mix(x, off, n, re, im, w, ph, inc, dcI, dcQ, sums) {
		ph = ph | 0;
		inc = inc | 0;
		let si = 0, sq = 0;
		for (let i = off, e = off + 2 * n; i < e; i += 2) {
			const xi = x[i], xq = x[i + 1], k = (ph >>> NCO_SHIFT) << 1, c = NCO[k], s = NCO[k + 1];
			const a = xi - dcI, b = xq - dcQ;
			si += xi;
			sq += xq;
			re[w] = a * c + b * s;
			im[w] = b * c - a * s;
			w++;
			ph = (ph + inc) | 0;
		}
		sums[0] += si;
		sums[1] += sq;
		return ph;
	}

	/* ---------- one channel: mixer, chain, demodulator, audio ---------- */

	class Channel {
		constructor(rx) {
			const mode = rx.mode, bw = rx.bw, rate = rx.rate, edge = edges(mode, bw), ifRate = MODES[mode].rate;
			const ssb = mode === "usb" || mode === "lsb", beta = kaiserBeta(ATTEN);
			this.rx = rx;
			this.mode = mode;
			this.ifRate = ifRate;
			this.phase = 0;
			this.inc = 0;

			// A sideband lies to one side of the dial: the chain keeps that far
			// clean on both, and the sideband's own filter comes after it
			const plan = ssb ? planChain(rate, ifRate, SSB_LOW + bw / 2 + edge.stop, 0) : planChain(rate, ifRate, edge.pass, edge.stop);
			let maxIn = rate / 1000 + 1, r = rate, settle = 0;
			this.stages = [];
			this.plan = plan;
			for (let i = 0; i < plan.length; i++) {
				this.stages.push(buildStage(plan[i], maxIn));
				settle += plan[i].n / r;
				r /= plan[i].decim;
				maxIn = Math.ceil(maxIn / plan[i].decim) + 1;
			}
			if (ssb) {
				// The sideband's own filter, at 12 kHz: SSB_LOW to SSB_LOW + bw from the dial, on its side
				let n = kaiserLength((edge.stop - edge.pass) / ifRate, ATTEN);
				if (!(n & 1)) n++;
				const mid = (SSB_LOW + bw / 2) / ifRate;
				this.stages.push(new SidebandFilter(lowpass(n, (edge.pass + edge.stop) / 2 / ifRate, beta), mode === "usb" ? mid : -mid, maxIn));
				settle += n / ifRate;
			}
			// What the demodulator reads: the last stage's output
			this.zin = { re: new Float64Array(maxIn + 8), im: new Float64Array(maxIn + 8), fill: 0 };
			for (let i = 0; i < this.stages.length; i++) this.stages[i].out = this.stages[i + 1] || this.zin;
			this.first = this.stages[0] || this.zin;

			// The level is taken 10 ms at a time, and the squelch decided on it
			this.blkLen = ifRate / 100;
			this.lastPow = 0;
			this.open = rx.squelch === null;
			this.gate = this.open ? 1 : 0;
			this.hold = 0;

			this.a48 = new Float64Array(1024);
			this.a12 = new Float64Array(256);
			this.out = new Float32Array(CHUNK);
			this.outN = 0;

			if (mode === "wfm") {
				// The discriminator's output, at 240 kHz, is the audio (to 15 kHz)
				// under the stereo pilot (19 kHz) and what rides above it. Down to
				// 48 kHz through a filter that keeps the pilot and the rest from
				// folding onto the audio, then one at 48 kHz that takes them off:
				// in two steps, half the work of doing it in one
				let n = kaiserLength((AUDIO_RATE - 19000 - 15000) / ifRate, ATTEN), n2 = kaiserLength(4000 / AUDIO_RATE, ATTEN);
				if (!(n & 1)) n++;
				if (!(n2 & 1)) n2++;
				this.adec = new FirDecimatorReal(lowpass(n, 22000 / ifRate, beta), ifRate / AUDIO_RATE, maxIn);
				this.alp = new FirDecimatorReal(lowpass(n2, 17000 / AUDIO_RATE, beta), 1, maxIn);
				this.fmScale = ifRate / (2 * Math.PI * FM_DEVIATION) * OUT_GAIN;
				settle += n / ifRate + n2 / AUDIO_RATE;
			} else if (mode === "nfm") {
				// Two-way FM is sent with its treble raised: it is taken back
				// down (from 300 Hz), the sub-audible tones under the speech
				// are cut, and so is the hiss above it
				const a = onePole(AUDIO_RATE, 1 / (2 * Math.PI * 300));
				this.deK = a;
				this.fmScale = ifRate / (2 * Math.PI * Math.max(1000, 0.2 * bw)) * OUT_GAIN / onePoleGain(a, AUDIO_RATE, 1000);
				this.hp = Biquad.highpass(AUDIO_RATE, 300, Math.SQRT1_2);
				this.lp = Biquad.lowpass(AUDIO_RATE, 4000, Math.SQRT1_2);
				settle += 0.004;
			} else if (mode === "am") {
				this.am = new AmDetector(AUDIO_RATE);
				settle += 0.012;
			} else {
				this.agc = new Agc(ifRate);
				let n = kaiserLength(2800 / AUDIO_RATE, ATTEN);
				while (n % 4) n++;
				this.interp = new Interpolator(lowpass(n, 6000 / AUDIO_RATE, beta), AUDIO_RATE / ifRate, maxIn + 8);
				this.bfo = 0;
				settle += n / AUDIO_RATE + 0.006;
			}
			// After anything that breaks the signal's flow, this long is left
			// silent: the filters fill with the new signal, unheard
			this.settle = Math.max(480, Math.ceil(settle * AUDIO_RATE) + 96);
			this.setDeemph(rx.deemph);
			this.reset();
		}

		setOffset(hz) {
			this.inc = Math.round(hz / this.rx.rate * 4294967296) | 0;
		}
		setDeemph(us) {
			if (this.mode === "wfm") this.deK = us > 0 ? onePole(AUDIO_RATE, us * 1e-6) : 0;
		}

		// Forget the signal so far: it is no longer the one coming
		reset() {
			for (let i = 0; i < this.stages.length; i++) this.stages[i].reset();
			this.pr = 0; this.pq = 0; this.deY = 0;
			if (this.adec) { this.adec.reset(); this.alp.reset(); }
			if (this.hp) { this.hp.reset(); this.lp.reset(); }
			if (this.am) this.am.reset();
			if (this.agc) { this.agc.reset(); this.interp.reset(); }
			this.blkLeft = this.blkLen;
			this.blkPow = 0;
			this.mPow = 0;
			this.mN = 0;
			this.mute = this.settle;
			this.fade = 0;
		}

		// Take over from the channel this one replaces: the audio it had not
		// yet sent, and where its squelch stood
		adopt(old) {
			this.out = old.out;
			this.outN = old.outN;
			this.open = old.open;
			this.gate = old.gate;
			this.hold = old.hold;
		}

		// n samples from the radio: the channel moved to 0 Hz, on down the
		// chain, and what comes out of that demodulated
		run(x, off, n, dcI, dcQ) {
			const first = this.first;
			this.phase = mix(x, off, n, first.re, first.im, first.fill, this.phase, this.inc, dcI, dcQ, this.rx._dcSum);
			let count = n;
			for (let i = 0; i < this.stages.length; i++) count = this.stages[i].run(count);
			// The demodulator, up to each place the level is taken: so the
			// squelch moves at the same sample however the input was cut up
			for (let i = 0; i < count;) {
				const run = Math.min(count - i, this.blkLeft);
				this.demod(i, run);
				i += run;
				this.blkLeft -= run;
				if (this.blkLeft === 0) this.endBlock();
			}
		}

		demod(i, n) {
			const zre = this.zin.re, zim = this.zin.im, a48 = this.a48, e = i + n;
			// (the power is added on to the block's so far, sample by sample:
			// the same sum, to the last bit, however the samples arrived)
			let s = this.blkPow, m = n;
			switch (this.mode) {
			case "wfm": {
				// How far the phase turned since the last sample is the audio
				const d = this.adec, buf = d.buf, k = this.fmScale;
				let w = d.fill, pr = this.pr, pq = this.pq;
				for (let j = i; j < e; j++) {
					const r = zre[j], q = zim[j];
					s += r * r + q * q;
					buf[w++] = atan2(q * pr - r * pq, r * pr + q * pq) * k;
					pr = r; pq = q;
				}
				this.pr = pr; this.pq = pq;
				const lp = this.alp;
				m = lp.run(d.run(n, lp.buf, lp.fill), a48, 0);
				const a = this.deK;
				if (a > 0) {
					let y = this.deY;
					for (let j = 0; j < m; j++) { y += a * (a48[j] - y); a48[j] = y; }
					this.deY = y;
				}
				break;
			}
			case "nfm": {
				const k = this.fmScale, a = this.deK;
				let pr = this.pr, pq = this.pq, y = this.deY;
				for (let j = i, o = 0; j < e; j++, o++) {
					const r = zre[j], q = zim[j];
					s += r * r + q * q;
					y += a * (atan2(q * pr - r * pq, r * pr + q * pq) * k - y);
					a48[o] = y;
					pr = r; pq = q;
				}
				this.pr = pr; this.pq = pq; this.deY = y;
				this.hp.run(a48, n);
				this.lp.run(a48, n);
				for (let o = 0; o < n; o++) { const v = a48[o]; a48[o] = v > 1 ? 1 : v < -1 ? -1 : v; }
				break;
			}
			case "am":
				for (let j = i, o = 0; j < e; j++, o++) {
					const r = zre[j], q = zim[j], p = r * r + q * q;
					s += p;
					a48[o] = Math.sqrt(p);
				}
				this.am.run(a48, n, this.rx.agc);
				break;
			default: {
				const a12 = this.a12;
				if (this.mode === "cw") {
					// The carrier is at 0 Hz: turning it at the pitch makes it a tone
					const dp = 2 * Math.PI * this.rx.cwPitch / this.ifRate;
					let ph = this.bfo;
					for (let j = i, o = 0; j < e; j++, o++) {
						const r = zre[j], q = zim[j];
						s += r * r + q * q;
						a12[o] = r * Math.cos(ph) - q * Math.sin(ph);
						ph += dp;
						if (ph > Math.PI) ph -= 2 * Math.PI;
					}
					this.bfo = ph;
				} else {
					// One sideband's filter has left the audio itself: its power is half the signal's
					for (let j = i, o = 0; j < e; j++, o++) {
						const v = zre[j];
						s += 2 * v * v;
						a12[o] = v;
					}
				}
				if (this.rx.agc) this.agc.run(a12, n);
				else for (let o = 0; o < n; o++) { const v = a12[o] * MANUAL_GAIN; a12[o] = v > 1 ? 1 : v < -1 ? -1 : v; }
				m = this.interp.run(a12, n, a48);
			}
			}
			this.blkPow = s;
			this.emit(a48, m);
		}

		// 10 ms of the channel are in: its level, and what the squelch makes of it
		endBlock() {
			const p = this.blkPow / this.blkLen, sq = this.rx.squelch;
			this.blkPow = 0;
			this.blkLeft = this.blkLen;
			this.mPow += p;
			this.mN++;
			this.lastPow = p;
			if (sq === null) { this.open = true; return; }
			const db = 10 * Math.log10(p + 1e-20);
			if (db >= sq) { this.open = true; this.hold = SQ_HOLD; }
			else if (this.open && db < sq - SQ_HYST) {
				if (this.hold > 0) this.hold--;
				else this.open = false;
			}
		}

		// The level since it was last asked, dBFS
		level() {
			const p = this.mN ? this.mPow / this.mN : this.lastPow;
			this.mPow = 0;
			this.mN = 0;
			return Math.max(FLOOR_DB, 10 * Math.log10(p + 1e-20));
		}

		// Audio on its way out: silent after a reset, faded in; faded out and
		// then withheld while the squelch is shut; sent a chunk at a time
		emit(buf, n) {
			let i = 0;
			while (i < n) {
				if (this.open && this.gate >= 1 && this.mute === 0 && this.fade >= 1) {
					const out = this.out;
					let w = this.outN, take = Math.min(CHUNK - w, n - i);
					for (; take > 0; take--) out[w++] = buf[i++];
					this.outN = w;
					if (w === CHUNK) this.flush(CHUNK);
					continue;
				}
				let g = 1;
				if (this.mute > 0) { this.mute--; g = 0; }
				else if (this.fade < 1) { this.fade = Math.min(1, this.fade + 1 / 240); g = this.fade; }
				if (this.open) this.gate = Math.min(1, this.gate + 1 / 240);
				else if (this.gate > 0) {
					this.gate -= 1 / 240;
					if (this.gate <= 0) {
						// Shut: what is waiting goes now, made up to a whole piece
						this.gate = 0;
						if (this.outN > 0) {
							while (this.outN < MIN_CHUNK) this.out[this.outN++] = 0;
							this.flush(this.outN);
						}
					}
				}
				if (this.gate > 0) {
					this.out[this.outN++] = buf[i] * g * this.gate;
					if (this.outN === CHUNK) this.flush(CHUNK);
				}
				i++;
			}
		}
		flush(n) {
			const c = n === CHUNK ? this.out : this.out.slice(0, n);
			if (n === CHUNK) this.out = new Float32Array(CHUNK);
			this.outN = 0;
			this.rx.onAudio(c);
		}
	}

	/* ---------- the receiver ----------

	   new Receiver({ rate, center, vfo, mode, bw, squelch, agc, deemph,
	                  cwPitch, audio, fftSize, fps, onFft, onAudio, onMeter })
	   .process(x, n, gap)   n samples in the Int8Array x (I, Q, I, Q...);
	                         gap: samples were lost before these
	   .set({ ... })         any of the above, at any time
	   onFft(bins, center, rate)   a spectrum line (see DESIGN.md)
	   onAudio(samples)            48 kHz mono, a Float32Array to keep
	   onMeter({ level, squelched, outside })   five times a second */

	function nop() {}

	class Receiver {
		constructor(o) {
			o = o || {};
			this.onFft = o.onFft || nop;
			this.onAudio = o.onAudio || nop;
			this.onMeter = o.onMeter || nop;
			this.rate = 0;
			this.center = 98e6;
			this.vfo = null;
			this.mode = "wfm";
			this.bw = MODES.wfm.bw;
			this.squelch = null;
			this.agc = true;
			this.deemph = 75;
			this.cwPitch = 700;
			this.audio = true;
			this.fftSize = 4096;
			this.fps = 20;
			this._chan = null;
			this._outside = false;
			const first = { rate: 2400000 };
			for (const k in o) if (typeof o[k] !== "function") first[k] = o[k];
			this.set(first);
		}

		set(o) {
			let all = false, fft = false, lines = false, chan = false, moved = false, tuned = false;
			if (o.rate != null && o.rate !== this.rate) {
				if (!(o.rate > 0) || o.rate % MODES.wfm.rate) throw new RangeError("the sample rate must be a multiple of " + MODES.wfm.rate);
				this.rate = o.rate;
				all = true;
			}
			if (o.center != null && o.center !== this.center) { this.center = o.center; moved = true; }
			if (o.mode != null && o.mode !== this.mode) {
				if (!MODES[o.mode]) throw new RangeError("no such mode: " + o.mode);
				this.mode = o.mode;
				// A width from another mode means nothing here
				if (o.bw == null) this.bw = MODES[o.mode].bw;
				chan = true;
			}
			if (o.bw != null) {
				const b = clampBw(this.mode, o.bw);
				if (b !== this.bw) { this.bw = b; chan = true; }
			}
			if (o.vfo != null && o.vfo !== this.vfo) { this.vfo = o.vfo; tuned = true; }
			if (this.vfo === null) { this.vfo = this.center + this.rate / 8; tuned = true; }
			if (o.squelch !== undefined) this.squelch = o.squelch === null ? null : +o.squelch;
			if (o.agc != null) this.agc = !!o.agc;
			if (o.deemph != null) this.deemph = +o.deemph;
			if (o.cwPitch != null) this.cwPitch = clamp(+o.cwPitch, 200, 1500);
			if (o.audio != null && !!o.audio !== this.audio) { this.audio = !!o.audio; chan = true; }
			if (o.fftSize != null && o.fftSize !== this.fftSize) {
				if (o.fftSize < 1024 || o.fftSize > 32768 || (o.fftSize & (o.fftSize - 1)))
					throw new RangeError("the FFT size must be a power of two, 1024 to 32768");
				this.fftSize = o.fftSize;
				fft = true;
			}
			if (o.fps != null && clamp(+o.fps, 5, 40) !== this.fps) { this.fps = clamp(+o.fps, 5, 40); lines = true; }

			if (all) {
				// A new sample rate: everything is rebuilt for it
				this._dcLen = this.rate / 1000;
				this._meterLen = this.rate / 5;
				this._meterLeft = this._meterLen;
				this._moved();
				this._buildFft();
				this._channel(true, false);
			} else {
				if (fft) this._buildFft();
				else if (lines) this._schedule();
				if (moved) this._moved();
				if (chan || moved || tuned) this._channel(chan, moved);
			}
			if (this._chan) this._chan.setDeemph(this.deemph);
		}

		// Samples were lost: what the channel's filters hold is not what comes next
		discontinuity() {
			if (this._chan) this._chan.reset();
		}

		// The radio is on another frequency: its DC offset is another, and
		// what the FFT has waiting is from the old one
		_moved() {
			this._dcI = this._dcI || 0;
			this._dcQ = this._dcQ || 0;
			this._dcPrimed = false;
			this._dcSum = this._dcSum || new Float64Array(2);
			this._dcSum[0] = 0;
			this._dcSum[1] = 0;
			this._dcLeft = this._dcLen;
			this._ringFill = 0;
			this._accN = 0;
			if (this._acc) this._acc.fill(0);
		}

		_buildFft() {
			const n = this.fftSize;
			this._fft = new FFT(n);
			this._win = fftWindow(n);
			this._ring = new Int8Array(2 * n);
			this._ringW = 0;
			this._ringFill = 0;
			this._fre = new Float64Array(n);
			this._fim = new Float64Array(n);
			this._acc = new Float64Array(n);
			this._accN = 0;
			this._fftLevel = FLOOR_DB;
			this._schedule();
		}

		// When the FFTs are taken: `fps` lines a second of signal, each the
		// average of a few FFTs spread evenly over its time
		_schedule() {
			const perLine = this.rate / this.fps, n = this.fftSize;
			this._perLine = Math.max(1, Math.min(FFT_MAX_AVG, Math.floor(perLine / n), Math.floor(FFT_BUDGET / (this.fps * n))));
			this._pos = 0;
			this._line = 0;
			this._fftIdx = 0;
			this._nextFft();
		}
		_nextFft() {
			const per = this.rate / this.fps, s0 = Math.round(this._line * per), s1 = Math.round((this._line + 1) * per);
			this._fftLeft = s0 + Math.round((this._fftIdx + 1) * (s1 - s0) / this._perLine) - this._pos;
		}

		// Build, keep, retune or drop the channel, as the settings now ask
		_channel(rebuild, reset) {
			const off = this.vfo - this.center;
			this._outside = Math.abs(off) + this.bw / 2 > this.rate / 2;
			if (!this.audio || this._outside) { this._chan = null; return; }
			if (!this._chan || rebuild) {
				const old = this._chan;
				this._chan = new Channel(this);
				if (old) this._chan.adopt(old);
			} else if (reset) this._chan.reset();
			this._chan.setOffset(off);
		}

		process(x, n, gap) {
			if (gap) this.discontinuity();
			let off = 0;
			while (n > 0) {
				// As far as the next thing that happens at a set sample
				let seg = n;
				if (seg > this._dcLeft) seg = this._dcLeft;
				if (seg > this._fftLeft) seg = this._fftLeft;
				if (seg > this._meterLeft) seg = this._meterLeft;
				const end = off + 2 * seg, ring = this._ring, size = this.fftSize;

				// The FFT takes its samples from the last `size` of them, kept here
				if (seg >= size) {
					ring.set(x.subarray(end - 2 * size, end));
					this._ringW = 0;
				} else {
					const w = this._ringW, head = Math.min(seg, size - w);
					ring.set(x.subarray(off, off + 2 * head), 2 * w);
					if (head < seg) ring.set(x.subarray(off + 2 * head, end));
					this._ringW = (w + seg) & (size - 1);
				}
				if (this._ringFill < size) this._ringFill = Math.min(size, this._ringFill + seg);

				if (this._chan) this._chan.run(x, off, seg, this._dcI, this._dcQ);
				else {
					// Nobody is listening: the samples are still added up, for the DC
					let si = 0, sq = 0;
					for (let i = off; i < end; i += 2) { si += x[i]; sq += x[i + 1]; }
					this._dcSum[0] += si;
					this._dcSum[1] += sq;
				}

				off = end;
				n -= seg;
				this._pos += seg;
				if ((this._dcLeft -= seg) === 0) this._dcBlock();
				if ((this._fftLeft -= seg) === 0) this._fftDue();
				if ((this._meterLeft -= seg) === 0) this._meter();
			}
		}

		_dcBlock() {
			const i = this._dcSum[0] / this._dcLen, q = this._dcSum[1] / this._dcLen;
			if (this._dcPrimed) {
				this._dcI += (i - this._dcI) * DC_ALPHA;
				this._dcQ += (q - this._dcQ) * DC_ALPHA;
			} else {
				this._dcI = i;
				this._dcQ = q;
				this._dcPrimed = true;
			}
			this._dcSum[0] = 0;
			this._dcSum[1] = 0;
			this._dcLeft = this._dcLen;
		}

		_fftDue() {
			const n = this.fftSize;
			if (this._ringFill >= n) {
				const rev = this._fft.rev, win = this._win, re = this._fre, im = this._fim, ring = this._ring;
				const dcI = this._dcI, dcQ = this._dcQ, mask = n - 1, acc = this._acc;
				let s = this._ringW;
				for (let j = 0; j < n; j++) {
					const w = win[j], r = rev[j];
					re[r] = (ring[2 * s] - dcI) * w;
					im[r] = (ring[2 * s + 1] - dcQ) * w;
					s = (s + 1) & mask;
				}
				this._fft.transform(re, im);
				for (let k = 0; k < n; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
				this._accN++;
			}
			if (++this._fftIdx === this._perLine) {
				this._fftIdx = 0;
				this._line++;
				if (this._accN > 0) this._emitLine();
			}
			this._nextFft();
		}

		_emitLine() {
			const n = this.fftSize, half = n >> 1, mask = n - 1, acc = this._acc, inv = 1 / this._accN;
			const bins = new Float32Array(n);
			for (let i = 0; i < n; i++) bins[i] = 10 * Math.log10(acc[(i + half) & mask] * inv + 1e-20);
			if (!this._chan && !this._outside) {
				// Nothing is being demodulated: the level is read off the display instead
				const df = this.rate / n, off = this.vfo - this.center;
				let lo = off - this.bw / 2, hi = off + this.bw / 2;
				if (this.mode === "usb") { lo = off + SSB_LOW; hi = lo + this.bw; }
				if (this.mode === "lsb") { hi = off - SSB_LOW; lo = hi - this.bw; }
				const i0 = clamp(Math.round((lo + this.rate / 2) / df), 0, n - 1), i1 = clamp(Math.round((hi + this.rate / 2) / df), 0, n - 1);
				let p = 0;
				for (let i = i0; i <= i1; i++) p += acc[(i + half) & mask];
				this._fftLevel = Math.max(FLOOR_DB, 10 * Math.log10(p * inv / BH_ENBW + 1e-20));
			}
			acc.fill(0);
			this._accN = 0;
			this.onFft(bins, this.center, this.rate);
		}

		_meter() {
			const c = this._chan;
			this._meterLeft = this._meterLen;
			this.onMeter({
				level: c ? c.level() : this._outside ? FLOOR_DB : this._fftLevel,
				squelched: !!c && !c.open,
				outside: this._outside
			});
		}

		// How the channel is built, for the curious and the tests
		describe() {
			const c = this._chan;
			if (!c) return null;
			return { mode: c.mode, ifRate: c.ifRate, settle: c.settle, stages: c.plan.map(function (s) {
				return { rate: s.rate, decim: s.decim, taps: s.n, halfband: s.halfband };
			}) };
		}
	}

	return { Receiver: Receiver, MODES: MODES, AUDIO_RATE: AUDIO_RATE, FLOOR_DB: FLOOR_DB, clampBw: clampBw };
});
