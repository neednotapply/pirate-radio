/* The Bluetooth page (bt/scanner.js), without a page: what it makes of the
   records pirate-bluetooth hands on. The advertising reports in an HCI
   event; an advertisement's structures and what they say of a device (its
   name, its maker, what kind of thing it is, whether it is a tracker and
   away from its owner); the devices heard, one for an address; and the
   made-up neighbourhood of the demo, which goes the same way as a real one.

   The advertisements here are made as devices send them, a byte at a time,
   after the Bluetooth specification and the makers' own published formats.

   node tests/bt/scanner.test.js */
"use strict";

const fs = require("fs"), path = require("path"), vm = require("vm");
const BT = path.join(__dirname, "../../feed/utils/pirate-radio-ui/files/bt/");
const { test, run, ok, equal, near, atLeast, atMost } = require("../sdr/harness.js");

// The page's scripts hang what they have on window
const page = { window: {} };
vm.runInNewContext(fs.readFileSync(BT + "names.js", "utf8"), page, { filename: "names.js" });
vm.runInNewContext(fs.readFileSync(BT + "scanner.js", "utf8"), page, { filename: "scanner.js" });
const names = page.window.PirateBTNames, pure = page.window.PirateBT.pure;

const hex = pure.unhex;
function join() {
	const all = [];
	for (let i = 0; i < arguments.length; i++) Array.prototype.push.apply(all, Array.from(arguments[i]));
	return new Uint8Array(all);
}
// An address as it is sent: lowest byte first
function addr(text) { return Array.from(hex(text)).reverse(); }

// The parameters of an LE Meta event with one LE Advertising Report in it
function advert(o) {
	const data = typeof o.data === "string" ? hex(o.data) : o.data || new Uint8Array(0);
	return join([0x02, 1, o.pdu || 0, o.type == null ? 1 : o.type], addr(o.addr || "C0:11:22:33:44:55"), [data.length], data, [(o.rssi == null ? -60 : o.rssi) & 255]);
}
// The same as an LE Extended Advertising Report; what: its event type's bits
function extended(o) {
	const data = typeof o.data === "string" ? hex(o.data) : o.data || new Uint8Array(0);
	return join([0x0d, 1, o.what & 255, o.what >> 8, o.type == null ? 1 : o.type], addr(o.addr || "C0:11:22:33:44:55"),
		[1, 0, 0xff, (o.tx == null ? 127 : o.tx) & 255, (o.rssi == null ? -60 : o.rssi) & 255, 0, 0, 0], [0, 0, 0, 0, 0, 0], [data.length], data);
}
// A record as pirate-bluetooth makes them: the length of the rest, when, the event, its parameters
function record(t, params) {
	const n = 5 + params.length;
	return join([n & 255, n >> 8, t & 255, t >>> 8 & 255, t >>> 16 & 255, t >>> 24 & 255, 0x3e], params);
}
// What a device that sends these structures is taken for
function seen() {
	return pure.describe(pure.partsOf(hex(Array.prototype.join.call(arguments, ""))));
}
function fact(s, label) {
	const f = s.facts.filter(function (x) { return x[0] === label; })[0];
	return f ? f[1] : null;
}
function tags(s) { return s.tags.map(function (t) { return t[0]; }).join(", "); }

test("names: who a company number is, what a service is, what an appearance says", function () {
	equal(names.company(0x004c), "Apple, Inc.", "76");
	equal(names.company(0x0006), "Microsoft", "6");
	equal(names.company(0x0499), "Ruuvi Innovations Ltd.", "1177");
	equal(names.company(0xf123), null, "a number nobody has");
	equal(names.service(0x180d), "Heart Rate", "a 16-bit service");
	equal(names.service("6e400001-b5a3-f393-e0a9-e50e24dcca9e"), "Nordic UART Service", "a whole UUID, in either case");
	equal(names.service(0x1234), null, "one with no name");
	equal(names.member(0xfeed), "Tile", "a company's own number");
	equal(names.member(0x180d), null, "which Bluetooth's own are not");
	equal(names.appearance(0x03c1).name + " / " + names.appearance(0x03c1).category, "Keyboard / Human Interface Device", "a kind within a category");
	equal(names.appearance(0x0040).name, "Phone", "a category by itself");
	equal(names.appearance(0xffc0), null, "a category nobody has");
});

test("base64 and text, as they come", function () {
	for (let n = 0; n < 9; n++) {
		const d = new Uint8Array(n);
		for (let i = 0; i < n; i++) d[i] = 250 - 37 * i & 255;
		const s = pure.b64enc(d);
		equal(s, Buffer.from(d).toString("base64"), n + " bytes, as base64");
		equal(pure.hex(pure.b64dec(s)), pure.hex(d), n + " bytes, and back");
	}
	equal(pure.utf8(hex("4b c3 bc 63 68 65 20 e2 82 ac 20 f0 9f 93 bb")), "Küche € 📻", "UTF-8 of two, three and four bytes");
	equal(pure.utf8(hex("41 ff 42 c3")), "A�B�", "what is not UTF-8 is a mark, and the rest stands");
});

test("records: each its length, its time, its event; one cut short is left", function () {
	const a = advert({ data: "020106" }), b = advert({ data: "" });
	const got = pure.records(join(record(1000, a), record(0xfffffff0, b), [9, 0, 1, 2]));
	equal(got.length, 2, "records");
	equal(got[0].t + " " + got[0].evt + " " + got[0].p.length, "1000 62 " + a.length, "the first");
	equal(got[1].t, 0xfffffff0, "a time near the clock's end is not negative");
	equal(pure.records(new Uint8Array(0)).length, 0, "none in nothing");
});

test("an advertising report: who, how, how strong, and the data", function () {
	const r = pure.reportsIn(advert({ pdu: 0, type: 0, addr: "00:11:22:33:44:55", data: "0201060303 0d18", rssi: -48 }));
	equal(r.length, 1, "reports");
	equal(r[0].addr + " " + r[0].addrType, "00:11:22:33:44:55 0", "the address, as it is written");
	equal(r[0].rssi, -48, "dBm");
	equal(pure.PDU[r[0].pdu], "ADV_IND", "how it advertises");
	ok(r[0].connectable && r[0].scannable && !r[0].directed && !r[0].response, "which says what may be done with it");
	equal(pure.hex(r[0].data), "0201060303 0d18".replace(/ /g, ""), "the data");
	const n = pure.reportsIn(advert({ pdu: 3, rssi: 127 }))[0];
	ok(!n.connectable && !n.scannable && n.rssi === null, "one that only advertises; a strength the adapter does not say");
	ok(pure.reportsIn(advert({ pdu: 4 }))[0].response, "an answer to a scan request");
	// Two in one event, each with its own data and strength
	const two = join([0x02, 2, 0, 1], addr("C0:00:00:00:00:01"), [3, 2, 1, 6, 0xc4], [3, 1], addr("C0:00:00:00:00:02"), [0, 0xb0]);
	const got = pure.reportsIn(two);
	equal(got.length + " " + got[0].addr + " " + got[0].rssi + " " + got[1].addr + " " + got[1].rssi + " " + got[1].data.length,
		"2 C0:00:00:00:00:01 -60 C0:00:00:00:00:02 -80 0", "two reports in one event");
	equal(pure.reportsIn(advert({ data: "0201060303" }).subarray(0, 14)).length, 0, "one cut short is no report");
	equal(pure.reportsIn(new Uint8Array([0x01, 1, 2, 3])).length, 0, "another LE event is none either");
});

test("an extended advertising report: the same, in the newer form", function () {
	const r = pure.reportsIn(extended({ what: 0x13, addr: "00:11:22:33:44:55", type: 0, data: "020106", rssi: -51, tx: 4 }))[0];
	equal(r.addr + " " + r.rssi + " " + r.tx + " " + pure.PDU[r.pdu], "00:11:22:33:44:55 -51 4 ADV_IND", "who, how strong, its power, how");
	ok(r.extended && r.connectable && r.scannable && !r.cut, "what it is");
	equal(pure.PDU[pure.reportsIn(extended({ what: 0x10 }))[0].pdu], "ADV_NONCONN_IND", "advertising only");
	equal(pure.PDU[pure.reportsIn(extended({ what: 0x12 }))[0].pdu], "ADV_SCAN_IND", "to be asked, not connected to");
	equal(pure.PDU[pure.reportsIn(extended({ what: 0x15 }))[0].pdu], "ADV_DIRECT_IND", "to one device");
	equal(pure.PDU[pure.reportsIn(extended({ what: 0x1b }))[0].pdu], "SCAN_RSP", "an answer to a scan request");
	const now = pure.reportsIn(extended({ what: 0x01 }))[0];
	ok(now.pdu === null && now.connectable && now.tx === null, "the newer advertising has no such name; a power not said");
	ok(pure.reportsIn(extended({ what: 0x40 }))[0].cut, "data that was cut");
	equal(pure.reportsIn(extended({ what: 0x00, type: 0xff }))[0].addr, "", "one that gives no address");
	// To one device by name: no data
	const d = pure.reportsIn(join([0x0b, 1, 1, 0], addr("00:11:22:33:44:55"), [1], addr("C0:00:00:00:00:09"), [0xba]))[0];
	equal(d.addr + " " + d.rssi + " " + d.directed + " " + d.data.length, "00:11:22:33:44:55 -70 true 0", "a direct advertising report");
});

test("whose an address is", function () {
	equal(pure.addrKind(0, "00:11:22:33:44:55"), "public", "a maker's");
	equal(pure.addrKind(1, "C0:11:22:33:44:55"), "static", "random, and kept");
	equal(pure.addrKind(1, "7F:11:22:33:44:55"), "resolvable", "private, for those it is bonded with");
	equal(pure.addrKind(1, "3F:11:22:33:44:55"), "unresolvable", "private, for nobody");
	equal(pure.addrKind(2, "00:11:22:33:44:55") + " " + pure.addrKind(3, "C0:11:22:33:44:55"), "public static", "the two the adapter has resolved");
});

test("an advertisement's structures; Apple's messages each by itself", function () {
	const p = pure.adParts(hex("020106 03031a18 0b0950697261746554656d70"));
	equal(p.map(function (x) { return x.type + ":" + x.d.length; }).join(" "), "1:1 3:2 9:10", "a type and its data, each");
	equal(pure.adParts(hex("020106 00 0303aafe")).length, 1, "a length of nothing ends them");
	equal(pure.adParts(hex("020106 0909 4142")).length, 1, "one that says more than there is is left");
	const k = pure.partsOf(hex("020106 0aff4c001005011812 3456 0716aafe10ee0301")).map(function (x) { return x.key; });
	equal(k.join(" "), "01 ff:004C:10 16:FEAA", "kept by what they are of: a maker's, a service's");
	// Nearby Info (5 bytes) and Handoff (3) in one
	const a = pure.partsOf(hex("0fff4c00 1005 0118123456 0c03 aabbcc"));
	equal(a.map(function (x) { return x.key + "=" + pure.hex(x.d); }).join(" "), "ff:004C:10=4c0010050118123456 ff:004C:0c=4c000c03aabbcc", "two of Apple's messages");
	// The one with no length: all the rest is its
	const b = pure.partsOf(hex("14ff4c00 01 000000000000000000000000000000 80"))[0];
	equal(b.key + " " + b.d.length + " " + b.d[3], "ff:004C:01 20 16", "Apple's type 1 has no length");
	equal(pure.partsOf(hex("07ff4c00 1009 0118"))[0].d.length, 4 + 2, "one cut short: what there is of it");
});

test("a name: its own word, tidied", function () {
	equal(seen("0b0950697261746554656d70").name, "PirateTemp", "a whole name");
	equal(seen("0408546563", "09094b c3bc 6368 65 20 31").name, "Küche 1", "the whole one over the shortened, in UTF-8");
	equal(seen("0508542d4563").name, "T-Ec", "a shortened one where that is all");
	equal(seen("0909 41 00 0a 42 20 20 43 1b").name, "AB C", "nothing in it that is not for showing");
	equal(seen("020106").name, "", "none");
	equal(pure.titleOf({ seen: seen("020106") }), "No name", "which the line says");
});

test("beacons: Apple's form and Google's", function () {
	const b = seen("020106", "1aff4c000215 f7826da64fa24e988024bc5b71e0893e 0001 0002 c5");
	equal(b.kind + " / " + b.what + " / " + b.maker, "beacon / an iBeacon / ", "an iBeacon is anybody's, not Apple's");
	equal(fact(b, "iBeacon"), "F7826DA6-4FA2-4E98-8024-BC5B71E0893E, major 1, minor 2, -59 dBm at 1 m", "what it says");
	equal(pure.titleOf({ seen: b }), "iBeacon", "and its line");
	const u = seen("0303aafe", "0e16aafe 10 ee 03 6578616d706c65 00");
	equal(u.kind + " / " + fact(u, "Eddystone URL") + " / " + u.maker, "beacon / https://example.com/ / ", "an Eddystone beacon's web address; not Google's either");
	equal(fact(seen("0c16aafe 10 f4 00 676f6f 07 2f61"), "Eddystone URL"), "http://www.goo.com/a", "the endings a byte each");
	equal(fact(seen("1716aafe 00 ee 00112233445566778899 aabbccddeeff 0000"), "Eddystone UID"), "00112233445566778899 / aabbccddeeff, -18 dBm at 0 m", "an identity");
	equal(fact(seen("1116aafe 20 00 0bb8 1580 00000064 000004b0"), "Eddystone telemetry"), "3000 mV, 21.5 °C, up 120 s", "how it is");
});

test("Apple's devices, and the trackers on its network", function () {
	const phone = seen("02011a", "0aff4c00 1005 0118 9a3c71");
	equal(phone.kind + " / " + phone.maker + " / " + phone.what, "personal / Apple / an Apple device: an iPhone, iPad, Mac or Watch", "a phone or the like");
	equal(fact(phone, "Apple's messages"), "Nearby Info", "by what it sends");
	const lost = seen("1eff4c00 1219 10 a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6 0100");
	equal(lost.kind + " / " + lost.what + " / " + tags(lost), "tracker / an AirTag / tracker, away from its owner", "an AirTag by itself");
	ok(lost.tracker.away === true && lost.tracker.network === "Apple's Find My" && lost.maker === "Apple", "which the page marks");
	const home = seen("02011a", "07ff4c00 1202 54 03");
	equal(home.what + " / " + tags(home) + " / " + fact(home, "Battery, as it says"), "an AirTag / tracker, with its owner / medium", "one with its owner");
	const other = seen("1eff4c00 1219 20 a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6 0100");
	equal(other.what + " / " + other.maker, "a tracker on Apple's Find My network (not Apple's own) / ", "another maker's tracker is not Apple's");
	const pods = seen("1eff4c00 1219 30 a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6 0100");
	equal(pods.kind + " / " + tags(pods), "audio / tracker, away from its owner", "headphones left behind");
	const pairing = seen("1eff4c00 0719 01 0e20 2b998f010005a1c4e87d3b52f0966e1d44a7c3085bd9");
	equal(pairing.kind + " / " + pairing.what + " / " + pairing.maker, "audio / AirPods Pro / Apple", "headphones, by the model they say");
	equal(seen("1eff4c00 0719 01 7e7e 2b998f010005a1c4e87d3b52f0966e1d44a7c3085bd9").what, "Apple or Beats headphones", "a model not known");
});

test("Microsoft's: a computer with Windows, and what asks to be paired", function () {
	const pc = seen("1eff0600 01 0f 20 22 5c1e09d7a3f2484bb16e7702c9d53a8ef0126b94 00 00 00");
	equal(pc.kind + " / " + pc.what + " / " + pc.maker, "personal / a Windows laptop / ", "what it says it is; whose computer it is, it does not say");
	equal(seen("09ff0600 01 49 20 22 5c 1e").what, "a Windows desktop computer", "the kind in the lower six bits");
	const mouse = seen("020106", "0319c203", "10ff0600 03 00 80 4465736b204d6f757365");
	equal(mouse.name + " / " + mouse.kind + " / " + mouse.what + " / " + tags(mouse), "Desk Mouse / input / a mouse / ready to pair", "a mouse that asks to be paired, by name");
	const kb = seen("0dff0600 03 02 80 400500 4b657973");
	equal(kb.name + " / " + kb.kind, "Keys / input", "one that says what it is as classic Bluetooth has it");
	const hs = seen("13ff0600 03 01 80 112233445566 040424 48656164");
	equal(hs.name + " / " + hs.kind, "Head / audio", "and one with its classic address before that");
});

test("Google's: what asks to be paired, and the trackers on its network", function () {
	const buds = seen("020106", "06162cfe 2e0d41", "020af5", "0c09506f636b65742042756473");
	equal(buds.name + " / " + buds.kind + " / " + buds.maker + " / " + tags(buds), "Pocket Buds / audio /  / ready to pair", "headphones that ask to be paired");
	equal(fact(buds, "Fast Pair") + " / " + fact(buds, "Transmit power, as it says"), "asks to be paired, model 0x2E0D41 / -11 dBm", "with their model and power");
	equal(fact(seen("09162cfe 00907c214ed3"), "Fast Pair"), "paired to an account", "ones that have an owner");
	const t = seen("1716aafe 41 09f3a25c7d1e84b6402fc9153ae78d06b1c4 5f");
	equal(t.kind + " / " + tags(t) + " / " + t.maker, "tracker / tracker, away from its owner / ", "a tracker by itself");
	ok(seen("1716aafe 40 09f3a25c7d1e84b6402fc9153ae78d06b1c4 5f").tracker.away === null, "one that does not say where its owner is");
});

test("other trackers, by the services they have", function () {
	const tile = seen("020106", "0303edfe", "0d16edfe 0200 7a11c93e5d02b4f6");
	equal(tile.kind + " / " + tile.what + " / " + tile.maker + " / " + tags(tile), "tracker / a Tile tracker / Tile / tracker", "a Tile");
	equal(fact(tile, "Service"), "Tile's (0xFEED)", "its service, once");
	const tag = seen("0303 5afd", "1616 5afd 13 5e09c1d47a2f8830b6e4159c27d0a3f1c855");
	equal(tag.kind + " / " + tag.maker + " / " + tag.tracker.network, "tracker / Samsung / Samsung's SmartThings Find", "a SmartTag");
	equal(seen("030333fe").what, "a Chipolo tracker", "a Chipolo");
	const near = seen("0616b2fc 01 01 aa"), away = seen("0616b2fc 02 00 aa");
	equal(tags(near) + " / " + near.tracker.network, "tracker, with its owner / Apple's Find My", "the trackers' common word: near its owner");
	equal(tags(away) + " / " + away.tracker.network, "tracker, away from its owner / Google's Find My Device", "and away");
});

test("a RuuviTag's readings (Ruuvi's own example)", function () {
	const r = seen("020106", "1bff9904 05 12fc 5394 c37c 0004 fffc 040c ac36 42 00cd cbb8334c884f");
	equal(r.kind + " / " + r.what + " / " + r.maker, "sensor / a RuuviTag / Ruuvi", "what it is");
	equal(fact(r, "Temperature") + ", " + fact(r, "Humidity") + ", " + fact(r, "Air pressure") + ", " + fact(r, "Battery"),
		"24.30 °C, 53.5 %, 1000.4 hPa, 2.977 V", "what it reads");
	equal(fact(seen("1bff9904 05 fc18 5394 c37c 0004 fffc 040c ac36 42 00cd cbb8334c884f"), "Temperature"), "-5.00 °C", "below freezing");
	const none = seen("1bff9904 05 8000 ffff ffff 8000 8000 8000 ffff ff ffff ffffffffffff");
	ok(fact(none, "Temperature") === null && fact(none, "Humidity") === null && fact(none, "Battery") === null, "a reading it has not is not shown");
});

test("what kind of thing: by its services, its appearance, its name", function () {
	const hr = seen("020106", "03030d18", "03194103", "100948524d2d4475616c3a303438383132");
	equal(hr.name + " / " + hr.kind + " / " + hr.what, "HRM-Dual:048812 / health / a heart rate belt", "a heart rate strap");
	equal(fact(hr, "Service") + " / " + fact(hr, "Appearance, as it says"), "Heart Rate (0x180D) / Heart Rate Belt (Heart Rate Sensor)", "as it says");
	equal(seen("03031218").kind + " " + seen("03034e18").kind + " " + seen("03031a18").kind, "input audio sensor", "a keyboard's service, LE Audio's, a sensor's");
	equal(seen("0319c103").kind + " " + seen("03194000").kind + " " + seen("03194109").kind + " " + seen("03190002").kind,
		"input personal audio tracker", "a keyboard, a phone, an earbud and a tag, by appearance");
	equal(seen("0f094c6976696e6720526f6f6d205456").kind + " " + seen("0c09506f636b65742042756473").kind + " " + seen("0b09466f726572756e6e6572").kind,
		"home audio personal", "by a name, where nothing better tells");
	const nus = seen("020106", "1107 9ecadc240ee5a9e093f3a3b50100406e", "0708542d4563686f");
	equal(nus.name + " / " + nus.what + " / " + fact(nus, "Service"), "T-Echo / a gadget with a serial port over Bluetooth / Nordic UART Service (6E400001-B5A3-F393-E0A9-E50E24DCCA9E)",
		"a whole UUID, lowest byte first as sent");
	equal(fact(seen("1107 fb349b5f80000080001000000d180000"), "Service"), "Heart Rate (0x180D)", "one of Bluetooth's own, written out in full");
	const tv = seen("08ff7500 4204018060", "0f094c6976696e6720526f6f6d205456");
	equal(tv.maker + " / " + fact(tv, "Maker's data, Samsung Electronics Co. Ltd."), "Samsung Electronics Co. Ltd. / 42 04 01 80 60", "a maker, by the number on its data");
	const odd = seen("020104", "07ff23f1 01020304");
	equal(odd.kind + " / " + odd.maker + " / " + odd.what, "other / company 0xF123 / ", "a number nobody has, and nothing else to go by");
	equal(fact(odd, "Flags"), "0x04: not to be found, Low Energy only", "what it says of itself");
	equal(seen("03031a18", "0616 1a18 0a1b2c").kind + " / " + seen("0303 e0fe").maker, "sensor / Huami (Xiaomi's bands)", "a service's data; a company's own service");
});

test("devices: one for an address; how strong, how often", function () {
	const devs = new pure.Devices(), data = "020106 0b0950697261746554656d70";
	let t = 100000, d;
	[-50, -54, -46, -50].forEach(function (rssi) {
		d = devs.heard(pure.reportsIn(advert({ addr: "C0:00:00:00:00:01", data: data, rssi: rssi }))[0], t);
		t += 1000;
	});
	equal(devs.list().length + " " + d.n + " " + devs.total + " " + devs.adverts, "1 4 1 4", "four advertisements, one device");
	equal(d.seen.name + " " + d.addrKind + " " + d.rssi + " " + d.lo + " " + d.hi, "PirateTemp static -50 -54 -46", "its name, its address, the strength now, the least and the most");
	near(d.level, -50, 2.5, "the strength it is shown at is eased");
	equal(d.first + " " + d.last + " " + d.hist.length, "100000 103000 4", "when first and last; a reading a second");
	equal(d.rev, 1, "said the same four times: taken for what it is once");
	// The same six bytes as a public address are another device
	devs.heard(pure.reportsIn(advert({ addr: "C0:00:00:00:00:01", type: 0, data: data }))[0], t);
	equal(devs.list().length, 2, "a public address and a random one alike are two devices");
	ok(devs.heard(pure.reportsIn(extended({ what: 0, type: 0xff }))[0], t) === null && devs.list().length === 2, "one that gives no address is nobody");

	// One that advertises every 250 ms, of which every third is missed
	const often = new pure.Devices();
	for (let i = 0; i < 40; i++) if (i % 3) d = often.heard(pure.reportsIn(advert({ addr: "C0:00:00:00:00:02" }))[0], 5000 + i * 250 + (i * 7 % 5));
	near(d.every, 250, 6, "how often it advertises, by the short gaps");
});

test("devices: the latest of each thing a device says is kept", function () {
	const devs = new pure.Devices(), a = "C0:00:00:00:00:03";
	// A phone that says two things in turn
	let d = devs.heard(pure.reportsIn(advert({ addr: a, pdu: 0, data: "02011a 0aff4c00 1005 0118 9a3c71" }))[0], 1000);
	equal(fact(d.seen, "Apple's messages"), "Nearby Info", "the first");
	d = devs.heard(pure.reportsIn(advert({ addr: a, pdu: 0, data: "02011a 08ff4c00 0c03 aabbcc" }))[0], 1300);
	equal(fact(d.seen, "Apple's messages") + " / " + d.rev, "Nearby Info, Handoff / 2", "then both");
	d = devs.heard(pure.reportsIn(advert({ addr: a, pdu: 0, data: "02011a 0aff4c00 1005 0118 9a3c71" }))[0], 1600);
	equal(d.rev, 2, "said again, nothing is new");
	d = devs.heard(pure.reportsIn(advert({ addr: a, pdu: 0, data: "02011a 0aff4c00 1005 0718 9a3c71" }))[0], 1900);
	equal(d.rev + " / " + pure.hex(d.sent), "3 / 02011a0aff4c00100507189a3c71", "said differently, it is; and the last as it was sent is kept");
	// What it answers a scan request with is its own too, and does not change how it advertises
	d = devs.heard(pure.reportsIn(advert({ addr: a, pdu: 4, data: "0509 50686f6e" }))[0], 2000);
	equal(d.seen.name + " / " + pure.PDU[d.pdu] + " / " + d.connectable + " / " + pure.hex(d.sent), "Phon / ADV_IND / true / 02011a0aff4c00100507189a3c71", "an answer adds its name");
	// What it is given is not kept: only a copy
	const params = advert({ addr: "C0:00:00:00:00:04", data: "0509 41424344" }), rep = pure.reportsIn(params)[0];
	d = devs.heard(rep, 3000);
	params.fill(0);
	equal(d.seen.name + " " + pure.hex(d.sent), "ABCD 050941424344", "the page's own copy");
});

test("devices: gone quiet, then forgotten; the order and the search", function () {
	const devs = new pure.Devices({ keep: 60000, quiet: 10000 });
	function hear(a, data, rssi, at) { return devs.heard(pure.reportsIn(advert({ addr: a, data: data, rssi: rssi }))[0], at); }
	hear("C0:00:00:00:00:0A", "0809 5a756c75 2031 31", -80, 1000);
	hear("C0:00:00:00:00:0B", "0609 416c666120", -40, 2000);
	hear("C0:00:00:00:00:0C", "020106", -60, 3000);
	hear("C0:00:00:00:00:0D", "0303edfe", -61, 4000);
	function ids(by) { return pure.order(devs.list(), by).map(function (d) { return d.addr.slice(-1); }).join(""); }
	equal(ids("signal"), "BCDA", "the strongest first; two about as strong, as they came");
	equal(ids("name"), "BACD", "by name, the nameless after, by what their lines say");
	equal(ids("new") + " " + ids("heard"), "DCBA DCBA", "the newest first; the last heard first");
	hear("C0:00:00:00:00:0A", "0809 5a756c75 2031 31", -80, 9000);
	equal(ids("heard"), "ADCB", "heard again");
	const list = devs.list();
	function found(q) { return list.filter(function (d) { return pure.matches(d, q); }).map(function (d) { return d.addr.slice(-1); }).sort().join(""); }
	equal(found("zulu") + " " + found("  TILE ") + " " + found("00:0c") + " " + found("tracker") + " " + found(""), "A D C D ABCD", "found by name, maker, address and kind");
	equal(devs.prune(61500) + " " + devs.list().length, "0 4", "all heard within the time they are kept");
	equal(devs.prune(63500) + " " + ids("heard"), "2 AD", "those not heard for so long are let go");
	equal(devs.total, 4, "but counted");
});

test("the demo's neighbourhood goes the same way as a real one", async function () {
	let now = 1700000000000;
	const be = pure.demoAdapter({ now: function () { return now; }, seed: 7 }), devs = new pure.Devices();
	const st = await be.status();
	equal(st.state + " " + st.adapter + " " + st.address, "listening hci0 00:1A:7D:DA:71:13", "an adapter that listens");
	let seq = 0, n = 0, walker = null, order = true, last = 0;
	async function minute(seconds) {
		for (let i = 0; i < seconds * 4; i++) {
			now += 250;
			const r = await be.reports({ seq: seq });
			atLeast(r.seq, seq, "the count goes on");
			seq = r.seq;
			pure.records(pure.b64dec(r.data)).forEach(function (rec) {
				const at = now - ((r.now - rec.t) >>> 0);
				if (at < last) order = false;
				last = at;
				ok(at <= now && at > now - 300, "each record is of the quarter second just gone");
				pure.reportsIn(rec.p).forEach(function (rep) { if (devs.heard(rep, at)) n++; });
			});
		}
	}
	await minute(45);
	equal(seq, n, "every record is one advertisement, and all are counted");
	ok(order, "in the order they were heard");
	const list = devs.list(), by = {};
	list.forEach(function (d) { by[d.addr] = d; });
	equal(list.length, 18, "those who are always there, and one walking past");
	walker = by["7A:C4:1F:08:B2:6D"];
	ok(walker && walker.seen.kind === "personal", "who is a phone");
	const kinds = {};
	list.forEach(function (d) { kinds[d.seen.kind] = (kinds[d.seen.kind] || 0) + 1; });
	equal(Object.keys(kinds).sort().map(function (k) { return k + " " + kinds[k]; }).join(", "),
		"audio 2, beacon 2, health 1, home 1, input 1, other 2, personal 3, sensor 1, tracker 5", "what they are taken for");
	equal(list.filter(function (d) { return d.seen.tracker && d.seen.tracker.away; }).map(function (d) { return d.seen.what; }).sort().join("; "),
		"a tracker on Google's Find My Device network; an AirTag", "two trackers are away from their owners");
	near(by["1A:44:0C:E7:93:B8"].every, 115, 12, "the laptop is heard about as often as it advertises");
	near(by["EA:0B:0C:0D:0E:0F"].every, 2000, 200, "and the AirTag");
	equal(by["CB:B8:33:4C:88:4F"].seen.what + ", " + fact(by["CB:B8:33:4C:88:4F"].seen, "Temperature").slice(0, 2), "a RuuviTag, 21", "the thermometer reads as the demo has it");
	list.forEach(function (d) { ok(d.rssi <= -30 && d.rssi >= -100 && d.addrKind !== "public", d.addr + ": a strength and an address that could be"); });
	// A minute on: the one who walked past has gone quiet
	await minute(60);
	ok(now - walker.last > 25000 && now - walker.last < 35000, "the walker was last heard as they left");
	ok(now - by["5B:3C:91:0A:44:E2"].last < 2000, "those who stay are still heard");
	atMost(devs.list().length, 19, "nobody else has come who should not");
});

test("what the tests' stand-in adapter (tests/fakebt) sends is read as it should be", function () {
	// (its three devices, as tests/fakebt.c has them)
	const t = seen("020106", "03031a18", "0b0950697261746554656d70");
	equal(t.name + " / " + t.kind + " / " + fact(t, "Service"), "PirateTemp / sensor / Environmental Sensing (0x181A)", "the thermometer");
	equal(seen("020106", "1aff4c000215 f7826da64fa24e988024bc5b71e0893e 0001 0002 c5").what, "an iBeacon", "the beacon");
	equal(tags(seen("1eff4c001219 10 a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6 0100")), "tracker, away from its owner", "the tracker by itself");
	// One of its reports as the daemon would hand it on, at -48 dBm
	const rec = pure.records(record(123456, join([0x02, 1, 0, 0], addr("00:11:22:33:44:55"), [19], hex("020106 03031a18 0b0950697261746554656d70"), [0xd0])))[0];
	const rep = pure.reportsIn(rec.p)[0];
	equal(rec.t + " " + rep.addr + " " + rep.rssi + " " + pure.addrKind(rep.addrType, rep.addr), "123456 00:11:22:33:44:55 -48 public", "who and how strong");
});

if (require.main === module) run("scanner.js: the Bluetooth page's own reckoning").then(function (failed) { process.exit(failed ? 1 : 0); });
else module.exports = function () { return run("scanner.js: the Bluetooth page's own reckoning"); };
