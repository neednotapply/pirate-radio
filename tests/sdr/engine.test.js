/* The receiver's engine (worker.js), as the Listen page drives it: in demo
   mode, and against a mock of pirate-websdr (mock-bridge.js) over a real
   socket. These run by the clock (the radio is paced in real time), a few
   seconds each.

   node tests/sdr/engine.test.js   (ONLY=<regexp> runs the tests whose name matches) */
"use strict";

const path = require("path"), http = require("http");
const SDR = path.join(__dirname, "../../feed/utils/pirate-radio-ui/files/sdr/");
const DSP = require(SDR + "dsp.js"), SigGen = require(SDR + "siggen.js"), Engine = require(SDR + "worker.js").Engine;
const { WebSocket, createServer } = require("./ws-lite.js"), { startMockBridge } = require("./mock-bridge.js");
const { test, run, ok, equal, near, atLeast, atMost } = require("./harness.js");

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// An engine, as the page has one, and everything it posts
function page(env) {
	const got = { all: [], conn: [], info: [], fft: [], audio: [], meter: [], error: [] };
	got.engine = new Engine(Object.assign({
		post: function (m) { got.all.push(m); got[m.type].push(m); },
		WebSocket: WebSocket, DSP: DSP, SigGen: SigGen
	}, env));
	got.send = function (m) { got.engine.handle(m); };
	got.states = function () { return got.conn.map(function (c) { return c.state; }).join(" "); };
	got.until = async function (fn, what, ms) {
		const t0 = Date.now();
		while (!fn()) {
			if (Date.now() - t0 > (ms || 5000)) throw new Error("waited in vain for " + what + " (conn: " + got.states() +
				(got.error.length ? "; errors: " + got.error.map(function (e) { return e.message; }).join(" | ") : "") + ")");
			await sleep(10);
		}
	};
	got.streaming = function () { return got.until(function () { return got.meter.length > 0; }, "the stream"); };
	got.seconds = function () { let n = 0; got.audio.forEach(function (a) { n += a.samples.length; }); return n / 48000; };
	got.last = function (type) { return got[type][got[type].length - 1]; };
	return got;
}
const WANT = { center: 98000000, rate: 2400000, vfo: 98100000, mode: "wfm" };
// Was the machine itself held up while `seconds` of signal went by? (A busy
// one loses frames through no fault of the engine's: what counts them exactly
// is only asked of a run that kept time.)
function calm(t0, seconds) { return Date.now() - t0 < seconds * 1000 + 600; }
function url(b) { return "ws://127.0.0.1:" + b.port + "/"; }

// A bare client of the bridge: another listener, by hand
function listener(b) {
	return new Promise(function (ok2, bad) {
		const ws = new WebSocket(url(b)), l = { ws: ws, text: [], frames: 0 };
		ws.onmessage = function (ev) { if (typeof ev.data === "string") l.text.push(JSON.parse(ev.data)); else l.frames++; };
		ws.onopen = function () { ok2(l); };
		ws.onerror = function (e) { bad(new Error(e.message)); };
		l.say = function (o) { ws.send(JSON.stringify(o)); };
		l.got = function (type) { return l.text.filter(function (m) { return m.type === type; }); };
	});
}

/* ---------- demo mode ---------- */

test("demo: starts, streams what DESIGN.md says, and stops", async function () {
	const p = page(), t0 = Date.now();
	p.send({ type: "start", radio: "hackrf", demo: true, settings: WANT });
	await p.until(function () { return p.meter.length >= 5; }, "five meter readings (a second of signal)");
	const kept = calm(t0, 1);
	p.send({ type: "stop" });
	const n = p.all.length;
	await sleep(150);
	equal(p.all.length, n, "messages after stop");
	equal(p.states(), "connecting open streaming closed", "conn states");
	equal(p.last("conn").message, "stopped", "why it closed");

	const i = p.info[0];
	ok(i.sim === true && i.radio === "hackrf" && /HackRF/.test(i.label), "info: a simulated HackRF");
	equal(i.center, 98000000, "info.center");
	equal(i.rate, 2400000, "info.rate");
	equal(i.rates.join(), "2400000,4800000,9600000", "info.rates");
	equal(i.range.join(), "1000000,6000000000", "info.range");
	equal(i.gains.map(function (g) { return g.name + "=" + g.value + "/" + g.min + ".." + g.max + "/" + g.step; }).join(" "),
		"LNA=24/0..40/8 AMP=0/0..14/14 VGA=20/0..62/2", "info.gains");

	ok(p.fft.length >= 18 && p.fft.length <= 24, "about 20 lines a second: " + p.fft.length);
	const f = p.fft[5];
	ok(f.bins instanceof Float32Array && f.bins.length === 4096, "a line is 4096 float bins");
	ok(f.center === 98000000 && f.rate === 2400000, "and carries its centre and rate");
	// the station at 98.1 MHz stands out of the noise where it should
	const at = Math.round((98100000 - (98000000 - 1200000)) / (2400000 / 4096));
	let peak = -200, floor = 0;
	for (let k = at - 60; k <= at + 60; k++) peak = Math.max(peak, f.bins[k]);
	for (let k = 100; k < 300; k++) floor += f.bins[k] / 200;
	atLeast(peak - floor, 25, "the station at 98.1 MHz over the noise, dB");

	ok(p.audio.every(function (a) { return a.samples instanceof Float32Array && a.rate === 48000 && a.samples.length >= 960 && a.samples.length <= 2400; }),
		"audio: 48 kHz, 20 to 50 ms a piece");
	near(p.seconds(), 1, 0.2, "a second of audio in a second");
	let loud = 0;
	p.audio.forEach(function (a) { for (let k = 0; k < a.samples.length; k++) loud = Math.max(loud, Math.abs(a.samples[k])); });
	ok(loud > 0.05 && loud <= 1, "and there is something to hear in it: peak " + loud.toFixed(3));

	const m = p.last("meter");
	equal(Object.keys(m).sort().join(), "clients,dropped,level,load,outside,overflows,squelched,type", "meter's fields");
	near(m.level, -15, 2, "meter.level: the station is on the air at -15 dBFS");
	ok(m.squelched === false && m.outside === false && m.clients === 1 && m.overflows === 0, "meter: open, inside, one listener");
	ok(m.dropped === 0 || !kept, "meter.dropped: " + m.dropped);
	ok(m.load > 0 && (m.load < 1 || !kept), "meter.load: " + m.load);
	equal(p.error.length, 0, "errors");
});

test("demo: the page's settings are followed", async function () {
	const p = page();
	p.send({ type: "start", radio: "hackrf", demo: true, settings: WANT });
	await p.streaming();

	p.send({ type: "set", center: 121000000 });
	await p.until(function () { return p.last("info").center === 121000000; }, "info with the new centre");
	await p.until(function () { return p.last("fft").center === 121000000; }, "lines at the new centre");
	p.send({ type: "set", vfo: 121500000, mode: "am", bw: 8000 });
	const before = p.meter.length;
	await p.until(function () { return p.meter.length >= before + 3; }, "meter readings on 121.5 MHz AM");
	ok(!p.last("meter").outside, "121.5 MHz is inside");

	p.send({ type: "set", rate: 4800000 });
	await p.until(function () { return p.last("info").rate === 4800000 && p.last("fft").rate === 4800000; }, "info and lines at the new rate");

	const lvl = function () { return p.last("meter").level; };
	p.send({ type: "set", center: 98000000, vfo: 98100000, mode: "wfm" });
	const m0 = p.meter.length;
	await p.until(function () { return p.meter.length >= m0 + 3; }, "meter readings back on 98.1 MHz");
	const quiet = lvl();
	p.send({ type: "set", gains: { LNA: 30 } });       // 30 is not a step of it: 32 is
	await p.until(function () { return p.last("info").gains[0].value === 32; }, "info with the gain, on its step");
	const m1 = p.meter.length;
	await p.until(function () { return p.meter.length >= m1 + 3; }, "meter readings at the new gain");
	near(lvl() - quiet, 8, 2, "8 dB more gain, dB more signal");

	p.send({ type: "set", vfo: 90000000 });
	const m2 = p.meter.length;
	await p.until(function () { return p.meter.length >= m2 + 2; }, "meter readings off the edge");
	ok(p.last("meter").outside === true, "a dial outside what the radio takes in: meter.outside");
	equal(p.error.length, 0, "errors so far");

	// what cannot be: said, and the stream goes on
	p.send({ type: "set", rate: 1000000 });
	p.send({ type: "set", mode: "fm", fftSize: 5000, squelch: "loud", gains: { XYZ: 3 } });
	equal(p.error.length, 5, "an error for each: " + p.error.map(function (e) { return e.message; }).join(" | "));
	const n = p.fft.length;
	await p.until(function () { return p.fft.length > n + 5; }, "the stream going on");
	equal(p.last("info").rate, 4800000, "the rate is as it was");
	p.send({ type: "stop" });
	equal(p.states(), "connecting open streaming closed", "conn states");
});

test("demo: an RTL-SDR, with a HackRF's settings left over", async function () {
	const p = page();
	p.send({ type: "start", radio: "rtlsdr", demo: true, settings: { center: 162475000, rate: 9600000, vfo: 162550000, mode: "nfm", gains: { LNA: 40, VGA: 30 } } });
	await p.until(function () { return p.meter.length >= 3; }, "three meter readings");
	const i = p.info[0];
	ok(/RTL-SDR/.test(i.label) && i.gains.length === 1 && i.gains[0].name === "TUNER", "info: an RTL-SDR, with its one gain");
	equal(i.rate, 2400000, "a rate it does not have becomes 2.4 Msps");
	equal(i.rates.join(), "240000,960000,1200000,1920000,2400000", "its rates");
	equal(p.error.length, 0, "the other radio's gains are passed over without complaint");
	near(p.last("meter").level, -17, 3, "weather radio on 162.55 MHz, dBFS");
	atLeast(p.seconds(), 0.3, "seconds of audio");
	p.send({ type: "stop" });
});

/* ---------- against the bridge ---------- */

test("bridge: connects, opens the radio, streams, and closes it on stop", async function () {
	const b = await startMockBridge(), p = page(), t0 = Date.now();
	try {
		p.send({ type: "start", radio: "hackrf", url: url(b), settings: WANT });
		await p.until(function () { return p.meter.length >= 5; }, "five meter readings");
		const kept = calm(t0, 1);
		equal(p.states(), "connecting open streaming", "conn states");
		equal(JSON.stringify(b.commands[0]), JSON.stringify({ cmd: "open", radio: "hackrf", freq: 98000000, rate: 2400000 }), "the first thing the bridge is told");
		const i = p.info[0];
		ok(i.sim === true && i.label === "Simulated HackRF" && i.center === 98000000 && i.rate === 2400000, "info is the bridge's");
		equal(i.gains.map(function (g) { return g.name + "=" + g.value; }).join(), "LNA=24,AMP=0,VGA=20", "its gains, in its order");
		ok(p.fft.length >= 16 && p.fft.every(function (f) { return f.center === 98000000 && f.rate === 2400000 && f.bins.length === 4096; }), "lines: " + p.fft.length);
		near(p.seconds(), p.meter.length / 5, 0.25, "audio keeps pace with the meter");
		const m = p.last("meter");
		near(m.level, -15, 2, "meter.level");
		ok(m.clients === 1 && ((m.dropped === 0 && m.overflows === 0) || !kept), "one listener, nothing lost: dropped " + m.dropped + ", overflows " + m.overflows);

		p.send({ type: "stop" });
		equal(p.last("conn").state, "closed", "conn after stop");
		await p.until(function () { return b.device() === null; }, "the bridge to let the radio go", 1000);
		ok(b.commands.some(function (c) { return c.cmd === "close"; }), "the bridge was told to close");
		const n = p.all.length;
		await sleep(150);
		equal(p.all.length, n, "messages after stop");
	} finally { await b.close(); }
});

test("bridge: the page's settings go to the radio, and what it answers comes back", async function () {
	const b = await startMockBridge(), p = page();
	try {
		// (gains the page kept from last time go with the start; one this radio has not is passed over)
		p.send({ type: "start", radio: "hackrf", url: url(b), settings: Object.assign({ gains: { LNA: 40, VGA: 31, TUNER: 12 } }, WANT) });
		await p.streaming();
		await p.until(function () { const d = b.device(); return d.gains[0].value === 40 && d.gains[2].value === 32; }, "the gains to reach the radio");
		await p.until(function () { const g = p.last("info").gains; return g[0].value === 40 && g[2].value === 32; }, "info with them");
		equal(p.error.length, 0, "errors");

		p.send({ type: "set", center: 100300000 });
		await p.until(function () { return b.device().freq === 100300000; }, "the radio to be tuned");
		await p.until(function () { return p.last("info").center === 100300000 && p.last("fft").center === 100300000; }, "info and lines at the new centre");
		// every line is at the centre it says: none from before the move carries the new one
		const moved = p.fft.findIndex(function (f) { return f.center === 100300000; });
		ok(p.fft.slice(0, moved).every(function (f) { return f.center === 98000000; }) && p.fft.slice(moved).every(function (f) { return f.center === 100300000; }),
			"lines change centre once, in order");

		// dragging: many moves in a moment become a few commands, the last one always
		const sent = b.commands.length;
		for (let k = 1; k <= 40; k++) p.send({ type: "set", center: 100300000 + k * 10000 });
		await p.until(function () { return b.device().freq === 100700000; }, "the radio to end where the dragging did");
		const cmds = b.commands.slice(sent).filter(function (c) { return c.cmd === "freq"; });
		ok(cmds.length >= 1 && cmds.length <= 4, "40 moves in one go: " + cmds.length + " commands");

		p.send({ type: "set", rate: 4800000 });
		await p.until(function () { return p.last("info").rate === 4800000 && p.last("fft").rate === 4800000; }, "info and lines at the new rate");
		equal(b.device().rate, 4800000, "the radio's rate");

		p.send({ type: "set", gains: { AMP: 14 } });
		await p.until(function () { return p.last("info").gains[1].value === 14; }, "info with the preamp on");

		// not this radio's to do: said here, not sent
		const before = b.commands.length;
		p.send({ type: "set", rate: 1200000 });
		p.send({ type: "set", gains: { TUNER: 20 } });
		equal(p.error.length, 2, "errors: " + p.error.map(function (e) { return e.message; }).join(" | "));
		equal(b.commands.length, before, "commands sent for them");
		const n = p.fft.length;
		await p.until(function () { return p.fft.length > n + 5; }, "the stream going on");
		p.send({ type: "stop" });
	} finally { await b.close(); }
});

test("bridge: a rate kept from the other radio is not asked of this one", async function () {
	const b = await startMockBridge(), p = page();
	try {
		p.send({ type: "start", radio: "rtlsdr", url: url(b), settings: { center: 162475000, rate: 9600000, vfo: 162550000, mode: "nfm" } });
		await p.streaming();
		equal(JSON.stringify(b.commands[0]), JSON.stringify({ cmd: "open", radio: "rtlsdr", freq: 162475000 }), "open, without the rate");
		equal(p.info[0].rate, 2400000, "the radio opens at its own");
		equal(p.fft[0].rate, 2400000, "and the lines say so");
		p.send({ type: "stop" });
	} finally { await b.close(); }
});

test("bridge: another listener moving the radio is followed", async function () {
	const b = await startMockBridge(), p = page();
	try {
		// Somebody is already listening, elsewhere on the dial and at another rate
		const other = await listener(b);
		other.say({ cmd: "open", radio: "hackrf", freq: 144500000, rate: 4800000 });
		await p.until(function () { return other.frames > 5; }, "the other listener's stream");

		p.send({ type: "start", radio: "hackrf", url: url(b), settings: WANT });
		await p.streaming();
		ok(p.info[0].center === 144500000 && p.info[0].rate === 4800000, "a radio in use is taken as it is: " + p.info[0].center + " Hz, " + p.info[0].rate);
		ok(p.fft[0].center === 144500000 && p.fft[0].rate === 4800000, "and the lines are at it");
		ok(!b.commands.some(function (c) { return c.cmd === "freq" || c.cmd === "rate"; }), "it is not moved from under the other listener");
		await p.until(function () { return p.last("meter").clients === 2; }, "meter.clients to say two", 3000);

		other.say({ cmd: "freq", hz: 146000000 });
		await p.until(function () { return p.last("info").center === 146000000 && p.last("fft").center === 146000000; }, "the other's move to reach the page");
		other.say({ cmd: "gain", name: "VGA", value: 40 });
		await p.until(function () { return p.last("info").gains[2].value === 40; }, "the other's gain to reach the page");
		other.say({ cmd: "rate", hz: 2400000 });
		await p.until(function () { return p.last("info").rate === 2400000 && p.last("fft").rate === 2400000; }, "the other's rate to reach the page");

		other.ws.close();
		await p.until(function () { return p.last("meter").clients === 1; }, "meter.clients to say one again", 3000);
		equal(p.error.length, 0, "errors");
		p.send({ type: "stop" });
	} finally { await b.close(); }
});

test("bridge: frames lost on the way are counted, and the sound goes on", async function () {
	const b = await startMockBridge({ dropEvery: 10 }), p = page(), t0 = Date.now();
	try {
		p.send({ type: "start", radio: "hackrf", url: url(b), settings: WANT });
		await p.until(function () { return p.meter.length >= 10; }, "ten meter readings (two seconds)");
		const m = p.last("meter");
		ok(m.dropped >= 7 && (m.dropped <= 13 || !calm(t0, 2)), "a frame in ten of 100: meter.dropped " + m.dropped);
		atLeast(p.seconds(), 1.5, "seconds of audio in two");
		let loud = 0;
		p.audio.forEach(function (a) { for (let k = 0; k < a.samples.length; k++) loud = Math.max(loud, Math.abs(a.samples[k])); });
		atMost(loud, 1, "no burst over full scale where the gaps were");
		equal(p.error.length, 0, "errors");
		p.send({ type: "stop" });
	} finally { await b.close(); }
});

test("bridge: what goes wrong is said, with its code, and nothing is tried again", async function () {
	// nothing listening there
	let b = await startMockBridge();
	const dead = url(b);
	await b.close();
	let p = page();
	p.send({ type: "start", radio: "hackrf", url: dead, settings: WANT });
	await p.until(function () { return p.conn.length >= 2; }, "the failure to connect");
	equal(p.states(), "connecting error", "no bridge: conn states");
	ok(/could not reach/.test(p.last("conn").message), "no bridge: " + p.last("conn").message);

	// the radio is not there
	b = await startMockBridge({ absent: ["hackrf"] });
	try {
		p = page();
		p.send({ type: "start", radio: "hackrf", url: url(b), settings: WANT });
		await p.until(function () { return p.last("conn") && p.last("conn").state === "error"; }, "the radio's refusal");
		equal(p.states(), "connecting open error", "no radio: conn states");
		ok(p.last("conn").code === "nodevice" && /HackRF/.test(p.last("conn").message), "no radio: code nodevice, the bridge's words: " + p.last("conn").message);

		// the other radio is in use
		const other = await listener(b);
		other.say({ cmd: "open", radio: "rtlsdr" });
		await p.until(function () { return other.frames > 3; }, "the other listener's stream");
		p = page();
		p.send({ type: "start", radio: "hackrf", url: url(b), settings: WANT });
		await p.until(function () { return p.last("conn") && p.last("conn").state === "error"; }, "the refusal");
		ok(p.last("conn").code === "busy" && /RTL-SDR is in use/.test(p.last("conn").message), "the other radio in use: code busy: " + p.last("conn").message);

		// the radio is taken for another job, then fails outright, then the line is cut
		const cases = [
			[function () { b.kick(); }, "closed", /handed to another job/],
			[function () { b.fail(); }, "closed", /stopped answering/],
			[function () { b.hangup(); }, "error", /connection to the router was lost/]
		];
		for (const c of cases) {
			p = page();
			p.send({ type: "start", radio: "rtlsdr", url: url(b), settings: { center: 162475000, rate: 2400000, vfo: 162550000, mode: "nfm" } });
			await p.streaming();
			const made = b.connections;
			c[0]();
			await p.until(function () { return p.last("conn").state !== "streaming"; }, "the end of the stream");
			ok(p.last("conn").state === c[1] && c[2].test(p.last("conn").message), "conn " + c[1] + ": " + p.last("conn").message);
			const n = p.all.length;
			await sleep(400);
			equal(b.connections, made, "connections made after it: none");
			equal(p.all.length, n, "messages after it: none");
		}
	} finally { await b.close(); }

	// a bridge that takes the socket and says nothing (its timers run 20 times fast here)
	const mute = createServer({ onConnection: function () {} });
	await new Promise(function (r) { mute.listen(0, "127.0.0.1", r); });
	try {
		p = page({ setTimeout: function (f, ms) { return setTimeout(f, ms / 20); } });
		p.send({ type: "start", radio: "hackrf", url: "ws://127.0.0.1:" + mute.address().port + "/", settings: WANT });
		await p.until(function () { return p.last("conn") && p.last("conn").state === "error"; }, "giving up on a silent bridge");
		ok(/did not answer/.test(p.last("conn").message), "a silent bridge: " + p.last("conn").message);
	} finally { mute.closeAllConnections(); mute.close(); }
});

test("bridge: too many listeners", async function () {
	const b = await startMockBridge(), p = page();
	try {
		const four = [];
		for (let k = 0; k < 4; k++) four.push(await listener(b));
		p.send({ type: "start", radio: "hackrf", url: url(b), settings: WANT });
		await p.until(function () { return p.conn.length >= 2; }, "the refusal");
		equal(p.states(), "connecting error", "conn states");
		four.forEach(function (l) { l.ws.close(); });
	} finally { await b.close(); }
});

test("bridge: stop, and start again", async function () {
	const b = await startMockBridge(), p = page();
	try {
		for (let k = 0; k < 3; k++) {
			p.send({ type: "start", radio: "hackrf", url: url(b), settings: WANT });
			const m = p.meter.length;
			await p.until(function () { return p.meter.length >= m + 2; }, "the stream, time " + (k + 1));
			p.send({ type: "stop" });
			await p.until(function () { return b.device() === null; }, "the radio to be let go", 1000);
		}
		equal(p.states(), "connecting open streaming closed connecting open streaming closed connecting open streaming closed", "conn states");
		equal(b.connections, 3, "connections made");
		// a start on top of a start: the first is dropped, quietly
		p.send({ type: "start", radio: "hackrf", url: url(b), settings: WANT });
		const m = p.meter.length;
		await p.until(function () { return p.meter.length >= m + 2; }, "the stream, a fourth time");
		p.send({ type: "start", radio: "rtlsdr", url: url(b), settings: { center: 162475000, rate: 2400000, vfo: 162550000, mode: "nfm" } });
		await p.until(function () { return p.last("info").radio === "rtlsdr" && p.last("conn").state === "streaming"; }, "the second start's radio");
		equal(b.connections, 5, "connections made");
		await p.until(function () { const d = b.device(); return d && d.radio === "rtlsdr" && d.listeners === 1; }, "one listener, on the second radio");
		// stop before anything is running: nothing to say
		const q = page();
		q.send({ type: "stop" });
		equal(q.all.length, 0, "a stop with nothing started");
		p.send({ type: "stop" });
	} finally { await b.close(); }
});

test("settings: kept from before the start; what cannot be is said and left out", async function () {
	const p = page();
	p.send({ type: "set", mode: "nfm", vfo: 162550000, squelch: -50 });
	p.send({ type: "set", center: "here", rate: -1, vfo: null, bw: 0, deemph: 60, fps: "fast", cwPitch: "high", gains: 7 });
	equal(p.error.length, 8, "an error for each of the eight: " + p.error.map(function (e) { return e.message; }).join(" | "));
	equal(p.conn.length, 0, "nothing starts by itself");
	p.send({ type: "start", radio: "rtlsdr", demo: true, settings: { center: 162475000, rate: 1200000 } });
	await p.until(function () { return p.meter.length >= 2; }, "two meter readings");
	const rx = p.engine.rx;
	ok(rx.mode === "nfm" && rx.vfo === 162550000 && rx.squelch === -50 && rx.bw === 12500 && rx.rate === 1200000, "what was set before the start holds");
	// a mode without a width takes its own; with one, that one
	p.send({ type: "set", mode: "am" });
	equal(rx.bw, 8000, "am's own width");
	p.send({ type: "set", mode: "usb", bw: 2400 });
	equal(rx.bw, 2400, "the width that came with the mode");
	p.send({ type: "set", squelch: null, agc: false, audio: false, fftSize: 8192, fps: 10, cwPitch: 600, deemph: 50 });
	ok(rx.squelch === null && rx.agc === false && rx.audio === false && rx.fftSize === 8192 && rx.fps === 10 && rx.cwPitch === 600 && rx.deemph === 50, "the rest reach the receiver");
	const n = p.fft.length;
	await p.until(function () { return p.fft.length >= n + 3; }, "lines at the new size");
	equal(p.last("fft").bins.length, 8192, "bins in a line");
	// no dial given: an eighth of the span right of centre, and it follows the radio
	const q = page();
	q.send({ type: "start", radio: "hackrf", demo: true, settings: { center: 100000000, rate: 2400000 } });
	await q.streaming();
	equal(q.engine.rx.vfo, 100300000, "the dial when the page gave none");
	q.send({ type: "set", center: 101000000 });
	equal(q.engine.rx.vfo, 101300000, "and after the radio moved");
	p.send({ type: "stop" });
	q.send({ type: "stop" });
});

test("falling behind: frames are let go, not heard late; a radio that paused is not mistaken for it", async function () {
	// The engine's clock is this test's to move: a jump is the engine having been held up
	let skew = 0;
	const b = await startMockBridge(), p = page({ now: function () { return performance.now() + skew; } });
	try {
		p.send({ type: "start", radio: "hackrf", url: url(b), settings: WANT });
		const ta = Date.now();
		await p.until(function () { return p.meter.length >= 3; }, "three meter readings");
		// Held up for 300 ms: within what is put up with
		skew += 300;
		const a = p.fft.length;
		await p.until(function () { return p.fft.length >= a + 8; }, "the stream going on");
		ok(p.last("meter").dropped === 0 || !calm(ta, 1), "300 ms behind: nothing let go: " + p.last("meter").dropped);
		// A second behind, and the frames keep coming at their own pace (so it
		// is not a backlog being worked off): let go for a second, then this
		// is taken to be how things are, and the stream goes on
		skew += 1000;
		const f0 = p.fft.length, t0 = Date.now();
		await p.until(function () { return p.last("meter").dropped >= 40; }, "frames being let go", 4000);
		await p.until(function () { return p.fft.length >= f0 + 10; }, "the stream to come back", 5000);
		const d = p.last("meter").dropped, kept = calm(t0, 1.6);
		ok(d >= 40 && (d <= 60 || !kept), "about a second of frames let go: " + d);
		ok(Date.now() - t0 < 2500 || !kept, "and it was back within a second or so");
		const t1 = Date.now();
		await sleep(500);
		ok(p.last("meter").dropped === d || !calm(t1, 0.5), "none since");
		p.send({ type: "stop" });
	} finally { await b.close(); }
});

/* ---------- the file as the browser loads it ---------- */

test("worker.js as a worker loads it: importScripts, with the page's version, and messages both ways", async function () {
	// A worker's global scope, as far as the engine uses one
	const vm = require("vm"), fs = require("fs"), posted = [], loaded = [];
	const scope = vm.createContext({
		location: { search: "?v=abc123" }, WebSocket: WebSocket, performance: performance, console: console,
		setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
		postMessage: function (m, transfer) { posted.push({ m: m, transfer: transfer }); }
	});
	vm.runInContext("var self = this;", scope);
	scope.importScripts = function () {
		for (let k = 0; k < arguments.length; k++) {
			loaded.push(arguments[k]);
			vm.runInContext(fs.readFileSync(SDR + arguments[k].replace(/\?.*$/, ""), "utf8"), scope, { filename: arguments[k] });
		}
	};
	vm.runInContext(fs.readFileSync(SDR + "worker.js", "utf8"), scope, { filename: "worker.js" });
	equal(loaded.join(), "dsp.js?v=abc123,siggen.js?v=abc123", "what it loads, and how");
	equal(typeof scope.onmessage, "function", "it listens for the page");
	ok(typeof scope.PirateDSP === "object" && typeof scope.PirateSigGen === "object", "the two libraries are there, as globals");

	scope.onmessage({ data: { type: "start", radio: "hackrf", demo: true, settings: WANT } });
	const t0 = Date.now();
	while (posted.filter(function (p) { return p.m.type === "meter"; }).length < 2) {
		if (Date.now() - t0 > 4000) throw new Error("no stream from the worker");
		await sleep(20);
	}
	scope.onmessage({ data: { type: "set", vfo: 97300000 } });
	scope.onmessage({ data: { type: "stop" } });
	const by = function (type) { return posted.filter(function (p) { return p.m.type === type; }); };
	equal(by("conn").map(function (p) { return p.m.state; }).join(" "), "connecting open streaming closed", "conn states");
	const kind = function (v) { return Object.prototype.toString.call(v); };
	const f = by("fft")[0], a = by("audio")[0];
	ok(kind(f.m.bins) === "[object Float32Array]" && f.transfer.length === 1 && f.transfer[0] === f.m.bins.buffer, "a line's bins are handed over, not copied");
	ok(kind(a.m.samples) === "[object Float32Array]" && a.transfer.length === 1 && a.transfer[0] === a.m.samples.buffer, "and so is the audio");
	ok(by("info").length === 1 && by("error").length === 0, "one info, no errors");
});

/* ---------- the mock itself keeps the protocol's rules ---------- */

test("mock bridge: handshake rules, bad commands, ping", async function () {
	const b = await startMockBridge();
	try {
		// a plain request is told what this port is
		const plain = await new Promise(function (ok2, bad) {
			http.get("http://127.0.0.1:" + b.port + "/", function (res) {
				let body = "";
				res.on("data", function (c) { body += c; });
				res.on("end", function () { ok2({ status: res.statusCode, body: body }); });
			}).on("error", bad);
		});
		ok(plain.status === 426 && /WebSocket/.test(plain.body), "a plain GET: " + plain.status);

		// a page from elsewhere is refused; this host's own is not
		const refused = await new Promise(function (ok2) {
			const ws = new WebSocket(url(b), { headers: { Origin: "http://evil.example" } });
			ws.onclose = function () { ok2(ws.status); };
			ws.onerror = function () {};
		});
		equal(refused, 403, "an Origin from elsewhere");
		const own = await new Promise(function (ok2) {
			const ws = new WebSocket(url(b), { headers: { Origin: "http://127.0.0.1:8080" } });
			ws.onopen = function () { ws.close(); ok2(101); };
			ws.onclose = function () { ok2(ws.status); };
			ws.onerror = function () {};
		});
		equal(own, 101, "this host's own Origin, whatever its port");

		const l = await listener(b);
		await sleep(50);
		const hello = l.text[0];
		ok(hello.type === "hello" && hello.proto === 1 && hello.sim === true && hello.open === null, "hello: " + JSON.stringify(hello));
		l.say({ cmd: "ping", t: 42 });
		l.say({ cmd: "freq", hz: 100e6 });
		l.say({ cmd: "dance" });
		l.say({ cmd: "open", radio: "hackrf", rate: 1000000 });
		l.ws.send("[1,2]");
		l.ws.send(JSON.stringify({ cmd: "open", radio: { nested: true } }));
		await sleep(100);
		equal(l.got("pong")[0].t, 42, "pong");
		equal(l.got("error").map(function (e) { return e.code; }).join(), "badrequest,badrequest,badrequest,badrequest,badrequest", "five bad requests");
		equal(b.device(), null, "and no radio opened by them");

		// open: info, then status, then frames, each `frame` samples, numbered in order
		const seqs = [];
		l.ws.onmessage = function (ev) {
			if (typeof ev.data === "string") { l.text.push(JSON.parse(ev.data)); return; }
			const h = new DataView(ev.data);
			seqs.push({ kind: h.getUint8(0), flags: h.getUint8(1), seq: h.getUint32(4, true), n: (ev.data.byteLength - 8) / 2, after: l.text.length });
		};
		const at = l.text.length;
		l.say({ cmd: "open", radio: "rtlsdr", freq: 162475000, rate: 1200000 });
		await sleep(400);
		equal(l.text.slice(at, at + 2).map(function (m) { return m.type; }).join(), "info,status", "the answer to open");
		const info = l.text[at];
		ok(info.radio === "rtlsdr" && info.freq === 162475000 && info.rate === 1200000 && info.frame === 24000, "info: " + JSON.stringify(info).slice(0, 120));
		ok(seqs.length >= 12 && seqs.length <= 28, "about 50 frames a second: " + seqs.length + " in 0.4 s");
		ok(seqs.every(function (s, k) { return s.kind === 1 && s.n === 24000 && (k === 0 || s.seq === seqs[k - 1].seq + 1); }), "frames of 24000 samples, in order");
		equal(seqs[0].flags, 1, "the first frame is flagged");
		ok(seqs.slice(1).every(function (s) { return s.flags === 0; }), "the rest are not");

		// a move: status first, then a flagged frame
		const n = seqs.length, t = l.text.length;
		l.say({ cmd: "freq", hz: 162000000 });
		await sleep(200);
		const st = l.text.slice(t).filter(function (m) { return m.type === "status" && m.freq === 162000000; })[0];
		ok(!!st, "a status with the new frequency");
		const firstAfter = seqs.slice(n).filter(function (s) { return s.after > l.text.indexOf(st); })[0];
		equal(firstAfter.flags, 1, "the first frame after it is flagged");
		l.say({ cmd: "freq", hz: 5e9 });
		l.say({ cmd: "close" });
		await sleep(100);
		equal(l.got("error").pop().code, "failed", "a frequency the radio cannot tune");
		equal(l.got("closed").length, 1, "closed, as asked");
		equal(b.device(), null, "the radio is let go");

		// what a client may not send
		const codes = [];
		for (const bad of [new Uint8Array(4), "x".repeat(600)]) {
			const c = await listener(b);
			const closed = new Promise(function (r) { c.ws.onclose = function (ev) { r(ev.code); }; });
			c.ws.send(bad);
			codes.push(await closed);
		}
		equal(codes.join(), "1003,1009", "binary, and an over-long text");
		l.ws.close();
	} finally { await b.close(); }
});

if (require.main === module) run("worker.js: the engine").then(function (failed) { process.exit(failed ? 1 : 0); });
else module.exports = function () { return run("worker.js: the engine"); };
