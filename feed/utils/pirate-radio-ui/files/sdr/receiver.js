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
	// there. (Frequencies as used in the Americas where they differ.)
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
		{ label: "CB", lo: 26.965e6, hi: 27.405e6, tune: 27.185e6, mode: "am", step: 10000 }
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

	/* ---------- sound ----------
	   The page is not a secure context (plain HTTP), so there is no
	   AudioWorklet: each piece of audio the engine sends becomes a buffer
	   scheduled to play right after the one before it. */

	function AudioOut() {
		var AC = window.AudioContext || window.webkitAudioContext;
		var ctx = null, gain = null, nextT = 0, vol = 0.7, muted = false;
		var LEAD = 0.12;       // seconds of cushion when (re)starting, against jitter
		var AHEAD = 0.6;       // more than this queued: the clocks drifted, drop a piece

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
			if (nextT < now + 0.01) nextT = now + LEAD;
			else if (nextT > now + AHEAD) return;
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
				el("div", { class: "sdr-freqbox" }, downBtn, freqIn, el("span", { class: "sdr-unit", text: "MHz" }), upBtn),
				modeBox, meter,
				el("div", { class: "sdr-volbox" }, muteBtn, volIn)),
			bandBox,
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
		var newRows = 0, needFull = true;
		var dirty = { spec: true, axis: true, over: true };
		var maps = {}, mapCount = 0;       // for a line's shape: the bins under each pixel
		var range = { lo: -95, hi: -35, set: false };   // dB shown, weakest to strongest (follows the signal)
		var lut = buildLut(st.palette, range.lo, range.hi), lutLo = range.lo, lutHi = range.hi;
		var BG32 = (255 << 24 | 18 << 16 | 16 << 8 | 14) >>> 0;
		var fullImg = null, lineImg = null;
		var hgram = new Uint32Array(256);
		var hover = null;                  // { x } in the overlay's pixels
		var noiseBin = null;               // the noise in one bin of the spectrum, dB (for the squelch that sets itself)
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
			noiseBin = noiseBin == null ? dbOfQ(floorQ) : noiseBin + (dbOfQ(floorQ) - noiseBin) * 0.15;
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
			// (bins of another width hold another share of the noise: measured anew)
			if (cur && (cur.n !== n || cur.rate !== m.rate)) noiseBin = null;
			// The trace: smoothed a little over time while the radio stays put
			if (!cur || !specAvg || cur.n !== n || cur.center !== m.center || cur.rate !== m.rate) specAvg = new Float32Array(bins);
			else for (i = 0; i < n; i++) specAvg[i] += (bins[i] - specAvg[i]) * 0.45;
			cur = row;
			followRange(q);
			applySquelch(false);
			dirty.spec = true;
			if (hover) dirty.over = true;
		}

		// The squelch in force. By hand: what the slider says. Auto: a little
		// above the noise the channel holds, which is the noise in one bin of
		// the spectrum (less the 3 dB the display's window adds to it) times
		// the bins the channel is wide. Sideband and Morse are listened to
		// down in the noise: no squelch for them.
		function squelchNow() {
			if (!st.sqAuto) return st.squelch;
			if (st.mode === "usb" || st.mode === "lsb" || st.mode === "cw" || noiseBin == null || !cur) return null;
			return Math.round(noiseBin - 3 + 10 * Math.log(st.bw / (cur.rate / cur.n)) / Math.LN10 + 8);
		}
		// Tell the engine, when it is news (the noise drifting by a dB is not)
		function applySquelch(sure) {
			var v = squelchNow();
			if (v === sqSent || (!sure && v != null && sqSent != null && Math.abs(v - sqSent) < 2)) return;
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
			hist = []; cur = null; specAvg = null; range.set = false; needFull = true; lastStat = null;
			// The gains kept from last time go to the radio with the start: what
			// it says of its gains before then is not news
			if (Object.keys(st.gains).length) cmdAt.gains = Date.now();
			noiseBin = null;
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
			if (m.outside) parts.push("the dial is outside what the radio takes in: click the display to tune");
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
			fitView();
			paint();
			save();
		}

		/* --- tuning --- */

		function snap(f) { return Math.round(f / st.step) * st.step; }
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
			var f = snap(st.vfo) + steps * st.step;
			if (!inBand(f) && inBand(st.vfo)) setCenter(st.center + (f - st.vfo));
			tune(f);
		}
		// Slide along the band: the view first, then the radio itself
		function pan(df) {
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
		// The strongest channel in view: the most power in any stretch as wide
		// as the channel, not merely the tallest bin
		function strongest() {
			if (!cur || !specAvg) return;
			var n = cur.n, binHz = cur.rate / n, base = cur.center - cur.rate / 2;
			var a = clamp(Math.floor((viewLo() - base) / binHz), 0, n - 1),
				b = clamp(Math.ceil((viewLo() + span() - base) / binHz), a + 1, n);
			var k = Math.max(1, Math.round(st.bw / binHz)), sum = 0, best = -1, bestAt = a, i;
			var lin = new Float64Array(b - a);
			for (i = a; i < b; i++) lin[i - a] = Math.pow(10, specAvg[i] / 10);
			for (i = 0; i < lin.length; i++) {
				sum += lin[i];
				if (i >= k) sum -= lin[i - k];
				if (i >= k - 1 && sum > best) { best = sum; bestAt = a + i - (k - 1) / 2; }
			}
			var f = base + (bestAt + 0.5) * binHz;
			if (st.mode === "usb") f -= st.bw / 2;
			if (st.mode === "lsb") f += st.bw / 2;
			tune(snap(f));
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
				if (f) { freqIn.blur(); tune(f); } else freqIn.select();
			} else if (ev.key === "Escape") { freqIn.value = fmtMHz(st.vfo); freqIn.blur(); }
		});
		freqIn.addEventListener("focus", function () { freqIn.select(); });
		freqIn.addEventListener("blur", function () { freqIn.value = fmtMHz(st.vfo); });
		downBtn.addEventListener("click", function () { nudge(-1); });
		upBtn.addEventListener("click", function () { nudge(1); });

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
		bandBox.appendChild(el("button", { type: "button", class: "sdr-band sdr-find", text: "Strongest signal",
			title: "Tune to the strongest signal in view", onclick: strongest }));

		muteBtn.addEventListener("click", function () { st.muted = !st.muted; audio.mute(st.muted); paint(); });
		volIn.addEventListener("input", function () { st.volume = +volIn.value / 100; audio.volume(st.volume); save(); });
		rateSel.addEventListener("change", function () {
			st.rate = +rateSel.value;
			pushHw({ rate: st.rate });
			if (!inBand(st.vfo)) setCenter(st.vfo - offset());
			fitView();
			paint();
			save();
		});
		bwSel.addEventListener("change", function () { st.bw = +bwSel.value; push({ bw: st.bw }); applySquelch(true); paint(); save(); });
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
			if (!d.moved && ev.type === "pointerup") tune(snap(fAtCss(d.x)));
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

		/* --- begin --- */

		buildSelects();
		buildRadio();
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
				if (ro) ro.disconnect();
				audio.close();
				if (saveT) { clearTimeout(saveT); saveT = null; }
			}
		};
	}

	window.PirateSDR = { mount: mount };
})();
