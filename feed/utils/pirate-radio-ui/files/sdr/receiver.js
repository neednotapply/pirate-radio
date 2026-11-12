/* Pirate Radio: the receiver on the Listen page.

   The page's part of the receiver in the browser: it draws the spectrum and
   the waterfall, takes the tuning and plays the sound. The signal processing
   is the engine's (worker.js, in a worker), and the radio's samples reach the
   engine from pirate-websdr on the router. What the three agree on is in
   feed/utils/pirate-websdr/DESIGN.md.

   window.PirateSDR.mount(node, options) puts a receiver in node and returns
   { destroy() }. app.js loads this file the first time the page is opened.
   options: radio ("hackrf" | "rtlsdr"), url (the bridge's ws:// address),
   workerUrl, demo (a simulated band, no radio), onStop(reason). */
(function () {
	"use strict";

	/* ---------- small things ---------- */

	function el(tag, attrs) {
		var n = document.createElement(tag), k;
		if (attrs) for (k in attrs) {
			if (k === "class") n.className = attrs[k];
			else if (k === "text") n.textContent = attrs[k];
			else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
			else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
		}
		for (var i = 2; i < arguments.length; i++) {
			var c = arguments[i];
			if (c == null) continue;
			n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
		}
		return n;
	}
	function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

	// The stylesheet's colours, for what is drawn rather than styled
	var C = { bg: "#0e1012", line: "#272a2f", line2: "#363a40", muted: "#8c939a", hi: "#f2f4f5", accent: "#e0a040" };
	var MONO = 'ui-monospace, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, monospace';

	// What can be listened to: the channel's width (and the widths on offer)
	// and the step the dial moves in
	var MODES = {
		wfm: { label: "FM", title: "Broadcast FM", bw: 180000, bws: [150000, 180000, 200000], step: 100000 },
		nfm: { label: "NFM", title: "Narrow FM: two-way radios, weather, marine", bw: 12500, bws: [8000, 12500, 16000, 25000], step: 12500 },
		am: { label: "AM", title: "AM: aircraft, CB, broadcast", bw: 8000, bws: [5000, 8000, 10000, 15000], step: 5000 },
		usb: { label: "USB", title: "Upper sideband: amateur radio above 10 MHz", bw: 2700, bws: [1800, 2400, 2700, 3200, 4000], step: 100 },
		lsb: { label: "LSB", title: "Lower sideband: amateur radio below 10 MHz", bw: 2700, bws: [1800, 2400, 2700, 3200, 4000], step: 100 },
		cw: { label: "CW", title: "Morse", bw: 500, bws: [200, 500, 1000], step: 10 }
	};
	var MODE_ORDER = ["wfm", "nfm", "am", "usb", "lsb", "cw"];
	var STEPS = [10, 50, 100, 500, 1000, 5000, 6250, 8330, 9000, 10000, 12500, 25000, 50000, 100000, 200000, 1000000];
	var ZOOMS = [1, 2, 4, 8, 16];
	// More bins as the view narrows, so a pixel stays about a bin
	var FFT_FOR_ZOOM = { 1: 4096, 2: 8192, 4: 16384, 8: 32768, 16: 32768 };

	// Places to go, in plain words: where the dial lands, and how to listen
	// there. (Frequencies as used in the Americas where they differ.) off: how
	// far the band's channels sit from whole steps of the dial, where they do.
	var BANDS = [
		{ label: "FM radio", lo: 87.5e6, hi: 108e6, tune: 98.1e6, mode: "wfm" },
		{ label: "Aircraft", lo: 118e6, hi: 137e6, tune: 121.5e6, mode: "am", step: 25000 },
		{ label: "Weather radio", lo: 162.4e6, hi: 162.55e6, tune: 162.55e6, mode: "nfm", step: 25000 },
		{ label: "Marine", lo: 156e6, hi: 162.025e6, tune: 156.8e6, mode: "nfm", step: 25000 },
		{ label: "Ham 2 m", lo: 144e6, hi: 148e6, tune: 146.52e6, mode: "nfm", step: 5000 },
		{ label: "Ham 70 cm", lo: 420e6, hi: 450e6, tune: 446e6, mode: "nfm" },
		{ label: "FRS / GMRS", lo: 462.5e6, hi: 467.75e6, tune: 462.5625e6, mode: "nfm" },
		{ label: "433 MHz", lo: 433.05e6, hi: 434.79e6, tune: 433.92e6, mode: "nfm", step: 5000 },
		{ label: "915 MHz", lo: 902e6, hi: 928e6, tune: 915e6, mode: "nfm" },
		{ label: "CB", lo: 26.965e6, hi: 27.405e6, tune: 27.185e6, mode: "am", step: 10000, off: 5000 }
	];

	// A gain stage, as its radio names it: what to call it, and what it is
	var GAINS = {
		LNA: ["RF gain", "The HackRF's first amplifier stage (LNA), in 8 dB steps"],
		VGA: ["IF gain", "The HackRF's baseband amplifier (VGA), in 2 dB steps"],
		AMP: ["Preamp", "The HackRF's front-end amplifier, +14 dB: for weak signals only (strong ones overload it)"],
		TUNER: ["Gain", "The tuner's gain"]
	};

	// The waterfall's colours: weakest to strongest
	var PALETTES = {
		amber: [[0, 14, 16, 18], [0.3, 58, 36, 8], [0.55, 138, 88, 24], [0.78, 224, 160, 64], [0.92, 246, 213, 138], [1, 255, 255, 255]],
		classic: [[0, 2, 4, 24], [0.22, 12, 30, 120], [0.42, 0, 150, 200], [0.6, 60, 190, 80], [0.76, 232, 220, 40], [0.9, 232, 60, 40], [1, 255, 255, 255]],
		grey: [[0, 10, 10, 12], [1, 245, 245, 245]]
	};
	var PALETTE_NAMES = [["amber", "Amber"], ["classic", "Classic"], ["grey", "Grey"]];

	function fmtMHz(hz) {
		var s = (hz / 1e6).toFixed(6).replace(/0+$/, ""), dot = s.indexOf(".");
		while (s.length - dot - 1 < 3) s += "0";
		return s;
	}
	function fmtHz(hz) {
		if (hz >= 1e6) return String(+(hz / 1e6).toFixed(3)) + " MHz";
		if (hz >= 1e3) return String(+(hz / 1e3).toFixed(2)) + " kHz";
		return hz + " Hz";
	}
	// "98.1", "98,1", "433.92M", "27185k", "1.09G": a bare number is MHz
	function parseFreq(text) {
		var m = /^\s*([0-9]+(?:[.,][0-9]*)?|[.,][0-9]+)\s*([kKmMgG])?(?:hz)?\s*$/i.exec(String(text));
		if (!m) return null;
		var v = parseFloat(m[1].replace(",", ".")), u = (m[2] || "M").toLowerCase();
		v *= u === "k" ? 1e3 : u === "g" ? 1e9 : 1e6;
		return isFinite(v) && v > 0 ? Math.round(v) : null;
	}
	// FM's de-emphasis: 75 microseconds in the Americas and Korea, 50 elsewhere
	function deemphHere() {
		try {
			var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
			return /^America\/|^Asia\/Seoul$|^Pacific\/Honolulu$/.test(tz) ? 75 : 50;
		} catch (e) { return 75; }
	}

	/* ---------- what is remembered in this browser ---------- */

	var PREF_KEY = "pr.sdr";
	function loadPrefs() {
		try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; }
	}
	function savePrefs(p) {
		try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) {}
	}

	// Favourites: channels to come back to, kept with the rest of what this
	// browser remembers, for both radios. Each has a name, a frequency, and
	// how it is listened to. What is kept is not trusted to be whole: only
	// what makes sense comes out of it, one of each channel, along the dial.
	var MAX_FAVS = 100, FAV_NAME = 28;
	function shortMHz(hz) { return String(+(hz / 1e6).toFixed(6)); }
	function favName(text, f, mode) {
		return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, FAV_NAME) || shortMHz(f) + " " + MODES[mode].label;
	}
	function cleanFavs(list) {
		var out = [];
		(Array.isArray(list) ? list : []).forEach(function (v) {
			if (!v || typeof v.f !== "number" || !isFinite(v.f) || v.f <= 0 || !MODES[v.mode] || out.length >= MAX_FAVS) return;
			var f = Math.round(v.f);
			if (out.some(function (o) { return o.f === f && o.mode === v.mode; })) return;
			out.push({
				name: favName(v.name, f, v.mode), f: f, mode: v.mode,
				bw: typeof v.bw === "number" && v.bw > 0 ? v.bw : MODES[v.mode].bw,
				step: typeof v.step === "number" && v.step > 0 ? v.step : MODES[v.mode].step
			});
		});
		return out.sort(function (a, b) { return a.f - b.f || (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0); });
	}

	/* ---------- the noise in a line of the spectrum ----------
	   A line, here, is the power in each bin (not dB), lowest frequency
	   first, eased over a few lines. What noise alone comes to in a bin is
	   taken from the line itself, and from beside the place in question: a
	   signal stands out from what is around it, and the noise is not the
	   same all along a line (what an aerial picks up from the things about
	   it comes in humps, and the radio's filter slopes at the line's ends).

	   The bins are added up sixteen at a time, every half-stretch along. Of
	   the stretches within six channel widths either side of a channel
	   (half a channel next to it left out: what a signal spills is not
	   noise) the one that three in ten are under is the noise there. That
	   looks past the signals among them, as long as most of what is beside
	   a channel is not signal, and it reads a fraction of a dB low. With too
	   few stretches beside a channel to go by (it fills the line, or is not
	   in it) the whole line's are used.

	   Measured as power, not off the picture: the trace is eased in dB,
	   which sets noise lower than it is, by more the fewer FFTs a line is
	   made of (so by more, zoomed in); and a level, which the squelch is,
	   has to be right whatever the zoom. */
	var NOISE_STRETCH = 16, NOISE_REACH = 6, NOISE_SHARE = 0.3;
	var WINDOW_BINS = 2.0044;      // the display's window spreads noise over this many bins (dsp.js: Blackman-Harris)
	var SCAN_MARGIN = 6;           // dB a channel holds over the noise beside it, for a scan to stop on it
	var SQUELCH_MARGIN = 5;        // dB over that noise at which the squelch that sets itself opens: a little
	                               // under the scan's, so that what a scan stops on is heard
	var SCAN_SHOULDER = 15;

	// What the picture's bytes stand for, as power (half a dB to a step)
	var POW_OF_Q = new Float64Array(256);
	(function () { for (var q = 0; q < 256; q++) POW_OF_Q[q] = Math.pow(10, (q / 2 - 127.5) / 10); })();

	/* The lines, kept as power: each line of the picture's bytes taken in.
	   Twice over: eased over a few lines, as the trace is, which tells at
	   once whether something is there; and averaged over a second or two,
	   which tells what. A broadcast station's carrier moves with the sound
	   it carries: a fifth of a second of it is a dozen lumps along the
	   line, and only over a second is it one signal as wide as it is.

	   Lines that come after the radio has moved can still hold what it
	   heard before. The first two or three do because those samples were
	   on their way. And on the HackRF, for most of a second after, a line
	   here and there does again: its driver (SoapyHackRF) loses count of
	   its buffers when it is read late, as it is while the radio is being
	   moved, and then hands out one it filled 15 buffers ago (0.8 s, at 2.4
	   MHz) as if it were new. Seen on the router: the picture of before the
	   move back for a tenth of a second, 0.35 s and again 0.5 s after it.
	   In the picture that is nothing; in a sum of powers a strong signal
	   that is no longer there would stand as one for a while. So the first
	   lines are each taken alone (the easing begins after them), and the
	   long average begins only when a second has gone by. */
	var SETTLE_LINES = 3;          // lines after a move that hold what was heard before it: taken alone
	var GUARD_LINES = 20;          // lines after a move among which one such can still turn up: not averaged
	var SCAN_LINES = 4;            // lines a scan's first look goes by, after the first: is anything there?
	var SCAN_LONG = 20;            // lines its second look goes by, a second of them: what is there?
	var LONG_LINES = 40;           // lines the long average holds at most: two seconds
	function PowerLine() {
		this.pow = null;           // the power in each bin, eased over a few lines
		this.long = null;          // and averaged over a second or two
		this.stayed = 0;           // lines since the radio last moved
		this.held = 0;             // lines in the long average
	}
	// A line (the picture's bytes). moved: the radio is not where the line before it was taken
	PowerLine.prototype.take = function (q, moved) {
		var n = q.length, p = this.pow, g = this.long, i, v, w, ease, mean;
		if (moved || !p || p.length !== n) {
			p = this.pow = new Float64Array(n);
			g = this.long = new Float64Array(n);
			this.stayed = 0;
			this.held = 0;
		}
		ease = this.stayed++ > SETTLE_LINES;
		mean = this.stayed > GUARD_LINES;
		if (mean && this.held < LONG_LINES) this.held++;
		w = mean ? 1 / this.held : 0;
		for (i = 0; i < n; i++) {
			v = POW_OF_Q[q[i]];
			p[i] = ease ? p[i] + (v - p[i]) * 0.45 : v;
			if (mean) g[i] += (v - g[i]) * w;
		}
	};
	// Lines enough since the radio moved for a quick look to go by `lines` of them
	PowerLine.prototype.settled = function (lines) { return this.stayed >= SETTLE_LINES + lines; };
	// The long average holds `lines` of them (40 at most)
	PowerLine.prototype.averaged = function (lines) { return this.held >= lines; };

	// A line ready to be added up (it is changed): the radio's own carrier, a
	// spike every line can have at its centre, made like the bins beside
	// it; the sums from the line's start; and the part of the line that
	// counts (3 % at either end is the slope of the radio's filter)
	function lineSums(lin, rate) {
		var n = lin.length, binHz = rate / n, mid = n >> 1, dc = Math.max(2, Math.ceil(1500 / binHz)), sum = 0, cnt = 0, i;
		for (i = mid - 3 * dc; i <= mid + 3 * dc; i++) {
			if (i < 0 || i >= n || Math.abs(i - mid) <= dc) continue;
			sum += lin[i];
			cnt++;
		}
		if (cnt) for (i = Math.max(0, mid - dc); i <= Math.min(n - 1, mid + dc); i++) lin[i] = sum / cnt;
		var pre = new Float64Array(n + 1);
		for (i = 0; i < n; i++) pre[i + 1] = pre[i] + lin[i];
		return { lin: lin, pre: pre, lo: Math.ceil(n * 0.03), end: Math.floor(n * 0.97) };
	}
	// The noise in a bin of such a line. all: the line over; about(a, b): beside its bins a to b
	function noiseOf(L) {
		var pre = L.pre, lo = L.lo, w = Math.max(1, Math.min(NOISE_STRETCH, (L.end - lo) >> 3)), stride = Math.max(1, w >> 1);
		var count = Math.max(0, Math.floor((L.end - lo - w) / stride) + 1), T = new Float64Array(count), some = new Float64Array(count), j;
		for (j = 0; j < count; j++) T[j] = (pre[lo + j * stride + w] - pre[lo + j * stride]) / w;
		function share(list) { return list.length ? list.sort()[Math.floor(list.length * NOISE_SHARE)] : 0; }
		var all = share(new Float64Array(T));
		return {
			all: all,
			about: function (a, b) {
				var gap = Math.max(2, Math.round((b - a) / 2)), far = Math.max(NOISE_REACH * (b - a), 6 * w), m = 0, j, j1;
				// (the stretches that lie between `gap` and `gap + far` from the channel, below it and above)
				j1 = Math.min(count - 1, Math.floor((a - gap - w - lo) / stride));
				for (j = Math.max(0, Math.ceil((a - gap - far - lo) / stride)); j <= j1; j++) some[m++] = T[j];
				j1 = Math.min(count - 1, Math.floor((b + gap + far - w - lo) / stride));
				for (j = Math.max(0, Math.ceil((b + gap - lo) / stride)); j <= j1; j++) some[m++] = T[j];
				return m < 8 ? all : share(some.subarray(0, m));
			}
		};
	}
	// The noise in a bin for the channel bw wide at the dial frequency f, in a line (left as it is):
	// beside the channel, and the line over
	function noiseAt(pow, center, rate, f, bw) {
		var binHz = rate / pow.length, base = center - rate / 2, noise = noiseOf(lineSums(new Float64Array(pow), rate));
		return {
			beside: noise.about(Math.round((f - bw / 2 - base) / binHz), Math.round((f + bw / 2 - base) / binHz)),
			line: noise.all
		};
	}
	// The squelch that sets itself: the level (dBFS) a channel bw wide has to
	// reach, the noise being `noise` in a bin. That is the noise the channel
	// holds (a bin's, less what the display's window adds to it, times the
	// bins the channel is wide) and the margin over it.
	function squelchFor(noise, bw, binHz) {
		return 10 * Math.log(noise * bw / binHz / WINDOW_BINS) / Math.LN10 + SQUELCH_MARGIN;
	}

	/* ---------- scanning: where signals stand out ----------
	   From a line of the spectrum (the power in each bin, lowest frequency
	   first, eased over a few lines): the signals in it, lowest first.

	   A signal is a stretch of the line that stands over the line's noise,
	   as wide as it is: a broadcast station is one signal whether it is
	   listened to as wide FM or 8 kHz at a time, and a scan stops on it
	   once. That takes a line averaged over a second or so (the long one,
	   above): in less, a station is lumps. The line is smoothed a little
	   (over a quarter of a channel, 12 kHz at most), and what is 3 dB over
	   the noise then is signal; a gap no wider than the smoothing does not
	   end one. A stretch is cut in two where it dips 8 dB under what it
	   rises to on either side: two channels side by side are two signals.
	   The dips are looked for with the stretch smoothed over a twelfth of
	   its own width, where that is more, so that a wide signal's own
	   unevenness does not cut it up.

	   A signal counts when a channel in it is `margin` dB over the noise
	   beside the signal; what the channel holds of other signals beside
	   this one is not counted for it. The dial goes to its middle (the
	   centre of what it holds over the noise); or, when one channel in it
	   holds four times what the channel at its middle does, to that one: a
	   carrier on something wide is what is there to hear. What comes of
	   each that counts:
	     f        the dial frequency: on the dial's steps, if the channel
	              there holds the signal (see below)
	     over     dB that channel is over the noise beside the signal
	     lo, hi   where the signal begins and ends, as dial frequencies (for
	              a sideband they are shifted as f is)
	     mid      where its middle is, likewise: f, before it went to a step
	   The noise a signal is held against is never less than what the squelch
	   that sets itself would go by in that channel, so that what a scan stops
	   on is heard. Not counted: the shoulders of something much stronger
	   nearby; the radio's own carrier, a spike every line can have at its
	   centre; and a signal that runs off either end of the line, of which
	   not all is to be seen. Of one that runs off the top, where it begins
	   is given as the list's `cut` (a dial frequency: the next look of a
	   scan going up begins under it, to have all of it); of one that runs
	   off the bottom, where it ends, as its `cutLow` (for a scan going
	   down). null with none.

	   The dial's steps can be wider than the channel (25 kHz, where 12.5 kHz
	   of narrow FM is listened to): the step nearest a signal can then be one
	   whose channel holds little of it, or none. The dial goes to the nearest
	   step only if the signal's middle is well inside the channel there: no
	   further from the step than three eighths of the channel's width. (With
	   steps up to three quarters of that width, it always is.) If not, to the
	   nearest of the steps the mode has of its own; if not there either, to a
	   whole kHz; if not there, to where the signal is.

	   o: bw (the channel's width, Hz), mode, step (the dial's, Hz), off (how
	   far its steps are from whole ones, Hz, if they are), margin (dB). null
	   when the channel is too wide a share of the line for noise and signal
	   to be told apart in it. */
	var SIGNAL_OVER = 3, SIGNAL_DIP = 8, SIGNAL_SMOOTH = 12000, SIGNAL_NEAR = 0.375;
	function signalsIn(pow, center, rate, o) {
		var n = pow.length, binHz = rate / n, base = center - rate / 2;
		var k = Math.max(1, Math.round(o.bw / binHz)), i, j;
		if (k > n / 4 || Math.floor(n * 0.97) - Math.ceil(n * 0.03) <= 2 * k) return null;
		var L = lineSums(new Float64Array(pow), rate), lin = L.lin, pre = L.pre, lo = L.lo, end = L.end;
		var noise = noiseOf(L), out = [];
		out.cut = out.cutLow = null;
		if (!(noise.all > 0)) return out;
		// The line smoothed: about each bin, the mean of `sm`
		var most = Math.max(1, Math.round(SIGNAL_SMOOTH / binHz)), sm = Math.max(1, Math.min(Math.round(k / 4), most));
		function smooth(i, w) {
			var j = Math.max(lo, Math.min(i - (w >> 1), end - w));
			return (pre[j + w] - pre[j]) / w;
		}
		var S = new Float64Array(end - lo);
		for (i = lo; i < end; i++) S[i - lo] = smooth(i, sm);
		// The stretches over the noise, each cut at its dips: pieces, [first bin, the bin after the last]
		var up = noise.all * Math.pow(10, SIGNAL_OVER / 10), dip = Math.pow(10, SIGNAL_DIP / 10), pieces = [], start = -1, last = -1;
		function cut(a, b) {
			var w = Math.max(sm, Math.min(most, Math.round((b - a) / 12)));
			var from = a, peak = smooth(a, w), low = peak, lowAt = a, v, i;
			for (i = a + 1; i < b; i++) {
				v = smooth(i, w);
				if (peak >= low * dip && v >= low * dip) {      // down from one rise and up to another: two signals
					pieces.push([from, lowAt]);
					from = lowAt;
					peak = v; low = v; lowAt = i;
				} else if (v > peak) {
					peak = v; low = v; lowAt = i;
				} else if (v < low) {
					low = v; lowAt = i;
				}
			}
			pieces.push([from, b]);
		}
		for (i = lo; i < end; i++) {
			if (S[i - lo] < up) continue;
			if (start >= 0 && i - last - 1 > sm) { cut(start, last + 1); start = -1; }
			if (start < 0) start = i;
			last = i;
		}
		if (start >= 0) cut(start, last + 1);

		var shift = o.mode === "usb" ? -o.bw / 2 : o.mode === "lsb" ? o.bw / 2 : 0, found = [];
		// The middle of what the bins a to b hold over `floor`: the centre of its weight (or NaN)
		function middle(a, b, floor) {
			var m = 0, sum = 0, x, i;
			for (i = a; i < b; i++) {
				x = lin[i] - floor;
				if (x > 0) { m += x; sum += x * (i + 0.5); }
			}
			return sum / m;
		}
		function channel(at) { return Math.min(Math.max(Math.round(at - k / 2), lo), end - k); }
		// How far the channel from bin a is over the noise beside it and the piece it is for: a
		// ratio. What the channel holds of other pieces is another signal's: noise is put in its place.
		function over(a, self) {
			var p0 = pieces[self][0], p1 = pieces[self][1], sum = pre[a + k] - pre[a], j, x0, x1;
			var beside = Math.max(noise.about(Math.min(p0, a), Math.max(p1, a + k)), Math.min(noise.all, noise.about(a, a + k)));
			for (j = 0; j < pieces.length; j++) {
				x0 = Math.max(a, pieces[j][0]);
				x1 = Math.min(a + k, pieces[j][1]);
				if (j !== self && x1 > x0) sum -= pre[x1] - pre[x0] - beside * (x1 - x0);
			}
			return sum / (beside * k);
		}
		pieces.forEach(function (p, self) {
			var p0 = p[0], p1 = p[1], need = Math.pow(10, o.margin / 10), at, a, r, most, best, j, x;
			if (p1 >= end) { out.cut = base + p0 * binHz + shift; return; }
			if (p0 <= lo) { out.cutLow = base + p1 * binHz + shift; return; }
			at = middle(p0, p1, noise.about(p0, p1));
			if (!(at >= 0)) return;
			r = over(channel(at), self);
			if (p1 - p0 > k) {
				// Wider than a channel: is there one in it that holds far more than the one at its middle?
				for (best = -1, a = p0, j = Math.max(lo, p0 - (k >> 1)); j <= Math.min(end - k, p1 - (k >> 1)); j++)
					if (pre[j + k] - pre[j] > best) { best = pre[j + k] - pre[j]; a = j; }
				x = middle(a, a + k, noise.about(p0, p1));
				most = x >= 0 ? over(channel(x), self) : 0;
				if (most >= 4 * r || (most >= need && !(r >= need))) { at = x; r = most; }
			}
			if (!(r >= need)) return;
			found.push({ f: base + at * binHz + shift, over: 10 * Math.log(r) / Math.LN10, lo: base + p0 * binHz + shift, hi: base + p1 * binHz + shift });
		});
		found = found.filter(function (p) {
			return !found.some(function (q) { return q !== p && Math.abs(q.f - p.f) <= 1.5 * o.bw && q.over - p.over >= SCAN_SHOULDER; });
		});
		// On the dial's steps, where the nearest has the signal's middle well inside its channel;
		// on finer ones where it has not: the mode's own, then whole kHz, then where the signal is
		var grids = [[o.step, o.off || 0]], near = SIGNAL_NEAR * o.bw;
		[MODES[o.mode] ? MODES[o.mode].step : o.step, 1000].forEach(function (g) {
			if (g < grids[grids.length - 1][0]) grids.push([g, 0]);
		});
		found.forEach(function (p) {
			var f = Math.round(p.f), i, g;
			for (i = 0; i < grids.length; i++) {
				g = Math.round((p.f - grids[i][1]) / grids[i][0]) * grids[i][0] + grids[i][1];
				if (Math.abs(g - p.f) <= near) { f = g; break; }
			}
			p.mid = p.f;
			p.f = f;
		});
		// Lowest first: two that come to the same frequency are one
		found.sort(function (p, q) { return p.f - q.f; });
		found.forEach(function (p) {
			var was = out[out.length - 1];
			if (was && was.f === p.f) {
				was.over = Math.max(was.over, p.over);
				was.lo = Math.min(was.lo, p.lo);
				was.hi = Math.max(was.hi, p.hi);
				was.mid = Math.min(was.mid, p.mid);
			} else {
				out.push({ f: p.f, over: p.over, lo: p.lo, hi: p.hi, mid: p.mid });
			}
		});
		return out;
	}

	// A quick look at a line eased over a few lines: does any channel in it hold `margin` dB more
	// than noise does? (What it is, and how wide, is signalsIn's to say, of a longer line.) null
	// when the channel is too wide a share of the line to tell.
	function anythingIn(pow, rate, bw, margin) {
		var n = pow.length, k = Math.max(1, Math.round(bw / (rate / n))), i;
		if (k > n / 4 || Math.floor(n * 0.97) - Math.ceil(n * 0.03) <= 2 * k) return null;
		var L = lineSums(new Float64Array(pow), rate), pre = L.pre, need = noiseOf(L).all * k * Math.pow(10, margin / 10);
		if (!(need > 0)) return false;
		for (i = L.lo; i + k <= L.end; i++) if (pre[i + k] - pre[i] >= need) return true;
		return false;
	}

	// The band a frequency is in, of the ones the page knows (the narrowest, of two)
	function bandAt(f) {
		var best = null;
		BANDS.forEach(function (b) {
			if (f >= b.lo && f <= b.hi && (!best || b.hi - b.lo < best.hi - best.lo)) best = b;
		});
		return best;
	}

	/* ---------- scanning: where to look next ----------
	   A scan goes along the dial from where it began, up or down, stays a
	   while on every signal it finds, and goes on from there, until it is
	   stopped. It keeps inside a band only while that band is what is being
	   listened to: the dial in it, and the mode the band's own (broadcast FM
	   in wide FM, aircraft in AM, the two-way bands in narrow FM). There it
	   goes round: from the end of the band it was making for, on from the
	   other end, as far as where it last stayed. Once round with nothing
	   else found, it leaves the band and goes on beyond it, as it does from
	   the start anywhere else: on along the dial, and from the end of what
	   the radio tunes round to the other end. (Said below of a scan going
	   up; one going down is the same, turned over.)

	   scanFrom(f, mode, step, reach, dir): a scan's beginning. reach: what
	   the radio tunes, [lowest, highest]; dir: -1 for down the dial, else up.
	   What it is, s:
	     dir      1 up the dial, -1 down
	     at       the lowest dial frequency not looked at yet
	     from     where it began, or last stayed
	     past     where what it began on, or last stayed on, ends: the signal,
	              or the channel it was listened to in, if that reaches further
	     under    and where that begins
	     lo, hi   what it is to go round: the band, or all the radio tunes
	     band     the band's name, while it keeps inside one
	     left     the name of the band it has left behind, once it has
	     wrapped  past the top, and on from the bottom

	   scanStep(s, dr, sig, step, bw, reach): the next step, from what a look
	   has shown. dr: the dial frequencies the radio takes in now, [lowest,
	   highest]; sig: the signals found there (signalsIn). What comes back:
	     { tune: f, lo, hi }  a signal, and where it begins and ends: the scan stays on it a while
	     { move: true }  the radio is to go up, s.at just inside the bottom of what it takes in
	     { look: true }  s.at is in what the radio takes in already: the same look serves again
	     { over: true }  all the way round what the radio tunes, and nothing
	   A signal whose middle lies in what the scan began on or last stayed on
	   is not stopped on. It is that signal again, on another step this look
	   (a carrier between two steps is on one in one look and on the other in
	   the next); or one so near it that it was in the channel listened to
	   there, and has been heard (two carriers 7 kHz apart, 12.5 kHz at a time).

	   scanOn(s, f, step, hi, lo, bw): on, from the signal at f it has stayed
	   on (or began on), which runs from lo to hi, listened to bw wide: the
	   next is looked for above its end, not in the rest of it, and a round
	   is counted from f.

	   scanBegun(s, sig, f, step, bw): a scan begun with the dial, at f, on
	   one of the signals a look has found (the dial in it; or its middle in
	   the dial's channel, bw wide): on, from where that one ends.

	   scanCentre(at, rate, side, limits, dir): the radio's centre for a move:
	   `at` just inside the bottom of what the radio takes in, for a scan
	   going up; just inside the top, for one going down. side: how far the
	   channel reaches from the dial on that side (under it: less than
	   nought; over it: more). */
	function scanFrom(f, mode, step, reach, dir) {
		var b = bandAt(f), d = dir < 0 ? -1 : 1;
		if (b && b.mode !== mode) b = null;
		return {
			dir: d, at: f + d * step / 2, from: f, past: f + step / 2, under: f - step / 2,
			lo: b ? Math.max(b.lo, reach[0]) : reach[0], hi: b ? Math.min(b.hi, reach[1]) : reach[1],
			band: b ? b.label : "", left: "", wrapped: false
		};
	}
	function scanOn(s, f, step, hi, lo, bw) {
		var half = Math.max(step, bw || 0) / 2;
		s.from = f;
		s.at = s.dir < 0 ? Math.min(f - step / 2, lo == null ? f : lo) : Math.max(f + step / 2, hi == null ? f : hi);
		s.past = Math.max(f + half, hi == null ? f : hi);
		s.under = Math.min(f - half, lo == null ? f : lo);
		s.wrapped = false;
	}
	function scanBegun(s, sig, f, step, bw) {
		var lo = null, hi = null;
		sig.forEach(function (p) {
			var mid = p.mid == null ? p.f : p.mid;
			if (!(p.lo <= f && f <= p.hi) && !(Math.abs(mid - f) <= bw / 2)) return;
			lo = lo == null ? p.lo : Math.min(lo, p.lo);
			hi = hi == null ? p.hi : Math.max(hi, p.hi);
		});
		if (hi != null) scanOn(s, f, step, hi, lo, bw);
	}
	function scanStep(s, dr, sig, step, bw, reach) {
		// Reckoned the way the scan is going: every frequency times d, so that further on is
		// more, whichever way that is. `far` is the end it is making for, `near` the other
		var d = s.dir < 0 ? -1 : 1, far = d > 0 ? s.hi : s.lo, near = d > 0 ? s.lo : s.hi;
		// (this leg ends at the far end; the next, just short of where the scan began)
		var end = s.wrapped ? d * s.from - step / 2 : d * far, top = Math.min(d * (d > 0 ? dr[1] : dr[0]), end), at = d * s.at;
		// (a signal that runs off the end of what the radio takes in, the way the scan is
		// going: this look ends short of it, and the next begins there, to have all of it)
		var cut = d > 0 ? sig.cut : sig.cutLow, n, p, mid;
		if (cut != null && d * cut - bw > at) top = Math.min(top, d * cut - bw / 2);
		if (at <= top) for (n = 0; n < sig.length; n++) {
			p = sig[d > 0 ? n : sig.length - 1 - n];        // (the nearest first)
			mid = p.mid == null ? p.f : p.mid;
			// (not what the scan began on or last stayed on, a step away this time; nor what was heard with it)
			if (d * p.f >= at && d * p.f <= top && !(mid > s.under && mid < s.past)) return { tune: p.f, lo: p.lo, hi: p.hi };
		}
		if (top < end) {
			// (from half a channel short of the end: what only shows at the very end of a line is not counted)
			s.at = d * Math.max(top - bw / 2, at + 1);
			return { move: true };
		}
		if (!s.wrapped) {                       // the far end: on, from the near one
			s.wrapped = true;
			s.at = near;
		} else if (s.band) {                    // once round the band, nothing else in it: on, beyond it
			s.left = s.band;
			s.band = "";
			// (the signal the round was counted from can be at the band's very end, as the weather
			// station on 162.55 MHz is: it is the one behind, and not stopped on again)
			s.at = far;
			s.lo = reach[0];
			s.hi = reach[1];
			s.wrapped = false;
		} else {
			return { over: true };
		}
		return s.at >= dr[0] && s.at <= dr[1] ? { look: true } : { move: true };
	}
	function scanCentre(at, rate, side, limits, dir) {
		return Math.round(clamp(at + (dir < 0 ? -1 : 1) * rate * 0.45 + side, limits[0], limits[1]));
	}

	/* ---------- sound ----------
	   The page is not a secure context (plain HTTP), so there is no
	   AudioWorklet: each piece of audio the engine sends becomes a buffer
	   scheduled to play right after the one before it. */

	function AudioOut() {
		var AC = window.AudioContext || window.webkitAudioContext;
		var ctx = null, gain = null, nextT = 0, vol = 0.7, muted = false;
		// Seconds of sound kept in hand against jitter. The HackRF's samples
		// come 55 ms at a time, and a network adds its own unevenness: when
		// the sound runs dry while it is flowing, a little more is kept.
		var lead = 0.14, lastAt = -1;

		function apply() { if (gain) gain.gain.value = muted ? 0 : vol * vol; }
		this.ok = !!AC;
		// Called from a click: browsers only let sound start from one
		this.start = function () {
			if (!AC) return;
			if (!ctx) {
				try { ctx = new AC({ sampleRate: 48000, latencyHint: "interactive" }); }
				catch (e) { ctx = new AC(); }
				gain = ctx.createGain();
				gain.connect(ctx.destination);
				apply();
			}
			if (ctx.state === "suspended" && ctx.resume) ctx.resume();
			nextT = 0;
		};
		this.stop = function () {
			if (ctx && ctx.state === "running" && ctx.suspend) ctx.suspend();
			nextT = 0;
		};
		this.close = function () {
			if (ctx && ctx.close) { try { ctx.close(); } catch (e) {} }
			ctx = null; gain = null;
		};
		this.push = function (samples, rate) {
			if (!ctx || ctx.state !== "running" || !samples.length) return;
			var now = ctx.currentTime;
			if (nextT < now + 0.01) {
				if (now - lastAt < 0.25 && lead < 0.4) lead += 0.04;
				nextT = now + lead;
			} else if (nextT > now + lead + 0.45) return;   // far ahead (the clocks drift apart): this piece is let go
			lastAt = now;
			var buf = ctx.createBuffer(1, samples.length, rate || 48000);
			if (buf.copyToChannel) buf.copyToChannel(samples, 0);
			else buf.getChannelData(0).set(samples);
			var src = ctx.createBufferSource();
			src.buffer = buf;
			src.connect(gain);
			src.start(nextT);
			nextT += buf.duration;
		};
		this.volume = function (v) { vol = clamp(v, 0, 1); apply(); };
		this.mute = function (m) { muted = !!m; apply(); };
	}

	/* ---------- colours ---------- */

	// A spectrum line is kept as bytes: half-dB steps from -127.5 dBFS up
	function dbOfQ(q) { return q / 2 - 127.5; }

	// For every byte level, its colour (as the 32 bits an ImageData holds),
	// with lo..hi dB spread over the palette
	function buildLut(name, lo, hi) {
		var stops = PALETTES[name] || PALETTES.amber, lut = new Uint32Array(256);
		for (var q = 0; q < 256; q++) {
			var t = clamp((dbOfQ(q) - lo) / (hi - lo), 0, 1), i = 1;
			while (i < stops.length - 1 && stops[i][0] < t) i++;
			var a = stops[i - 1], b = stops[i], f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
			var r = Math.round(a[1] + (b[1] - a[1]) * f), g = Math.round(a[2] + (b[2] - a[2]) * f),
				bl = Math.round(a[3] + (b[3] - a[3]) * f);
			lut[q] = (255 << 24 | bl << 16 | g << 8 | r) >>> 0;   // little-endian: A B G R
		}
		return lut;
	}

	/* ---------- the receiver ---------- */

	function mount(root, opts) {
		opts = opts || {};
		var radio = opts.radio === "rtlsdr" ? "rtlsdr" : "hackrf";
		var prefs = loadPrefs(), mine = prefs[radio] || {};
		var alive = true, worker = null, audio = new AudioOut();
		var favs = cleanFavs(prefs.favs), favChips = [], favForm = null, favReach = "";

		var st = {
			running: false,
			rate: mine.rate || 2400000,
			vfo: mine.vfo || 98100000,
			mode: MODES[mine.mode] ? mine.mode : "wfm",
			squelch: typeof mine.squelch === "number" ? mine.squelch : null,
			sqAuto: mine.sqAuto !== false,
			gains: mine.gains || {},
			volume: typeof prefs.volume === "number" ? prefs.volume : 0.7,
			muted: false,
			zoom: 1,
			palette: PALETTES[prefs.palette] ? prefs.palette : "amber",
			info: null
		};
		st.bw = mine.bw || MODES[st.mode].bw;
		st.step = mine.step || MODES[st.mode].step;
		st.center = mine.center || st.vfo - offset();
		st.viewCenter = st.center;
		audio.volume(st.volume);

		var saveT = null;
		function save() {
			if (saveT) return;
			saveT = setTimeout(function () {
				saveT = null;
				var p = loadPrefs();
				p[radio] = { center: st.center, rate: st.rate, vfo: st.vfo, mode: st.mode, bw: st.bw,
					step: st.step, squelch: st.squelch, sqAuto: st.sqAuto, gains: st.gains };
				p.volume = st.volume;
				p.palette = st.palette;
				savePrefs(p);
			}, 400);
		}

		/* --- what is on the page --- */

		var powerBtn = el("button", { type: "button", class: "btn primary sdr-power", text: "Start" });
		var freqIn = el("input", { class: "sdr-freq", type: "text", inputmode: "decimal", spellcheck: "false",
			autocomplete: "off", "aria-label": "Frequency, MHz",
			title: "The frequency you are listening to, in MHz. Type another and press Enter." });
		var downBtn = el("button", { type: "button", class: "btn sdr-nudge", text: "◀", title: "One step down (left arrow key)" });
		var upBtn = el("button", { type: "button", class: "btn sdr-nudge", text: "▶", title: "One step up (right arrow key)" });
		// (the text form of each sign is asked for: some systems would draw it as a picture)
		var SCAN_SIGN = { "-1": "⏮", "1": "⏭" }, scanBtns = {};
		[-1, 1].forEach(function (dir) {
			var way = dir < 0 ? "down" : "up";
			scanBtns[dir] = el("button", { type: "button", class: "btn sdr-nudge sdr-seek sdr-seek-" + way, text: SCAN_SIGN[dir] + "\uFE0E",
				"aria-label": "Scan " + way + " the dial",
				title: "Scan " + way + " the dial: a few seconds on every signal that stands out, then on to the next, until you stop it. " +
					"Press it again on one to stay there; press the other to turn round." });
		});
		var favBtn = el("button", { type: "button", class: "btn sdr-star", text: "☆", "aria-label": "Favourite" });
		var favBox = el("div", { class: "sdr-favs" });
		var modeBox = el("div", { class: "sdr-modes", role: "group", "aria-label": "How to listen" });
		var meterFill = el("span"), meterMark = el("i");
		var meterTxt = el("span", { class: "sdr-meter-txt", text: "" });
		var meter = el("div", { class: "sdr-meter", title: "How strong the signal in the channel is" },
			el("div", { class: "sdr-meter-bar" }, meterFill, meterMark), meterTxt);
		var muteBtn = el("button", { type: "button", class: "btn small", text: "Mute" });
		var volIn = el("input", { type: "range", class: "sdr-range sdr-vol", min: "0", max: "100", step: "1",
			value: String(Math.round(st.volume * 100)), "aria-label": "Volume", title: "Volume" });

		var bandBox = el("div", { class: "sdr-bands" });
		var spec = el("canvas", { class: "sdr-spec" }), axis = el("canvas", { class: "sdr-axis" }),
			fall = el("canvas", { class: "sdr-fall" }), over = el("canvas", { class: "sdr-over", tabindex: "0",
				"aria-label": "Spectrum and waterfall: click to tune, drag to move along the band, scroll to zoom" });
		var msg = el("div", { class: "sdr-msg" });
		var display = el("div", { class: "sdr-display" }, spec, axis, fall, over, msg);

		var rateSel = el("select", { class: "sel" }), bwSel = el("select", { class: "sel" }),
			stepSel = el("select", { class: "sel" }), palSel = el("select", { class: "sel" });
		var sqIn = el("input", { type: "range", class: "sdr-range", min: "-110", max: "0", step: "1" });
		var sqOut = el("span", { class: "sdr-val" });
		var sqAutoIn = el("input", { type: "checkbox" });
		var gainBox = el("div", { class: "sdr-gains" });
		var zoomOut = el("button", { type: "button", class: "btn small", text: "−", title: "Zoom out" });
		var zoomIn = el("button", { type: "button", class: "btn small", text: "+", title: "Zoom in (or scroll over the display)" });
		var zoomTxt = el("span", { class: "sdr-val" });
		var statEl = el("div", { class: "sdr-status" });

		function field(label, title) {
			var f = el("label", { class: "sdr-field", title: title || null }, el("span", { class: "sdr-lbl", text: label }));
			for (var i = 2; i < arguments.length; i++) f.appendChild(arguments[i]);
			return f;
		}

		root.appendChild(el("div", { class: "sdr" },
			el("div", { class: "sdr-top" },
				powerBtn,
				el("div", { class: "sdr-freqbox" }, scanBtns[-1], downBtn, freqIn, el("span", { class: "sdr-unit", text: "MHz" }), upBtn, scanBtns[1], favBtn),
				modeBox, meter,
				el("div", { class: "sdr-volbox" }, muteBtn, volIn)),
			bandBox,
			favBox,
			display,
			el("div", { class: "sdr-controls" },
				field("Span", "How much of the band the radio takes in. Wider needs a faster network and more of this computer.", rateSel),
				field("Channel", "How wide a slice is listened to", bwSel),
				field("Step", "How far one step of the dial goes", stepSel),
				el("div", { class: "sdr-field", title: "Silence until a signal is at least this strong. Auto sets it a little above the noise, wherever you tune (not for sideband or Morse); by hand, all the way left is off." },
					el("span", { class: "sdr-lbl", text: "Squelch" }),
					el("label", { class: "sdr-auto" }, sqAutoIn, "auto"), sqIn, sqOut),
				gainBox,
				field("Zoom", null, zoomOut, zoomTxt, zoomIn),
				field("Colours", null, palSel)),
			statEl));

		/* --- the picture --- */

		var W = 0, dpr = 1;                // the canvases' width in their own pixels
		var hist = [], histMax = 300;      // spectrum lines, newest first: { q, n, center, rate }
		var cur = null, specAvg = null;    // the newest line's shape, and the trace (smoothed over time)
		var power = new PowerLine();       // the same lines as power: what noise and signals are measured on
		var newRows = 0, needFull = true;
		var dirty = { spec: true, axis: true, over: true };
		var maps = {}, mapCount = 0;       // for a line's shape: the bins under each pixel
		var range = { lo: -95, hi: -35, set: false };   // dB shown, weakest to strongest (follows the signal)
		var lut = buildLut(st.palette, range.lo, range.hi), lutLo = range.lo, lutHi = range.hi;
		var BG32 = (255 << 24 | 18 << 16 | 16 << 8 | 14) >>> 0;
		var fullImg = null, lineImg = null;
		var hgram = new Uint32Array(256);
		var hover = null;                  // { x } in the overlay's pixels
		var noisePow = null, noiseFor = "", noiseAge = 0;   // the noise in a bin that the squelch that sets itself
		                                   // goes by; what it was taken for; lines since
		var sqSent;                        // the squelch the engine has now (null: none)
		var raf = 0;

		function span() { return st.rate / st.zoom; }
		function viewLo() { return st.viewCenter - span() / 2; }
		function xOf(f) { return (f - viewLo()) / span() * W; }
		function fAtCss(xCss) { return viewLo() + xCss * dpr / W * span(); }
		// The view stays inside what the radio takes in
		function fitView() {
			var half = span() / 2;
			st.viewCenter = st.zoom <= 1 ? st.center
				: clamp(st.viewCenter, st.center - st.rate / 2 + half, st.center + st.rate / 2 - half);
			maps = {}; mapCount = 0;
			needFull = true;
			dirty.spec = dirty.axis = dirty.over = true;
		}
		// The channel's edges, for where the dial is
		function chanEdges(f) {
			if (st.mode === "usb") return [f, f + st.bw];
			if (st.mode === "lsb") return [f - st.bw, f];
			return [f - st.bw / 2, f + st.bw / 2];
		}
		// The radio's centre sits a little below the dial, as the centre itself
		// carries the radio's own DC spike: unless the channel is so wide, for
		// the span, that it only fits in the middle
		function offset() { return st.bw > st.rate * 0.5 ? 0 : st.rate / 8; }
		function inBand(f) {
			var e = chanEdges(f);
			return e[0] >= st.center - st.rate * 0.47 && e[1] <= st.center + st.rate * 0.47;
		}

		function resize() {
			var w = display.clientWidth;
			if (!w) return;
			dpr = Math.min(window.devicePixelRatio || 1, 2);
			W = Math.max(64, Math.round(w * dpr));
			spec.width = W; spec.height = Math.round(spec.clientHeight * dpr);
			axis.width = W; axis.height = Math.round(axis.clientHeight * dpr);
			// The waterfall: a line of it is one pixel of the page high
			fall.width = W; fall.height = Math.max(32, fall.clientHeight);
			over.width = W; over.height = Math.round(display.clientHeight * dpr);
			histMax = fall.height;
			if (hist.length > histMax) hist.length = histMax;
			fullImg = null; lineImg = null;
			maps = {}; mapCount = 0;
			needFull = true;
			dirty.spec = dirty.axis = dirty.over = true;
		}

		// For a spectrum line of this shape: which of its bins lie under each
		// pixel of the view (first, and one past the last; -1: none)
		function mapFor(row) {
			var key = row.n + ":" + row.center + ":" + row.rate, m = maps[key];
			if (m) return m;
			var b0 = new Int32Array(W), b1 = new Int32Array(W);
			var lo = viewLo(), hz = span() / W, binHz = row.rate / row.n, base = row.center - row.rate / 2;
			for (var x = 0; x < W; x++) {
				var fl = lo + x * hz, a = Math.floor((fl - base) / binHz), b = Math.ceil((fl + hz - base) / binHz);
				if (b <= a) b = a + 1;
				if (b <= 0 || a >= row.n) { b0[x] = -1; continue; }
				b0[x] = a < 0 ? 0 : a;
				b1[x] = b > row.n ? row.n : b;
			}
			if (mapCount >= 24) { maps = {}; mapCount = 0; }
			m = maps[key] = { b0: b0, b1: b1 };
			mapCount++;
			return m;
		}

		// One line of the waterfall: the strongest bin under each pixel, coloured
		function renderRow(row, out, off) {
			var m = mapFor(row), b0 = m.b0, b1 = m.b1, q = row.q, l = lut;
			for (var x = 0; x < W; x++) {
				var a = b0[x];
				if (a < 0) { out[off + x] = BG32; continue; }
				var v = q[a];
				for (var i = a + 1, b = b1[x]; i < b; i++) if (q[i] > v) v = q[i];
				out[off + x] = l[v];
			}
		}

		function drawFallFull() {
			var ctx = fall.getContext("2d"), H = fall.height;
			if (!fullImg || fullImg.width !== W || fullImg.height !== H) fullImg = ctx.createImageData(W, H);
			var out = new Uint32Array(fullImg.data.buffer);
			for (var y = 0; y < H; y++) {
				if (y < hist.length) renderRow(hist[y], out, y * W);
				else out.fill(BG32, y * W, (y + 1) * W);
			}
			ctx.putImageData(fullImg, 0, 0);
		}
		// The newest k lines pushed in at the top, the rest moved down
		function drawFallNew(k) {
			var ctx = fall.getContext("2d"), H = fall.height;
			ctx.drawImage(fall, 0, 0, W, H - k, 0, k, W, H - k);
			if (!lineImg || lineImg.width !== W) lineImg = ctx.createImageData(W, 1);
			var out = new Uint32Array(lineImg.data.buffer);
			for (var y = k - 1; y >= 0; y--) {
				renderRow(hist[y], out, 0);
				ctx.putImageData(lineImg, 0, y);
			}
		}

		function niceStep(raw) {
			var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / p;
			return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
		}
		function tickStep() { return niceStep(span() / Math.max(3, Math.floor(W / (96 * dpr)))); }

		function drawAxis() {
			var ctx = axis.getContext("2d"), w = axis.width, h = axis.height;
			ctx.fillStyle = "#131518";
			ctx.fillRect(0, 0, w, h);
			var lo = viewLo(), sp = span(), step = tickStep();
			var dec = step >= 1e6 ? 0 : step >= 1e5 ? 1 : step >= 1e4 ? 2 : step >= 1e3 ? 3 : step >= 100 ? 4 : 5;
			ctx.font = Math.round(11 * dpr) + "px " + MONO;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillStyle = C.muted;
			ctx.strokeStyle = C.line2;
			ctx.lineWidth = 1;
			// (A mark too near an edge for its number to fit goes without one)
			var half = ctx.measureText((lo / 1e6).toFixed(dec)).width / 2 + 2 * dpr;
			ctx.beginPath();
			for (var i = Math.ceil(lo / step); i * step < lo + sp; i++) {
				var x = Math.round((i * step - lo) / sp * w) + 0.5;
				ctx.moveTo(x, 0); ctx.lineTo(x, 4 * dpr);
				if (x >= half && x <= w - half) ctx.fillText((i * step / 1e6).toFixed(dec), x, h / 2 + 2 * dpr);
			}
			ctx.stroke();
		}

		function drawSpec() {
			var ctx = spec.getContext("2d"), w = spec.width, h = spec.height;
			var top = range.hi + 8, bot = range.lo - 5, k = h / (top - bot);
			ctx.fillStyle = C.bg;
			ctx.fillRect(0, 0, w, h);
			// The grid: every 10 dB, and where the scale below has its marks
			ctx.strokeStyle = C.line;
			ctx.lineWidth = 1;
			ctx.fillStyle = C.muted;
			ctx.font = Math.round(10 * dpr) + "px " + MONO;
			ctx.textAlign = "left";
			ctx.textBaseline = "bottom";
			ctx.beginPath();
			for (var d = Math.ceil(bot / 10) * 10; d < top; d += 10) {
				var gy = Math.round((top - d) * k) + 0.5;
				ctx.moveTo(0, gy); ctx.lineTo(w, gy);
				ctx.fillText(String(d), 4 * dpr, gy - 1);
			}
			var lo = viewLo(), sp = span(), step = tickStep();
			for (var i = Math.ceil(lo / step); i * step < lo + sp; i++) {
				var gx = Math.round((i * step - lo) / sp * w) + 0.5;
				ctx.moveTo(gx, 0); ctx.lineTo(gx, h);
			}
			ctx.stroke();
			if (!cur || !specAvg) return;
			var m = mapFor(cur), b0 = m.b0, b1 = m.b1, a = specAvg, pen = false, first = -1, last = -1;
			ctx.beginPath();
			for (var x = 0; x < w; x++) {
				var s = b0[x];
				if (s < 0) { pen = false; continue; }
				var v = a[s];
				for (var j = s + 1, e = b1[x]; j < e; j++) if (a[j] > v) v = a[j];
				var y = clamp((top - v) * k, 0, h);
				if (pen) ctx.lineTo(x + 0.5, y); else { ctx.moveTo(x + 0.5, y); pen = true; if (first < 0) first = x; }
				last = x;
			}
			ctx.strokeStyle = C.accent;
			ctx.lineWidth = Math.max(1, dpr * 0.9);
			ctx.stroke();
			if (first >= 0) {
				// The same line closed along the bottom, filled faintly
				ctx.lineTo(last + 0.5, h); ctx.lineTo(first + 0.5, h); ctx.closePath();
				ctx.fillStyle = "rgba(224, 160, 64, .10)";
				ctx.fill();
			}
		}

		// Over both: the channel being listened to, and the pointer's reading
		function drawOver() {
			var ctx = over.getContext("2d"), w = over.width, h = over.height;
			ctx.clearRect(0, 0, w, h);
			if (!W) return;
			var e = chanEdges(st.vfo), x0 = xOf(e[0]), x1 = xOf(e[1]), xc = xOf(st.vfo);
			if (x1 >= 0 && x0 <= w) {
				ctx.fillStyle = "rgba(242, 244, 245, .10)";
				ctx.fillRect(x0, 0, Math.max(1, x1 - x0), spec.height);
				ctx.fillStyle = "rgba(242, 244, 245, .06)";
				ctx.fillRect(x0, spec.height + axis.height, Math.max(1, x1 - x0), h - spec.height - axis.height);
				ctx.fillStyle = "rgba(242, 244, 245, .7)";
				ctx.fillRect(Math.round(xc), 0, Math.max(1, Math.round(dpr)), h);
			}
			if (hover) {
				var f = viewLo() + hover.x / W * span(), txt = fmtMHz(Math.round(f / 100) * 100) + " MHz";
				if (cur && specAvg) {
					var bin = Math.floor((f - (cur.center - cur.rate / 2)) / (cur.rate / cur.n));
					if (bin >= 0 && bin < cur.n) txt += "  " + Math.round(specAvg[bin]) + " dB";
				}
				ctx.fillStyle = "rgba(242, 244, 245, .28)";
				ctx.fillRect(Math.round(hover.x), 0, 1, h);
				ctx.font = Math.round(11 * dpr) + "px " + MONO;
				ctx.textBaseline = "top";
				ctx.textAlign = "left";
				var tw = ctx.measureText(txt).width + 10 * dpr, tx = hover.x + 8 * dpr;
				if (tx + tw > w) tx = hover.x - 8 * dpr - tw;
				ctx.fillStyle = "rgba(14, 16, 18, .88)";
				ctx.fillRect(tx, 6 * dpr, tw, 18 * dpr);
				ctx.fillStyle = C.hi;
				ctx.fillText(txt, tx + 5 * dpr, 9 * dpr);
			}
		}

		function frame() {
			raf = requestAnimationFrame(frame);
			if (!W) { resize(); if (!W) return; }
			if (needFull || newRows >= fall.height) drawFallFull();
			else if (newRows) drawFallNew(newRows);
			needFull = false; newRows = 0;
			if (dirty.spec) { drawSpec(); dirty.spec = false; }
			if (dirty.axis) { drawAxis(); dirty.axis = false; }
			if (dirty.over) { drawOver(); dirty.over = false; }
		}

		// The dB shown follows the signal: from just under the noise to just
		// over the strongest thing in view, moving slowly
		function followRange(q) {
			var n = q.length, i, acc = 0, floorQ = 0, peakQ = 255;
			hgram.fill(0);
			for (i = 0; i < n; i++) hgram[q[i]]++;
			for (i = 0; i < 256; i++) { acc += hgram[i]; if (acc >= n * 0.3) { floorQ = i; break; } }
			for (acc = 0, i = 255; i >= 0; i--) { acc += hgram[i]; if (acc >= n * 0.002) { peakQ = i; break; } }
			var lo = dbOfQ(floorQ) - 4, hi = Math.max(lo + 40, Math.min(0, dbOfQ(peakQ) + 6));
			if (!range.set) { range.lo = lo; range.hi = hi; range.set = true; needFull = true; }
			else { range.lo += (lo - range.lo) * 0.06; range.hi += (hi - range.hi) * 0.06; }
			if (Math.abs(range.lo - lutLo) > 1 || Math.abs(range.hi - lutHi) > 1 || needFull) {
				lutLo = range.lo; lutHi = range.hi;
				lut = buildLut(st.palette, lutLo, lutHi);
			}
		}

		function onFft(m) {
			var bins = m.bins, n = bins.length, q = new Uint8Array(n), i;
			for (i = 0; i < n; i++) {
				var v = (bins[i] + 127.5) * 2 + 0.5;
				q[i] = v < 0 ? 0 : v > 255 ? 255 : v;
			}
			var row = { q: q, n: n, center: m.center, rate: m.rate };
			hist.unshift(row);
			if (hist.length > histMax) hist.length = histMax;
			newRows++;
			// The trace: smoothed a little over time while the radio stays put.
			// And the same as power, which is what noise and signals are measured on
			var moved = !cur || !specAvg || cur.n !== n || cur.center !== m.center || cur.rate !== m.rate;
			if (moved) specAvg = new Float32Array(bins);
			else for (i = 0; i < n; i++) specAvg[i] += (bins[i] - specAvg[i]) * 0.45;
			power.take(q, moved);
			cur = row;
			followRange(q);
			applySquelch(followNoise());
			if (scan) scanLook();
			dirty.spec = true;
			if (hover) dirty.over = true;
		}

		// The noise the squelch that sets itself goes by: what is beside the
		// channel being listened to, or the whole line's where that is less.
		// By the first, whatever a scan stops on is heard; by the second, so is
		// a channel inside something wide (a broadcast station listened to as
		// AM) or on a hump of noise, as they always were: only what holds no
		// more than noise does anywhere is shut out. Read off the line a few
		// times a second and eased, and taken anew, at once, when the dial, the
		// channel's width or the radio has moved (true then).
		function followNoise() {
			var key = [cur.center, cur.rate, cur.n, st.vfo, st.bw].join(" ");
			if (key === noiseFor && ++noiseAge < 4) return false;
			var at = noiseAt(power.pow, cur.center, cur.rate, st.vfo, st.bw), v = Math.min(at.beside, at.line);
			var fresh = key !== noiseFor || noisePow == null;
			noisePow = !(v > 0) ? null : fresh ? v : noisePow + (v - noisePow) * 0.4;
			noiseFor = key;
			noiseAge = 0;
			return fresh;
		}
		// The squelch asked for. By hand: what the slider says. Auto: a little
		// above the noise the channel would hold with no signal in it
		// (squelchFor), and a little under what a scan counts as a signal.
		// Sideband and Morse are listened to down in the noise: no squelch for
		// them.
		function squelchWant() {
			if (!st.sqAuto) return st.squelch;
			if (st.mode === "usb" || st.mode === "lsb" || st.mode === "cw" || noisePow == null || !cur) return null;
			return squelchFor(noisePow, st.bw, cur.rate / cur.n);
		}
		function squelchNow() {
			var v = squelchWant();
			return v == null ? null : Math.round(v);
		}
		// Tell the engine, when it is news: the noise drifting by less than a dB is not
		function applySquelch(sure) {
			var want = squelchWant(), v = want == null ? null : Math.round(want);
			if (v === sqSent || (!sure && want != null && sqSent != null && Math.abs(want - sqSent) < 1)) return;
			sqSent = v;
			push({ squelch: v });
			paintSquelch();
		}
		function paintSquelch() {
			var v = st.running || !st.sqAuto ? squelchNow() : null;
			sqAutoIn.checked = st.sqAuto;
			sqIn.disabled = st.sqAuto;
			sqIn.value = String(v == null ? -110 : v);
			sqOut.textContent = v == null ? (st.sqAuto ? "" : "off") : v + " dB";
			meterMark.style.left = v == null ? "-10px" : clamp((v + 110) / 110 * 100, 0, 100) + "%";
		}

		/* --- the engine --- */

		var hwT = null, hwNext = {}, cmdAt = {};   // what goes to the radio, a few times a second at most

		function push(o) {
			if (!worker) return;
			o.type = "set";
			worker.postMessage(o);
		}
		function pushHw(o) {
			var k;
			for (k in o) {
				if (k === "gains") { hwNext.gains = hwNext.gains || {}; for (var g in o.gains) hwNext.gains[g] = o.gains[g]; }
				else hwNext[k] = o[k];
				cmdAt[k] = Date.now();
			}
			if (hwT) return;
			hwT = setTimeout(function () {
				hwT = null;
				var n = hwNext;
				hwNext = {};
				push(n);
			}, 90);
		}
		function asked(k) { return Date.now() - (cmdAt[k] || 0) < 1500; }   // did this page just ask for it itself?

		function settings() {
			return { center: st.center, rate: st.rate, gains: st.gains, vfo: st.vfo, mode: st.mode, bw: st.bw,
				squelch: squelchNow(), agc: true, deemph: deemphHere(), fftSize: FFT_FOR_ZOOM[st.zoom], fps: 20 };
		}

		function say(text, kind) {
			statEl.textContent = text || "";
			statEl.className = "sdr-status" + (kind ? " " + kind : "");
		}
		function showMsg(title, sub) {
			clear(msg);
			if (!title) { msg.hidden = true; return; }
			msg.hidden = false;
			msg.appendChild(el("b", { text: title }));
			if (sub) msg.appendChild(el("span", { text: sub }));
		}
		function radioName() { return (st.info && st.info.label) || (radio === "rtlsdr" ? "RTL-SDR" : "HackRF"); }

		function start() {
			if (st.running) return;
			if (!window.Worker) { showMsg("This browser can't run the receiver", "It has no Web Workers."); return; }
			audio.start();
			try { worker = new Worker(opts.workerUrl || "sdr/worker.js"); }
			catch (e) { showMsg("The receiver wouldn't start", String(e.message || e)); return; }
			var w = worker;
			w.onmessage = function (ev) { if (alive && worker === w) onEngine(ev.data || {}); };
			w.onerror = function (ev) {
				if (worker !== w) return;
				halt("The receiver stopped", (ev && ev.message) || "its engine failed to load");
			};
			st.running = true;
			noteText = "";
			hist = []; cur = null; specAvg = null; power = new PowerLine(); range.set = false; needFull = true; lastStat = null;
			// The gains kept from last time go to the radio with the start: what
			// it says of its gains before then is not news
			if (Object.keys(st.gains).length) cmdAt.gains = Date.now();
			noisePow = null;
			noiseFor = "";
			sqSent = squelchNow();
			w.postMessage({ type: "start", url: opts.url, radio: radio, demo: !!opts.demo, settings: settings() });
			showMsg("Connecting…");
			paint();
		}
		// Stop the engine; it closes the radio by itself, given a moment
		function stop() {
			var w = worker;
			worker = null;
			if (w) {
				try { w.postMessage({ type: "stop" }); } catch (e) {}
				setTimeout(function () { w.terminate(); }, 500);
			}
			if (hwT) { clearTimeout(hwT); hwT = null; }
			hwNext = {};
			st.running = false;
			if (scan) { if (scan.timer) clearTimeout(scan.timer); scan = null; paintScan(); }
			audio.stop();
			meterFill.style.width = "0";
			meterTxt.textContent = "";
			paint();
		}
		function halt(title, sub) {
			stop();
			showMsg(title, sub);
			say("");
			if (opts.onStop) { try { opts.onStop(sub || title); } catch (e) {} }
		}

		var lastStat = null;
		function onEngine(m) {
			if (m.type === "fft") return onFft(m);
			if (m.type === "audio") return audio.push(m.samples, m.rate);
			if (m.type === "meter") return onMeter(m);
			if (m.type === "info") return onInfo(m);
			if (m.type === "conn") {
				if (m.state === "connecting") showMsg("Connecting…");
				else if (m.state === "open") showMsg("Opening the " + radioName() + "…");
				else if (m.state === "streaming") showMsg(null);
				else if (m.state === "closed") halt("Stopped", m.message || "");
				else if (m.state === "error") halt("Couldn't listen", (m.message || "The radio didn't answer.") +
					(m.code === "nodevice" ? " If another feature is using this radio, free it on the Receivers page." : ""));
				return;
			}
			if (m.type === "error") say(String(m.message || "Something went wrong."), "err");
		}

		function onMeter(m) {
			lastStat = m;
			var lvl = typeof m.level === "number" && isFinite(m.level) ? m.level : -120;
			meterFill.style.width = clamp((lvl + 110) / 110 * 100, 0, 100).toFixed(1) + "%";
			meter.classList.toggle("quiet", !!m.squelched);
			meterTxt.textContent = m.outside ? "" : Math.round(lvl) + " dB";
			var parts = [(opts.demo || (st.info && st.info.sim) ? "A simulated radio" : radioName()),
				fmtHz(st.rate) + " wide"], kind = "";
			if (scan) parts.unshift(scanSays());
			else if (noteText && Date.now() < noteUntil) parts.unshift(noteText);
			if (m.outside && !scan) parts.push("the dial is outside what the radio takes in: click the display to tune");
			if (typeof m.load === "number") parts.push("this computer " + Math.round(m.load * 100) + "% busy");
			if (m.dropped) parts.push(m.dropped + " lost on the network");
			if (m.clients > 1) parts.push(m.clients + " listening");
			if (m.load > 0.92) { parts.push("it can't keep up: choose a narrower span"); kind = "err"; }
			say(parts.join(" · "), kind);
		}

		var gainKey = "", gainCtl = {};
		function onInfo(m) {
			st.info = m;
			if (m.rate && m.rate !== st.rate && !asked("rate")) st.rate = m.rate;
			if (typeof m.center === "number" && m.center !== st.center && !asked("center")) st.center = m.center;
			(m.gains || []).forEach(function (g) { if (!asked("gains")) st.gains[g.name] = g.value; });
			// Somebody else moved the radio from under the dial: the dial follows
			if (!inBand(st.vfo)) { st.vfo = snap(st.center + offset()); push({ vfo: st.vfo }); }
			buildRadio();
			if (reach().join() !== favReach) buildFavs();   // (what it tunes is known now)
			fitView();
			paint();
			save();
		}

		/* --- tuning --- */

		// On the dial's steps: counted from a channel, in a band whose channels are off the whole steps
		function stepOff(f) { var b = bandAt(f); return b && b.off && st.step === b.step ? b.off : 0; }
		function snap(f) { var off = stepOff(f); return Math.round((f - off) / st.step) * st.step + off; }
		function limits() { return st.info && st.info.range && st.info.range.length === 2 ? st.info.range : [1e6, 6e9]; }

		function setCenter(c) {
			var r = limits();
			st.center = Math.round(clamp(c, r[0], r[1]));
			pushHw({ center: st.center });
		}
		// Listen to f. The radio itself moves only when f is outside what it
		// takes in; then the dial lands a little right of the radio's centre.
		function tune(f) {
			var r = limits();
			st.vfo = Math.round(clamp(f, r[0], r[1]));
			if (!inBand(st.vfo)) setCenter(st.vfo - offset());
			if (st.zoom > 1) {
				var e = chanEdges(st.vfo);
				if (e[0] < viewLo() || e[1] > viewLo() + span()) st.viewCenter = st.vfo;
			}
			push({ vfo: st.vfo });
			fitView();
			paint();
			save();
		}
		// One step: past the edge of the band the radio comes along, so the
		// dial stays where it is on the screen
		function nudge(steps) {
			endScan();
			var f = snap(st.vfo) + steps * st.step;
			if (!inBand(f) && inBand(st.vfo)) setCenter(st.center + (f - st.vfo));
			tune(f);
		}
		// Slide along the band: the view first, then the radio itself
		function pan(df) {
			endScan();
			var want = st.viewCenter + df, half = span() / 2;
			var lo = st.center - st.rate / 2 + half, hi = st.center + st.rate / 2 - half;
			if (want < lo) setCenter(st.center + (want - lo));
			else if (want > hi) setCenter(st.center + (want - hi));
			st.viewCenter = st.zoom <= 1 ? st.center : want;
			fitView();
			save();
		}
		function setZoom(z, keepF, keepFrac) {
			z = clamp(z, ZOOMS[0], ZOOMS[ZOOMS.length - 1]);
			if (z === st.zoom) return;
			endScan();
			st.zoom = z;
			// What was under the pointer stays under it; without one, the dial stays in view
			if (keepF != null) st.viewCenter = keepF - (keepFrac - 0.5) * span();
			else st.viewCenter = st.vfo;
			push({ fftSize: FFT_FOR_ZOOM[z] });
			fitView();
			paint();
		}
		function setMode(id) {
			if (!MODES[id] || id === st.mode) return;
			endScan();
			st.mode = id;
			st.bw = MODES[id].bw;
			st.step = MODES[id].step;
			push({ mode: id, bw: st.bw });
			applySquelch(true);
			if (!inBand(st.vfo)) tune(st.vfo);
			buildSelects();
			paint();
			save();
		}
		function goBand(b) {
			endScan();
			st.mode = b.mode;
			st.bw = MODES[b.mode].bw;
			st.step = b.step || MODES[b.mode].step;
			st.zoom = 1;
			push({ mode: st.mode, bw: st.bw, fftSize: FFT_FOR_ZOOM[1] });
			applySquelch(true);
			st.vfo = b.tune;
			setCenter(b.tune - offset());
			push({ vfo: st.vfo });
			buildSelects();
			fitView();
			paint();
			save();
		}
		/* --- the scan: along the dial, a while on every signal that stands out ---
		   Up the dial or down it, by which of its two buttons began it. It
		   goes on until it is stopped: by that button, or by tuning by hand
		   (the other button turns it round). It looks first in what the radio
		   takes in now; then, with nothing there beyond where it has got to,
		   the radio itself goes on, a span at a time, each look waiting for a
		   few lines of what it hears there. On a signal it stays, to be
		   listened to, and then goes on from it. Where it looks next is
		   scanStep's to say (above): round the band that is being listened
		   to, then on beyond it; anywhere else, on along the dial. No sound
		   while the radio is on its way. */

		var SCAN_STAY = 5000;          // ms on a signal before the scan goes on
		var SCAN_BACK = 2500;          // ms after going on in which stopping still means the signal just left
		var scan = null, noteText = "", noteUntil = 0;

		// Something the status line goes on saying for a few seconds
		function note(text) {
			noteText = text;
			noteUntil = Date.now() + 8000;
			if (!st.running) say(text);
		}
		// What a scan has to say of itself, while there is one
		function scanSays() {
			if (!scan) return "";
			var dir = scan.s.dir, way = dir < 0 ? "down" : "up";
			if (scan.stay) {
				return "Scanning " + way + ": here for " + Math.max(1, Math.ceil((scan.stay.until - Date.now()) / 1000)) +
					" s more, then on. Press " + SCAN_SIGN[dir] + " again to stay.";
			}
			return scan.said || "Scanning " + way + "…";
		}
		// The dial frequencies whose channel lies inside what the radio takes in
		function dialRange() {
			var e = chanEdges(0);
			return [st.center - st.rate * 0.47 - e[0], st.center + st.rate * 0.47 - e[1]];
		}
		// The buttons (the one whose way the scan is going is lit), and the status line at once
		// (not at the meter's next reading)
		function paintScan() {
			scanBtns[-1].classList.toggle("on", !!scan && scan.s.dir < 0);
			scanBtns[1].classList.toggle("on", !!scan && scan.s.dir > 0);
			if (st.running && lastStat) onMeter(lastStat);
		}
		// One of the two buttons: a scan begins, its way along the dial. Pressed while a scan is
		// going that way, the scan stops (a moment after it went on from a signal, it is that
		// signal that was meant: back to it). Pressed while one is going the other way, the scan
		// turns round: a new one, from where the dial is.
		function scanButton(dir) {
			var sc = scan, back;
			if (sc && sc.s.dir === dir) {
				back = !sc.stay && sc.last && Date.now() - sc.last.at < SCAN_BACK ? sc.last.f : null;
				endScan();
				if (back != null) tune(back);
				return;
			}
			if (!st.running || !cur || !specAvg) { note("Press Start first: a scan goes by what the radio hears."); return; }
			endScan();
			noteText = "";
			scan = { s: scanFrom(st.vfo, st.mode, st.step, reach(), dir), first: true, wait: null, quiet: false, stay: null, timer: null, last: null, said: "" };
			paintScan();
			scanLook();
		}
		// Over: stopped, by the button or by tuning by hand; or nothing found anywhere
		function endScan(text) {
			var sc = scan;
			if (!sc) return;
			scan = null;
			if (sc.timer) clearTimeout(sc.timer);
			if (sc.quiet) push({ audio: true });
			if (text) note(text);
			paintScan();
		}
		// With a line of the spectrum to go by: a signal beyond where the scan
		// has got to? If not, the radio goes further on, and the next look
		// waits for what it hears there.
		function scanLook() {
			var sc = scan;
			if (!sc || sc.stay || !cur || !specAvg) return;
			if (sc.wait) {
				if (Math.abs(cur.center - sc.wait.center) > 1 || cur.rate !== st.rate) {
					if (Date.now() - sc.wait.since > 4000) endScan("The radio did not go where the scan sent it: the scan has stopped.");
					return;
				}
			}
			// (not by the lines that came as the radio moved, nor by too few after them)
			if (!power.settled(SCAN_LINES)) return;
			sc.wait = null;
			// A quick look: is anything here at all? (Asked a little under what counts, so as not
			// to miss by a hair what the longer look would find.) If so, a second of it, to tell
			// what, and how wide: the lines for that may still be coming.
			var any = anythingIn(power.pow, cur.rate, st.bw, SCAN_MARGIN - 2), sig = [];
			if (any == null) {
				endScan("The channel is too wide a part of this span to scan by: choose a wider span.");
				return;
			}
			if (any) {
				if (!power.averaged(SCAN_LONG)) return;
				sig = signalsIn(power.long, cur.center, cur.rate, { bw: st.bw, mode: st.mode, step: st.step, off: stepOff(st.vfo), margin: SCAN_MARGIN });
			}
			var s = sc.s, r, tries = 0, band, from;
			// Begun on a signal: on from its end, not through the rest of it
			if (sc.first) {
				sc.first = false;
				scanBegun(s, sig, st.vfo, st.step, st.bw);
			}
			do {
				band = s.band;
				r = scanStep(s, dialRange(), sig, st.step, st.bw, reach());
				if (band && s.left) sc.said = "Scanning " + (s.dir < 0 ? "down" : "up") + ": nothing else stands out in " + s.left +
					", so on " + (s.dir < 0 ? "below" : "above") + " it…";
			} while (r.look && ++tries < 4);
			if (r.tune != null) {
				scanStay(r.tune, r.hi, r.lo);
			} else if (r.over) {
				from = s.from;
				endScan("Nothing stands out anywhere this radio tunes: the scan has stopped.");
				tune(from);
			} else {
				scanMove();
			}
		}
		// On a signal: the dial there, its sound on, and after a while on from it
		function scanStay(f, hi, lo) {
			var sc = scan;
			sc.stay = { f: f, hi: hi, lo: lo, until: Date.now() + SCAN_STAY };
			sc.said = "";
			if (sc.quiet) { sc.quiet = false; push({ audio: true }); }
			tune(f);
			sc.timer = setTimeout(function () {
				if (scan !== sc || !sc.stay) return;
				sc.timer = null;
				sc.last = { f: sc.stay.f, at: Date.now() };
				scanOn(sc.s, sc.stay.f, st.step, sc.stay.hi, sc.stay.lo, st.bw);
				sc.stay = null;
				scanLook();
				paintScan();
			}, SCAN_STAY);
			paintScan();
		}
		// The radio, on to where the scan has got to: that frequency just
		// inside the end of what it takes in that the scan is coming from
		function scanMove() {
			var sc = scan, s = sc.s, e = chanEdges(0);
			var c = scanCentre(s.at, st.rate, s.dir < 0 ? e[1] : e[0], limits(), s.dir);
			if (!sc.quiet) { sc.quiet = true; push({ audio: false }); }
			st.center = c;
			cmdAt.center = Date.now();
			st.vfo = snap(clamp(s.at, c - st.rate * 0.47 - e[0], c + st.rate * 0.47 - e[1]));
			push({ center: c, vfo: st.vfo });
			sc.wait = { center: c, since: Date.now() };
			fitView();
			paint();
		}

		/* --- favourites: channels kept, to come back to --- */

		// The one the dial is on, if it is one
		function favHere() {
			for (var i = 0; i < favs.length; i++) if (favs[i].f === st.vfo && favs[i].mode === st.mode) return favs[i];
			return null;
		}
		// What this radio tunes: as it says once it is open, as its kind does before
		function reach() {
			return st.info && st.info.range && st.info.range.length === 2 ? st.info.range
				: radio === "rtlsdr" ? [24e6, 1766e6] : [1e6, 6e9];
		}
		// Into what this browser remembers; and said, when it would not keep it
		function keepFavs() {
			var p = loadPrefs();
			p.favs = favs;
			savePrefs(p);
			if (JSON.stringify(cleanFavs(loadPrefs().favs)) !== JSON.stringify(favs))
				say("This browser did not keep that: its storage for this page is switched off, or full.", "err");
		}
		function goFav(v) {
			endScan();
			closeFavForm();
			if (v.mode !== st.mode || v.bw !== st.bw) {
				st.mode = v.mode;
				st.bw = v.bw;
				push({ mode: st.mode, bw: st.bw });
				applySquelch(true);
			}
			st.step = v.step;
			buildSelects();
			tune(v.f);
		}
		// The row of them: a favourite this radio cannot reach is shown, not offered
		function buildFavs() {
			var r = reach(), here = favHere();
			favReach = r.join();
			favChips = [];
			clear(favBox);
			favBox.appendChild(el("span", { class: "sdr-lbl", text: "Favourites" }));
			favs.forEach(function (v) {
				var far = v.f < r[0] || v.f > r[1];
				var b = el("button", { type: "button", class: "sdr-band sdr-fav" + (v === here ? " on" : ""), text: v.name,
					title: fmtMHz(v.f) + " MHz, " + MODES[v.mode].label + (far ? ": outside what this radio tunes" : ""),
					onclick: function () { goFav(v); } });
				b.disabled = far;
				favChips.push({ b: b, v: v });
				favBox.appendChild(b);
			});
			if (favForm) favBox.appendChild(favForm);
			else if (!favs.length) favBox.appendChild(el("span", { class: "sdr-favhint",
				text: "none yet: tune to a channel and press ☆ beside the frequency to keep it here" }));
		}
		// The star: keep the channel the dial is on, under a name. On one that
		// is kept already: another name for it, or let it go.
		function openFavForm() {
			var was = favHere();
			if (!was && favs.length >= MAX_FAVS) { say("That is " + MAX_FAVS + " favourites: let one go first.", "err"); return; }
			var ch = { f: st.vfo, mode: st.mode, bw: st.bw, step: st.step };
			var nameIn = el("input", { class: "inp", type: "text", maxlength: String(FAV_NAME), spellcheck: "false",
				autocomplete: "off", "aria-label": "A name for this favourite" });
			nameIn.value = was ? was.name : favName("", ch.f, ch.mode);
			function done() {
				favForm = null;
				keepFavs();
				buildFavs();
				paint();
				favBtn.focus();
			}
			// (by where they are, not by which was found when the form opened:
			// another tab may have kept the same channel meanwhile)
			function others() { return favs.filter(function (v) { return v.f !== ch.f || v.mode !== ch.mode; }); }
			function keep() {
				ch.name = favName(nameIn.value, ch.f, ch.mode);
				favs = cleanFavs([ch].concat(others()));
				done();
			}
			function drop() {
				favs = others();
				done();
			}
			nameIn.addEventListener("keydown", function (ev) {
				if (ev.key === "Enter") { ev.preventDefault(); keep(); }
				else if (ev.key === "Escape") { ev.preventDefault(); closeFavForm(); favBtn.focus(); }
			});
			favForm = el("span", { class: "sdr-favedit" },
				el("span", { class: "sdr-val", text: fmtMHz(ch.f) + " " + MODES[ch.mode].label }), nameIn,
				el("button", { type: "button", class: "btn small primary", text: "Save", onclick: keep }),
				was ? el("button", { type: "button", class: "btn small reset", text: "Remove", onclick: drop }) : null,
				el("button", { type: "button", class: "btn small", text: "Cancel", onclick: closeFavForm }));
			buildFavs();
			nameIn.focus();
			nameIn.select();
		}
		function closeFavForm() {
			if (!favForm) return;
			favForm = null;
			buildFavs();
		}
		// Kept in another tab or window of this browser: shown here too
		function onStorage(ev) {
			if (ev.key !== PREF_KEY && ev.key !== null) return;
			var theirs = cleanFavs(loadPrefs().favs);
			if (JSON.stringify(theirs) === JSON.stringify(favs)) return;
			favs = theirs;
			buildFavs();
			paint();
		}

		/* --- the controls, kept in step with what is so --- */

		function option(sel, value, label) { sel.appendChild(el("option", { value: String(value), text: label })); }

		function buildSelects() {
			clear(bwSel);
			MODES[st.mode].bws.forEach(function (b) { option(bwSel, b, fmtHz(b)); });
			if (MODES[st.mode].bws.indexOf(st.bw) < 0) option(bwSel, st.bw, fmtHz(st.bw));
			bwSel.value = String(st.bw);
			clear(stepSel);
			STEPS.forEach(function (s) { option(stepSel, s, fmtHz(s)); });
			if (STEPS.indexOf(st.step) < 0) option(stepSel, st.step, fmtHz(st.step));
			stepSel.value = String(st.step);
		}

		// What depends on the radio: the spans it offers, its gain stages
		function buildRadio() {
			var rates = (st.info && st.info.rates) || [st.rate];
			clear(rateSel);
			rates.forEach(function (r) { option(rateSel, r, fmtHz(r)); });
			if (rates.indexOf(st.rate) < 0) option(rateSel, st.rate, fmtHz(st.rate));
			rateSel.value = String(st.rate);

			// (the stages with a range first, the ones that are a switch after)
			function isSwitch(g) { return g.step > 0 && g.max - g.min <= g.step ? 1 : 0; }
			var gains = ((st.info && st.info.gains) || []).slice().sort(function (a, b) { return isSwitch(a) - isSwitch(b); });
			var key = gains.map(function (g) { return [g.name, g.min, g.max, g.step].join(":"); }).join(",");
			if (key !== gainKey) {
				gainKey = key;
				gainCtl = {};
				clear(gainBox);
				gains.forEach(function (g) {
					var names = GAINS[g.name] || [g.name, g.name + " gain"], c;
					if (isSwitch(g)) {
						// Two settings: a switch
						c = el("input", { type: "checkbox" });
						c.addEventListener("change", function () { setGain(g.name, c.checked ? g.max : g.min); });
						gainBox.appendChild(el("label", { class: "sdr-field sdr-check", title: names[1] }, c,
							el("span", { class: "sdr-lbl", text: names[0] })));
						gainCtl[g.name] = { input: c, on: g.max };
					} else {
						var out = el("span", { class: "sdr-val" });
						c = el("input", { type: "range", class: "sdr-range", min: String(g.min), max: String(g.max),
							step: String(g.step > 0 ? g.step : 1) });
						c.addEventListener("input", function () { out.textContent = c.value + " dB"; setGain(g.name, +c.value); });
						gainBox.appendChild(field(names[0], names[1], c, out));
						gainCtl[g.name] = { input: c, out: out };
					}
				});
			}
			gains.forEach(function (g) {
				var c = gainCtl[g.name], v = st.gains[g.name] != null ? st.gains[g.name] : g.value;
				if (!c || document.activeElement === c.input) return;
				if (c.out) { c.input.value = String(v); c.out.textContent = Math.round(v) + " dB"; }
				else c.input.checked = v >= c.on;
			});
		}
		function setGain(name, value) {
			st.gains[name] = value;
			var g = {};
			g[name] = value;
			pushHw({ gains: g });
			save();
		}

		function paint() {
			powerBtn.textContent = st.running ? "Stop" : "Start";
			powerBtn.classList.toggle("primary", !st.running);
			if (document.activeElement !== freqIn) freqIn.value = fmtMHz(st.vfo);
			Array.prototype.forEach.call(modeBox.children, function (b) {
				b.classList.toggle("on", b.getAttribute("data-mode") === st.mode);
			});
			Array.prototype.forEach.call(bandBox.children, function (b) {
				var i = b.getAttribute("data-band");
				if (i != null) b.classList.toggle("on", st.vfo >= BANDS[i].lo && st.vfo <= BANDS[i].hi);
			});
			muteBtn.textContent = st.muted ? "Unmute" : "Mute";
			muteBtn.classList.toggle("on", st.muted);
			var here = favHere();
			favBtn.textContent = here ? "★" : "☆";
			favBtn.classList.toggle("on", !!here);
			favBtn.setAttribute("aria-pressed", here ? "true" : "false");
			favBtn.title = here ? "“" + here.name + "” is a favourite: rename it, or remove it" : "Keep this channel as a favourite";
			favChips.forEach(function (c) { c.b.classList.toggle("on", c.v === here); });
			paintSquelch();
			zoomTxt.textContent = st.zoom + "×";
			zoomOut.disabled = st.zoom <= ZOOMS[0];
			zoomIn.disabled = st.zoom >= ZOOMS[ZOOMS.length - 1];
			dirty.over = true;
		}

		/* --- what the user does --- */

		powerBtn.addEventListener("click", function () {
			if (st.running) { stop(); showMsg("Stopped", "Press Start to listen again."); say(""); }
			else start();
		});
		freqIn.addEventListener("keydown", function (ev) {
			if (ev.key === "Enter") {
				var f = parseFreq(freqIn.value);
				if (f) { freqIn.blur(); endScan(); tune(f); } else freqIn.select();
			} else if (ev.key === "Escape") { freqIn.value = fmtMHz(st.vfo); freqIn.blur(); }
		});
		freqIn.addEventListener("focus", function () { freqIn.select(); });
		freqIn.addEventListener("blur", function () { freqIn.value = fmtMHz(st.vfo); });
		downBtn.addEventListener("click", function () { nudge(-1); });
		upBtn.addEventListener("click", function () { nudge(1); });
		[-1, 1].forEach(function (dir) { scanBtns[dir].addEventListener("click", function () { scanButton(dir); }); });
		favBtn.addEventListener("click", function () { if (favForm) closeFavForm(); else openFavForm(); });

		MODE_ORDER.forEach(function (id) {
			modeBox.appendChild(el("button", { type: "button", class: "sdr-mode", "data-mode": id, text: MODES[id].label,
				title: MODES[id].title, onclick: function () { setMode(id); } }));
		});
		BANDS.forEach(function (b, i) {
			// A radio only gets the places it can reach
			if (radio === "rtlsdr" && (b.tune < 24e6 || b.tune > 1766e6)) return;
			bandBox.appendChild(el("button", { type: "button", class: "sdr-band", "data-band": String(i), text: b.label,
				title: fmtMHz(b.tune) + " MHz, " + MODES[b.mode].label, onclick: function () { goBand(b); } }));
		});

		muteBtn.addEventListener("click", function () { st.muted = !st.muted; audio.mute(st.muted); paint(); });
		volIn.addEventListener("input", function () { st.volume = +volIn.value / 100; audio.volume(st.volume); save(); });
		rateSel.addEventListener("change", function () {
			endScan();
			st.rate = +rateSel.value;
			pushHw({ rate: st.rate });
			if (!inBand(st.vfo)) setCenter(st.vfo - offset());
			fitView();
			paint();
			save();
		});
		bwSel.addEventListener("change", function () { endScan(); st.bw = +bwSel.value; push({ bw: st.bw }); applySquelch(true); paint(); save(); });
		stepSel.addEventListener("change", function () { st.step = +stepSel.value; save(); });
		sqIn.addEventListener("input", function () {
			st.squelch = +sqIn.value <= -110 ? null : +sqIn.value;
			applySquelch(true);
			paint();
			save();
		});
		sqAutoIn.addEventListener("change", function () {
			// By hand from here: starting from where auto had it
			if (!sqAutoIn.checked) st.squelch = sqSent == null ? null : sqSent;
			st.sqAuto = sqAutoIn.checked;
			applySquelch(true);
			paint();
			save();
		});
		zoomOut.addEventListener("click", function () { setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(st.zoom) - 1)]); });
		zoomIn.addEventListener("click", function () { setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(st.zoom) + 1)]); });
		PALETTE_NAMES.forEach(function (p) { option(palSel, p[0], p[1]); });
		palSel.value = st.palette;
		palSel.addEventListener("change", function () {
			st.palette = palSel.value;
			lut = buildLut(st.palette, lutLo, lutHi);
			needFull = true;
			save();
		});

		// The display: a click tunes, a drag slides along the band, the wheel zooms
		var drag = null, wheelAcc = 0;
		function relX(ev) { return ev.clientX - over.getBoundingClientRect().left; }
		over.addEventListener("pointerdown", function (ev) {
			if (ev.button != null && ev.button !== 0) return;
			drag = { x: relX(ev), last: relX(ev), moved: false, id: ev.pointerId };
			try { over.setPointerCapture(ev.pointerId); } catch (e) {}
		});
		over.addEventListener("pointermove", function (ev) {
			var x = relX(ev);
			if (drag && ev.pointerId === drag.id) {
				if (!drag.moved && Math.abs(x - drag.x) < 5) return;
				drag.moved = true;
				pan(-(x - drag.last) * dpr / W * span());
				drag.last = x;
				hover = null;
			} else if (ev.pointerType !== "touch") {
				hover = { x: x * dpr };
			}
			dirty.over = true;
		});
		function endDrag(ev) {
			if (!drag || ev.pointerId !== drag.id) return;
			var d = drag;
			drag = null;
			if (!d.moved && ev.type === "pointerup") { endScan(); tune(snap(fAtCss(d.x))); }
		}
		over.addEventListener("pointerup", endDrag);
		over.addEventListener("pointercancel", endDrag);
		over.addEventListener("pointerleave", function () { hover = null; dirty.over = true; });
		over.addEventListener("wheel", function (ev) {
			ev.preventDefault();
			// A notch of a wheel, or as much of a touchpad's stream
			wheelAcc += ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
			if (Math.abs(wheelAcc) < 60) return;
			var up = wheelAcc < 0;
			wheelAcc = 0;
			if (ev.shiftKey) { nudge(up ? 1 : -1); return; }
			var i = ZOOMS.indexOf(st.zoom) + (up ? 1 : -1), x = relX(ev);
			if (i < 0 || i >= ZOOMS.length) return;
			setZoom(ZOOMS[i], fAtCss(x), x * dpr / W);
		}, { passive: false });

		function onKey(ev) {
			if (!alive || !root.isConnected) return;
			var t = ev.target && ev.target.tagName;
			if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
			if (ev.key === "ArrowLeft") { nudge(ev.shiftKey ? -10 : -1); ev.preventDefault(); }
			else if (ev.key === "ArrowRight") { nudge(ev.shiftKey ? 10 : 1); ev.preventDefault(); }
			else if (ev.key === "m" || ev.key === "M") muteBtn.click();
		}
		document.addEventListener("keydown", onKey);

		var ro = null;
		if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(display); }
		window.addEventListener("resize", resize);
		window.addEventListener("storage", onStorage);

		/* --- begin --- */

		buildSelects();
		buildRadio();
		buildFavs();
		paint();
		showMsg("Press Start to listen", opts.demo ? "A simulated band: no radio is used." : "");
		if (!audio.ok) say("This browser has no Web Audio: the display works, there is no sound.", "err");
		resize();
		raf = requestAnimationFrame(frame);

		return {
			destroy: function () {
				if (!alive) return;
				stop();
				alive = false;
				cancelAnimationFrame(raf);
				document.removeEventListener("keydown", onKey);
				window.removeEventListener("resize", resize);
				window.removeEventListener("storage", onStorage);
				if (ro) ro.disconnect();
				audio.close();
				if (saveT) { clearTimeout(saveT); saveT = null; }
			}
		};
	}

	// (pure: the parts with no page to them, for tests/sdr/page.test.js)
	window.PirateSDR = { mount: mount, pure: {
		signalsIn: signalsIn, scanFrom: scanFrom, scanStep: scanStep, scanOn: scanOn, scanBegun: scanBegun, scanCentre: scanCentre,
		anythingIn: anythingIn, noiseAt: noiseAt, squelchFor: squelchFor, PowerLine: PowerLine, cleanFavs: cleanFavs,
		SCAN_MARGIN: SCAN_MARGIN, SQUELCH_MARGIN: SQUELCH_MARGIN, WINDOW_BINS: WINDOW_BINS,
		SETTLE_LINES: SETTLE_LINES, GUARD_LINES: GUARD_LINES, SCAN_LINES: SCAN_LINES, SCAN_LONG: SCAN_LONG
	} };
})();
