/* Pirate Radio web UI. A tiny single-page app that talks to the router's rpcd/ubus
   methods (pirate.recon, pirate.sdr) over /ubus with a root session.
   No framework. Served by uhttpd at the web root (/).

   Demo mode: open with ?demo=1 (or from a file:// path) to render built-in
   sample data without a router, for previewing the design. */
(function () {
	"use strict";

	var UBUS = "/ubus";
	// rpcd's unauthenticated session: 32 zeros, no dashes. A UUID-style id is an
	// unknown session to uhttpd, so every call (login included) is denied.
	var NULL_SID = "00000000000000000000000000000000";
	var DEMO = /[?&]demo=1/.test(location.search) || location.protocol === "file:";
	var SID = null;

	/* ---------- ubus JSON-RPC client ---------- */

	function rpc(method, params) {
		return fetch(UBUS, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
		}).then(function (r) { return r.json(); }).then(function (j) {
			if (j.error) {
				var e = new Error(j.error.message || "rpc error");
				e.code = j.error.code;
				throw e;
			}
			return j.result;
		});
	}

	function dropSession() {
		SID = null;
		try { sessionStorage.removeItem("pirate_sid"); } catch (e) {}
	}

	// ubus "call" returns [status, data]; status 0 == ok, 6 == permission. An
	// expired or unknown session comes back as JSON-RPC error -32002 instead.
	function callm(object, method, params) {
		return rpc("call", [SID || NULL_SID, object, method, params || {}]).catch(function (e) {
			if (e.code === -32002) { dropSession(); throw new Error("unauthorized"); }
			throw e;
		}).then(function (r) {
			if (!Array.isArray(r)) throw new Error("bad ubus reply");
			if (r[0] === 6) { dropSession(); throw new Error("unauthorized"); }
			if (r[0] !== 0) throw new Error("ubus status " + r[0]);
			return r[1] || {};
		});
	}

	// keep === false: don't remember the session across reloads (the first-run
	// probe, whose session must not outlive an unset password).
	function login(user, pass, keep) {
		return rpc("call", [NULL_SID, "session", "login",
			{ username: user, password: pass, timeout: 3600 }]).then(function (r) {
			if (!Array.isArray(r) || r[0] !== 0 || !r[1] || !r[1].ubus_rpc_session)
				throw new Error("login failed");
			SID = r[1].ubus_rpc_session;
			if (keep !== false) rememberSession();
			return SID;
		});
	}
	function rememberSession() {
		try { sessionStorage.setItem("pirate_sid", SID); } catch (e) {}
	}

	// call(): the one entry point the views use; serves demo data when offline.
	function call(object, method, params) {
		if (DEMO) {
			var d = MOCK[object + ":" + method];
			if (typeof d === "function") d = d(params || {});
			return Promise.resolve(JSON.parse(JSON.stringify(d != null ? d : {})));
		}
		return callm(object, method, params || {});
	}

	/* ---------- demo data ---------- */

	function iso(secAgo) { return new Date(Date.now() - secAgo * 1000).toISOString(); }
	function stamp(secAgo) { return new Date(Date.now() - secAgo * 1000).toISOString().replace("T", " ").replace(/\..*/, ""); }
	function pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }

	// Mutable demo job table so "Use the radio" visibly switches jobs in demo.
	var DEMO_JOBS = [
		{ name: "soapy", type: "soapy", radio: "hackrf", state: "running" },
		{ name: "adsb", type: "adsb", radio: "rtlsdr", state: "running" },
		{ name: "survey", type: "hackrf_sweep", radio: "hackrf", state: "stopped" },
		{ name: "ism", type: "rtl_433", radio: "rtlsdr", state: "off" },
		{ name: "ais", type: "rtl_ais", radio: "rtlsdr", state: "off" },
		{ name: "rtltcp", type: "rtl_tcp", radio: "rtlsdr", state: "off" }
	];
	function demoStatus() {
		var head = "pirate-radio\n  microSD:  mounted /mnt/sdcard (PIRATERADIO, 29.7G free)\n" +
			"  RTL-SDR:  present (Realtek RTL2838U, serial 00000001)\n" +
			"  HackRF:   present (serial 457863)\n\n  job        type           radio    state\n";
		return head + DEMO_JOBS.map(function (j) {
			return "  " + pad(j.name, 10) + " " + pad(j.type, 14) + " " + pad(j.radio, 8) + " " + j.state;
		}).join("\n");
	}

	var DEMO_ADB = { on: true };
	var DEMO_CAP = {
		running: false, iface: "", filter: "", file: "", start: 0,
		files: [
			{ name: "cap-20261029-1355.pcap", size: 5242880, mtime: "2026-10-29 13:55" },
			{ name: "dns-cap-20261029-1402.pcap0", size: 3145728, mtime: "2026-10-29 14:02" }
		]
	};
	var DEMO_HS = {
		running: false, phy: "", channel: "", file: "", start: 0,
		files: [ { name: "home-hs-ch6-20261029-1310.pcap", size: 28672, mtime: "2026-10-29 13:10" } ]
	};
	var DEMO_FW = { staged: false, size: 0, verified: false };
	var DEMO_DP = { enabled: true, service: "ppp", dial_tone: true, dcnow: true, dmz: false };
	var DEMO_DCNOW = { name: "Unnamed_2bec1b", id: "2bec1b43c9a2c523e3bcbeac146109088a0643419e1b39837057632447d93082", as_pi: false };
	function demoDreampi() {
		var s = { installed: true, local_ip: "192.168.169.1", dreamcast_ip: "192.168.169.2", wan_ip: "192.168.1.185",
			modems: [{ device: "/dev/ttyACM0", id: "0572:1340", name: "Conexant USB modem (Dell NW147, Lenovo RD02-D400, TRENDnet TFM-561U)" }],
			state: DEMO_DP.enabled ? "connected" : "off", call_service: "ppp", number: "5551234",
			since: Math.round(Date.now() / 1000) - 754, link: DEMO_DP.enabled, rx_bytes: 482113, tx_bytes: 2310442,
			lookup: "dc.dreamcastlive.net", dcnow_name: DEMO_DCNOW.name, dcnow_id: DEMO_DCNOW.id, dcnow_as_dreampi: DEMO_DCNOW.as_pi };
		for (var k in DEMO_DP) s[k] = DEMO_DP[k];
		return s;
	}

	var DEMO_USB = { enabled: true, card: false, password: false, ejected: false };
	var DEMO_USB_FILES = {
		"": [{ name: "Music", dir: true }, { name: "Photos", dir: true }, { name: "notes.txt", size: 2048 },
			{ name: "pirate-radio-backup.tar.gz", size: 48213 }],
		"Music": [{ name: "mixtape.mp3", size: 7340032 }],
		"Photos": [{ name: "2026", dir: true }, { name: "slate.jpg", size: 2516582 }],
		"Photos/2026": [{ name: "dreamcast.jpg", size: 1887436 }]
	};
	var DEMO_CARD_FILES = {
		"": [{ name: "pirate-radio", dir: true }, { name: "recon", dir: true }, { name: "survey", dir: true }]
	};
	function demoUsb() {
		var drives = DEMO_USB.ejected ? [] : [{ name: "KINGSTON", device: "sdb1", disk: "sdb", label: "KINGSTON", fs: "exfat",
			model: "Kingston DataTraveler 3.0", size: 30943995904, used: 13207024435, free: 17736971469, readonly: false, card: false }];
		if (DEMO_USB.card) drives.push({ name: "microSD", device: "sda1", disk: "sda", label: "PIRATERADIO", fs: "exfat",
			model: "microSD card", size: 61847109632, used: 40960000, free: 61806149632, readonly: false, card: true });
		return { installed: true, enabled: DEMO_USB.enabled, sharing: DEMO_USB.enabled && drives.length > 0, user: "pirate",
			password: DEMO_USB.password, host: "PirateRadio", http_port: 8082, card: DEMO_USB.card, card_in: true, drives: drives };
	}

	/* The Flipper page's demo: a few files, and a menu on its screen */
	var DEMO_FZ = { seq: 1, item: 0 };
	var DEMO_FZ_FILES = {
		"/": [{ name: "any", dir: true }, { name: "int", dir: true }, { name: "ext", dir: true }],
		"/int": [{ name: ".bt.settings", size: 52 }],
		"/ext": [{ name: "badusb", dir: true }, { name: "infrared", dir: true }, { name: "nfc", dir: true },
			{ name: "subghz", dir: true }, { name: "notes.txt", size: 14 }],
		"/ext/badusb": [{ name: "hello.txt", size: 88 }],
		"/ext/infrared": [{ name: "TV.ir", size: 1204 }],
		"/ext/nfc": [],
		"/ext/subghz": [{ name: "garage.sub", size: 412 }]
	};
	var DEMO_FZ_MENU = ["Sub-GHz", "RFID", "NFC", "Infrared", "GPIO", "iButton", "Bad USB"];
	// The screen as the Flipper sends it: 128x64, a byte for 8 rows of a column
	function demoFlipperFrame() {
		var c = document.createElement("canvas"), g, px, bytes = new Uint8Array(1024), x, y, i, top;
		c.width = 128; c.height = 64;
		g = c.getContext("2d");
		g.fillStyle = "#fff"; g.fillRect(0, 0, 128, 64);
		g.fillStyle = "#000"; g.font = "bold 10px monospace"; g.textBaseline = "top";
		top = Math.max(0, Math.min(DEMO_FZ.item - 1, DEMO_FZ_MENU.length - 4));
		for (i = 0; i < 4; i++) {
			var n = top + i;
			if (n === DEMO_FZ.item) { g.fillRect(2, 2 + i * 15, 118, 14); g.fillStyle = "#fff"; }
			g.fillText(DEMO_FZ_MENU[n], 8, 4 + i * 15);
			g.fillStyle = "#000";
		}
		g.fillRect(124, 2 + Math.round(DEMO_FZ.item * 58 / DEMO_FZ_MENU.length), 3, 8);
		px = g.getImageData(0, 0, 128, 64).data;
		for (y = 0; y < 64; y++)
			for (x = 0; x < 128; x++)
				if (px[(y * 128 + x) * 4] < 128) bytes[(y >> 3) * 128 + x] |= 1 << (y & 7);
		var s = "";
		for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
		return btoa(s);
	}
	function demoFzEntry(path) {
		var dir = path.replace(/\/[^/]*$/, "") || "/", name = path.replace(/^.*\//, "");
		var list = DEMO_FZ_FILES[dir];
		return { list: list, dir: dir, name: name, i: list ? list.map(function (f) { return f.name; }).indexOf(name) : -1 };
	}

	var MOCK = {
		"pirate.flipper:status": { state: "ready", device: "/dev/ttyACM0", name: "Pirate", model: "Flipper Zero",
			firmware: "1.3.4", branch: "release", build_date: "04-11-2026", commit: "a1b2c3d4", battery: 87,
			charging: "charging", protobuf: "0.25", sd: true, sd_total: 31914983424, sd_free: 30120000000 },
		"pirate.flipper:info": {
			info: { hardware_model: "Flipper Zero", hardware_name: "Pirate", hardware_region: "1",
				hardware_otp_ver: "2", firmware_version: "1.3.4", firmware_branch: "release",
				firmware_commit: "a1b2c3d4", firmware_build_date: "04-11-2026", radio_alive: "true",
				radio_stack_major: "1", radio_stack_minor: "20" },
			power: { charge_level: "87", charge_state: "charging", battery_voltage: "4.05", battery_health: "100" }
		},
		"pirate.flipper:screen": function (p) {
			if (p.seq === DEMO_FZ.seq) return { state: "ready", seq: DEMO_FZ.seq };
			return { state: "ready", seq: DEMO_FZ.seq, frame: demoFlipperFrame(), orientation: "horizontal" };
		},
		"pirate.flipper:input": function (p) {
			if (/short|repeat/.test(p.type || "click") || p.type === "click") {
				if (p.key === "up") DEMO_FZ.item = (DEMO_FZ.item + DEMO_FZ_MENU.length - 1) % DEMO_FZ_MENU.length;
				if (p.key === "down") DEMO_FZ.item = (DEMO_FZ.item + 1) % DEMO_FZ_MENU.length;
				DEMO_FZ.seq++;
			}
			return { ok: true };
		},
		"pirate.flipper:list": function (p) {
			var list = DEMO_FZ_FILES[p.path];
			if (!list) return { error: "no such file or folder" };
			return { path: p.path, files: list.map(function (f) { return { name: f.name, dir: !!f.dir, size: f.size || 0 }; }) };
		},
		"pirate.flipper:read": function (p) {
			var e = demoFzEntry(p.path), f = e.i >= 0 ? e.list[e.i] : null, text;
			if (!f || f.dir) return { error: "no such file or folder" };
			text = "Pirate Radio demo: " + p.path + "\n";
			if (p.offset == null) return { ready: true, size: text.length };
			return { size: text.length, offset: 0, data: btoa(text), more: false };
		},
		"pirate.flipper:write": function (p) {
			var e = demoFzEntry(p.path), n = Math.floor((p.data || "").length * 3 / 4);
			if (!p.more && e.list && e.i < 0) e.list.push({ name: e.name, size: (p.offset || 0) + n });
			return p.more ? { ok: true, received: (p.offset || 0) + n } : { ok: true, size: (p.offset || 0) + n };
		},
		"pirate.flipper:mkdir": function (p) {
			var e = demoFzEntry(p.path);
			if (!e.list) return { error: "no such file or folder" };
			if (e.i >= 0) return { error: "already exists" };
			e.list.push({ name: e.name, dir: true });
			DEMO_FZ_FILES[p.path] = [];
			return { ok: true };
		},
		"pirate.flipper:delete": function (p) {
			var e = demoFzEntry(p.path);
			if (e.i < 0) return { error: "no such file or folder" };
			if (e.list[e.i].dir && (DEMO_FZ_FILES[p.path] || []).length && !p.recursive) return { error: "the folder isn't empty" };
			e.list.splice(e.i, 1);
			delete DEMO_FZ_FILES[p.path];
			return { ok: true };
		},
		"pirate.flipper:rename": function (p) {
			var e = demoFzEntry(p.path), t = demoFzEntry(p.to);
			if (e.i < 0) return { error: "no such file or folder" };
			if (t.i >= 0) return { error: "already exists" };
			e.list[e.i].name = t.name;
			if (DEMO_FZ_FILES[p.path]) { DEMO_FZ_FILES[p.to] = DEMO_FZ_FILES[p.path]; delete DEMO_FZ_FILES[p.path]; }
			return { ok: true };
		},
		"pirate.flipper:alert": { ok: true },
		"pirate.flipper:time": { ok: true },
		"pirate.flipper:reboot": { ok: true },
		"pirate.usb:status": demoUsb,
		"pirate.usb:list": function (p) {
			var files = p.name === "KINGSTON" && !DEMO_USB.ejected ? DEMO_USB_FILES : p.name === "microSD" && DEMO_USB.card ? DEMO_CARD_FILES : null;
			if (!files) return { error: "no such drive" };
			var list = files[p.path || ""];
			if (!list) return { error: "no such folder" };
			var t = Math.round(Date.now() / 1000) - 86400;
			return { path: p.path || "", total: list.length, truncated: false, entries: list.map(function (f, i) {
				return { name: f.name, dir: !!f.dir, size: f.size || 0, mtime: t - i * 3600 };
			}) };
		},
		"pirate.usb:eject": function (p) {
			if (p.name === "microSD" && DEMO_USB.card) return { error: "the microSD card can't be ejected here: turn off sharing it instead" };
			if (p.name !== "KINGSTON" || DEMO_USB.ejected) return { error: "no such drive" };
			DEMO_USB.ejected = true;
			setTimeout(function () { DEMO_USB.ejected = false; }, 15000);   // "plugged in again"
			return { ok: true, name: p.name };
		},
		"pirate.usb:set": function (p) {
			if ("enabled" in p) DEMO_USB.enabled = !!p.enabled;
			if ("card" in p) DEMO_USB.card = !!p.card;
			return demoUsb();
		},
		"pirate.usb:set_password": function (p) {
			if (p.password && p.password.length < 5) return { error: "use at least 5 characters" };
			DEMO_USB.password = !!p.password;
			return demoUsb();
		},
		"pirate.recon:dashboard": {
			uplink: { ssid: "NoInternetHere-5", iface: "phy1-sta0",
				subnet: "192.168.1.0/24", gateway: "192.168.1.1", online: true },
			hosts: { count: 5, scanned: "2026-10-29 14:02" },
			survey: { count: 38 },
			threats: { count: 1, high: 1 },
			gps: { installed: true, running: true },
			radios: [
				{ iface: "wlan0", mode: "Master", ssid: "Pirate Radio", channel: 36 },
				{ iface: "wlan1", mode: "Client", ssid: "NoInternetHere-5", channel: 6 },
				{ iface: "wlan2", mode: "Monitor", ssid: "", channel: 6 }
			],
			sdr: { present: true, running: 3 }
		},
		"pirate.recon:uplink": { ssid: "NoInternetHere-5", iface: "phy1-sta0",
			subnet: "192.168.1.0/24", gateway: "192.168.1.1", gateway_mac: "a4:2b:b0:11:22:33" },
		"pirate.recon:hosts": {
			scanned: "2026-10-29T14:02:11Z",
			hosts: [
				{ ip: "192.168.1.1", mac: "a4:2b:b0:11:22:33", vendor: "Netgear", gateway: true },
				{ ip: "192.168.1.10", mac: "b8:27:eb:aa:bb:cc", vendor: "Raspberry Pi Foundation" },
				{ ip: "192.168.1.23", mac: "3c:22:fb:12:34:56", vendor: "Apple, Inc." },
				{ ip: "192.168.1.42", mac: "dc:a6:32:77:88:99", vendor: "Raspberry Pi Trading" },
				{ ip: "192.168.1.185", mac: "e4:5f:01:ab:cd:ef", vendor: "(Unknown)", self: true }
			]
		},
		"pirate.recon:ports": function (p) {
			return { target: p.target, ports: [
				{ port: 22, proto: "tcp", service: "ssh" },
				{ port: 80, proto: "tcp", service: "http" },
				{ port: 443, proto: "tcp", service: "https" }
			] };
		},
		"pirate.recon:survey_networks": function () {
			return { total: 38, networks: [
				{ ssid: "Pirate Radio", bssid: "a4:2b:b0:aa:00:01", channel: 36, security: "WPA3", best_signal: -31, count: 210, last: iso(20), lat: 37.42193, lon: -122.08400 },
				{ ssid: "NoInternetHere-5", bssid: "a4:2b:b0:11:22:34", channel: 6, security: "WPA3", best_signal: -44, count: 142, last: iso(45), lat: 37.42191, lon: -122.08411 },
				{ ssid: "CoffeeShop", bssid: "aa:bb:cc:00:11:22", channel: 1, security: "Open", best_signal: -58, count: 31, last: iso(240), lat: 37.42210, lon: -122.08455 },
				{ ssid: "xfinitywifi", bssid: "06:1d:ac:31:aa:10", channel: 11, security: "Open", best_signal: -73, count: 9, last: iso(1800) },
				{ ssid: "", bssid: "e8:de:27:44:55:66", channel: 11, security: "WPA", best_signal: -81, count: 4, last: iso(7200) }
			] };
		},
		"pirate.recon:survey_gps": { installed: true, running: true, device: "/dev/ttyACM0",
			fix: "3D", lat: 37.421925, lon: -122.084102, sats_used: 9, sats: 12 },
		"pirate.recon:survey_scan": { phy: "phy1", found: 6, total: 38, gps: true, saved: true },
		"pirate.recon:survey_clear": {},
		"pirate.recon:threats_rogue": {
			total_networks: 38,
			protected: ["Pirate Radio", "NoInternetHere-5"],
			threats: [{
				type: "evil_twin", severity: "high", ssid: "CoffeeShop",
				detail: "\"CoffeeShop\" is advertised both open and secured — a classic evil-twin setup.",
				bssids: [
					{ bssid: "aa:bb:cc:00:11:22", security: "Open", signal: -58, channel: 1 },
					{ bssid: "aa:bb:cc:00:11:23", security: "WPA", signal: -66, channel: 6 }
				]
			}]
		},
		"pirate.recon:threats_deauth": function (p) {
			var secs = Number(p.secs) || 15;
			return { alert: false, total: 4, window_s: secs, channel: 6, deauth: 3, disassoc: 1,
				sources: [{ mac: "de:ad:be:ef:00:01", count: 3 }, { mac: "de:ad:be:ef:00:02", count: 1 }] };
		},
		"pirate.recon:scan": function (p) {
			if (p.profile === "ping")
				return { profile: "ping", target: p.target, saved: "scan-ping-20261029-1405.txt",
					hosts: [{ ip: "192.168.1.1" }, { ip: "192.168.1.10" }, { ip: "192.168.1.23" }, { ip: "192.168.1.42" }] };
			var svc = p.profile === "service";
			return { profile: p.profile, target: p.target, saved: "scan-" + p.profile + "-20261029-1405.txt",
				hosts: [{ ip: (/^[0-9.]+$/.test(p.target || "") ? p.target : "192.168.1.10"), ports: [
					{ port: 22, proto: "tcp", service: "ssh", version: svc ? "OpenSSH 9.6" : "" },
					{ port: 80, proto: "tcp", service: "http", version: svc ? "nginx 1.26" : "" },
					{ port: 443, proto: "tcp", service: "https", version: svc ? "nginx 1.26" : "" },
					{ port: 8080, proto: "tcp", service: "http-proxy", version: "" }
				] }] };
		},
		"pirate.sdr:use": function (p) {
			var job = DEMO_JOBS.filter(function (j) { return j.name === p.job; })[0];
			var stopped = [];
			if (job) {
				DEMO_JOBS.forEach(function (j) {
					if (j.radio === job.radio && j.name !== job.name && j.state === "running") { j.state = "off"; stopped.push(j.name); }
				});
				job.state = "running";
			}
			return { job: p.job, radio: job ? job.radio : "", switched: true, stopped: stopped };
		},
		"pirate.sdr:devices": function () {
			return { now: Math.floor(Date.now() / 1000), enabled: true,
				frequencies: ["433.92M", "315M", "915M"], hop_interval: 600, decoded: 212,
				devices: [
					{ model: "Acurite-Tower", id: 12345, channel: "A", first: stamp(9000), last: stamp(28), count: 96, freq: "433.92M", readings: { temperature_C: 21.4, humidity: 48, battery_ok: 1 } },
					{ model: "LaCrosse-TX141THBv2", id: 88, channel: 2, last: stamp(140), count: 41, freq: "915M", readings: { temperature_C: 19.8, humidity: 55 } },
					{ model: "Toyota-TPMS", id: "8fa21c", last: stamp(600), count: 6, freq: "315M", readings: { pressure_PSI: 32.1, temperature_C: 27.0 } },
					{ model: "Honeywell-Door", id: 7781, last: stamp(3600), count: 3, freq: "345M", readings: { state: "open", battery_ok: 1 } }
				] };
		},
		"pirate.router:status": {
			hostname: "pirate-radio", model: "GL.iNet GL-AR750S (NAND)", firmware: "OpenWrt 25.12.6",
			uptime: 48212, load: "0.42",
			memory: { total: 124416, free: 38160, available: 51232 },
			flash: { total: 98304, free: 72960 }, online: true
		},
		"pirate.router:clients": {
			clients: [
				{ mac: "b8:27:eb:aa:bb:cc", ip: "192.168.1.10", host: "raspberrypi" },
				{ mac: "3c:22:fb:12:34:56", ip: "192.168.1.23", host: "nicks-iphone" },
				{ mac: "dc:a6:32:77:88:99", ip: "192.168.1.42", host: "octoprint" },
				{ mac: "e4:5f:01:ab:cd:ef", ip: "192.168.1.185", host: "-" }
			]
		},
		"pirate.router:adblock": function (p) {
			if (p && (p.enabled === true || p.enabled === 1 || p.enabled === "1" || p.enabled === "true")) DEMO_ADB.on = true;
			else if (p && (p.enabled === false || p.enabled === 0 || p.enabled === "0" || p.enabled === "false")) DEMO_ADB.on = false;
			return { installed: true, enabled: DEMO_ADB.on, running: DEMO_ADB.on, domains: 58781 };
		},
		"pirate.router:wifi_status": { configured: true, ssid: "NoInternetHere-5", encryption: "psk2", connected: true, live_ssid: "NoInternetHere-5", signal: -58 },
		"pirate.router:wifi_scan": {
			networks: [
				{ ssid: "NoInternetHere-5", bssid: "78:d2:94:75:db:ca", channel: 36, signal: -58, enc: "wpa2" },
				{ ssid: "CoffeeShop", bssid: "aa:bb:cc:00:11:22", channel: 1, signal: -67, enc: "open" },
				{ ssid: "Neighbor-5G", bssid: "e8:de:27:44:55:66", channel: 149, signal: -74, enc: "wpa3" },
				{ ssid: "", bssid: "12:34:56:78:9a:bc", channel: 6, signal: -81, enc: "wpa2" }
			]
		},
		"pirate.router:wifi_join": function (p) {
			if (!p.ssid) return { error: "no SSID" };
			var e = p.enc === "open" ? "none" : (p.enc === "wpa3" ? "sae" : "psk2");
			if (e !== "none" && !p.key) return { error: "this network needs a password" };
			return { ok: true, ssid: p.ssid, encryption: e };
		},
		"pirate.router:set_password": function (p) {
			if (!p.password) return { error: "empty password" };
			if (p.password.length < 5) return { error: "use at least 5 characters" };
			return { ok: true };
		},
		"pirate.capture:interfaces": {
			interfaces: [
				{ name: "br-lan", state: "up" },
				{ name: "phy1-sta0", state: "up" },
				{ name: "phy0-ap0", state: "up" },
				{ name: "eth0", state: "down" }
			]
		},
		"pirate.capture:status": function () {
			if (!DEMO_CAP.running) return { running: false, iface: "", filter: "", file: "", size: 0, elapsed: 0 };
			var e = Math.floor(Date.now() / 1000) - DEMO_CAP.start;
			return { running: true, iface: DEMO_CAP.iface, filter: DEMO_CAP.filter,
				file: DEMO_CAP.file, size: 12000 + e * 2500, elapsed: e };
		},
		"pirate.capture:list": function () { return { files: DEMO_CAP.files.slice() }; },
		"pirate.capture:start": function (p) {
			DEMO_CAP.running = true; DEMO_CAP.iface = p.iface || "br-lan"; DEMO_CAP.filter = p.filter || "";
			DEMO_CAP.start = Math.floor(Date.now() / 1000);
			var ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
			DEMO_CAP.file = (p.name ? p.name + "-" : "") + "cap-" + ts + ".pcap";
			return MOCK["pirate.capture:status"]();
		},
		"pirate.capture:stop": function () {
			if (DEMO_CAP.running)
				DEMO_CAP.files.unshift({ name: DEMO_CAP.file, size: 12000 + (Math.floor(Date.now() / 1000) - DEMO_CAP.start) * 2500, mtime: "just now" });
			DEMO_CAP.running = false;
			return { stopped: true };
		},
		"pirate.handshake:radios": {
			radios: [ { phy: "phy0", monitor: true }, { phy: "phy1", monitor: true } ]
		},
		"pirate.handshake:status": function () {
			if (!DEMO_HS.running) return { running: false, phy: "", channel: "", file: "", size: 0, elapsed: 0, eapol: 0 };
			var e = Math.floor(Date.now() / 1000) - DEMO_HS.start;
			return { running: true, phy: DEMO_HS.phy, channel: DEMO_HS.channel, file: DEMO_HS.file,
				size: 4096 + e * 300, elapsed: e, eapol: e > 8 ? 4 : 0 };
		},
		"pirate.handshake:list": function () { return { files: DEMO_HS.files.slice() }; },
		"pirate.handshake:start": function (p) {
			DEMO_HS.running = true; DEMO_HS.phy = p.phy || "phy1"; DEMO_HS.channel = p.channel || "6";
			DEMO_HS.start = Math.floor(Date.now() / 1000);
			var ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
			DEMO_HS.file = (p.name ? p.name + "-" : "") + "hs-ch" + DEMO_HS.channel + "-" + ts + ".pcap";
			return MOCK["pirate.handshake:status"]();
		},
		"pirate.handshake:stop": function () {
			if (DEMO_HS.running) DEMO_HS.files.unshift({ name: DEMO_HS.file, size: 28000, mtime: "just now" });
			DEMO_HS.running = false;
			return { stopped: true };
		},
		"pirate.firmware:status": function () {
			return { model: "GL.iNet GL-AR750S (NAND)", firmware: "OpenWrt 25.12.6",
				staging_free: 61000, staged: DEMO_FW.staged, staged_size: DEMO_FW.size, verified: DEMO_FW.verified };
		},
		"pirate.firmware:verify": function () {
			if (!DEMO_FW.staged) return { ok: false, error: "no image staged" };
			DEMO_FW.verified = true;
			return { ok: true, message: "image is a valid upgrade for this device" };
		},
		"pirate.firmware:fetch": function (p) {
			if (!p.url) return { ok: false, error: "no URL" };
			DEMO_FW.staged = true; DEMO_FW.size = 7340032; DEMO_FW.verified = false;
			return { ok: true, size: DEMO_FW.size };
		},
		"pirate.firmware:backup": function () {
			return { ok: true, file: "/tmp/pirate-backup-20261030-101500.tar.gz", size: 48213 };
		},
		"pirate.firmware:apply": function () {
			if (!DEMO_FW.staged) return { ok: false, error: "no image staged" };
			if (!DEMO_FW.verified) return { ok: false, error: "image failed verification; not flashing" };
			return { ok: true, message: "flashing now; the device will reboot", mode: "keep" };
		},
		"pirate.firmware:clear": function () {
			DEMO_FW.staged = false; DEMO_FW.size = 0; DEMO_FW.verified = false;
			return { ok: true };
		},
		"pirate.dreampi:status": demoDreampi,
		"pirate.dreampi:set": function (p) {
			["enabled", "service", "dial_tone", "dcnow", "dmz"].forEach(function (k) { if (p[k] != null) DEMO_DP[k] = p[k]; });
			return demoDreampi();
		},
		"pirate.dreampi:dcnow": function () { return { id: DEMO_DCNOW.id, name: DEMO_DCNOW.name }; },
		"pirate.dreampi:dcnow_id": function (p) {
			if (p.id && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{64}$/i.test(p.id))
				return { error: "enter a MAC address (B8:27:EB:12:34:56) or a 64-digit id, or nothing" };
			DEMO_DCNOW.as_pi = !!p.id;
			DEMO_DCNOW.id = p.id ? "45759ed22bbc324f6af24e849c045704a1b2c3d4e5f60718293a4b5c6d7e8f90" : "2bec1b43c9a2c523e3bcbeac146109088a0643419e1b39837057632447d93082";
			DEMO_DCNOW.name = p.id ? "NeedNotApply" : "Unnamed_2bec1b";
			return { id: DEMO_DCNOW.id, name: DEMO_DCNOW.name };
		},
		"pirate.dreampi:dcnow_name": function (p) {
			if (!p.name || /^\s|\s$/.test(p.name)) return { error: "enter a name without leading or trailing spaces" };
			DEMO_DCNOW.name = p.name;
			return { name: p.name };
		},
		"pirate.dreampi:log": { lines: [
			stamp(790) + " daemon.err dreampi[2210]: listening on /dev/ttyACM0",
			stamp(770) + " daemon.err dreampi[2210]: heard 5551234",
			stamp(768) + " user.notice dreampi: call to 5551234: ppp",
			stamp(760) + " daemon.err dreampi[2210]: answering (ppp)",
			stamp(741) + " daemon.err dreampi[2210]: CONNECT 33600",
			stamp(735) + " daemon.notice pppd[2290]: pppd 2.5.2 started by root, uid 0",
			stamp(731) + " daemon.notice pppd[2290]: PAP peer authentication succeeded for dream",
			stamp(730) + " daemon.notice pppd[2290]: local  IP address 192.168.169.1",
			stamp(730) + " daemon.notice pppd[2290]: remote IP address 192.168.169.2"
		] }
	};

	/* ---------- dom helpers ---------- */

	function el(tag, attrs) {
		var n = document.createElement(tag), k;
		if (attrs) for (k in attrs) {
			if (k === "class") n.className = attrs[k];
			else if (k === "text") n.textContent = attrs[k];
			else if (k === "html") n.innerHTML = attrs[k];
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
	function $(id) { return document.getElementById(id); }
	function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }

	function btn(label, o) {
		o = o || {};
		var b = el("button", { type: "button",
			class: "btn" + (o.primary ? " primary" : "") + (o.cls ? " " + o.cls : ""), text: label });
		if (o.onclick) b.addEventListener("click", o.onclick);
		return b;
	}
	function badge(text, cls) { return el("span", { class: "b " + (cls || ""), text: text }); }

	function tableEl(headers, rows) {
		var wrap = el("div", { class: "table-scroll" });
		var t = el("table", { class: "tbl" });
		var head = el("tr");
		headers.forEach(function (h) { head.appendChild(el("th", { text: h })); });
		t.appendChild(head);
		rows.forEach(function (r) {
			var tr = el("tr");
			r.forEach(function (c) {
				var td = el("td");
				if (c != null) td.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
				tr.appendChild(td);
			});
			t.appendChild(tr);
		});
		wrap.appendChild(t);
		return wrap;
	}
	function alertEl(kind, content) {
		var a = el("div", { class: "alert " + kind });
		(Array.isArray(content) ? content : [content]).forEach(function (c) {
			if (c != null) a.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
		});
		return a;
	}
	function ago(time) {
		var t = Date.parse(time), s = Math.max(0, Math.round((Date.now() - t) / 1000));
		if (isNaN(t)) return time || "-";
		if (s < 90) return s + " s ago";
		if (s < 5400) return Math.round(s / 60) + " min ago";
		if (s < 129600) return Math.round(s / 3600) + " h ago";
		return Math.round(s / 86400) + " days ago";
	}
	function dur(sec) {
		sec = +sec || 0;
		var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
		if (d) return d + "d " + h + "h";
		if (h) return h + "h " + m + "m";
		return m + "m";
	}
	function mb(kb) { return Math.round((+kb || 0) / 1024); }
	function size(b) {
		b = +b || 0;
		if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
		if (b >= 1024) return Math.round(b / 1024) + " KB";
		return b + " B";
	}
	function gb(b) {
		b = +b || 0;
		if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
		return size(b);
	}
	function secClass(sec) {
		if (sec === "Open") return "sec-open";
		if (sec === "WEP" || sec === "WPA") return "sec-warn";
		if (sec === "WPA3") return "sec-ok";
		return "sec-neutral";
	}
	function sevClass(sev) {
		return sev === "high" ? "sev-high" : (sev === "medium" ? "sev-warn" : "sev-neutral");
	}

	/* ---------- SDR helpers (status text, rtl_433 readings) ---------- */

	// rtl_433 key suffix -> unit shown after the value (from the LuCI ISM page).
	var UNITS = [
		[/_C$/, "°C"], [/_F$/, "°F"], [/_kPa$/, "kPa"], [/_hPa$/, "hPa"],
		[/_PSI$/i, "PSI"], [/_bar$/, "bar"], [/_km_h$/, "km/h"], [/_m_s$/, "m/s"],
		[/_mi_h$/, "mph"], [/_mm$/, "mm"], [/_in$/, "in"], [/_deg$/, "°"],
		[/_lux$/, "lux"], [/_V$/, "V"], [/_mV$/, "mV"], [/^humidity$|_humidity$|^moisture$/, "%"]
	];
	function reading(key, value) {
		if (key === "battery_ok") return value ? "battery OK" : "battery low";
		for (var i = 0; i < UNITS.length; i++)
			if (UNITS[i][0].test(key))
				return (key.replace(UNITS[i][0], "").replace(/_/g, " ") || key) + " " +
					((typeof value === "number") ? +value.toFixed(1) : value) + " " + UNITS[i][1];
		return key.replace(/_/g, " ") + " " + value;
	}
	function mhz(f) { return String(f).replace(/M$/i, "") + " MHz"; }
	function agoIsm(time) {
		return ago(/Z$|[+-]\d\d:?\d\d$/.test(time || "") ? time : time + "Z");
	}
	// "  adsb       adsb           rtlsdr   running" -> {name,type,radio,state}
	function parseJobs(status) {
		var jobs = [], re = /^ {2}(\S+) +(\S+) +(\S+) +(running|stopped|waiting|off) *$/mg, m;
		while ((m = re.exec(status || "")) !== null)
			jobs.push({ name: m[1], type: m[2], radio: m[3], state: m[4] });
		return jobs;
	}
	function fetchSdrStatus() {
		if (DEMO) return Promise.resolve(demoStatus());
		return fetch("/cgi-bin/pirate-radio", { cache: "no-store" }).then(function (r) {
			return r.ok ? r.text() : null;
		}).then(function (html) {
			var pre = html ? new DOMParser().parseFromString(html, "text/html").querySelector("pre") : null;
			return pre ? pre.textContent.replace(/^\n+|\s+$/g, "") : null;
		}).catch(function () { return null; });
	}
	var SDR_PAGES = [
		["Pirate Radio status", "http://%s/cgi-bin/pirate-radio", null],
		["Aircraft map", "http://%s:8080/", "adsb"],
		["Recorded data", "http://%s:8081/pirate-radio/", null]
	];
	var SDR_CLIENTS = [
		["SoapySDR (SDR++, GQRX, CubicSDR, SDRangel, GNU Radio)", "driver=remote,remote=tcp://%s:55132", "soapy"],
		["rtl_tcp (SDR#, SDR++, GQRX)", "%s:1234", "rtltcp"],
		["ADS-B, SBS", "%s:30003", "adsb"],
		["ADS-B, Beast", "%s:30005", "adsb"],
		["AIS, NMEA (OpenCPN)", "tcp://%s:10110", "ais"]
	];

	/* ---------- view scaffolding ---------- */

	var VIEW = $("view");
	function loading() { clear(VIEW).appendChild(el("div", { class: "loading", text: "Loading…" })); }
	function viewHead(title, sub) {
		return el("div", { class: "view-head" },
			el("h2", { text: title }), sub ? el("span", { class: "sub", text: sub }) : null);
	}
	function panel(title) {
		var p = el("div", { class: "panel" });
		if (title) p.appendChild(el("h3", { class: "sub-h", text: title }));
		return p;
	}

	/* ---------- Dashboard ---------- */

	function tile(o) {
		var t = el(o.tab ? "button" : "div", { class: "tile tone-" + (o.tone || "neutral") });
		if (o.tab) { t.type = "button"; t.addEventListener("click", function () { setTab(o.tab); }); }
		t.appendChild(el("span", { class: "k", text: o.k }));
		t.appendChild(el("span", { class: "v", text: String(o.v) }));
		if (o.s) t.appendChild(el("span", { class: "s", text: o.s }));
		return t;
	}

	function loadDashboard() {
		loading();
		return call("pirate.recon", "dashboard").then(renderDashboard).catch(onError);
	}

	function renderDashboard(d) {
		clear(VIEW);
		VIEW.appendChild(viewHead("Dashboard", "where the Slate is and what it sees"));
		var up = d.uplink || {}, online = !!up.online;
		setNetPill(online, up.ssid);

		var grid = el("div", { class: "grid" });
		grid.appendChild(tile({ k: "Uplink", v: up.ssid || "—", tone: online ? "accent" : "bad",
			s: online ? "online · " + (up.subnet || "") : "no internet route", tab: "survey" }));
		grid.appendChild(tile({ k: "Hosts", v: d.hosts ? d.hosts.count : 0, tab: "hosts",
			s: d.hosts && d.hosts.scanned ? "last scan " + d.hosts.scanned : "on the joined network" }));
		grid.appendChild(tile({ k: "Wi-Fi survey", v: d.survey ? d.survey.count : 0, tab: "survey",
			s: "access points logged" }));
		var th = d.threats || { count: 0, high: 0 };
		grid.appendChild(tile({ k: "Threats", v: th.count || 0, tab: "threats",
			tone: th.high > 0 ? "bad" : (th.count > 0 ? "warn" : "ok"), s: (th.high || 0) + " high severity" }));
		var gps = d.gps || {};
		grid.appendChild(tile({ k: "GPS", v: gps.running ? "live" : (gps.installed ? "idle" : "none"),
			tone: gps.running ? "ok" : "neutral",
			s: gps.installed ? (gps.running ? "gpsd running" : "plug in a receiver") : "not installed", tab: "survey" }));
		var sdr = d.sdr;
		grid.appendChild(tile({ k: "SDR jobs", v: sdr && sdr.present ? (sdr.running || 0) : "—", tab: "sdr",
			tone: sdr && sdr.present && sdr.running ? "accent" : "neutral",
			s: sdr && sdr.present ? "receivers running" : "not installed" }));
		VIEW.appendChild(grid);

		var radios = d.radios || [];
		var p = panel("Radios");
		p.style.marginTop = "14px";
		var rows = el("div", { class: "rows" });
		if (!radios.length) rows.appendChild(el("div", { class: "row muted" }, "no radios reported"));
		radios.forEach(function (r) {
			var cls = (r.mode || "").toLowerCase();
			rows.appendChild(el("div", { class: "row" },
				el("span", { class: "tag " + cls, text: r.mode || "?" }),
				el("span", { class: "grow", text: r.ssid || (cls === "monitor" ? "(monitor)" : "(no SSID)") }),
				el("span", { class: "muted", text: "ch " + (r.channel || "—") }),
				el("span", { class: "muted", text: r.iface || "" })));
		});
		p.appendChild(rows);
		VIEW.appendChild(p);
	}

	/* ---------- Hosts ---------- */

	function renderHosts() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Hosts", "what is on the network this router has joined"));

		var secUp = panel("Joined network");
		var uplinkLine = el("div", { class: "muted", text: "Loading…" });
		secUp.appendChild(uplinkLine);

		var secScan = panel();
		secScan.style.marginTop = "14px";
		var scanInfo = el("span", { class: "status" });
		var scanBtn = btn("Scan network", { primary: true, onclick: doDiscover });
		secScan.appendChild(el("div", { class: "toolbar" }, scanBtn, scanInfo));
		var tableWrap = el("div");
		tableWrap.appendChild(el("div", { class: "muted", text: "Loading…" }));
		secScan.appendChild(tableWrap);

		var portWrap = el("div");
		VIEW.appendChild(secUp); VIEW.appendChild(secScan); VIEW.appendChild(portWrap);

		function showUplink(u) {
			if (!u || u.error) { clear(uplinkLine).appendChild(el("em", { text: "Not joined to a network." })); return; }
			clear(uplinkLine);
			uplinkLine.appendChild(el("strong", { text: u.ssid || "wired" }));
			uplinkLine.appendChild(document.createTextNode(
				"  ·  " + (u.iface || "") + "  ·  " + (u.subnet || "") +
				"  ·  gw " + (u.gateway || "-") + (u.gateway_mac ? " (" + u.gateway_mac + ")" : "")));
			setNetPill(true, u.ssid);
			if (u.subnet && profTarget && !profTarget.value) profTarget.value = u.subnet;
		}
		function fillTable(data) {
			var list = (data && data.hosts) || [];
			if (data && data.error) { clear(tableWrap).appendChild(alertEl("warn", data.error)); return; }
			if (!list.length) { clear(tableWrap).appendChild(el("div", { class: "placeholder", html:
				"No scan yet. Click <b>Scan network</b>." })); return; }
			var rows = list.map(function (h) {
				var tags = el("span");
				if (h.gateway) tags.appendChild(badge("gateway", "sec-ok"));
				if (h.self) tags.appendChild(badge("this router", "sec-neutral"));
				return [
					el("strong", { text: h.ip }),
					h.mac || "-",
					(h.vendor && h.vendor !== "(Unknown)") ? h.vendor : "-",
					tags,
					btn("Ports", { cls: "small", onclick: function () { scanPorts(h.ip); } })
				];
			});
			clear(tableWrap).appendChild(tableEl(["Address", "MAC", "Vendor", "", "Scan"], rows));
			scanInfo.textContent = (data && data.scanned)
				? list.length + " hosts, scanned " + String(data.scanned).replace("T", " ").replace("Z", " UTC") : "";
		}
		function doDiscover() {
			scanBtn.disabled = true; scanInfo.textContent = "scanning the local segment…";
			call("pirate.recon", "discover").then(function (d) {
				fillTable(d);
				return call("pirate.recon", "uplink").then(showUplink);
			}).catch(function (e) { clear(tableWrap).appendChild(alertEl("warn", String(e.message || e))); })
				.then(function () { scanBtn.disabled = false; });
		}
		function scanPorts(ip) {
			var body = el("div", {}, el("em", { text: "Scanning " + ip + "…" }));
			clear(portWrap).appendChild(panel("Ports on " + ip)).appendChild(body);
			portWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
			call("pirate.recon", "ports", { target: ip }).then(function (res) {
				if (res.error) { clear(body).appendChild(alertEl("warn", res.error)); return; }
				var ports = res.ports || [];
				if (!ports.length) { clear(body).appendChild(el("p", { class: "muted", text: "No open ports in the top 100." })); return; }
				clear(body).appendChild(tableEl(["Port", "Proto", "Service"], ports.map(function (p) {
					return [el("strong", { text: String(p.port) }), p.proto || "-", p.service || "-"];
				})));
			}).catch(function (e) { clear(body).appendChild(alertEl("warn", String(e.message || e))); });
		}

		// Port & service scan profiles (nmap).
		var secProf = panel("Port & service scan");
		secProf.style.marginTop = "14px";
		var profTarget = el("input", { class: "inp", type: "text", placeholder: "host IP, name, or subnet (CIDR)" });
		var profSel = el("select", { class: "sel" },
			el("option", { value: "quick", text: "Quick — top 100 ports" }),
			el("option", { value: "top1000", text: "Top 1000 ports" }),
			el("option", { value: "ping", text: "Ping sweep (hosts up)" }));
		var profStatus = el("span", { class: "status" });
		var profWrap = el("div");
		secProf.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Target" }), profTarget),
			el("label", {}, el("span", { class: "lbl", text: "Profile" }), profSel)));
		secProf.appendChild(el("div", { class: "toolbar" }, btn("Run scan", { primary: true, onclick: runProfile }), profStatus));
		secProf.appendChild(profWrap);
		secProf.appendChild(el("p", { class: "descr", text:
			"nmap against a host you name or the joined subnet, logged to the card under recon/. Longer profiles take a while on this hardware." }));
		VIEW.appendChild(secProf);

		function runProfile() {
			if (!profTarget.value) { profStatus.textContent = "enter a target"; return; }
			profStatus.textContent = "scanning… (this can take a while)";
			clear(profWrap);
			call("pirate.recon", "scan", { profile: profSel.value, target: profTarget.value }).then(function (r) {
				profStatus.textContent = r.saved ? "saved " + r.saved : "";
				if (r.error) { profWrap.appendChild(alertEl("warn", r.error)); return; }
				var hosts = r.hosts || [];
				if (!hosts.length) { profWrap.appendChild(el("div", { class: "placeholder", text: "No results." })); return; }
				if (profSel.value === "ping") {
					profWrap.appendChild(tableEl(["Hosts up"], hosts.map(function (h) { return [el("code", { text: h.ip })]; })));
					return;
				}
				hosts.forEach(function (h) {
					profWrap.appendChild(el("h4", { class: "sub-h2", text: h.ip }));
					var ports = h.ports || [];
					if (!ports.length) { profWrap.appendChild(el("div", { class: "muted", text: "no open ports" })); return; }
					profWrap.appendChild(tableEl(["Port", "Proto", "Service"], ports.map(function (p) {
						return [el("strong", { text: String(p.port) }), p.proto || "-", p.service || "-"];
					})));
				});
			}).catch(function (e) {
				profStatus.textContent = "";
				if (String(e.message || e) === "unauthorized") return onError(e);
				profWrap.appendChild(alertEl("warn", String(e.message || e)));
			});
		}

		call("pirate.recon", "uplink").then(showUplink).catch(function () { showUplink(null); });
		call("pirate.recon", "hosts").then(fillTable).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(tableWrap).appendChild(alertEl("warn", String(e.message || e)));
		});
	}

	/* ---------- Wi-Fi Survey ---------- */

	function gpsText(g) {
		if (!g || g.installed === false) return "No GPS tools installed. Add a USB GPS and gpsd to tag sightings.";
		if (!g.running) return "No GPS plugged in. Plug in a USB GPS and gpsd starts by itself.";
		var where = g.device ? " on " + g.device : "";
		if (g.fix === "2D" || g.fix === "3D")
			return "GPS fix (" + g.fix + ")" + where + ": " + g.lat.toFixed(6) + ", " + g.lon.toFixed(6) +
				(g.sats_used != null ? " — " + g.sats_used + " of " + (g.sats || 0) + " satellites" : "");
		return "gpsd running" + where + " but no fix yet" + (g.sats != null ? " (" + g.sats + " satellites seen)" : "") + ".";
	}

	function renderSurvey() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Wi-Fi Survey", "a wardriving-style log of the access points heard"));

		var sec = panel();
		var status = el("span", { class: "status" });
		var scanBtn = btn("Scan now", { primary: true, onclick: doScan });
		var clearBtn = btn("Clear log", { cls: "reset", onclick: doClear });
		sec.appendChild(el("div", { class: "toolbar" }, scanBtn, clearBtn, status));
		var tableWrap = el("div");
		tableWrap.appendChild(el("div", { class: "muted", text: "Loading…" }));
		sec.appendChild(tableWrap);

		var secGps = panel("Location");
		secGps.style.marginTop = "14px";
		var gpsLine = el("p", { class: "muted", text: "Loading…" });
		secGps.appendChild(gpsLine);
		secGps.appendChild(btn("Refresh GPS", { onclick: refreshGps }));

		VIEW.appendChild(sec); VIEW.appendChild(secGps);

		function fill(data) {
			if (data && data.error) { clear(tableWrap).appendChild(alertEl("warn", data.error)); return; }
			var nets = (data && data.networks) || [];
			var hasGps = nets.some(function (n) { return n.lat != null; });
			if (!nets.length) { clear(tableWrap).appendChild(el("div", { class: "placeholder", html:
				"No networks logged yet. Click <b>Scan now</b>." })); status.textContent = ""; return; }
			var headers = ["SSID", "BSSID", "Ch", "Security", "Signal", "Seen", "Last"];
			if (hasGps) headers.push("Location");
			var rows = nets.map(function (n) {
				var cells = [
					n.ssid ? el("strong", { text: n.ssid }) : el("em", { class: "muted", text: "(hidden)" }),
					el("code", { text: n.bssid }),
					String(n.channel),
					badge(n.security || "?", secClass(n.security)),
					n.best_signal != null ? n.best_signal + " dBm" : "-",
					String(n.count),
					ago(n.last)
				];
				if (hasGps) cells.push(n.lat != null ? n.lat.toFixed(5) + ", " + n.lon.toFixed(5) : "-");
				return cells;
			});
			clear(tableWrap).appendChild(tableEl(headers, rows));
			status.textContent = (data && data.total != null) ? data.total + " networks logged" : "";
		}
		function doScan() {
			scanBtn.disabled = true; status.textContent = "scanning on a free radio…";
			call("pirate.recon", "survey_scan").then(function (res) {
				if (res.error) throw new Error(res.error);
				return Promise.all([
					call("pirate.recon", "survey_networks").then(fill),
					call("pirate.recon", "survey_gps").then(function (g) { clear(gpsLine).appendChild(document.createTextNode(gpsText(g))); })
				]);
			}).catch(function (e) { status.textContent = ""; clear(tableWrap).appendChild(alertEl("warn", String(e.message || e))); })
				.then(function () { scanBtn.disabled = false; });
		}
		function doClear() {
			call("pirate.recon", "survey_clear").then(function () {
				return call("pirate.recon", "survey_networks").then(fill);
			}).catch(function (e) { clear(tableWrap).appendChild(alertEl("warn", String(e.message || e))); });
		}
		function refreshGps() {
			call("pirate.recon", "survey_gps").then(function (g) {
				clear(gpsLine).appendChild(document.createTextNode(gpsText(g)));
			}).catch(function (e) { clear(gpsLine).appendChild(document.createTextNode(String(e.message || e))); });
		}

		call("pirate.recon", "survey_networks").then(fill).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(tableWrap).appendChild(alertEl("warn", String(e.message || e)));
		});
		refreshGps();
	}

	/* ---------- Threats ---------- */

	var THREAT_NAME = { evil_twin: "Evil twin", impersonation: "Impersonation", extra_bssid: "Extra access point" };

	function renderThreats() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Threats", "passive Wi-Fi threat detection — listen only"));

		var secRogue = panel("Rogue access points");
		secRogue.appendChild(el("p", { class: "descr", text:
			"Checks the access points the Wi-Fi Survey logged for an SSID advertised both open and secured (an evil twin), and for your own network names being impersonated." }));
		var rogueBtn = btn("Check now", { primary: true, onclick: checkRogue });
		secRogue.appendChild(el("div", { class: "toolbar" }, rogueBtn));
		var protLine = el("p", { class: "muted" });
		var rogueBox = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		secRogue.appendChild(protLine); secRogue.appendChild(rogueBox);

		var secDeauth = panel("Deauth watch");
		secDeauth.style.marginTop = "14px";
		secDeauth.appendChild(el("p", { class: "descr", text:
			"Listens on the 2.4 GHz monitor radio for the deauth/disassoc frames a jamming or handshake-capture attack floods the air with." }));
		var sel = el("select", { class: "sel" },
			el("option", { value: "15", text: "15 seconds" }),
			el("option", { value: "30", text: "30 seconds" }),
			el("option", { value: "60", text: "60 seconds" }));
		var deauthBtn = btn("Watch now", { onclick: function () { watchDeauth(sel.value); } });
		secDeauth.appendChild(el("div", { class: "toolbar" }, sel, deauthBtn));
		var deauthBox = el("div");
		secDeauth.appendChild(deauthBox);

		VIEW.appendChild(secRogue); VIEW.appendChild(secDeauth);

		function showRogue(data) {
			clear(protLine);
			if (data && data.protected && data.protected.length)
				protLine.textContent = "Protecting: " + data.protected.join(", ");
			clear(rogueBox);
			if (data && data.error) { rogueBox.appendChild(alertEl("warn", data.error)); return; }
			var threats = (data && data.threats) || [];
			if (!threats.length) {
				rogueBox.appendChild(alertEl("success",
					"No rogue access points in the " + ((data && data.total_networks) || 0) + " networks logged."));
				return;
			}
			threats.forEach(function (t) {
				var box = el("div", { class: "threat " + sevClass(t.severity) });
				box.appendChild(el("p", {}, badge((t.severity || "?").toUpperCase(), sevClass(t.severity)),
					document.createTextNode(" "), el("strong", { text: THREAT_NAME[t.type] || t.type }),
					document.createTextNode(" — "), el("strong", { text: t.ssid })));
				if (t.detail) box.appendChild(el("p", { class: "descr", text: t.detail }));
				box.appendChild(tableEl(["BSSID", "Security", "Signal", "Channel"], (t.bssids || []).map(function (b) {
					return [el("code", { text: b.bssid }), b.security || "-",
						b.signal != null ? b.signal + " dBm" : "-", "ch " + (b.channel != null ? b.channel : "?")];
				})));
				rogueBox.appendChild(box);
			});
		}
		function checkRogue() {
			rogueBtn.disabled = true;
			call("pirate.recon", "threats_rogue").then(showRogue)
				.catch(function (e) {
					if (String(e.message || e) === "unauthorized") return onError(e);
					clear(rogueBox).appendChild(alertEl("warn", String(e.message || e)));
				}).then(function () { rogueBtn.disabled = false; });
		}
		function watchDeauth(secs) {
			deauthBtn.disabled = true;
			clear(deauthBox).appendChild(el("p", {}, el("em", { text: "Listening for " + secs + " seconds…" })));
			call("pirate.recon", "threats_deauth", { secs: secs }).then(function (r) {
				clear(deauthBox);
				if (r.error) { deauthBox.appendChild(alertEl("warn", r.error)); return; }
				deauthBox.appendChild(r.alert
					? alertEl("danger", [badge("HIGH", "sev-high"), document.createTextNode(
						" Possible deauth attack: " + r.total + " frames in " + r.window_s + " s on channel " + r.channel + ".")])
					: alertEl("info", r.total + " deauth/disassoc frames in " + r.window_s + " s on channel " + r.channel + " — nothing unusual."));
				deauthBox.appendChild(el("p", { class: "descr", text: r.deauth + " deauthentication, " + r.disassoc + " disassociation." }));
				if ((r.sources || []).length)
					deauthBox.appendChild(tableEl(["Transmitter (SA)", "Frames"], r.sources.map(function (s) {
						return [el("code", { text: s.mac }), String(s.count)];
					})));
			}).catch(function (e) { clear(deauthBox).appendChild(alertEl("warn", String(e.message || e))); })
				.then(function () { deauthBtn.disabled = false; });
		}

		call("pirate.recon", "threats_rogue").then(showRogue).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(rogueBox).appendChild(alertEl("warn", String(e.message || e)));
		});
	}

	/* ---------- Radios & SDR ---------- */

	function renderSdr() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Radios & SDR", "receivers running on this router"));
		var host = location.hostname || "192.168.1.1";

		var jobsPanel = panel("Jobs");
		jobsPanel.appendChild(el("p", { class: "descr", text:
			"Each radio runs one job at a time. Hand a radio to another job and the service switches it over. A job starts when its radio is plugged in and stops when it is removed." }));
		var jobsWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		jobsPanel.appendChild(jobsWrap);
		var raw = el("details", { class: "raw" }, el("summary", { text: "Raw status" }));
		var rawPre = el("pre", { class: "raw-pre" });
		raw.appendChild(rawPre);
		jobsPanel.appendChild(raw);

		var ismPanel = panel("ISM sensors");
		ismPanel.style.marginTop = "14px";
		var ismStatus = el("p", { class: "descr" });
		var ismWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		ismPanel.appendChild(ismStatus); ismPanel.appendChild(ismWrap);

		var addrPanel = panel("Addresses");
		addrPanel.style.marginTop = "14px";
		var addrWrap = el("div");
		addrPanel.appendChild(addrWrap);

		VIEW.appendChild(jobsPanel); VIEW.appendChild(ismPanel); VIEW.appendChild(addrPanel);

		var jobsMap = {};
		function stateCls(s) { return s === "running" ? "sec-ok" : (s === "stopped" ? "sec-warn" : "sec-neutral"); }

		function fillAddresses() {
			function sb(job) {
				if (!job) return badge("always on", "sec-ok");
				var s = jobsMap[job] && jobsMap[job].state;
				if (s === "running") return badge("on", "sec-ok");
				if (s === "stopped") return badge("stopped", "sec-warn");
				if (s === "waiting") return badge("radio unplugged", "sec-neutral");
				if (s === "off") return badge("off", "sec-neutral");
				return badge("job " + job, "sec-neutral");
			}
			function fmt(s) { return s.replace("%s", host); }
			clear(addrWrap);
			addrWrap.appendChild(el("h4", { class: "sub-h2", text: "Web pages" }));
			addrWrap.appendChild(tableEl(["Page", "Address", "Runs when"], SDR_PAGES.map(function (p) {
				var u = fmt(p[1]);
				return [p[0], el("a", { href: u, target: "_blank", rel: "noopener", text: u }), sb(p[2])];
			})));
			addrWrap.appendChild(el("h4", { class: "sub-h2", text: "Connect from a computer" }));
			addrWrap.appendChild(tableEl(["Client", "Address", "Runs when"], SDR_CLIENTS.map(function (c) {
				return [c[0], el("code", { text: fmt(c[1]) }), sb(c[2])];
			})));
		}

		function fillJobs(status) {
			rawPre.textContent = status || "No answer from /cgi-bin/pirate-radio.";
			var jobs = parseJobs(status);
			jobsMap = {};
			jobs.forEach(function (j) { jobsMap[j.name] = j; });
			clear(jobsWrap);
			// "  note: ..." lines: a radio plugged in but in a mode it can't be used in.
			var note, noteRe = /^ {2}note: (.+)$/mg;
			while ((note = noteRe.exec(status || "")) !== null)
				jobsWrap.appendChild(alertEl("warn", note[1]));
			if (!jobs.length) {
				jobsWrap.appendChild(el("div", { class: "muted", text:
					"No job status reported (is pirate-radio installed on this device?)." }));
			} else {
				jobsWrap.appendChild(tableEl(["Job", "Radio", "Type", "State", ""], jobs.map(function (j) {
					var action = j.state === "running"
						? el("span", { class: "muted", text: "—" })
						: j.state === "waiting"
						? el("span", { class: "muted", text: "plug in " + (j.radio === "-" ? "an SDR" : "the " + j.radio) })
						: btn("Use " + j.radio, { cls: "small", onclick: function () { handTo(j.name); } });
					return [el("strong", { text: j.name }), j.radio, j.type, badge(j.state, stateCls(j.state)), action];
				})));
			}
			fillAddresses();
		}

		function handTo(job) {
			call("pirate.sdr", "use", { job: job }).then(function () {
				return fetchSdrStatus().then(fillJobs);
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				clear(jobsWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}

		function fillIsm(data) {
			if (data.error) { ismStatus.textContent = String(data.error); clear(ismWrap); return; }
			ismStatus.textContent = data.frequencies
				? "Listening on " + data.frequencies.map(mhz).join(", ") + ", switching every " + data.hop_interval + " s."
				: "";
			var devs = (data.devices || []).slice().sort(function (a, b) { return String(b.last).localeCompare(String(a.last)); });
			if (!devs.length) {
				clear(ismWrap).appendChild(el("div", { class: "placeholder", text: data.enabled
					? "Nothing decoded yet — rtl_433 hops bands, so give it a few minutes."
					: "Nothing decoded yet, and the ISM job is not running." }));
				return;
			}
			clear(ismWrap).appendChild(tableEl(["Device", "ID", "Latest readings", "Band", "Heard", "Last"], devs.map(function (d) {
				var rd = Object.keys(d.readings || {}).map(function (k) { return reading(k, d.readings[k]); }).join(", ") || "-";
				var idch = ((d.id != null) ? String(d.id) : "-") + ((d.channel != null) ? " / ch " + d.channel : "");
				return [el("strong", { text: String(d.model) }), idch, rd, (d.freq != null ? mhz(d.freq) : "-"), String(d.count), agoIsm(d.last)];
			})));
		}

		fetchSdrStatus().then(fillJobs);
		call("pirate.sdr", "devices").then(fillIsm).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			ismStatus.textContent = String(e.message || e);
		});
	}

	/* ---------- Router ---------- */

	function renderRouter() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Router", "the device itself and its network"));

		var sysPanel = panel("System");
		var sysWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		sysPanel.appendChild(sysWrap);

		var netPanel = panel("Internet");
		netPanel.style.marginTop = "14px";
		var netWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		netPanel.appendChild(netWrap);

		var cliPanel = panel("Clients");
		cliPanel.style.marginTop = "14px";
		var cliWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		cliPanel.appendChild(cliWrap);

		var adbPanel = panel("Ad blocking");
		adbPanel.style.marginTop = "14px";
		var adbWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		adbPanel.appendChild(adbWrap);

		VIEW.appendChild(sysPanel); VIEW.appendChild(netPanel);
		VIEW.appendChild(cliPanel); VIEW.appendChild(adbPanel);

		function kv(pairs) {
			var dl = el("dl", { class: "kv" });
			pairs.forEach(function (p) {
				if (p[1] == null || p[1] === "") return;
				dl.appendChild(el("dt", { text: p[0] }));
				dl.appendChild(el("dd", { text: String(p[1]) }));
			});
			return dl;
		}

		function fillSys(s) {
			var m = s.memory || {}, f = s.flash || {};
			clear(sysWrap).appendChild(kv([
				["Model", s.model],
				["Firmware", s.firmware],
				["Hostname", s.hostname],
				["Uptime", dur(s.uptime)],
				["Load", s.load],
				["RAM", m.total ? (mb(m.available != null ? m.available : m.free) + " MB free of " + mb(m.total) + " MB") : null],
				["Flash", f.total ? (mb(f.free) + " MB free of " + mb(f.total) + " MB") : null]
			]));
			setNetPill(!!s.online);
		}

		function fillNet(u, online) {
			if (!u || u.error) { clear(netWrap).appendChild(el("div", { class: "muted", text: "Not joined to a network." })); return; }
			clear(netWrap).appendChild(kv([
				["Network", u.ssid || "wired"],
				["Interface", u.iface],
				["Subnet", u.subnet],
				["Gateway", u.gateway ? (u.gateway + (u.gateway_mac ? " (" + u.gateway_mac + ")" : "")) : null],
				["Internet", online ? "reachable" : "no default route"]
			]));
		}

		function fillClients(data) {
			var list = (data && data.clients) || [];
			if (data && data.error) { clear(cliWrap).appendChild(alertEl("warn", data.error)); return; }
			if (!list.length) { clear(cliWrap).appendChild(el("div", { class: "placeholder", text: "No DHCP leases yet." })); return; }
			clear(cliWrap).appendChild(tableEl(["Host", "IP", "MAC"], list.map(function (c) {
				return [
					(c.host && c.host !== "-") ? el("strong", { text: c.host }) : el("em", { class: "muted", text: "(unknown)" }),
					el("code", { text: c.ip }), el("code", { text: c.mac })
				];
			})));
		}

		function fillAdb(a) {
			clear(adbWrap);
			if (a.error) { adbWrap.appendChild(alertEl("warn", a.error)); return; }
			if (!a.installed) { adbWrap.appendChild(el("div", { class: "muted", text: "Adblock is not installed in this image." })); return; }
			var on = !!a.enabled;
			adbWrap.appendChild(el("div", { class: "toolbar" },
				badge(on ? "on" : "off", on ? "sec-ok" : "sec-neutral"),
				el("span", { class: "status", text: a.domains ? a.domains.toLocaleString() + " domains blocked" : (on ? "enabled" : "disabled") }),
				btn(on ? "Disable" : "Enable", { cls: on ? "reset" : "", primary: !on, onclick: function () { toggleAdb(!on); } })));
		}
		function toggleAdb(to) {
			clear(adbWrap).appendChild(el("div", { class: "muted", text: to ? "Enabling…" : "Disabling…" }));
			call("pirate.router", "adblock", { enabled: to }).then(fillAdb).catch(function (e) {
				clear(adbWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}

		// Wi-Fi uplink
		var wifiPanel = panel("Wi-Fi uplink");
		wifiPanel.style.marginTop = "14px";
		var wifiStatus = el("div", { class: "muted", text: "Loading…" });
		var wifiScanWrap = el("div");
		var joinSsid = el("input", { class: "inp", type: "text", placeholder: "SSID" });
		var joinKey = el("input", { class: "inp", type: "password", placeholder: "password (blank if open)" });
		var joinStatus = el("span", { class: "status" });
		wifiPanel.appendChild(wifiStatus);
		wifiPanel.appendChild(el("div", { class: "toolbar" }, btn("Scan for networks", { onclick: wifiScan })));
		wifiPanel.appendChild(wifiScanWrap);
		wifiPanel.appendChild(el("h4", { class: "sub-h2", text: "Join a network" }));
		wifiPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "SSID" }), joinSsid),
			el("label", {}, el("span", { class: "lbl", text: "Password" }), joinKey)));
		wifiPanel.appendChild(el("div", { class: "toolbar" },
			btn("Join", { primary: true, onclick: function () { doJoin(joinSsid.value, "", joinKey.value); } }), joinStatus));
		wifiPanel.appendChild(el("p", { class: "descr", text:
			"Changing the uplink reloads Wi-Fi — the Pirate Radio AP drops briefly and comes back, so you stay reachable on it even if the new network is wrong." }));

		// Set root password
		var pwPanel = panel("Set root password");
		pwPanel.style.marginTop = "14px";
		var pw1 = el("input", { class: "inp", type: "password", placeholder: "new password" });
		var pw2 = el("input", { class: "inp", type: "password", placeholder: "confirm" });
		var pwStatus = el("span", { class: "status" });
		pwPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "New password" }), pw1),
			el("label", {}, el("span", { class: "lbl", text: "Confirm" }), pw2)));
		pwPanel.appendChild(el("div", { class: "toolbar" }, btn("Set password", { primary: true, onclick: setPassword }), pwStatus));
		pwPanel.appendChild(el("p", { class: "descr", text: "Sets the root password used for SSH and this UI's sign-in." }));

		VIEW.appendChild(wifiPanel); VIEW.appendChild(pwPanel);

		function showWifi(s) {
			clear(wifiStatus);
			if (!s || s.configured === false) { wifiStatus.appendChild(el("span", { class: "muted", text: "No uplink configured." })); return; }
			var ok = !!s.connected;
			wifiStatus.appendChild(badge(ok ? "connected" : "down", ok ? "sec-ok" : "sec-neutral"));
			wifiStatus.appendChild(document.createTextNode(" " + (s.ssid || s.live_ssid || "—") +
				(ok && s.signal ? "  ·  " + s.signal + " dBm" : "") + (s.encryption ? "  ·  " + s.encryption : "")));
		}
		function encLabel(e) { return e === "open" ? "open" : (e === "wpa3" ? "WPA3" : (e === "wep" ? "WEP" : "WPA2")); }
		function wifiScan() {
			clear(wifiScanWrap).appendChild(el("div", { class: "muted", text: "scanning…" }));
			call("pirate.router", "wifi_scan").then(function (r) {
				var nets = (r && r.networks) || [];
				nets.sort(function (a, b) { return (b.signal || -999) - (a.signal || -999); });
				if (!nets.length) { clear(wifiScanWrap).appendChild(el("div", { class: "placeholder", text: "No networks found." })); return; }
				clear(wifiScanWrap).appendChild(tableEl(["Network", "Ch", "Signal", "Security", ""], nets.map(function (n) {
					return [
						n.ssid ? el("strong", { text: n.ssid }) : el("em", { class: "muted", text: "(hidden)" }),
						String(n.channel || "-"),
						(n.signal ? n.signal + " dBm" : "-"),
						badge(encLabel(n.enc), n.enc === "open" ? "sec-open" : (n.enc === "wpa3" ? "sec-ok" : "sec-warn")),
						n.ssid ? btn("Use", { cls: "small", onclick: function () {
							joinSsid.value = n.ssid; joinKey.value = "";
							if (n.enc === "open") doJoin(n.ssid, "open", "");
							else { joinKey.focus(); joinStatus.className = "status"; joinStatus.textContent = "enter the password, then Join"; }
						} }) : ""
					];
				})));
			}).catch(function (e) { clear(wifiScanWrap).appendChild(alertEl("warn", String(e.message || e))); });
		}
		function doJoin(ssid, enc, key) {
			if (!ssid) { joinStatus.className = "status"; joinStatus.textContent = "enter an SSID"; return; }
			joinStatus.className = "status";
			joinStatus.textContent = "joining " + ssid + "… (Wi-Fi reloads)";
			call("pirate.router", "wifi_join", { ssid: ssid, enc: enc || "", key: key }).then(function (r) {
				if (r.error) { joinStatus.textContent = r.error; joinStatus.className = "status err"; return; }
				joinStatus.className = "status ok-text";
				joinStatus.textContent = "applied — joining " + r.ssid + " (" + r.encryption + "); give it a moment";
				setTimeout(function () { call("pirate.router", "wifi_status").then(showWifi).catch(function () {}); }, 6000);
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				joinStatus.textContent = String(e.message || e); joinStatus.className = "status err";
			});
		}
		function setPassword() {
			pwStatus.className = "status";
			if (pw1.value.length < 5) { pwStatus.textContent = "use at least 5 characters"; return; }
			if (pw1.value !== pw2.value) { pwStatus.textContent = "the two entries differ"; return; }
			pwStatus.textContent = "setting…";
			call("pirate.router", "set_password", { password: pw1.value }).then(function (r) {
				if (r.error) { pwStatus.textContent = r.error; pwStatus.className = "status err"; return; }
				pwStatus.className = "status ok-text"; pwStatus.textContent = "password set";
				pw1.value = ""; pw2.value = "";
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				pwStatus.textContent = String(e.message || e); pwStatus.className = "status err";
			});
		}

		call("pirate.router", "wifi_status").then(showWifi).catch(function () { clear(wifiStatus); });

		call("pirate.router", "status").then(function (s) {
			fillSys(s);
			return call("pirate.recon", "uplink").then(function (u) { fillNet(u, s.online); })
				.catch(function () { fillNet(null, s.online); });
		}).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(sysWrap).appendChild(alertEl("warn", String(e.message || e)));
			clear(netWrap);
		});
		call("pirate.router", "clients").then(fillClients).catch(function (e) {
			clear(cliWrap).appendChild(alertEl("warn", String(e.message || e)));
		});
		call("pirate.router", "adblock").then(fillAdb).catch(function (e) {
			clear(adbWrap).appendChild(alertEl("warn", String(e.message || e)));
		});
	}

	/* ---------- Capture ---------- */

	function renderCapture() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Capture", "passive packet capture to the microSD card"));

		var ctl = panel("New capture");
		var ifaceSel = el("select", { class: "sel" });
		var filterIn = el("input", { class: "inp", type: "text", placeholder: "optional BPF filter, e.g. port 53" });
		var nameIn = el("input", { class: "inp", type: "text", placeholder: "optional name" });
		var startBtn = btn("Start capture", { primary: true, onclick: doStart });
		var stopBtn = btn("Stop", { cls: "reset", onclick: doStop });
		var statusLine = el("div", { class: "status" });
		ctl.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Interface" }), ifaceSel),
			el("label", {}, el("span", { class: "lbl", text: "Filter" }), filterIn),
			el("label", {}, el("span", { class: "lbl", text: "Name" }), nameIn)));
		ctl.appendChild(el("div", { class: "toolbar" }, startBtn, stopBtn, statusLine));
		ctl.appendChild(el("p", { class: "descr", text:
			"Captures on an ordinary interface (no monitor mode, no transmit), size-rotated so it cannot fill the card." }));

		var filesPanel = panel("Saved captures");
		filesPanel.style.marginTop = "14px";
		var filesWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		filesPanel.appendChild(el("div", { class: "toolbar" }, btn("Refresh", { onclick: refresh })));
		filesPanel.appendChild(filesWrap);

		VIEW.appendChild(ctl); VIEW.appendChild(filesPanel);

		function fillIfaces(d) {
			clear(ifaceSel);
			((d && d.interfaces) || []).forEach(function (i) {
				ifaceSel.appendChild(el("option", { value: i.name,
					text: i.name + (i.state && i.state !== "up" ? " (" + i.state + ")" : "") }));
			});
		}
		function showStatus(s) {
			var running = s && s.running;
			startBtn.disabled = !!running;
			stopBtn.disabled = !running;
			if (running) {
				statusLine.textContent = "capturing on " + s.iface + (s.filter ? " [" + s.filter + "]" : "") +
					" — " + size(s.size) + ", " + dur(s.elapsed) + (s.file ? " — " + s.file : "");
				statusLine.className = "status ok-text";
			} else {
				statusLine.textContent = "idle";
				statusLine.className = "status";
			}
		}
		function fillFiles(d) {
			var list = (d && d.files) || [];
			if (!list.length) { clear(filesWrap).appendChild(el("div", { class: "placeholder", text: "No captures on the card yet." })); return; }
			clear(filesWrap).appendChild(tableEl(["File", "Size", "When"], list.map(function (f) {
				var url = "http://" + (location.hostname || "192.168.1.1") + ":8081/pirate-radio/capture/" + f.name;
				return [el("a", { href: url, target: "_blank", rel: "noopener", text: f.name }), size(f.size), f.mtime || ""];
			})));
		}
		function refresh() {
			call("pirate.capture", "status").then(showStatus).catch(function () {});
			call("pirate.capture", "list").then(fillFiles).catch(function (e) {
				clear(filesWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function doStart() {
			startBtn.disabled = true;
			call("pirate.capture", "start", { iface: ifaceSel.value, filter: filterIn.value, name: nameIn.value }).then(function (s) {
				if (s.error) { statusLine.textContent = s.error; statusLine.className = "status err"; startBtn.disabled = false; return; }
				showStatus(s); refresh();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				statusLine.textContent = String(e.message || e); statusLine.className = "status err"; startBtn.disabled = false;
			});
		}
		function doStop() {
			stopBtn.disabled = true;
			call("pirate.capture", "stop").then(function () { refresh(); }).catch(function (e) {
				statusLine.textContent = String(e.message || e); statusLine.className = "status err";
			});
		}

		call("pirate.capture", "interfaces").then(fillIfaces).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
		});
		refresh();
	}

	/* ---------- Handshake (passive) ---------- */

	function renderHandshake() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Handshake", "passive WPA handshake capture (monitor mode)"));
		VIEW.appendChild(alertEl("info",
			"Listen-only: a radio in monitor mode records the WPA 4-way handshake when a device reconnects on its own. It never transmits, deauthenticates, or forces a reconnection. For networks you own or are authorized to test — cracking happens offline on your computer."));

		var ctl = panel("New capture");
		ctl.style.marginTop = "14px";
		var radioSel = el("select", { class: "sel" });
		var chIn = el("input", { class: "inp", type: "number", min: "1", max: "196", placeholder: "channel, e.g. 6" });
		var nameIn = el("input", { class: "inp", type: "text", placeholder: "optional name" });
		var startBtn = btn("Start capture", { primary: true, onclick: doStart });
		var stopBtn = btn("Stop", { cls: "reset", onclick: doStop });
		var statusLine = el("div", { class: "status" });
		ctl.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Radio" }), radioSel),
			el("label", {}, el("span", { class: "lbl", text: "Channel" }), chIn),
			el("label", {}, el("span", { class: "lbl", text: "Name" }), nameIn)));
		ctl.appendChild(el("div", { class: "toolbar" }, startBtn, stopBtn, statusLine));

		var filesPanel = panel("Saved handshakes");
		filesPanel.style.marginTop = "14px";
		var filesWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		filesPanel.appendChild(el("div", { class: "toolbar" }, btn("Refresh", { onclick: refresh })));
		filesPanel.appendChild(filesWrap);

		VIEW.appendChild(ctl); VIEW.appendChild(filesPanel);

		function fillRadios(d) {
			clear(radioSel);
			var any = false;
			((d && d.radios) || []).forEach(function (r) {
				var o = el("option", { value: r.phy, text: r.phy + (r.monitor ? "" : " (no monitor)") });
				if (!r.monitor) o.disabled = true; else any = true;
				radioSel.appendChild(o);
			});
			if (!any) radioSel.appendChild(el("option", { value: "", text: "no monitor-capable radio" }));
		}
		function showStatus(s) {
			var running = s && s.running;
			startBtn.disabled = !!running;
			stopBtn.disabled = !running;
			if (running) {
				var hs = s.eapol >= 4 ? " — handshake likely (" + s.eapol + " EAPOL)"
					: (s.eapol ? " — " + s.eapol + " EAPOL frames" : " — waiting for a handshake…");
				statusLine.textContent = "listening on " + s.phy + " ch " + s.channel + " — " + size(s.size) + ", " + dur(s.elapsed) + hs;
				statusLine.className = "status " + (s.eapol >= 4 ? "ok-text" : "");
			} else {
				statusLine.textContent = "idle";
				statusLine.className = "status";
			}
		}
		function fillFiles(d) {
			var list = (d && d.files) || [];
			if (!list.length) { clear(filesWrap).appendChild(el("div", { class: "placeholder", text: "No handshakes captured yet." })); return; }
			clear(filesWrap).appendChild(tableEl(["File", "Size", "When"], list.map(function (f) {
				var url = "http://" + (location.hostname || "192.168.1.1") + ":8081/pirate-radio/handshake/" + f.name;
				return [el("a", { href: url, target: "_blank", rel: "noopener", text: f.name }), size(f.size), f.mtime || ""];
			})));
		}
		function refresh() {
			call("pirate.handshake", "status").then(showStatus).catch(function () {});
			call("pirate.handshake", "list").then(fillFiles).catch(function (e) {
				clear(filesWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function doStart() {
			startBtn.disabled = true;
			call("pirate.handshake", "start", { phy: radioSel.value, channel: chIn.value, name: nameIn.value }).then(function (s) {
				if (s.error) { statusLine.textContent = s.error; statusLine.className = "status err"; startBtn.disabled = false; return; }
				showStatus(s); refresh();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				statusLine.textContent = String(e.message || e); statusLine.className = "status err"; startBtn.disabled = false;
			});
		}
		function doStop() {
			stopBtn.disabled = true;
			call("pirate.handshake", "stop").then(function () { refresh(); }).catch(function (e) {
				statusLine.textContent = String(e.message || e); statusLine.className = "status err";
			});
		}

		call("pirate.handshake", "radios").then(fillRadios).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
		});
		refresh();
	}

	/* ---------- Firmware ---------- */

	function renderFirmware() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Firmware", "flash a new Pirate Radio image to this device"));

		var curPanel = panel("Current firmware");
		var curWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		curPanel.appendChild(curWrap);

		var flashPanel = panel("Flash new firmware");
		flashPanel.style.marginTop = "14px";
		flashPanel.appendChild(alertEl("info",
			"Upload a sysupgrade image, or fetch it by URL. It is checked against this device before anything is written — a flash never starts from an image that fails the check. If a flash ever goes wrong, hold the reset button at power-on for the GL.iNet U-Boot recovery page."));

		var fileIn = el("input", { class: "inp", type: "file", accept: ".bin,.img,application/octet-stream" });
		var urlIn = el("input", { class: "inp", type: "text", placeholder: "https://…/…-sysupgrade.bin" });
		var shaIn = el("input", { class: "inp", type: "text", placeholder: "expected sha256 (optional)" });
		flashPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Image file" }), fileIn),
			el("label", {}, el("span", { class: "lbl", text: "…or URL" }), urlIn),
			el("label", {}, el("span", { class: "lbl", text: "sha256" }), shaIn)));
		flashPanel.appendChild(el("div", { class: "toolbar" },
			btn("Upload image", { onclick: doUpload }), btn("Fetch by URL", { onclick: doFetch })));

		var stagedLine = el("div", { class: "status", text: "No image staged." });
		var keepChk = el("input", { type: "checkbox" }); keepChk.checked = true;
		var flashBtn = btn("Flash & reboot", { primary: true, cls: "reset", onclick: doApply });
		flashBtn.disabled = true;
		var clearBtn = btn("Discard image", { onclick: doClear });
		flashPanel.appendChild(stagedLine);
		flashPanel.appendChild(el("div", { class: "toolbar" },
			el("label", { class: "chkline" }, keepChk, document.createTextNode(" Keep current settings")),
			flashBtn, clearBtn));
		flashPanel.appendChild(el("p", { class: "descr", text:
			"Flashing reboots the device; it is unreachable for a minute or two. With settings kept, your Wi-Fi, uplink and password carry over." }));

		var bkPanel = panel("Back up configuration");
		bkPanel.style.marginTop = "14px";
		var bkStatus = el("span", { class: "status" });
		bkPanel.appendChild(el("div", { class: "toolbar" }, btn("Back up now", { onclick: doBackup }), bkStatus));
		bkPanel.appendChild(el("p", { class: "descr", text:
			"Writes a config archive to the device. Copy it off with scp for a spare — a kept-settings flash does not need it." }));

		VIEW.appendChild(curPanel); VIEW.appendChild(flashPanel); VIEW.appendChild(bkPanel);

		function kv(pairs) {
			var dl = el("dl", { class: "kv" });
			pairs.forEach(function (p) {
				if (p[1] == null || p[1] === "") return;
				dl.appendChild(el("dt", { text: p[0] }));
				dl.appendChild(el("dd", { text: String(p[1]) }));
			});
			return dl;
		}
		function showStaged(s) {
			clear(stagedLine);
			if (!s || !s.staged) { stagedLine.className = "status"; stagedLine.textContent = "No image staged."; flashBtn.disabled = true; return; }
			stagedLine.className = "status";
			stagedLine.appendChild(badge(s.verified ? "verified" : "not verified", s.verified ? "sec-ok" : "sec-warn"));
			stagedLine.appendChild(document.createTextNode(" " + size(s.staged_size) + " staged" + (s.verified ? " — ready to flash" : "")));
			flashBtn.disabled = !s.verified;
		}
		function showStatus(s) {
			clear(curWrap).appendChild(kv([
				["Model", s.model],
				["Firmware", s.firmware],
				["Staging free", s.staging_free ? mb(s.staging_free) + " MB" : null]
			]));
			showStaged(s);
		}
		function refresh() {
			return call("pirate.firmware", "status").then(showStatus).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				clear(curWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function verifyStaged() {
			stagedLine.className = "status"; stagedLine.textContent = "verifying…";
			return call("pirate.firmware", "verify").then(function (r) {
				if (!r.ok) { stagedLine.textContent = r.error || "verification failed"; stagedLine.className = "status err"; }
				return refresh();
			});
		}
		function uploadImage(f) {
			if (DEMO) { DEMO_FW.staged = true; DEMO_FW.size = f.size; DEMO_FW.verified = false; return Promise.resolve({ ok: true, size: f.size }); }
			return fetch("/cgi-bin/pirate-upload", { method: "PUT", body: f }).then(function (r) { return r.json(); });
		}
		function doUpload() {
			var f = fileIn.files && fileIn.files[0];
			if (!f) { stagedLine.className = "status err"; stagedLine.textContent = "choose an image file first"; return; }
			stagedLine.className = "status"; stagedLine.textContent = "uploading " + f.name + "…";
			uploadImage(f).then(function (r) {
				if (!r || !r.ok) { stagedLine.className = "status err"; stagedLine.textContent = (r && r.error) || "upload failed"; return; }
				return verifyStaged();
			}).catch(function (e) { stagedLine.className = "status err"; stagedLine.textContent = String(e.message || e); });
		}
		function doFetch() {
			if (!urlIn.value) { stagedLine.className = "status err"; stagedLine.textContent = "enter a URL"; return; }
			stagedLine.className = "status"; stagedLine.textContent = "fetching…";
			call("pirate.firmware", "fetch", { url: urlIn.value, sha256: shaIn.value }).then(function (r) {
				if (!r.ok) { stagedLine.className = "status err"; stagedLine.textContent = r.error || "download failed"; return; }
				return verifyStaged();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				stagedLine.className = "status err"; stagedLine.textContent = String(e.message || e);
			});
		}
		function doApply() {
			if (!window.confirm("Flash this image and reboot the Slate? It will be offline for a minute or two.")) return;
			flashBtn.disabled = true;
			call("pirate.firmware", "apply", { mode: keepChk.checked ? "keep" : "reset" }).then(function (r) {
				if (!r.ok) { stagedLine.className = "status err"; stagedLine.textContent = r.error || "flash refused"; flashBtn.disabled = false; return; }
				stagedLine.className = "status ok-text";
				stagedLine.textContent = "flashing now — the Slate is rebooting. Reload this page in a minute or two.";
			}).catch(function () {
				// sysupgrade tears the connection down as it reboots; that is expected.
				stagedLine.className = "status ok-text";
				stagedLine.textContent = "flashing — the Slate is rebooting. Reload this page in a minute or two.";
			});
		}
		function doClear() {
			call("pirate.firmware", "clear").then(function () { fileIn.value = ""; return refresh(); }).catch(function () {});
		}
		function doBackup() {
			bkStatus.className = "status"; bkStatus.textContent = "backing up…";
			call("pirate.firmware", "backup").then(function (r) {
				if (!r.ok) { bkStatus.className = "status err"; bkStatus.textContent = r.error || "backup failed"; return; }
				bkStatus.className = "status ok-text"; bkStatus.textContent = "saved " + r.file + " (" + size(r.size) + ")";
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				bkStatus.className = "status err"; bkStatus.textContent = String(e.message || e);
			});
		}

		refresh();
	}

	/* ---------- DreamPi ---------- */

	// dreampi's states: badge, badge class, what it means
	var DP_STATES = {
		"listening": ["ready", "sec-ok", "Playing a dial tone: dial from the Dreamcast."],
		"answering": ["answering", "sec-warn", "Heard the Dreamcast dial; answering."],
		"connected": ["online", "sec-ok", "The Dreamcast is online."],
		"hanging-up": ["hanging up", "sec-warn", "The call ended; resetting the modem."],
		"starting": ["starting", "sec-warn", "Starting the modem."],
		"no-modem": ["no modem", "sec-neutral", "Plug in a USB modem to answer the Dreamcast."],
		"off": ["off", "sec-neutral", "Answering is turned off."]
	};
	var DP_SERVICES = { ppp: "DreamPi servers", dcnet: "DCNet" };
	var DP_TIMER = null;

	function renderDreampi() {
		clear(VIEW);
		VIEW.appendChild(viewHead("DreamPi", "a Dreamcast online through a USB modem"));

		var stPanel = panel("Status");
		var stWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		stPanel.appendChild(stWrap);

		var setPanel = panel("Settings");
		setPanel.style.marginTop = "14px";
		var svcSel = el("select", { class: "sel" },
			el("option", { value: "ppp", text: "DreamPi servers (PPP on the Slate)" }),
			el("option", { value: "dcnet", text: "DCNet (Flycast's network)" }));
		var enChk = el("input", { type: "checkbox" });
		var toneChk = el("input", { type: "checkbox" });
		var nowChk = el("input", { type: "checkbox" });
		var dmzChk = el("input", { type: "checkbox" });
		var dmzNote = el("p", { class: "descr" });
		var saveStatus = el("span", { class: "status" });
		var setWrap = el("div", { hidden: "" });
		setWrap.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Calls go to" }), svcSel)));
		setWrap.appendChild(el("div", { class: "toolbar" },
			el("label", { class: "chkline" }, enChk, document.createTextNode(" Answer the Dreamcast")),
			el("label", { class: "chkline" }, toneChk, document.createTextNode(" Dial tone")),
			el("label", { class: "chkline" }, nowChk, document.createTextNode(" Dreamcast Now")),
			el("label", { class: "chkline" }, dmzChk, document.createTextNode(" DMZ"))));
		setWrap.appendChild(el("div", { class: "toolbar" }, btn("Save", { primary: true, onclick: save }), saveStatus));
		setWrap.appendChild(el("p", { class: "descr", text:
			"Dial *69 before the number to send one call to DCNet. Turn the dial tone off only for a Dreamcast set to blind dial. " +
			"Dreamcast Now lists what you play on dreamcast.online/now; during PPP calls it sends a hash of this router's MAC address " +
			"and of the game server names the Dreamcast looks up." }));
		setWrap.appendChild(dmzNote);
		setPanel.appendChild(setWrap);

		var nowPanel = panel("Dreamcast Now");
		nowPanel.style.marginTop = "14px";
		var nowLine = el("div", { class: "status", text: "Loading…" });
		var nameIn = el("input", { class: "inp", type: "text", maxlength: "40", placeholder: "your name on the list" });
		var nameStatus = el("span", { class: "status" });
		var asIn = el("input", { class: "inp", type: "text", placeholder: "B8:27:EB:12:34:56, or the 64-digit id" });
		var asStatus = el("span", { class: "status" });
		var host = location.hostname || "the Slate";
		nowPanel.appendChild(nowLine);
		nowPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Name" }), nameIn)));
		nowPanel.appendChild(el("div", { class: "toolbar" }, btn("Set name", { primary: true, onclick: setName }), nameStatus));
		nowPanel.appendChild(el("p", { class: "descr", text:
			"During PPP calls the Slate reports to Dreamcast Now as a DreamPi does, and the site works out the game from the " +
			"servers the Dreamcast looks up. The name is public there, and one name belongs to one Dreamcast; until one is set, " +
			"the site shows \"Unnamed_\" and an id." }));
		nowPanel.appendChild(el("h4", { class: "sub-h2", text: "Report as your DreamPi" }));
		nowPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "DreamPi's MAC address or id" }), asIn)));
		nowPanel.appendChild(el("div", { class: "toolbar" }, btn("Use", { onclick: setAs }),
			btn("Back to this router's own", { cls: "reset", onclick: function () { asIn.value = ""; setAs(); } }), asStatus));
		nowPanel.appendChild(el("p", { class: "descr", text:
			"To carry on as the DreamPi you had (its name, picture and history), give its MAC address, or the id " +
			"dreamcast.online/now/configure/ shows for it while it's on your network." }));
		nowPanel.appendChild(el("p", { class: "descr", text:
			"The site's own configure page works with the Slate too, as with a DreamPi: open " +
			"dreamcast.online/now/configure/ on a computer on the Slate's network. It looks for dreampi.local; if your browser " +
			"doesn't find it, enter " + host + ". Browsers may ask before letting a website reach a device on your network." }));

		var howPanel = panel("Connecting the Dreamcast");
		howPanel.style.marginTop = "14px";
		howPanel.appendChild(el("p", { class: "descr", text:
			"Dreamcast modem → line voltage inducer → USB voice modem (a DreamPi's: Conexant RD02-D400 / Dell NW147, Zoom 3095, …) → " +
			"the Slate's USB port, through a hub if an SDR is plugged in too. The Slate plays the dial tone and answers; no phone line is involved." }));
		howPanel.appendChild(el("p", { class: "descr", text:
			"On the Dreamcast, set up the ISP as for a DreamPi: any phone number, any user name and password, DNS automatic. " +
			"DCNet works with DCNet-patched games." }));

		var logPanel = panel("Recent log");
		logPanel.style.marginTop = "14px";
		var logPre = el("pre", { class: "raw-pre", text: "Loading…" });
		logPanel.appendChild(el("div", { class: "toolbar" }, btn("Refresh", { onclick: refresh })));
		logPanel.appendChild(logPre);

		VIEW.appendChild(stPanel); VIEW.appendChild(setPanel); VIEW.appendChild(nowPanel);
		VIEW.appendChild(howPanel); VIEW.appendChild(logPanel);

		function kv(pairs) {
			var dl = el("dl", { class: "kv" });
			pairs.forEach(function (p) {
				if (p[1] == null || p[1] === "") return;
				dl.appendChild(el("dt", { text: p[0] }));
				dl.appendChild(el("dd", { text: String(p[1]) }));
			});
			return dl;
		}
		function showStatus(s) {
			clear(stWrap);
			if (!s.installed) { stWrap.appendChild(el("div", { class: "muted", text: "DreamPi is not installed in this image." })); return; }
			var st = DP_STATES[s.state] || [s.state, "sec-neutral", ""];
			var m = (s.modems || [])[0];
			var inCall = s.state === "answering" || s.state === "connected";
			stWrap.appendChild(el("div", { class: "toolbar" }, badge(st[0], st[1]), el("span", { class: "status", text: st[2] })));
			stWrap.appendChild(kv([
				["Modem", m ? m.name + " — " + m.device + " (" + m.id + ")" : "none plugged in"],
				["Call", inCall ? (s.number || "?") + " · " + (DP_SERVICES[s.call_service] || s.call_service) +
					(s.since ? " · " + dur(Date.now() / 1000 - s.since) : "") : null],
				// rx on the router's end of the link is what the Dreamcast sent
				["PPP link", s.link ? s.dreamcast_ip + " ⇄ " + s.local_ip + " · " + size(s.rx_bytes) + " up, " +
					size(s.tx_bytes) + " down" : null],
				["Last lookup", s.link ? s.lookup : null],
				["Calls go to", DP_SERVICES[s.service] || s.service]
			]));
			showListing(s.dcnow_name, s.dcnow, s.dcnow_id, s.dcnow_as_dreampi);
			// The form follows the saved settings until it is shown
			if (setWrap.hidden) {
				svcSel.value = s.service;
				enChk.checked = !!s.enabled; toneChk.checked = !!s.dial_tone; nowChk.checked = !!s.dcnow;
				dmzChk.checked = !!s.dmz;
				setWrap.hidden = false;
			}
			dmzNote.textContent = "DMZ, which DreamPi's guides advise for games that take incoming connections: everything that " +
				"comes in from the internet unasked goes to the Dreamcast, none of it to the Slate. If the Slate is behind another " +
				"router, make " + (s.wan_ip ? "the Slate (" + s.wan_ip + " there)" : "the Slate") + " that router's DMZ host too.";
		}
		function showLog(r) {
			var lines = (r && r.lines) || [];
			logPre.textContent = lines.length ? lines.join("\n") : "Nothing logged yet.";
		}
		// The name as the site has it, once fetched; until then the last one set here
		var siteName = null;
		var listedId = "";
		function showListing(name, on, id, asPi) {
			if (siteName) name = siteName;
			if (id) listedId = id;
			clear(nowLine);
			if (!name) { nowLine.textContent = "Loading…"; return; }
			nowLine.appendChild(document.createTextNode((on === false ? "Reporting is off. " : "") + "Listed as "));
			nowLine.appendChild(el("strong", { text: name }));
			nowLine.appendChild(document.createTextNode(" on "));
			nowLine.appendChild(el("a", { href: "https://dreamcast.online/now/", target: "_blank", rel: "noopener", text: "dreamcast.online/now" }));
			if (listedId) nowLine.appendChild(document.createTextNode(" (id " + listedId.slice(0, 6) + "…" +
				(asPi ? ", as your DreamPi" : "") + ")"));
			if (!nameIn.value) nameIn.value = /^Unnamed_/.test(name) ? "" : name;
		}
		function setAs() {
			asStatus.className = "status"; asStatus.textContent = "switching…";
			call("pirate.dreampi", "dcnow_id", { id: asIn.value.trim() }).then(function (r) {
				if (r.error && !r.id) { asStatus.className = "status err"; asStatus.textContent = r.error; return; }
				siteName = r.name || null; listedId = r.id || ""; nameIn.value = "";
				asStatus.className = "status ok-text";
				asStatus.textContent = r.name ? "now listed as " + r.name : "switched; " + (r.error || "");
				status();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				asStatus.className = "status err"; asStatus.textContent = String(e.message || e);
			});
		}
		function setName() {
			nameStatus.className = "status"; nameStatus.textContent = "setting…";
			call("pirate.dreampi", "dcnow_name", { name: nameIn.value.trim() }).then(function (r) {
				if (r.error) { nameStatus.className = "status err"; nameStatus.textContent = r.error; return; }
				siteName = r.name;
				nameStatus.className = "status ok-text"; nameStatus.textContent = "listed as " + r.name;
				status();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				nameStatus.className = "status err"; nameStatus.textContent = String(e.message || e);
			});
		}
		function status() {
			return call("pirate.dreampi", "status").then(showStatus).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				clear(stWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function refresh() {
			status();
			call("pirate.dreampi", "log").then(showLog).catch(function (e) { logPre.textContent = String(e.message || e); });
		}
		function save() {
			saveStatus.className = "status"; saveStatus.textContent = "saving…";
			call("pirate.dreampi", "set", { enabled: enChk.checked, service: svcSel.value,
				dial_tone: toneChk.checked, dcnow: nowChk.checked, dmz: dmzChk.checked }).then(function (r) {
				if (r.error) { saveStatus.className = "status err"; saveStatus.textContent = r.error; return; }
				saveStatus.className = "status ok-text"; saveStatus.textContent = "saved";
				showStatus(r);
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				saveStatus.className = "status err"; saveStatus.textContent = String(e.message || e);
			});
		}

		// The state changes as the Dreamcast calls: keep it current while
		// this page is open.
		if (DP_TIMER) clearInterval(DP_TIMER);
		DP_TIMER = setInterval(function () {
			if (current !== "dreampi") { clearInterval(DP_TIMER); DP_TIMER = null; return; }
			status();
		}, 5000);
		refresh();
		// The site's current name, which may have been set elsewhere
		call("pirate.dreampi", "dcnow").then(function (r) {
			if (r.name) { siteName = r.name; nameIn.value = ""; showListing(r.name, null, r.id); }
		}).catch(function () {});
	}

	/* ---------- Drives (USB flash drives and disks) ---------- */

	var USB_TIMER = null;

	function renderDrives() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Drives", "USB flash drives and disks, shared while plugged in; the microSD card too, if you choose"));

		var drPanel = panel("Plugged in");
		var drWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		drPanel.appendChild(drWrap);

		// The file browser, for the drive being browsed
		var fbPanel = panel(null);
		fbPanel.style.marginTop = "14px";
		fbPanel.hidden = true;
		var fbHead = el("h3", { class: "sub-h" });
		var fbCrumbs = el("div", { class: "crumbs" });
		var fbWrap = el("div");
		fbPanel.appendChild(fbHead); fbPanel.appendChild(fbCrumbs); fbPanel.appendChild(fbWrap);

		var shPanel = panel("Network share");
		shPanel.style.marginTop = "14px";
		var shState = el("div", { class: "toolbar" });
		var shAccess = el("p", { class: "descr" });
		var enChk = el("input", { type: "checkbox" });
		var cardChk = el("input", { type: "checkbox" });
		var enStatus = el("span", { class: "status" });
		var enLine = el("label", { class: "chkline" }, enChk, document.createTextNode(" Share the drives on the network (SMB)"));
		var cardNote = el("p", { class: "descr" });
		var pw1 = el("input", { class: "inp", type: "password", autocomplete: "new-password", placeholder: "at least 5 characters" });
		var pw2 = el("input", { class: "inp", type: "password", autocomplete: "new-password", placeholder: "again" });
		var pwStatus = el("span", { class: "status" });
		var pwClear = btn("Remove the password", { cls: "reset", onclick: function () { setPassword(""); } });
		var shOpts = el("div", {},
			el("div", { class: "toolbar" }, enLine,
				el("label", { class: "chkline" }, cardChk, document.createTextNode(" Share the microSD card too")),
				btn("Save", { onclick: saveEnabled }), enStatus),
			cardNote);
		var shForm = el("div", { hidden: "" });
		shForm.appendChild(el("h4", { class: "sub-h2", text: "Share password" }));
		shForm.appendChild(shAccess);
		shForm.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "New password" }), pw1),
			el("label", {}, el("span", { class: "lbl", text: "Retype it" }), pw2)));
		shForm.appendChild(el("div", { class: "toolbar" },
			btn("Set password", { primary: true, onclick: function () { setPassword(null); } }), pwClear, pwStatus));
		var shMissing = el("div", { class: "muted", hidden: "", text:
			"This firmware has no SMB server (ksmbd): drives show here, but not on the network." });
		shPanel.appendChild(shState); shPanel.appendChild(shOpts); shPanel.appendChild(shForm); shPanel.appendChild(shMissing);

		var howPanel = panel("Connecting");
		howPanel.style.marginTop = "14px";
		var howWrap = el("div");
		howPanel.appendChild(howWrap);

		VIEW.appendChild(drPanel); VIEW.appendChild(fbPanel); VIEW.appendChild(shPanel); VIEW.appendChild(howPanel);

		var last = null;          // the last status
		var browsing = null;      // { name, path } of the folder on show
		var formSet = false;
		var webHost = location.hostname || "192.168.1.1";

		function smbHost(s) { return String(s.host || "pirateradio").toLowerCase() + ".local"; }
		function fileUrl(port, name, path) {
			var parts = [name].concat(path ? path.split("/") : []);
			return "http://" + webHost + ":" + port + "/" + parts.map(encodeURIComponent).join("/");
		}
		function failed(e) {
			if (String(e.message || e) === "unauthorized") { onError(e); return true; }
			return false;
		}

		function meter(used, total) {
			var pct = total ? Math.min(100, Math.round(used * 100 / total)) : 0;
			var m = el("div", { class: "meter" + (pct >= 90 ? " full" : "") });
			var fill = el("span");
			fill.style.width = pct + "%";
			m.appendChild(fill);
			return m;
		}
		function driveCard(d, s) {
			var card = el("div", { class: "drive" });
			var head = el("div", { class: "drive-head" },
				el("strong", { text: d.name }),
				d.card ? badge("microSD", "sec-ok") : null,
				badge(d.fs || "?", "sec-neutral"),
				d.readonly ? badge("read-only", "sec-warn") : null,
				el("span", { class: "muted", text: d.model || "" }));
			card.appendChild(head);
			card.appendChild(meter(d.used, d.size));
			card.appendChild(el("div", { class: "status", text:
				gb(d.free) + " free of " + gb(d.size) + " · " + d.device }));
			var pairs = [];
			if (s.installed && s.enabled) {
				pairs.push(["Windows", "\\\\" + smbHost(s) + "\\" + d.name]);
				pairs.push(["macOS, Linux", "smb://" + smbHost(s) + "/" + d.name]);
			}
			if (pairs.length) {
				var dl = el("dl", { class: "kv" });
				pairs.forEach(function (p) { dl.appendChild(el("dt", { text: p[0] })); dl.appendChild(el("dd", { text: p[1] })); });
				card.appendChild(dl);
			}
			var ejStatus = el("span", { class: "status" });
			card.appendChild(el("div", { class: "toolbar drive-actions" },
				btn("Browse", { primary: true, onclick: function () { browse(d.name, ""); } }),
				el("a", { class: "btn", href: fileUrl(s.http_port || 8082, d.name, "") + "/", target: "_blank", rel: "noopener",
					text: "Open in a new tab" }),
				// The card stays in: "Share the microSD card too" takes it off the list
				d.card ? null : btn("Eject", { onclick: function () { eject(d, ejStatus); } }),
				ejStatus));
			return card;
		}
		var shown = "";
		function showStatus(s) {
			// Polled every few seconds: redraw only when something changed
			var key = JSON.stringify(s);
			if (key === shown) return;
			shown = key;
			last = s;
			var drives = s.drives || [];
			clear(drWrap);
			if (!drives.length) {
				drWrap.appendChild(el("div", { class: "placeholder" },
					el("b", { text: "No drive plugged in" }),
					el("div", { class: "muted", text: "Plug a USB flash drive or disk into the router's USB port (through a hub " +
						"if something else is plugged in). It shows up here, and on the network, within a few seconds." })));
			} else {
				drives.forEach(function (d) { drWrap.appendChild(driveCard(d, s)); });
				drWrap.appendChild(el("p", { class: "descr", text:
					"Eject a drive before pulling it out: it is written to as you use it. FAT32, exFAT, NTFS and ext4 work." +
					(drives.some(function (d) { return d.card; }) ? " The microSD card can't be ejected here: turn off sharing it first." : "") }));
			}
			// The drive being browsed went away
			if (browsing && !drives.some(function (d) { return d.name === browsing.name; })) {
				browsing = null; fbPanel.hidden = true;
			}

			clear(shState);
			shMissing.hidden = !!s.installed;
			shForm.hidden = !s.installed;
			enLine.hidden = !s.installed;
			// The checkboxes follow the saved settings until they are first shown
			if (!formSet) { enChk.checked = !!s.enabled; cardChk.checked = !!s.card; formSet = true; }
			cardNote.textContent = "The microSD card holds Pirate Radio's recordings and captures, Wi-Fi handshakes " +
				"included: share it only with a password set, or on a network you trust. Shared, it shows here as " +
				"microSD, alongside the drives." + (s.card && !s.card_in ? " No card is in the slot right now." : "");
			if (s.installed) {
				var st = !s.enabled ? ["off", "sec-neutral", "Sharing is turned off; the drives show only here."] :
					s.sharing ? ["sharing", "sec-ok", "On the network as " + smbHost(s) + "."] :
					["idle", "sec-neutral", "Starts when a drive is plugged in."];
				shState.appendChild(badge(st[0], st[1]));
				shState.appendChild(el("span", { class: "status", text: st[2] }));
				shAccess.textContent = s.password ?
					"Password-protected: sign in as \"" + s.user + "\" with the share password. Set a new one below, " +
					"or remove it to let anyone on the network in." :
					"No password: anyone on the router's network can read and write the drives. Windows 11 refuses " +
					"to connect without one: set a password, and sign in as \"" + s.user + "\" with it.";
				pwClear.hidden = !s.password;
			}

			clear(howWrap);
			var h = smbHost(s);
			howWrap.appendChild(el("p", { class: "descr", text:
				"Windows: in File Explorer's address bar, type \\\\" + h + " (the router also appears under Network). " +
				"macOS: Finder → Go → Connect to Server → smb://" + h + ". Android and iOS: a file manager's " +
				"\"connect to server\" (SMB) with " + h + "." }));
			howWrap.appendChild(el("p", { class: "descr", text:
				"\"Open in a new tab\" and the files below open from the router (port " + (s.http_port || 8082) + "), " +
				"which asks for the router's sign-in: root and its password. Only the router's own network reaches the " +
				"drives; nothing is shared to the internet." }));
		}

		function crumbsFor(name, path) {
			clear(fbCrumbs);
			var parts = path ? path.split("/") : [];
			var link = function (label, p) {
				return el("button", { type: "button", class: "linkbtn", text: label, onclick: function () { browse(name, p); } });
			};
			fbCrumbs.appendChild(link(name, ""));
			parts.forEach(function (seg, i) {
				fbCrumbs.appendChild(el("span", { class: "muted", text: " / " }));
				var p = parts.slice(0, i + 1).join("/");
				fbCrumbs.appendChild(i === parts.length - 1 ? el("span", { text: seg }) : link(seg, p));
			});
		}
		function when(t) {
			if (!t) return "";
			var d = new Date(t * 1000);
			function two(n) { return (n < 10 ? "0" : "") + n; }
			return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
		}
		function browse(name, path) {
			browsing = { name: name, path: path };
			fbPanel.hidden = false;
			fbHead.textContent = "Files on " + name;
			crumbsFor(name, path);
			clear(fbWrap).appendChild(el("div", { class: "muted", text: "Loading…" }));
			call("pirate.usb", "list", { name: name, path: path }).then(function (r) {
				if (!browsing || browsing.name !== name || browsing.path !== path) return;
				if (r.error) { clear(fbWrap).appendChild(alertEl("warn", r.error)); return; }
				var list = r.entries || [];
				var port = (last && last.http_port) || 8082;
				clear(fbWrap);
				if (!list.length) { fbWrap.appendChild(el("div", { class: "placeholder", text: "This folder is empty." })); return; }
				var rows = [];
				if (r.path) {
					var up = r.path.split("/").slice(0, -1).join("/");
					rows.push([el("button", { type: "button", class: "linkbtn", text: "↑ up", onclick: function () { browse(name, up); } }), "", ""]);
				}
				list.forEach(function (f) {
					var p = r.path ? r.path + "/" + f.name : f.name;
					rows.push([
						f.dir ? el("button", { type: "button", class: "linkbtn", text: f.name + "/", onclick: function () { browse(name, p); } })
							: el("a", { href: fileUrl(port, name, p), target: "_blank", rel: "noopener", text: f.name }),
						f.dir ? "" : size(f.size),
						when(f.mtime)
					]);
				});
				fbWrap.appendChild(tableEl(["Name", "Size", "Modified"], rows));
				if (r.truncated) fbWrap.appendChild(el("p", { class: "descr", text:
					"Showing the first " + list.length + " of " + r.total + " entries; open the folder in a new tab, or over the network, for all of them." }));
			}).catch(function (e) {
				if (failed(e)) return;
				clear(fbWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}

		function eject(d, line) {
			if (!window.confirm("Eject " + d.name + "? It stops being shared and is safe to pull out; plug it in again to use it.")) return;
			line.className = "status"; line.textContent = "ejecting…";
			call("pirate.usb", "eject", { name: d.name }).then(function (r) {
				if (r.error) { line.className = "status err"; line.textContent = r.error; return; }
				line.className = "status ok-text"; line.textContent = "ejected: safe to pull out";
				if (browsing && browsing.name === d.name) { browsing = null; fbPanel.hidden = true; }
				setTimeout(status, 800);
			}).catch(function (e) {
				if (failed(e)) return;
				line.className = "status err"; line.textContent = String(e.message || e);
			});
		}
		function saveEnabled() {
			enStatus.className = "status"; enStatus.textContent = "saving…";
			call("pirate.usb", "set", { enabled: enChk.checked, card: cardChk.checked }).then(function (r) {
				if (r.error) { enStatus.className = "status err"; enStatus.textContent = r.error; return; }
				enStatus.className = "status ok-text"; enStatus.textContent = "saved";
				showStatus(r);
			}).catch(function (e) {
				if (failed(e)) return;
				enStatus.className = "status err"; enStatus.textContent = String(e.message || e);
			});
		}
		// pw: null takes the form's; "" removes the password
		function setPassword(pw) {
			var bad = function (msg) { pwStatus.className = "status err"; pwStatus.textContent = msg; };
			if (pw === null) {
				if (pw1.value.length < 5) return bad("use at least 5 characters");
				if (pw1.value !== pw2.value) return bad("the two entries differ");
				pw = pw1.value;
			} else if (!window.confirm("Remove the share password? Anyone on the network can then read and write the drives.")) {
				return;
			}
			pwStatus.className = "status"; pwStatus.textContent = "saving…";
			call("pirate.usb", "set_password", { password: pw }).then(function (r) {
				if (r.error) return bad(r.error);
				pw1.value = ""; pw2.value = "";
				pwStatus.className = "status ok-text";
				pwStatus.textContent = r.password ? "password set" : "password removed";
				showStatus(r);
			}).catch(function (e) {
				if (failed(e)) return;
				bad(String(e.message || e));
			});
		}
		function status() {
			return call("pirate.usb", "status").then(showStatus).catch(function (e) {
				if (failed(e)) return;
				clear(drWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}

		// Drives come and go as they're plugged in and pulled out: keep the
		// page current while it is open.
		if (USB_TIMER) clearInterval(USB_TIMER);
		USB_TIMER = setInterval(function () {
			if (current !== "drives") { clearInterval(USB_TIMER); USB_TIMER = null; return; }
			status();
		}, 4000);
		status();
	}

	/* ---------- Flipper (a Flipper Zero on the USB port; pirate-flipper) ---------- */

	var FZ_TIMER = null, FZ_RUN = 0;
	var FZ_KEYBOARD = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
		Enter: "ok", " ": "ok", Backspace: "back", Escape: "back" };
	// The screen's backlight and its pixels
	var FZ_BG = [254, 138, 44], FZ_FG = [24, 14, 4];

	function renderFlipper() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Flipper", "a Flipper Zero on the USB port: its screen and buttons, its files"));
		var run = ++FZ_RUN;   // this page's loops stop once it is left, or drawn again
		function alive() { return run === FZ_RUN && current === "flipper"; }
		function failed(e) {
			if (String(e.message || e) === "unauthorized") { onError(e); return true; }
			return false;
		}
		function say(line, text, kind) {
			line.className = "status" + (kind === "err" ? " err" : kind === "ok" ? " ok-text" : "");
			line.textContent = text;
		}

		/* The Flipper itself */
		var devPanel = panel("Flipper Zero");
		var devWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		var actStatus = el("span", { class: "status" });
		var devActs = el("div", { class: "toolbar", hidden: "" },
			btn("Beep and blink", { onclick: findIt }),
			btn("Set its clock to this computer's", { onclick: setClock }),
			btn("Restart it", { onclick: restart }),
			btn("All details", { onclick: details }),
			actStatus);
		var detWrap = el("div", { hidden: "" });
		devPanel.appendChild(devWrap); devPanel.appendChild(devActs); devPanel.appendChild(detWrap);

		/* Its screen and buttons */
		var scrPanel = panel("Screen");
		scrPanel.style.marginTop = "14px";
		scrPanel.hidden = true;
		var canvas = el("canvas", { class: "fz-screen", width: "128", height: "64", tabindex: "0",
			"aria-label": "The Flipper's screen. With it selected, the arrow keys, Enter and Backspace press its buttons." });
		var g = canvas.getContext("2d");
		var img = g.createImageData(128, 64);
		var scrStatus = el("span", { class: "status", text: "waiting for the screen…" });
		var pad = el("div", { class: "fz-pad" });
		scrPanel.appendChild(el("div", { class: "fz-wrap" }, el("div", { class: "fz-lcd" }, canvas), pad));
		scrPanel.appendChild(el("div", { class: "toolbar" }, btn("Save a screenshot", { onclick: screenshot }), scrStatus));
		scrPanel.appendChild(el("p", { class: "descr", text:
			"Press the buttons here, or click the screen and use the arrow keys, Enter (OK) and Backspace or Esc (Back). " +
			"Hold a button for a long press." }));

		/* Its files */
		var fPanel = panel("Files");
		fPanel.style.marginTop = "14px";
		fPanel.hidden = true;
		var fStatus = el("span", { class: "status" });
		var upInput = el("input", { type: "file", multiple: "", hidden: "" });
		var upBtn = btn("Upload files", { primary: true, onclick: function () { upInput.click(); } });
		var mkBtn = btn("New folder", { onclick: newFolder });
		var fCrumbs = el("div", { class: "crumbs" });
		var fWrap = el("div");
		upInput.addEventListener("change", function () {
			var files = Array.prototype.slice.call(upInput.files || []);
			upInput.value = "";
			if (files.length) uploadAll(files);
		});
		fPanel.appendChild(el("div", { class: "toolbar" }, upBtn, mkBtn,
			btn("Refresh", { onclick: function () { browse(path); } }), fStatus, upInput));
		fPanel.appendChild(fCrumbs);
		fPanel.appendChild(fWrap);
		fPanel.appendChild(el("p", { class: "descr", text:
			"ext is the Flipper's SD card, int its own storage. File names are plain ASCII; downloads are 8 MB at most." }));

		VIEW.appendChild(devPanel); VIEW.appendChild(scrPanel); VIEW.appendChild(fPanel);

		var ready = false, shown = "", path = "/ext", listing = [];

		/* ---- status ---- */

		function showDevice(s) {
			var key = JSON.stringify(s);
			if (key === shown) return;
			shown = key;
			var was = ready;
			ready = s.state === "ready";
			scrPanel.hidden = fPanel.hidden = devActs.hidden = !ready;
			if (!ready) { detWrap.hidden = true; scrSeq = 0; }
			clear(devWrap);
			if (s.state === "missing") {
				devWrap.appendChild(alertEl("warn", s.error));
			} else if (s.state === "absent") {
				devWrap.appendChild(el("div", { class: "placeholder" },
					el("b", { text: "No Flipper plugged in" }),
					el("div", { class: "muted", text: "Plug a Flipper Zero into the router's USB port with a data cable " +
						"(through a hub if a drive is plugged in too). It shows up here within a few seconds. If it is " +
						"locked with a PIN, unlock it." })));
				if (s.error) devWrap.appendChild(alertEl("warn", s.error));
			} else if (s.state === "dfu") {
				devWrap.appendChild(alertEl("warn", "The Flipper is in DFU (recovery) mode: it has no screen or files to " +
					"show. Repair or update its firmware with qFlipper on a computer."));
			} else if (s.state === "connecting") {
				devWrap.appendChild(el("div", { class: "muted", text: "Connecting to the Flipper on " + (s.device || "USB") + "…" }));
				if (s.error) devWrap.appendChild(alertEl("warn", s.error));
			} else {
				var head = el("div", { class: "drive-head" },
					el("strong", { text: s.name || "Flipper" }),
					badge(s.model || "Flipper Zero", "sec-neutral"),
					s.firmware ? badge("firmware " + s.firmware, "sec-ok") : null,
					s.branch ? el("span", { class: "muted", text: s.branch }) : null);
				devWrap.appendChild(head);
				if (s.battery != null) {
					var m = el("div", { class: "meter" + (s.battery <= 15 ? " full" : "") }), fill = el("span");
					fill.style.width = Math.max(0, Math.min(100, s.battery)) + "%";
					m.appendChild(fill);
					devWrap.appendChild(m);
				}
				devWrap.appendChild(el("div", { class: "status", text:
					(s.battery != null ? "battery " + s.battery + "%" + (s.charging ? " · " + s.charging : "") : "battery unknown") +
					" · " + (s.sd ? "SD card: " + gb(s.sd_free) + " free of " + gb(s.sd_total) : "no SD card") }));
				var dl = el("dl", { class: "kv" });
				[["Port", s.device], ["Firmware built", s.build_date], ["Commit", s.commit], ["RPC protocol", s.protobuf]].forEach(function (p) {
					if (!p[1]) return;
					dl.appendChild(el("dt", { text: p[0] }));
					dl.appendChild(el("dd", { text: p[1] }));
				});
				devWrap.appendChild(dl);
			}
			// Plugged in: show its files
			if (ready && !was) browse(path);
		}
		function status() {
			return call("pirate.flipper", "status").then(showDevice).catch(function (e) {
				if (failed(e)) return;
				var msg = String(e.message || e);
				if (msg === "ubus status 4")
					msg = "The Flipper service (pirate-flipper) isn't running on this router: its firmware may predate the Flipper page.";
				showDevice({ state: "missing", error: msg });
			});
		}

		/* ---- actions ---- */

		function act(method, params, doing, done) {
			say(actStatus, doing);
			return call("pirate.flipper", method, params).then(function (r) {
				if (r.error) return say(actStatus, r.error, "err");
				say(actStatus, done, "ok");
			}).catch(function (e) { if (!failed(e)) say(actStatus, String(e.message || e), "err"); });
		}
		function findIt() { act("alert", {}, "beeping…", "it beeped and blinked"); }
		function setClock() {
			var d = new Date();
			act("time", { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(),
				minute: d.getMinutes(), second: d.getSeconds(), weekday: d.getDay() || 7 },
				"setting its clock…", "clock set to " + d.toLocaleString());
		}
		function restart() {
			if (!window.confirm("Restart the Flipper? It is back here in a few seconds.")) return;
			act("reboot", { mode: "os" }, "restarting…", "restarting: back in a few seconds");
		}
		function details() {
			if (!detWrap.hidden) { detWrap.hidden = true; return; }
			call("pirate.flipper", "info").then(function (r) {
				if (r.error) return say(actStatus, r.error, "err");
				var rows = [];
				[r.info || {}, r.power || {}].forEach(function (t) {
					Object.keys(t).sort().forEach(function (k) { rows.push([k.replace(/_/g, " "), String(t[k])]); });
				});
				clear(detWrap).appendChild(tableEl(["", ""], rows));
				detWrap.hidden = false;
			}).catch(function (e) { if (!failed(e)) say(actStatus, String(e.message || e), "err"); });
		}

		/* ---- the screen ---- */

		var scrSeq = 0, vertical = false;
		function draw(b64, orient) {
			var bin = atob(b64), vert = /^vertical/.test(orient || ""), cw = vert ? 64 : 128, x, y;
			if (vert !== vertical) {
				vertical = vert;
				canvas.width = cw; canvas.height = vert ? 128 : 64;
				canvas.classList.toggle("vert", vert);
				img = g.createImageData(canvas.width, canvas.height);
			}
			var d = img.data;
			for (y = 0; y < 64; y++) {
				for (x = 0; x < 128; x++) {
					var on = (bin.charCodeAt((y >> 3) * 128 + x) >> (y & 7)) & 1, nx = x, ny = y;
					if (orient === "horizontal_flip") { nx = 127 - x; ny = 63 - y; }
					else if (orient === "vertical") { nx = 63 - y; ny = x; }
					else if (orient === "vertical_flip") { nx = y; ny = 127 - x; }
					var i = (ny * cw + nx) * 4, c = on ? FZ_FG : FZ_BG;
					d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
				}
			}
			g.putImageData(img, 0, 0);
		}
		// One request out at a time: the router answers once the screen changes
		function screenLoop() {
			if (!alive()) return;
			if (!ready || document.hidden) { setTimeout(screenLoop, 1000); return; }
			call("pirate.flipper", "screen", { seq: scrSeq }).then(function (r) {
				if (!alive()) return;
				if (r.frame) {
					draw(r.frame, r.orientation);
					if (!scrSeq) say(scrStatus, "live", "ok");
					scrSeq = r.seq;
				}
				setTimeout(screenLoop, r.state !== "ready" ? 1500 : r.frame ? 0 : 150);
			}, function (e) {
				if (failed(e)) return;
				say(scrStatus, String(e.message || e), "err");
				setTimeout(screenLoop, 2000);
			});
		}
		function screenshot() {
			var s = el("canvas"), k = 4, t = new Date();
			s.width = canvas.width * k; s.height = canvas.height * k;
			var sg = s.getContext("2d");
			sg.imageSmoothingEnabled = false;
			sg.drawImage(canvas, 0, 0, s.width, s.height);
			function two(n) { return (n < 10 ? "0" : "") + n; }
			var name = "flipper-" + t.getFullYear() + two(t.getMonth() + 1) + two(t.getDate()) + "-" +
				two(t.getHours()) + two(t.getMinutes()) + two(t.getSeconds()) + ".png";
			s.toBlob(function (b) { if (b) saveBlob(b, name); });
		}

		/* ---- its buttons ---- */

		var queue = Promise.resolve(), pending = 0;
		// In order, one after another, as the Flipper would have them
		function send(key, type) {
			pending++;
			queue = queue.then(function () {
				return call("pirate.flipper", "input", { key: key, type: type });
			}).then(function (r) {
				if (r && r.error) say(scrStatus, r.error, "err");
			}, function (e) {
				if (!failed(e)) say(scrStatus, String(e.message || e), "err");
			}).then(function () { pending--; });
		}
		// A button held down: press; after half a second, long, then repeats;
		// let go: short (if it wasn't long) and release
		function holder(key, b) {
			var down = false, long = false, t = null, rep = null;
			return {
				down: function () {
					if (down) return;
					down = true; long = false;
					if (b) b.classList.add("down");
					send(key, "press");
					t = setTimeout(function () {
						long = true;
						send(key, "long");
						rep = setInterval(function () { if (pending < 2) send(key, "repeat"); }, 200);
					}, 500);
				},
				up: function () {
					if (!down) return;
					down = false;
					if (b) b.classList.remove("down");
					clearTimeout(t); clearInterval(rep);
					send(key, long ? "release" : "short+release");
				}
			};
		}
		var holds = {};
		[["up", "▲", "Up"], ["left", "◀", "Left"], ["ok", "OK", "OK"], ["right", "▶", "Right"],
			["down", "▼", "Down"], ["back", "↩", "Back"]].forEach(function (k) {
			var b = el("button", { type: "button", class: "fz-key fz-" + k[0], "aria-label": k[2], title: k[2], text: k[1] });
			var h = holds[k[0]] = holder(k[0], b);
			b.addEventListener("pointerdown", function (ev) {
				ev.preventDefault();
				if (b.setPointerCapture) try { b.setPointerCapture(ev.pointerId); } catch (e2) {}
				h.down();
			});
			["pointerup", "pointercancel", "lostpointercapture"].forEach(function (t) { b.addEventListener(t, h.up); });
			b.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
			// The keyboard on a focused button: Enter and Space press it
			b.addEventListener("keydown", function (ev) {
				if ((ev.key === "Enter" || ev.key === " ") && !ev.repeat) { ev.preventDefault(); h.down(); }
			});
			b.addEventListener("keyup", function (ev) {
				if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); h.up(); }
			});
			pad.appendChild(b);
		});
		canvas.addEventListener("keydown", function (ev) {
			var k = FZ_KEYBOARD[ev.key];
			if (!k) return;
			ev.preventDefault();
			if (!ev.repeat) holds[k].down();
		});
		canvas.addEventListener("keyup", function (ev) {
			var k = FZ_KEYBOARD[ev.key];
			if (!k) return;
			ev.preventDefault();
			holds[k].up();
		});
		canvas.addEventListener("blur", function () { Object.keys(holds).forEach(function (k) { holds[k].up(); }); });
		canvas.addEventListener("pointerdown", function () { canvas.focus(); });

		/* ---- files ---- */

		function join(dir, name) { return (dir === "/" ? "" : dir) + "/" + name; }
		function parentOf(p) { return p.replace(/\/[^/]*$/, "") || "/"; }
		function badName(n) {
			if (!n || n === "." || n === "..") return "give a name";
			if (!/^[\x20-\x7e]+$/.test(n)) return "the Flipper takes plain ASCII names only";
			if (/[\/\\:*?"<>|]/.test(n)) return "no / \\ : * ? \" < > | in names";
			return null;
		}
		function crumbs(p) {
			clear(fCrumbs);
			var link = function (label, to) {
				return el("button", { type: "button", class: "linkbtn", text: label, onclick: function () { browse(to); } });
			};
			var parts = p === "/" ? [] : p.slice(1).split("/");
			fCrumbs.appendChild(parts.length ? link("Flipper", "/") : el("span", { text: "Flipper" }));
			parts.forEach(function (seg, i) {
				fCrumbs.appendChild(el("span", { class: "muted", text: " / " }));
				var to = "/" + parts.slice(0, i + 1).join("/");
				fCrumbs.appendChild(i === parts.length - 1 ? el("span", { text: seg }) : link(seg, to));
			});
		}
		function browse(p) {
			path = p;
			crumbs(p);
			upBtn.disabled = mkBtn.disabled = p === "/";
			clear(fWrap).appendChild(el("div", { class: "muted", text: "Loading…" }));
			call("pirate.flipper", "list", { path: p }).then(function (r) {
				if (!alive() || path !== p) return;
				if (r.error) { clear(fWrap).appendChild(alertEl("warn", r.error)); return; }
				// "any" is the Flipper's alias for one of the others
				listing = (r.files || []).filter(function (f) { return p !== "/" || f.name !== "any"; }).sort(function (a, b) {
					return (b.dir - a.dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
				});
				clear(fWrap);
				var rows = [];
				if (p !== "/") rows.push([el("button", { type: "button", class: "linkbtn", text: "↑ up",
					onclick: function () { browse(parentOf(p)); } }), "", ""]);
				listing.forEach(function (f) {
					var fp = join(p, f.name);
					var label = p !== "/" ? f.name + (f.dir ? "/" : "") :
						f.name === "ext" ? "ext/ (SD card)" : f.name === "int" ? "int/ (internal)" : f.name + "/";
					var line = el("span", { class: "status" });
					rows.push([
						f.dir ? el("button", { type: "button", class: "linkbtn", text: label, onclick: function () { browse(fp); } })
							: el("span", { text: f.name }),
						f.dir ? "" : size(f.size),
						p === "/" ? "" : el("span", { class: "fz-acts" },
							f.dir ? null : btn("Download", { cls: "small", onclick: function () { download(fp, f.name, line); } }),
							btn("Rename", { cls: "small", onclick: function () { rename(fp, f.name); } }),
							btn("Delete", { cls: "small reset", onclick: function () { remove(fp, f); } }),
							line)
					]);
				});
				if (listing.length) fWrap.appendChild(tableEl(["Name", "Size", ""], rows));
				else {
					if (rows.length) fWrap.appendChild(tableEl(["Name", "Size", ""], rows));
					fWrap.appendChild(el("div", { class: "placeholder", text: "This folder is empty." }));
				}
				if (r.total) fWrap.appendChild(el("p", { class: "descr", text:
					"Showing the first " + listing.length + " of " + r.total + " entries." }));
			}).catch(function (e) {
				if (failed(e)) return;
				clear(fWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function fileOp(method, params, doing, done) {
			say(fStatus, doing);
			return call("pirate.flipper", method, params).then(function (r) {
				if (r.error) return say(fStatus, r.error, "err");
				say(fStatus, done, "ok");
				browse(path);
			}).catch(function (e) { if (!failed(e)) say(fStatus, String(e.message || e), "err"); });
		}
		function newFolder() {
			var n = window.prompt("New folder in " + path + ":", "");
			if (n == null) return;
			var bad = badName(n.trim());
			if (bad) return say(fStatus, bad, "err");
			fileOp("mkdir", { path: join(path, n.trim()) }, "making " + n.trim() + "…", "made " + n.trim());
		}
		function rename(fp, name) {
			var n = window.prompt("Rename " + name + " to:", name);
			if (n == null || n.trim() === name) return;
			var bad = badName(n.trim());
			if (bad) return say(fStatus, bad, "err");
			fileOp("rename", { path: fp, to: join(parentOf(fp), n.trim()) }, "renaming…", "renamed to " + n.trim());
		}
		function remove(fp, f) {
			if (!window.confirm("Delete " + f.name + (f.dir ? " and everything in it" : "") + " from the Flipper?")) return;
			fileOp("delete", { path: fp, recursive: !!f.dir }, "deleting " + f.name + "…", "deleted " + f.name);
		}

		function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
		function download(fp, name, line) {
			say(line, "reading…");
			function poll() {
				return call("pirate.flipper", "read", { path: fp }).then(function (r) {
					if (r.error) throw new Error(r.error);
					if (r.busy) { say(line, "reading… " + size(r.got)); return wait(400).then(poll); }
					return slices();
				});
			}
			function slices() {
				var parts = [], off = 0;
				function next() {
					return call("pirate.flipper", "read", { path: fp, offset: off }).then(function (r) {
						if (r.error) throw new Error(r.error);
						var bin = atob(r.data || ""), u = new Uint8Array(bin.length), i;
						for (i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
						parts.push(u);
						off += u.length;
						if (r.more) { say(line, "downloading… " + Math.round(off * 100 / r.size) + "%"); return next(); }
						saveBlob(new Blob(parts, { type: "application/octet-stream" }), name);
						say(line, "downloaded", "ok");
					});
				}
				return next();
			}
			poll().catch(function (e) { if (!failed(e)) say(line, String(e.message || e), "err"); });
		}

		function b64(u8) {
			var s = "", i;
			for (i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
			return btoa(s);
		}
		function readFile(file) {
			if (file.arrayBuffer) return file.arrayBuffer();
			return new Promise(function (res, rej) {
				var fr = new FileReader();
				fr.onload = function () { res(fr.result); };
				fr.onerror = function () { rej(fr.error); };
				fr.readAsArrayBuffer(file);
			});
		}
		// Pieces of 32 KiB: a ubus request through uhttpd is 64 KB at most
		function uploadOne(dir, file) {
			var bad = badName(file.name);
			if (bad) return Promise.reject(new Error(file.name + ": " + bad));
			if (dir === path && listing.some(function (f) { return f.name === file.name; }) &&
				!window.confirm(file.name + " is on the Flipper already. Replace it?")) return Promise.resolve();
			var fp = join(dir, file.name);
			return readFile(file).then(function (buf) {
				var u8 = new Uint8Array(buf), off = 0;
				function next() {
					var piece = u8.subarray(off, off + 32768), more = off + piece.length < u8.length;
					say(fStatus, "uploading " + file.name + "… " + (u8.length ? Math.round(off * 100 / u8.length) : 0) + "%");
					return call("pirate.flipper", "write", { path: fp, offset: off, data: b64(piece), more: more }).then(function (r) {
						if (r.error) throw new Error(file.name + ": " + r.error);
						off += piece.length;
						if (more) return next();
						say(fStatus, "uploaded " + file.name + " (" + size(u8.length) + ")", "ok");
					});
				}
				return next();
			});
		}
		function uploadAll(files) {
			var dir = path, chain = Promise.resolve();
			if (dir === "/") return say(fStatus, "open ext (the SD card) or int first", "err");
			files.forEach(function (f) { chain = chain.then(function () { return uploadOne(dir, f); }); });
			chain.then(function () { if (path === dir) browse(dir); }, function (e) {
				if (failed(e)) return;
				say(fStatus, String(e.message || e), "err");
				if (path === dir) browse(dir);
			});
		}

		// Plugged in and pulled out as it likes: keep the page current while it is open
		if (FZ_TIMER) clearInterval(FZ_TIMER);
		FZ_TIMER = setInterval(function () {
			if (!alive()) { clearInterval(FZ_TIMER); FZ_TIMER = null; return; }
			status();
		}, 4000);
		status();
		screenLoop();
	}

	function saveBlob(blob, name) {
		var a = el("a", { href: URL.createObjectURL(blob), download: name });
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
	}

	/* ---------- fallback for an unknown route ---------- */

	function renderPlaceholder(name) {
		clear(VIEW);
		VIEW.appendChild(viewHead(String(name)));
		VIEW.appendChild(el("div", { class: "placeholder", text: "Unknown section." }));
	}

	/* ---------- tabs / router ---------- */

	var TABS = [
		["dashboard", "Dashboard"],
		["sdr", "Radios & SDR"],
		["hosts", "Hosts"],
		["survey", "Wi-Fi Survey"],
		["threats", "Threats"],
		["router", "Router"],
		["dreampi", "DreamPi"],
		["drives", "Drives"],
		["flipper", "Flipper"],
		["capture", "Capture"],
		["handshake", "Handshake"],
		["firmware", "Firmware"]
	];
	var current = "dashboard";

	function renderTabs() {
		var nav = clear($("tabs"));
		TABS.forEach(function (t) {
			nav.appendChild(el("button", {
				class: "tab" + (t[0] === current ? " active" : ""),
				type: "button", text: t[1],
				onclick: function () { setTab(t[0]); }
			}));
		});
	}

	function setTab(id) {
		current = id;
		renderTabs();
		try { location.hash = id; } catch (e) {}
		if (id === "dashboard") return loadDashboard();
		if (id === "sdr") return renderSdr();
		if (id === "hosts") return renderHosts();
		if (id === "survey") return renderSurvey();
		if (id === "threats") return renderThreats();
		if (id === "router") return renderRouter();
		if (id === "dreampi") return renderDreampi();
		if (id === "drives") return renderDrives();
		if (id === "flipper") return renderFlipper();
		if (id === "capture") return renderCapture();
		if (id === "handshake") return renderHandshake();
		if (id === "firmware") return renderFirmware();
		renderPlaceholder(id);
	}

	/* ---------- chrome ---------- */

	function setNetPill(online, ssid) {
		var p = $("net-pill");
		if (online == null) { p.className = "pill"; p.textContent = "—"; return; }
		p.className = "pill " + (online ? "ok" : "bad");
		p.textContent = (online ? "online" : "offline") + (ssid ? " · " + ssid : "");
	}

	function onError(e) {
		if (String(e.message || e) === "unauthorized" && !DEMO) { firstRun(); return; }
		clear(VIEW).appendChild(el("div", { class: "placeholder" },
			el("b", { text: "Couldn't reach the Slate" }),
			el("div", { class: "muted", text: String(e.message || e) })));
	}

	/* ---------- login ---------- */

	function showLogin() { $("login").hidden = false; var p = $("p"); if (p) p.focus(); }
	function hideLogin() { $("login").hidden = true; }

	// First run: a fresh flash has no root password, and rpcd then accepts any
	// password (session.c: "password is not set"). So an empty-password sign-in
	// that succeeds means no password exists yet: ask for one to be set before
	// ever asking for one. If it fails, a password exists: the normal sign-in.
	function firstRun() {
		login("root", "", false).then(showSetup).catch(showLogin);
	}
	function showSetup() { $("setup").hidden = false; var p = $("np1"); if (p) p.focus(); }

	$("setup-form").addEventListener("submit", function (ev) {
		ev.preventDefault();
		var a = $("np1").value, b = $("np2").value, err = $("setup-err");
		function fail(msg) { err.textContent = msg; err.hidden = false; }
		err.hidden = true;
		if (a.length < 5) return fail("Use at least 5 characters.");
		if (a !== b) return fail("The two entries differ.");
		call("pirate.router", "set_password", { password: a }).then(function (r) {
			if (r.error) return fail(r.error);
			$("np1").value = ""; $("np2").value = "";
			rememberSession();
			$("setup").hidden = true;
			setTab(current);
		}).catch(function (e) { fail(String(e.message || e)); });
	});

	$("login-form").addEventListener("submit", function (ev) {
		ev.preventDefault();
		var err = $("login-err");
		err.hidden = true;
		login($("u").value, $("p").value).then(function () {
			hideLogin();
			setTab(current);
		}).catch(function () {
			err.textContent = "Sign-in failed. Check the password.";
			err.hidden = false;
		});
	});

	/* ---------- boot ---------- */

	function startTab() {
		var h = (location.hash || "").replace("#", "");
		return TABS.some(function (t) { return t[0] === h; }) ? h : "dashboard";
	}

	function boot() {
		current = startTab();
		renderTabs();
		if (DEMO) {
			$("demo-badge").hidden = false;
			setTab(current);
			if (/[?&]setup=1/.test(location.search)) showSetup();
			return;
		}
		try { SID = sessionStorage.getItem("pirate_sid"); } catch (e) { SID = null; }
		if (SID) { setTab(current); } else { firstRun(); }
	}

	window.addEventListener("hashchange", function () {
		var h = startTab();
		if (h !== current) setTab(h);
	});

	boot();
})();
