#!/usr/bin/env python3
"""End-to-end test of the Listen page's radio stream (pirate-websdr), against
feed/utils/pirate-websdr/DESIGN.md: Part 1 (the wire protocol) and Part 3 (the
bridge).

    python3 tests/websdr/test_bridge.py --bin feed/utils/pirate-websdr/src/pirate-websdr

starts that binary with --sim (a few times, with different options) and tests
all of it.

    python3 tests/websdr/test_bridge.py --url ws://127.0.0.1:8073/

tests the wire protocol alone against whatever listens there: another
implementation of Part 1, or a bridge that is running already. What only
this bridge can be asked (its options, its signals, what its simulated radio
sends) is left out.

Python's standard library only. Prints "ok - ..." and "FAIL - ..." lines, as
the other tests here do; exit status 1 when anything failed.
"""

import argparse
import base64
import cmath
import hashlib
import json
import math
import os
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
POSIX = os.name == "posix"

OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 1, 2, 8, 9, 10


class Failed(Exception):
    """A check that did not hold."""


class Gone(Exception):
    """The other end hung up."""


class Refused(Exception):
    """The handshake was answered with something other than 101."""

    def __init__(self, status, head, body):
        super().__init__("HTTP %d" % status)
        self.status = status
        self.head = head
        self.body = body


def check(cond, what):
    if not cond:
        raise Failed(what)


def accept_for(key):
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


def encode_frame(opcode, payload=b"", fin=True, mask=True):
    """A client's frame, as RFC 6455 has it."""
    head = bytearray([(0x80 if fin else 0) | opcode])
    n = len(payload)
    m = 0x80 if mask else 0
    if n < 126:
        head.append(m | n)
    elif n < 65536:
        head.append(m | 126)
        head += struct.pack(">H", n)
    else:
        head.append(m | 127)
        head += struct.pack(">Q", n)
    if not mask:
        return bytes(head) + payload
    key = os.urandom(4)
    return bytes(head) + key + bytes(b ^ key[i & 3] for i, b in enumerate(payload))


def decode_frame(buf):
    """One frame off the front of a bytearray: (fin, opcode, masked, payload),
    or None while it is not all there."""
    if len(buf) < 2:
        return None
    fin, opcode = buf[0] & 0x80, buf[0] & 0x0F
    masked, n = buf[1] & 0x80, buf[1] & 0x7F
    off = 2
    if n == 126:
        if len(buf) < 4:
            return None
        n = struct.unpack_from(">H", buf, 2)[0]
        off = 4
    elif n == 127:
        if len(buf) < 10:
            return None
        n = struct.unpack_from(">Q", buf, 2)[0]
        off = 10
    if masked:
        off += 4
    if len(buf) < off + n:
        return None
    payload = bytes(buf[off:off + n])
    if masked:
        key = buf[off - 4:off]
        payload = bytes(b ^ key[i & 3] for i, b in enumerate(payload))
    del buf[:off + n]
    return bool(fin), opcode, bool(masked), payload


class IQ:
    """A binary frame of the stream."""

    def __init__(self, payload):
        check(len(payload) >= 8, "an IQ frame has an 8-byte header")
        self.kind, self.flags, self.reserved, self.seq = struct.unpack_from("<BBHI", payload)
        self.samples = payload[8:]
        self.count = len(self.samples) // 2

    @property
    def discont(self):
        return bool(self.flags & 1)


class WS:
    """A WebSocket client, just enough of one."""

    def __init__(self, host, port, origin=None, rcvbuf=None, path="/", request=None, timeout=5.0):
        self.buf = bytearray()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if rcvbuf:
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
        self.sock.settimeout(timeout)
        self.sock.connect((host, port))
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        if request is None:
            lines = ["GET %s HTTP/1.1" % path, "Host: %s:%d" % (host, port), "Upgrade: websocket",
                     "Connection: Upgrade", "Sec-WebSocket-Key: " + key, "Sec-WebSocket-Version: 13"]
            if origin:
                lines.append("Origin: " + origin)
            request = "\r\n".join(lines) + "\r\n\r\n"
        self.sock.sendall(request.encode())
        while b"\r\n\r\n" not in self.buf:
            data = self.sock.recv(4096)
            if not data:
                raise Gone("hung up during the handshake")
            self.buf += data
        end = self.buf.index(b"\r\n\r\n")
        self.head = bytes(self.buf[:end]).decode("latin-1")
        del self.buf[:end + 4]
        self.status = int(self.head.split(" ", 2)[1])
        if self.status != 101:
            body = bytes(self.buf)
            try:
                while True:
                    data = self.sock.recv(4096)
                    if not data:
                        break
                    body += data
            except OSError:
                pass
            self.sock.close()
            raise Refused(self.status, self.head, body)
        for line in request.split("\r\n"):         # the key of a request that was given whole
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
        got = [l.split(":", 1)[1].strip() for l in self.head.split("\r\n")[1:]
               if l.lower().startswith("sec-websocket-accept:")]
        check(got == [accept_for(key)], "Sec-WebSocket-Accept is base64(SHA-1(key + GUID))")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def send_raw(self, data):
        self.sock.sendall(data)

    def send_frame(self, opcode, payload=b"", fin=True, mask=True):
        self.sock.sendall(encode_frame(opcode, payload, fin, mask))

    def cmd(self, **fields):
        self.send_frame(OP_TEXT, json.dumps(fields).encode())

    def frame(self, timeout=5.0):
        """The next frame: (opcode, payload). Raises Gone when the other end
        hung up, TimeoutError when nothing came."""
        deadline = time.monotonic() + timeout
        while True:
            f = decode_frame(self.buf)
            if f:
                fin, opcode, masked, payload = f
                check(fin, "the bridge does not fragment")
                check(not masked, "the bridge does not mask")
                return opcode, payload
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("nothing came in %.1f s" % timeout)
            self.sock.settimeout(left)
            try:
                data = self.sock.recv(262144)
            except socket.timeout:
                raise TimeoutError("nothing came in %.1f s" % timeout)
            except OSError:
                raise Gone("the connection broke")
            if not data:
                raise Gone("hung up")
            self.buf += data

    def event(self, timeout=5.0):
        """The next frame, read: ("json", object), ("iq", IQ), ("close", code,
        reason), ("ping", payload) or ("pong", payload)."""
        opcode, payload = self.frame(timeout)
        if opcode == OP_TEXT:
            return ("json", json.loads(payload.decode("utf-8")))
        if opcode == OP_BINARY:
            return ("iq", IQ(payload))
        if opcode == OP_CLOSE:
            code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else None
            return ("close", code, payload[2:])
        if opcode == OP_PING:
            return ("ping", payload)
        if opcode == OP_PONG:
            return ("pong", payload)
        raise Failed("a frame with opcode %d" % opcode)

    def wait(self, kind, pred=None, timeout=5.0, errors_ok=False):
        """The next text message of that type (and for which pred holds); IQ
        frames and other messages before it are passed over."""
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise Failed("no %s message in %.1f s" % (kind, timeout))
            try:
                ev = self.event(left)
            except TimeoutError:
                raise Failed("no %s message in %.1f s" % (kind, timeout))
            if ev[0] == "close":
                raise Failed("closed (%s) while waiting for %s" % (ev[1], kind))
            if ev[0] != "json":
                continue
            msg = ev[1]
            if msg.get("type") == kind and (pred is None or pred(msg)):
                return msg
            if msg.get("type") == "error" and kind != "error" and not errors_ok:
                raise Failed("error while waiting for %s: %s" % (kind, msg))

    def iq(self, timeout=5.0):
        """The next IQ frame."""
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise Failed("no IQ frame in %.1f s" % timeout)
            try:
                ev = self.event(left)
            except TimeoutError:
                raise Failed("no IQ frame in %.1f s" % timeout)
            if ev[0] == "iq":
                return ev[1]
            if ev[0] == "close":
                raise Failed("closed (%s) while waiting for an IQ frame" % ev[1])

    def collect(self, seconds):
        """Every event of the next <seconds>."""
        out = []
        deadline = time.monotonic() + seconds
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return out
            try:
                out.append(self.event(left))
            except TimeoutError:
                return out

    def expect_close(self, code, timeout=5.0):
        """A Close frame with that status code, then the connection's end."""
        deadline = time.monotonic() + timeout
        while True:
            ev = self.event(max(0.05, deadline - time.monotonic()))
            if ev[0] == "close":
                check(ev[1] == code, "closed with %s, not %d" % (ev[1], code))
                break
        try:
            while True:
                self.frame(max(0.05, deadline - time.monotonic()))
        except Gone:
            return
        except TimeoutError:
            raise Failed("said goodbye (%d) but did not hang up" % code)

    def open_radio(self, radio, freq, rate):
        """Opens a radio and brings it to that centre and rate: one that was
        open already (shared, or kept from the test before) is given as it is."""
        self.cmd(cmd="open", radio=radio, freq=freq, rate=rate)
        info = self.wait("info", timeout=10)        # (the bridge takes 2 s between a close and an open)
        check(info["radio"] == radio, "info names the radio that was asked for")
        if info["rate"] != rate:
            self.cmd(cmd="rate", hz=rate)
            info = self.wait("info", lambda m: m["rate"] == rate)
        if info["freq"] != freq:
            self.cmd(cmd="freq", hz=freq)
            self.wait("status", lambda m: m["freq"] == freq)
            info["freq"] = freq
        return info


def pace(ws, seconds):
    """How fast the radio makes samples: (samples, seconds), by the sequence
    numbers of the frames of the next <seconds> and when they came. Frames
    this reader missed do not count against the radio."""
    first = ws.iq()
    t0 = t1 = time.monotonic()
    last = first
    while t1 - t0 < seconds:
        last = ws.iq()
        t1 = time.monotonic()
    return (last.seq - first.seq) * first.count, t1 - t0


def tone_power(samples, rate, hz, n=4096):
    """The power of the signal at +hz in I + jQ (int8 pairs), 1.0 being a
    full-scale tone: the stream correlated with that tone."""
    n = min(n, len(samples) // 2)
    step = cmath.exp(-2j * math.pi * hz / rate)
    rot = 1 + 0j
    acc = 0j
    for k in range(n):
        i, q = samples[2 * k], samples[2 * k + 1]
        i = i - 256 if i > 127 else i
        q = q - 256 if q > 127 else q
        acc += complex(i, q) * rot
        rot *= step
    return (abs(acc) / n / 127.0) ** 2


# ---------- the bridge under test ----------

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Bridge:
    """A pirate-websdr started with --sim on a port of its own (sim=False:
    with whatever it has for a radio, which test_radio.py makes a stand-in)."""

    last = None         # the one started last: its log is shown when a test fails

    def __init__(self, binary, *args, env=None, sim=True):
        Bridge.last = self
        self.final_log = None
        self.host = "127.0.0.1"
        self.port = free_port()
        self.log = tempfile.NamedTemporaryFile(prefix="websdr-test-", suffix=".log", delete=False)
        full = dict(os.environ)
        full.update(env or {})
        self.proc = subprocess.Popen([binary] + (["--sim"] if sim else []) + ["--port", str(self.port)] + list(args),
                                     stdout=self.log, stderr=self.log, env=full)
        deadline = time.monotonic() + 5
        while True:
            try:
                socket.create_connection((self.host, self.port), timeout=0.5).close()
                break
            except OSError:
                if self.proc.poll() is not None or time.monotonic() > deadline:
                    raise Failed("the bridge did not start: " + self.log_text())
                time.sleep(0.05)

    def connect(self, **kw):
        return WS(self.host, self.port, **kw)

    def log_text(self):
        if self.final_log is not None:
            return self.final_log
        try:
            with open(self.log.name, "r", errors="replace") as f:
                return f.read()
        except OSError:
            return ""

    def stop(self):
        """Asks it to stop; its exit status (None if it had to be killed)."""
        status = None
        if self.final_log is not None:
            return self.proc.returncode
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                status = self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        else:
            status = self.proc.returncode
        text = self.log_text()
        self.log.close()
        try:
            os.unlink(self.log.name)
        except OSError:
            pass
        self.final_log = text
        return status


class Remote:
    """Something that speaks Part 1 already, at a ws:// address."""

    def __init__(self, url):
        check(url.startswith("ws://"), "--url is ws://host:port/")
        hostport = url[5:].split("/", 1)[0]
        self.host, _, port = hostport.partition(":")
        self.port = int(port or 80)

    def connect(self, **kw):
        return WS(self.host, self.port, **kw)

    def log_text(self):
        return ""


# ---------- the wire protocol (Part 1): any implementation ----------

LOW = ("rtlsdr", 100000000, 240000)     # light: 0.48 MB/s, a test's default


def t_hello(srv):
    ws = srv.connect()
    try:
        opcode, payload = ws.frame()
        check(opcode == OP_TEXT, "the first frame is text")
        hello = json.loads(payload.decode())
        check(hello.get("type") == "hello", "the first message is hello")
        check(hello.get("proto") == 1, "hello.proto is 1")
        check(isinstance(hello.get("server"), str) and hello["server"], "hello.server names it")
        check(isinstance(hello.get("sim"), bool), "hello.sim is a boolean")
        check("open" in hello and hello["open"] in (None, "hackrf", "rtlsdr"), "hello.open is a radio or null")
    finally:
        ws.close()


def t_open(srv):
    ws = srv.connect()
    try:
        ws.wait("hello")
        radio, freq, rate = LOW
        ws.cmd(cmd="open", radio=radio, freq=freq, rate=rate)
        info = ws.wait("info")
        for key, kind in (("radio", str), ("label", str), ("freq", (int, float)), ("rate", (int, float)),
                          ("frame", int), ("rates", list), ("range", list), ("gains", list)):
            check(isinstance(info.get(key), kind), "info.%s is there" % key)
        check(info["radio"] == radio, "info.radio is the one opened")
        check(info["rate"] in info["rates"], "info.rate is one of info.rates")
        check(all(r % 48000 == 0 for r in info["rates"]), "every rate is a multiple of 48000")
        check(len(info["range"]) == 2 and info["range"][0] < info["range"][1], "info.range is [low, high]")
        check(len(info["gains"]) >= 1, "the radio has a gain element")
        for g in info["gains"]:
            for key in ("name", "min", "max", "step", "value"):
                check(key in g, "a gain element has %s" % key)
            check(g["min"] <= g["value"] <= g["max"], "a gain is within its range")
        status = ws.wait("status")
        for key in ("freq", "rate", "gains", "clients", "dropped", "overflows"):
            check(key in status, "status.%s is there" % key)
        check(isinstance(status["gains"], dict), "status.gains maps names to dB")
        check(set(status["gains"]) == set(g["name"] for g in info["gains"]), "status.gains has info's elements")
        check(status["clients"] >= 1, "status.clients counts this one")

        info = ws.open_radio(radio, freq, rate)
        check(info["frame"] == min(rate // 50, 48000), "frame is min(rate / 50, 48000)")
        frames = [ws.iq() for _ in range(12)]
        for f in frames:
            check(f.kind == 1, "an IQ frame's first byte is 1")
            check(f.reserved == 0, "its reserved bytes are 0")
            check(f.flags & ~1 == 0, "only the discontinuity flag is used")
            check(f.count == info["frame"], "an IQ frame holds info.frame samples (%d, not %d)" % (info["frame"], f.count))
        seqs = [f.seq for f in frames]
        check(seqs == list(range(seqs[0], seqs[0] + len(seqs))), "sequence numbers go up by one: %s" % seqs)

        # in real time: a second of frames is about a second of signal
        got, took = pace(ws, 1.0)
        check(0.7 * rate * took < got < 1.3 * rate * took, "the stream runs in real time (%d samples in %.2f s)" % (got, took))
    finally:
        ws.close()


def t_freq(srv):
    ws = srv.connect()
    try:
        radio, freq, rate = LOW
        ws.open_radio(radio, freq, rate)
        ws.iq()
        new = freq + 300000
        ws.cmd(cmd="freq", hz=new)
        status = ws.wait("status", lambda m: m["freq"] == new)
        check(status["rate"] == rate, "a new centre leaves the rate alone")
        first = ws.iq()
        check(first.discont, "the first frame after a new centre's status is flagged a discontinuity")
        prev = first
        for _ in range(4):
            f = ws.iq()
            check(not f.discont or f.seq != prev.seq + 1, "frames that follow without a gap are not flagged")
            prev = f
    finally:
        ws.close()


def t_rate(srv):
    ws = srv.connect()
    try:
        radio, freq, rate = LOW
        info = ws.open_radio(radio, freq, rate)
        other = [r for r in info["rates"] if r != rate][0]
        ws.cmd(cmd="rate", hz=other)
        # info (the new frame size) and status (the new rate), in either order,
        # and only then frames of the new size
        info = status = None
        while not (info and status):
            ev = ws.event()
            if ev[0] == "json" and ev[1]["type"] == "info" and ev[1]["rate"] == other:
                info = ev[1]
            elif ev[0] == "json" and ev[1]["type"] == "status" and ev[1]["rate"] == other:
                status = ev[1]
            elif ev[0] == "json" and ev[1]["type"] == "error":
                raise Failed("the rate was refused: %s" % ev[1])
            elif ev[0] == "iq":
                check(ev[1].count == min(rate // 50, 48000), "no frame of the new size before info and status say so")
        check(info["frame"] == min(other // 50, 48000), "info.frame follows the rate")
        first = ws.iq()
        check(first.discont, "the first frame at the new rate is flagged a discontinuity")
        check(first.count == info["frame"], "frames at the new rate hold the new info.frame samples")
        infos = [info]

        ws.cmd(cmd="rate", hz=1234567)
        err = ws.wait("error")
        check(err["code"] == "badrequest", "a rate that is not offered is a badrequest")
        check(ws.iq().count == infos[-1]["frame"], "the stream goes on after it")
        ws.open_radio(radio, freq, rate)
    finally:
        ws.close()


def t_gain(srv):
    ws = srv.connect()
    try:
        radio, freq, rate = LOW
        info = ws.open_radio(radio, freq, rate)
        g = info["gains"][0]
        ws.cmd(cmd="gain", name=g["name"], value=g["max"] + 1000)
        status = ws.wait("status", lambda m: m["gains"][g["name"]] == g["max"])
        ws.cmd(cmd="gain", name=g["name"], value=g["min"] - 1000)
        status = ws.wait("status", lambda m: m["gains"][g["name"]] == g["min"])
        check(status["freq"] == freq and status["rate"] == rate, "a gain leaves centre and rate alone")
        ws.cmd(cmd="gain", name="NOSUCH", value=1)
        check(ws.wait("error")["code"] == "badrequest", "a gain element the radio has not is a badrequest")
        ws.cmd(cmd="gain", name=g["name"], value=g["value"])
        ws.wait("status", lambda m: m["gains"][g["name"]] == g["value"])
    finally:
        ws.close()


def t_ping(srv):
    ws = srv.connect()
    try:
        ws.cmd(cmd="ping", t=1234)
        check(ws.wait("pong")["t"] == 1234, "pong carries ping's t")
        ws.cmd(cmd="ping", t=1731200000123.5)
        check(ws.wait("pong")["t"] == 1731200000123.5, "pong carries a large, fractional t exactly")
    finally:
        ws.close()


def t_close(srv):
    ws = srv.connect()
    try:
        radio, freq, rate = LOW
        ws.open_radio(radio, freq, rate)
        ws.iq()
        ws.cmd(cmd="close")
        closed = ws.wait("closed")
        check(isinstance(closed.get("reason"), str), "closed says why")
        after = ws.collect(0.6)
        check(not any(ev[0] == "iq" for ev in after), "no frames after closed")
        ws.cmd(cmd="ping", t=7)
        check(ws.wait("pong")["t"] == 7, "the socket stays open after closed")
        ws.cmd(cmd="freq", hz=freq)
        check(ws.wait("error")["code"] == "badrequest", "freq with no radio open is a badrequest")
        ws.open_radio(radio, freq, rate)
        check(ws.iq().count > 0, "it opens again")
    finally:
        ws.close()


def t_errors(srv):
    ws = srv.connect()
    try:
        ws.wait("hello")
        bad = [b'{"cmd":"dance"}', b'not json', b'{"cmd":"open","radio":"hackrf"', b'["open"]',
               b'{"cmd":{"open":1}}', b'{"cmd":"open","radio":["hackrf"]}', b'{"radio":"hackrf"}',
               b'{"cmd":"open","radio":"wifi"}', b'{"cmd":"open"}',
               b'{"cmd":"freq","hz":100000000}', b'{"cmd":"rate","hz":2400000}',
               b'{"cmd":"gain","name":"LNA","value":8}', b'{"cmd":"open","radio":"hackrf"} x', b'{}']
        for text in bad:
            ws.send_frame(OP_TEXT, text)
            err = ws.wait("error")
            check(err["code"] == "badrequest", "%r is a badrequest, not %s" % (text, err["code"]))
            check(isinstance(err.get("message"), str), "an error has a message")
        ws.cmd(cmd="ping", t=1, more="unknown keys are ignored")
        check(ws.wait("pong")["t"] == 1, "the socket is fine after the errors")
    finally:
        ws.close()


def t_share(srv):
    a = srv.connect()
    b = None
    try:
        radio, freq, rate = LOW
        a.open_radio(radio, freq, rate)
        b = srv.connect()
        hello = b.wait("hello")
        check(hello["open"] == radio, "hello.open names the radio in use")
        b.cmd(cmd="open", radio=radio, freq=freq + 500000, rate=rate)
        info = b.wait("info")
        check(info["freq"] == freq, "a joiner takes the radio as it is")
        a.wait("status", lambda m: m["clients"] == 2)
        b.wait("status", lambda m: m["clients"] == 2)
        fa, fb = a.iq(), b.iq()
        for _ in range(8):
            if fa.seq < fb.seq:
                fa = a.iq()
            elif fb.seq < fa.seq:
                fb = b.iq()
        check(fa.seq == fb.seq and fa.samples == fb.samples, "both get the same frames")
        new = freq + 200000
        b.cmd(cmd="freq", hz=new)
        a.wait("status", lambda m: m["freq"] == new)
        b.wait("status", lambda m: m["freq"] == new)
        b.cmd(cmd="close")
        b.wait("closed")
        a.wait("status", lambda m: m["clients"] == 1)
        check(a.iq().count > 0, "the one left still gets the stream")
    finally:
        a.close()
        if b:
            b.close()


def t_busy(srv):
    a = srv.connect()
    b = srv.connect()
    try:
        radio, freq, rate = LOW
        a.open_radio(radio, freq, rate)
        b.wait("hello")
        b.cmd(cmd="open", radio="hackrf")
        err = b.wait("error")
        check(err["code"] == "busy", "the other radio, while one is in use, is busy (%s)" % err["code"])
        b.cmd(cmd="ping", t=3)
        check(b.wait("pong")["t"] == 3, "and the socket is fine")
        check(a.iq().count > 0, "the one listening is not disturbed")
    finally:
        a.close()
        b.close()


def t_frames_ws(srv):
    ws = srv.connect()
    try:
        ws.wait("hello")
        ws.send_frame(OP_PING, b"are you there")
        while True:
            ev = ws.event()
            if ev[0] == "pong":
                check(ev[1] == b"are you there", "a ping frame is answered with its payload")
                break
        ws.send_frame(OP_CLOSE, struct.pack(">H", 1000))
        ws.expect_close(1000)
    finally:
        ws.close()
    ws = srv.connect()
    try:
        ws.wait("hello")
        ws.send_frame(OP_BINARY, b"\x01\x02\x03")
        ws.expect_close(1003)
    finally:
        ws.close()


PORTABLE = [
    ("hello comes first", t_hello),
    ("open: info, status, frames in real time", t_open),
    ("freq: status first, then a flagged frame", t_freq),
    ("rate: info, status, frames of the new size", t_rate),
    ("gain: clamped, and reported", t_gain),
    ("ping and pong", t_ping),
    ("close stops the frames, not the socket", t_close),
    ("bad commands are errors", t_errors),
    ("two listeners share one radio", t_share),
    ("one radio at a time", t_busy),
    ("ping, close and binary frames", t_frames_ws),
]


# ---------- the bridge itself (Part 3): --bin only ----------

def t_sim_signals(srv):
    """The simulated radio: a carrier 100 kHz above every whole MHz."""
    ws = srv.connect()
    try:
        rate = 960000
        ws.open_radio("rtlsdr", 100000000, rate)
        ws.iq()
        f = ws.iq()
        on, mirror, off = (tone_power(f.samples, rate, hz) for hz in (100000, -100000, 250000))
        check(on > 100 * mirror, "the carrier is at +100 kHz, not -100 kHz (I and Q the right way round): %.2e, %.2e" % (on, mirror))
        check(on > 100 * off, "and stands out of the noise: %.2e, %.2e" % (on, off))
        check(0.01 < on < 0.2, "at about a fifth of full scale: %.3f" % on)

        ws.cmd(cmd="freq", hz=100050000)
        ws.wait("status", lambda m: m["freq"] == 100050000)
        ws.iq()
        f = ws.iq()
        moved, stayed = tone_power(f.samples, rate, 50000), tone_power(f.samples, rate, 100000)
        check(moved > 100 * stayed, "tuning 50 kHz up moves it 50 kHz down: %.2e, %.2e" % (moved, stayed))
    finally:
        ws.close()


def t_sim_gain(srv):
    ws = srv.connect()
    try:
        rate = 2400000
        info = ws.open_radio("hackrf", 100000000, rate)
        check([g["name"] for g in info["gains"]] == ["LNA", "AMP", "VGA"], "the HackRF's gains are LNA, AMP, VGA")
        byname = dict((g["name"], g) for g in info["gains"])
        check((byname["LNA"]["value"], byname["VGA"]["value"], byname["AMP"]["value"]) == (24, 20, 0),
              "at their defaults: 24, 20, 0")
        check(info["rates"] == [2400000, 4800000, 9600000], "the HackRF's rates")
        check(info["frame"] == 48000, "48000 samples a frame at 2.4 Msps")

        def level():
            ws.iq()
            return tone_power(ws.iq().samples, rate, 100000)

        ws.cmd(cmd="gain", name="LNA", value=20)        # a step of 8: 16 or 24
        st = ws.wait("status", lambda m: m["gains"]["LNA"] in (16, 24))
        ws.cmd(cmd="gain", name="LNA", value=24)
        ws.wait("status", lambda m: m["gains"]["LNA"] == 24)
        base = level()
        ws.cmd(cmd="gain", name="LNA", value=8)
        ws.wait("status", lambda m: m["gains"]["LNA"] == 8)
        low = level()
        check(low * 10 < base, "16 dB less gain, a weaker signal: %.2e, %.2e" % (low, base))
        ws.cmd(cmd="gain", name="LNA", value=24)
        ws.wait("status", lambda m: m["gains"]["LNA"] == 24)
        check(st is not None, "gains snap to their steps")
    finally:
        ws.close()


def t_rates(srv):
    """Every rate of both radios: the right frame, in real time."""
    for radio, rates in (("rtlsdr", [240000, 960000, 1200000, 1920000, 2400000]),
                         ("hackrf", [2400000, 4800000, 9600000])):
        ws = srv.connect()
        try:
            info = ws.open_radio(radio, 100000000, rates[0])
            check(info["rates"] == rates, "%s offers %s" % (radio, rates))
            for rate in rates:
                if rate != rates[0]:
                    ws.cmd(cmd="rate", hz=rate)
                    info = ws.wait("info", lambda m: m["rate"] == rate)
                check(info["frame"] == min(rate // 50, 48000), "%d: frame is %d" % (rate, info["frame"]))
                check(ws.iq().count == info["frame"], "%d: frames hold info.frame samples" % rate)
                got, took = pace(ws, 0.6)
                check(0.7 * rate * took < got < 1.3 * rate * took,
                      "%s at %d samples a second runs in real time (%d in %.2f s)" % (radio, rate, got, took))
            ws.cmd(cmd="close")
            ws.wait("closed")
        finally:
            ws.close()
        time.sleep(0.2)


def t_limits(srv):
    """What the radio cannot do is said, and changes nothing."""
    ws = srv.connect()
    try:
        radio, freq, rate = LOW
        info = ws.open_radio(radio, freq, rate)
        for hz in (1, info["range"][0] - 1, info["range"][1] + 1, 1e12, 1e300, -1e300):
            ws.cmd(cmd="freq", hz=hz)
            err = ws.wait("error")
            check(err["code"] == "failed", "a centre outside the radio's range is failed, not %s" % err["code"])
        ws.cmd(cmd="open", radio=radio, rate=1000)
        check(ws.wait("error")["code"] == "badrequest", "open with a rate the radio has not is a badrequest")
        for hz in (-5, 0, 1e300):
            ws.cmd(cmd="open", radio=radio, freq=hz)
            check(ws.wait("error")["code"] == "badrequest", "open with a centre of %g is a badrequest" % hz)
        ws.cmd(cmd="gain", name=info["gains"][0]["name"], value=1e300)
        ws.wait("status", lambda m: m["gains"][info["gains"][0]["name"]] == info["gains"][0]["max"])
        ws.cmd(cmd="gain", name=info["gains"][0]["name"], value=info["gains"][0]["value"])
        ws.wait("status", lambda m: m["gains"][info["gains"][0]["name"]] == info["gains"][0]["value"])
        ws.cmd(cmd="freq", hz="100e6")
        check(ws.wait("error")["code"] == "badrequest", "a centre given as text is a badrequest")
        status = ws.wait("status")
        check(status["freq"] == freq and status["rate"] == rate, "the radio is where it was")
        check(ws.iq().count == info["frame"], "and the stream goes on")
    finally:
        ws.close()
    # a centre outside the range, given with open: the nearest the radio has
    time.sleep(0.2)
    other = "hackrf" if LOW[0] == "rtlsdr" else "rtlsdr"
    ws = srv.connect()
    try:
        ws.wait("hello")
        ws.cmd(cmd="open", radio=other, freq=5)
        info = ws.wait("info", timeout=8)
        check(info["freq"] == info["range"][0], "open with a centre below the range starts at its low end")
        ws.iq()
    finally:
        ws.close()


def t_hurry(srv):
    """Stop and start in a hurry: the radio's receiver is given half a second."""
    ws = srv.connect()
    try:
        radio, freq, rate = LOW
        ws.open_radio(radio, freq, rate)
        ws.iq()
        for _ in range(3):
            ws.cmd(cmd="close")
            ws.wait("closed")
            t0 = time.monotonic()
            ws.cmd(cmd="open", radio=radio)
            info = ws.wait("info")
            check(time.monotonic() - t0 < 0.3, "info comes at once")
            check(info["freq"] == freq and info["rate"] == rate, "the radio is as it was left")
            f = ws.iq()
            took = time.monotonic() - t0
            check(f.discont, "the first frame after a start is flagged a discontinuity")
            check(0.35 < took < 2.0, "the stream starts half a second after it stopped (%.2f s)" % took)
    finally:
        ws.close()


def t_slow_client(srv):
    """One that stops reading loses frames; the other loses nothing."""
    # a slow stream: what the sockets hold of it is long, so only a real
    # stall (the 3 s here), not a busy test machine, makes a listener late
    rate = 240000
    a = srv.connect()
    b = srv.connect(rcvbuf=32768)
    try:
        a.open_radio("rtlsdr", 100000000, rate)
        b.wait("hello")
        b.cmd(cmd="open", radio="rtlsdr")
        b.wait("info")
        b.iq()
        seqs = [ev[1].seq for ev in a.collect(3.0) if ev[0] == "iq"]      # b reads nothing meanwhile
        check(len(seqs) > 100, "the reader got its stream: %d frames" % len(seqs))
        missing = seqs[-1] - seqs[0] + 1 - len(seqs)
        check(missing <= 2, "the reader lost nothing to the one that stalled (%d frames)" % missing)
        prev, gap, flagged = None, False, False
        deadline = time.monotonic() + 8
        status = None
        while time.monotonic() < deadline and not (gap and flagged and status and status["dropped"] > 0):
            ev = b.event(5)
            if ev[0] == "iq":
                if prev is not None and ev[1].seq != prev + 1:
                    gap = True
                    flagged = flagged or ev[1].discont
                prev = ev[1].seq
            elif ev[0] == "json" and ev[1]["type"] == "status":
                status = ev[1]
            a.collect(0.01)
        check(gap, "the one that stalled missed frames")
        check(flagged, "and the frame after the gap is flagged a discontinuity")
        check(status and status["dropped"] > 0, "and its status counts them: %s" % (status and status["dropped"]))
        sa = a.wait("status")
        check(sa["dropped"] <= 2, "while the reader's status counts none: %d" % sa["dropped"])
    finally:
        a.close()
        b.close()


def t_strict(srv):
    """What a client may not send."""
    for what, send, code in (
            ("a frame that is not masked", lambda ws: ws.send_frame(OP_TEXT, b'{"cmd":"ping"}', mask=False), 1002),
            ("a message over 512 bytes", lambda ws: ws.send_frame(OP_TEXT, b'{"cmd":"ping","x":"' + b"y" * 600 + b'"}'), 1009),
            ("a message of 70000 bytes", lambda ws: ws.send_raw(encode_frame(OP_TEXT, b"z" * 70000)[:2000]), 1009),
            ("a message in pieces", lambda ws: ws.send_frame(OP_TEXT, b'{"cmd":', fin=False), 1009),
            ("a continuation", lambda ws: ws.send_frame(0, b'"ping"}'), 1009),
            ("reserved bits", lambda ws: ws.send_raw(bytes([0xC1, 0x80, 1, 2, 3, 4])), 1002),
            ("an opcode nobody knows", lambda ws: ws.send_frame(0x3, b""), 1002),
            ("a ping in pieces", lambda ws: ws.send_frame(OP_PING, b"x", fin=False), 1002)):
        ws = srv.connect()
        try:
            ws.wait("hello")
            send(ws)
            try:
                ws.expect_close(code)
            except Failed as e:
                raise Failed("%s: %s" % (what, e))
        finally:
            ws.close()
    # a message of exactly 512 bytes is fine
    ws = srv.connect()
    try:
        ws.wait("hello")
        text = b'{"cmd":"ping","t":5,"pad":"'
        text += b"p" * (512 - len(text) - 2) + b'"}'
        check(len(text) == 512, "(the test's own arithmetic)")
        ws.send_frame(OP_TEXT, text)
        check(ws.wait("pong")["t"] == 5, "512 bytes are taken")
        # two commands in one packet, and one in two
        ws.send_raw(encode_frame(OP_TEXT, b'{"cmd":"ping","t":8}') + encode_frame(OP_TEXT, b'{"cmd":"ping","t":9}'))
        check(ws.wait("pong")["t"] == 8 and ws.wait("pong")["t"] == 9, "frames that arrive together are both read")
        whole = encode_frame(OP_TEXT, b'{"cmd":"ping","t":10}')
        ws.send_raw(whole[:5])
        time.sleep(0.2)
        ws.send_raw(whole[5:])
        check(ws.wait("pong")["t"] == 10, "and one that arrives in two parts")
    finally:
        ws.close()


def t_compact(srv):
    """What the bridge says is compact JSON, "type" first: the rootfs test
    (tests/rootfs-test.sh) greps the greeting for it, with nc and no JSON parser."""
    ws = srv.connect(request="GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                             "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
    try:
        check("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" in ws.head, "RFC 6455's example key gets its example answer")
        opcode, hello = ws.frame()
        check(opcode == OP_TEXT and hello.startswith(b'{"type":"hello","proto":1,'),
              'the greeting begins {"type":"hello","proto":1, : %r' % hello[:40])
        radio, freq, rate = LOW
        ws.cmd(cmd="open", radio=radio, freq=freq, rate=rate)
        ws.cmd(cmd="ping", t=1)
        ws.cmd(cmd="nonsense")
        ws.cmd(cmd="close")
        seen = {}
        deadline = time.monotonic() + 10
        while len(seen) < 5 and time.monotonic() < deadline:
            opcode, payload = ws.frame(10)
            if opcode != OP_TEXT:
                continue
            kind = json.loads(payload.decode())["type"]
            seen[kind] = payload
            check(payload.startswith(b'{"type":"' + kind.encode() + b'",'), "%s begins with its type: %r" % (kind, payload[:40]))
            outside = b"".join(payload.split(b'"')[0::2])       # what is not inside a text
            check(b" " not in outside and b"\n" not in outside, "%s has no blanks between its parts: %r" % (kind, payload[:60]))
        check(set(seen) == {"info", "status", "pong", "error", "closed"}, "info, status, pong, error and closed were all seen: %s" % sorted(seen))
    finally:
        ws.close()

    # the rootfs test's other two requests, byte for byte
    def first_line(request):
        s = socket.create_connection((srv.host, srv.port), timeout=5)
        try:
            s.sendall(request)
            data = b""
            while b"\r\n" not in data:
                more = s.recv(4096)
                if not more:
                    break
                data += more
            return data.split(b"\r\n")[0]
        finally:
            s.close()

    line = first_line(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    check(b" 426 " in line, "a plain request's status line has 426: %r" % line)
    line = first_line(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://elsewhere.example\r\nUpgrade: websocket\r\n"
                      b"Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
    check(b" 403 " in line, "another site's page gets a status line with 403: %r" % line)


def t_garbage(srv):
    """Whatever is thrown at it, it stays up: random requests, frames, commands."""
    import random
    rnd = random.Random(8073)

    def noise(n):
        return bytes(rnd.getrandbits(8) for _ in range(n))

    def frame():
        b0 = rnd.choice([0x81, 0x82, 0x80, 0x01, 0x88, 0x89, 0x8A, rnd.getrandbits(8)])
        mask = 0x80 if rnd.random() < 0.9 else 0
        kind = rnd.random()
        if kind < 0.6:
            n = rnd.randint(0, 125)
            head = bytes([b0, mask | n])
        elif kind < 0.85:
            n = rnd.choice([0, 1, 126, 300, 512, 513, 700, 65535])
            head = bytes([b0, mask | 126]) + struct.pack(">H", n)
        else:
            n = rnd.choice([0, 100, 70000, 2 ** 40])
            head = bytes([b0, mask | 127]) + struct.pack(">Q", n)
        return head + (noise(4) if mask else b"") + noise(min(n, rnd.choice([0, n, n // 2]), 1500))

    def command():
        o = {}
        if rnd.random() < 0.95:
            o["cmd"] = rnd.choice(["open", "freq", "rate", "gain", "close", "ping", "x", ""])
        for k in rnd.sample(["radio", "freq", "rate", "hz", "name", "value", "t", "zz" * 20], rnd.randint(0, 5)):
            o[k] = rnd.choice(["hackrf", "rtlsdr", "LNA", "VGA", "AMP", "TUNER", "q" * 200, 0, -1, 1, 98e6,
                               2400000, 240000, 9600000, 1e308, -1e308, 1e-300, 5e9, 7.5, True, False, None,
                               "é\u0000\n\"\\"])
        s = json.dumps(o)
        r = rnd.random()
        if r < 0.1:
            s = s[:rnd.randint(0, len(s))]
        elif r < 0.15:
            s = s.replace(":", rnd.choice(["", "::", ",", "[", "{"]), 1)
        elif r < 0.2:
            s = "[" + s + "]"
        elif r < 0.25:
            s = s.replace("{", '{"n":{"a":1},', 1)
        return s.encode()[:rnd.choice([400, 512, 513, 2000])]

    for i in range(120):
        mode = rnd.randint(0, 3)
        try:
            if mode == 0:
                s = socket.create_connection((srv.host, srv.port), timeout=2)
                s.sendall(noise(rnd.choice([0, 1, 10, 100, 1000, 4095, 4096, 6000])) +
                          rnd.choice([b"", b"\r\n\r\n", b"GET / HTTP/1.1\r\n\r\n"]))
                s.close()
                continue
            ws = srv.connect(timeout=2)
            try:
                if mode == 1:
                    ws.send_raw(noise(rnd.choice([1, 2, 3, 10, 500, 3000])))
                elif mode == 2:
                    for _ in range(rnd.randint(1, 12)):
                        ws.send_raw(frame())
                else:
                    for _ in range(rnd.randint(1, 25)):
                        ws.send_frame(OP_TEXT, command())
                if rnd.random() < 0.3:
                    ws.collect(0.02)
            finally:
                ws.close()
        except (OSError, Gone, Refused, Failed, TimeoutError, ValueError, KeyError, TypeError, struct.error):
            pass                                    # it may well hang up on this
        if i % 20 == 19:
            for attempt in range(10):               # (its sockets may all be taken for a moment)
                try:
                    ws = srv.connect()
                    break
                except (Refused, OSError):
                    if attempt == 9:
                        raise Failed("it takes no connection any more (round %d)" % i)
                    time.sleep(0.3)
            try:
                ws.cmd(cmd="ping", t=i)
                check(ws.wait("pong", timeout=8, errors_ok=True)["t"] == i, "it still answers")
            finally:
                ws.close()
    time.sleep(1.2)                                 # the ones it told to go are gone
    ws = srv.connect()
    try:
        radio, freq, rate = LOW
        ws.open_radio(radio, freq, rate)
        check(ws.iq().count == rate // 50, "and still streams")
    finally:
        ws.close()


def t_http(srv):
    def refused(**kw):
        try:
            srv.connect(**kw).close()
        except Refused as r:
            return r
        raise Failed("it was let in")

    host = "%s:%d" % (srv.host, srv.port)
    r = refused(request="GET / HTTP/1.1\r\nHost: %s\r\n\r\n" % host)
    check(r.status == 426, "a plain GET is answered 426, not %d" % r.status)
    check(b"WebSocket" in r.body, "and told what this is")
    r = refused(request="POST / HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\n\r\n" % host)
    check(r.status == 400, "a POST is answered 400, not %d" % r.status)
    r = refused(request="GET / HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n\r\n" % host)
    check(r.status == 426 and "sec-websocket-version: 13" in r.head.lower(), "an old WebSocket version is answered 426 and 13")
    r = refused(request="GET / HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        "Sec-WebSocket-Version: 13\r\n\r\n" % host)
    check(r.status == 400, "no key is answered 400, not %d" % r.status)
    r = refused(request="GET /" + "x" * 5000 + " HTTP/1.1\r\nHost: %s\r\n\r\n" % host)
    check(r.status == 400, "an endless request is answered 400, not %d" % r.status)

    r = refused(origin="http://evil.example")
    check(r.status == 403, "a page of another site is answered 403, not %d" % r.status)
    r = refused(origin="null")
    check(r.status == 403, "a page of no site is answered 403, not %d" % r.status)
    for origin in ("http://%s" % srv.host, "http://%s:8080" % srv.host, "https://%s" % srv.host.upper()):
        ws = srv.connect(origin=origin)
        ws.wait("hello")
        ws.close()

    # A page under a name that somebody else's DNS points at this machine (DNS
    # rebinding): the page's host and the request's agree, and still it is
    # not ours. The machine is reached by an address, "localhost", or its own
    # name (alone, or as its network knows it: .local, .lan).
    def named(name):
        return ("GET / HTTP/1.1\r\nHost: %s:%d\r\nOrigin: http://%s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n" % (name, srv.port, name))

    me = socket.gethostname()
    for name in ("evil.example", me + ".evil.example", "x" + me, me + ".local.evil.example"):
        r = refused(request=named(name))
        check(r.status == 403, "a page under the name %s is answered 403, not %d" % (name, r.status))
    for name in ("localhost", me, me.upper(), me + ".local", me + ".lan", "[::1]"):
        ws = srv.connect(request=named(name))
        ws.wait("hello")
        ws.close()
    # Firefox's Connection header, and letter case
    ws = srv.connect(request="GET /stream HTTP/1.1\r\nhost: %s\r\nupgrade: WebSocket\r\nconnection: keep-alive, Upgrade\r\n"
                             "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n" % host)
    check("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" in ws.head, "RFC 6455's own example key gives its example answer")
    ws.wait("hello")
    ws.close()
    # a request that dribbles in
    s = socket.create_connection((srv.host, srv.port), timeout=5)
    for part in ("GET / HT", "TP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upg" % host,
                 "rade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n", "\r\n"):
        s.sendall(part.encode())
        time.sleep(0.1)
    check(s.recv(4096).startswith(b"HTTP/1.1 101"), "a request in several packets is put together")
    s.close()


def t_any_origin(binary):
    srv = Bridge(binary, "--any-origin")
    try:
        ws = srv.connect(origin="http://elsewhere.example")
        ws.wait("hello")
        ws.close()
    finally:
        srv.stop()


def t_max_clients(binary):
    srv = Bridge(binary, "--max-clients", "2")
    try:
        a, b = srv.connect(), srv.connect()
        a.wait("hello")
        b.wait("hello")
        try:
            srv.connect().close()
            raise Failed("a third listener was let in")
        except Refused as r:
            check(r.status == 503, "the one too many is answered 503, not %d" % r.status)
        a.close()
        time.sleep(0.3)
        c = srv.connect()
        c.wait("hello")
        c.close()
        b.close()
    finally:
        srv.stop()


def t_linger(binary):
    """The state file, and the radio kept open a while for whoever comes back."""
    state = os.path.join(tempfile.mkdtemp(prefix="websdr-test-"), "websdr")
    with open(state, "w") as f:
        f.write("stale\n")
    srv = Bridge(binary, "--linger", "1.5", "--state-file", state)
    try:
        check(not os.path.exists(state), "a state file left by an earlier run is removed")
        ws = srv.connect()
        check(ws.wait("hello")["open"] is None, "nothing is open at first")
        ws.open_radio("hackrf", 100000000, 2400000)
        with open(state) as f:
            check(f.read() == "hackrf\n", "the state file names the radio that is open")
        other = srv.connect()
        check(other.wait("hello")["open"] == "hackrf", "hello.open names it")
        other.close()
        ws.cmd(cmd="close")
        ws.wait("closed")
        t0 = time.monotonic()
        check(os.path.exists(state), "the radio stays open after the last listener")
        other = srv.connect()
        check(other.wait("hello")["open"] is None, "though hello.open says nobody has it")
        other.close()
        ws.cmd(cmd="open", radio="hackrf", freq=101000000)
        info = ws.wait("info")
        check(time.monotonic() - t0 < 1.0, "coming back within the linger takes no time")
        check(info["freq"] == 101000000, "and the radio, nobody else's, is tuned as asked")
        ws.iq()
        ws.close()                                  # hanging up counts as leaving
        time.sleep(0.5)
        check(os.path.exists(state), "still open half a second after the listener hung up")
        deadline = time.monotonic() + 3
        while os.path.exists(state) and time.monotonic() < deadline:
            time.sleep(0.05)
        check(not os.path.exists(state), "closed, and the state file gone, once the linger is over")
    finally:
        srv.stop()
        try:
            os.rmdir(os.path.dirname(state))
        except OSError:
            pass


def t_reopen_gap(binary):
    """At least 2 s between closing a device and opening one."""
    srv = Bridge(binary, "--linger", "0")
    try:
        ws = srv.connect()
        ws.open_radio("hackrf", 100000000, 2400000)
        ws.iq()
        ws.cmd(cmd="close")
        ws.wait("closed")
        time.sleep(0.5)                             # no linger: it is closed by now
        t0 = time.monotonic()
        ws.cmd(cmd="open", radio="hackrf")
        ws.wait("info", timeout=8)
        took = time.monotonic() - t0
        check(1.2 < took < 4.0, "opening again waits out the 2 s since the close (%.2f s after 0.5 s)" % took)
        ws.iq()

        # the other radio, with nobody else listening: this one goes, that one comes
        t0 = time.monotonic()
        ws.cmd(cmd="open", radio="rtlsdr", rate=240000)
        info = ws.wait("info", timeout=8)
        took = time.monotonic() - t0
        check(info["radio"] == "rtlsdr" and info["rate"] == 240000, "the other radio opens in its place")
        check(1.7 < took < 4.5, "after the 2 s between a close and an open (%.2f s)" % took)
        check(ws.iq().count == 4800, "and streams")
    finally:
        srv.stop()


def t_absent(binary):
    srv = Bridge(binary, env={"PIRATE_WEBSDR_SIM_ABSENT": "rtlsdr"})
    try:
        ws = srv.connect()
        ws.wait("hello")
        ws.cmd(cmd="open", radio="rtlsdr")
        err = ws.wait("error", timeout=8)
        check(err["code"] == "nodevice", "a radio that does not open is nodevice, not %s" % err["code"])
        check("RTL-SDR" in err["message"], "and the message names it: %s" % err["message"])
        check(not any(ev[0] == "iq" for ev in ws.collect(0.3)), "no frames follow")
        ws.open_radio("hackrf", 100000000, 2400000)
        check(ws.iq().count == 48000, "the other one opens")
    finally:
        srv.stop()


def t_watchdog(binary):
    state = os.path.join(tempfile.mkdtemp(prefix="websdr-test-"), "websdr")
    srv = Bridge(binary, "--state-file", state, env={"PIRATE_WEBSDR_SIM_STALL": "1"})
    try:
        ws = srv.connect()
        ws.open_radio("rtlsdr", 100000000, 240000)
        check(ws.iq().count == 4800, "it streams at first")
        t0 = time.monotonic()
        closed = ws.wait("closed", timeout=10)
        took = time.monotonic() - t0
        check(closed["reason"] == "the radio stopped answering", "a silent radio is closed and said so: %s" % closed["reason"])
        check(2.5 < took < 7, "about 3 s after it went quiet (%.1f s)" % took)
        time.sleep(0.2)
        check(not os.path.exists(state), "and the device is let go of")
        ws.cmd(cmd="ping", t=2)
        check(ws.wait("pong")["t"] == 2, "the socket stays open")
        check(not any(ev[0] == "iq" for ev in ws.collect(1.2)), "it is not opened again by itself")
    finally:
        srv.stop()
        try:
            os.rmdir(os.path.dirname(state))
        except OSError:
            pass


def t_release(binary):
    """SIGUSR1: another job wants the radio."""
    state = os.path.join(tempfile.mkdtemp(prefix="websdr-test-"), "websdr")
    srv = Bridge(binary, "--state-file", state)
    try:
        a, b = srv.connect(), srv.connect()
        a.open_radio("hackrf", 100000000, 2400000)
        b.wait("hello")
        b.cmd(cmd="open", radio="hackrf")
        b.wait("info")
        check(os.path.exists(state), "the radio is open")
        os.kill(srv.proc.pid, signal.SIGUSR1)
        for ws in (a, b):
            closed = ws.wait("closed")
            check(closed["reason"] == "the radio was handed to another job", "each listener is told why: %s" % closed["reason"])
        time.sleep(0.2)
        check(not os.path.exists(state), "the device is closed at once, no linger")
        check(srv.proc.poll() is None, "the bridge itself runs on")
        c = srv.connect()
        check(c.wait("hello")["open"] is None, "nothing is open any more")
        c.close()
        a.open_radio("hackrf", 100000000, 2400000)
        check(a.iq().count == 48000, "a listener can ask for it back")
        os.kill(srv.proc.pid, signal.SIGUSR1)
        a.wait("closed")
        os.kill(srv.proc.pid, signal.SIGUSR1)      # with nothing open: nothing happens
        a.cmd(cmd="ping", t=4)
        check(a.wait("pong")["t"] == 4, "SIGUSR1 with nothing open changes nothing")
    finally:
        srv.stop()
        try:
            os.rmdir(os.path.dirname(state))
        except OSError:
            pass


def t_term(binary):
    """SIGTERM: out in order, with status 0."""
    state = os.path.join(tempfile.mkdtemp(prefix="websdr-test-"), "websdr")
    srv = Bridge(binary, "--state-file", state)
    try:
        ws = srv.connect()
        ws.open_radio("hackrf", 100000000, 2400000)
        ws.iq()
        t0 = time.monotonic()
        srv.proc.send_signal(signal.SIGTERM)
        status = srv.proc.wait(timeout=5)
        check(status == 0, "it exits with status 0, not %s" % status)
        check(time.monotonic() - t0 < 2, "promptly")
        check(not os.path.exists(state), "leaving no state file")
        try:
            while True:
                ws.event(2)
        except Gone:
            pass
        except TimeoutError:
            raise Failed("its listener was not hung up on")
        log = srv.log_text()
        check("closed" in log and "stopped" in log, "having closed the radio first: %r" % log[-200:])
    finally:
        srv.stop()
        try:
            os.rmdir(os.path.dirname(state))
        except OSError:
            pass


def t_port_taken(binary):
    srv = Bridge(binary)
    try:
        second = subprocess.run([binary, "--sim", "--port", str(srv.port)], stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=10)
        check(second.returncode == 1, "a second one on the same port gives up with status 1, not %s" % second.returncode)
        check(b"cannot listen" in second.stdout, "and says why")
        usage = subprocess.run([binary, "--port", "99999"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
        check(usage.returncode == 2 and b"usage" in usage.stdout, "a bad option gives the usage and status 2")
    finally:
        srv.stop()


ON_MAIN = [
    ("simulated radio: the carrier where it should be", t_sim_signals),
    ("simulated radio: gain makes it stronger", t_sim_gain),
    ("every rate of both radios", t_rates),
    ("what the radio cannot do", t_limits),
    ("stop and start in a hurry", t_hurry),
    ("a listener that stalls loses frames, the other none", t_slow_client),
    ("frames a client may not send", t_strict),
    ("the handshake: what is refused, what is let in", t_http),
    ("compact JSON, as the rootfs test greps it", t_compact),
    ("garbage does not bring it down", t_garbage),
]

OWN = [
    ("--any-origin", t_any_origin, False),
    ("--max-clients", t_max_clients, False),
    ("the state file and the linger", t_linger, False),
    ("2 s between a close and an open", t_reopen_gap, False),
    ("a radio that is not there", t_absent, False),
    ("a radio that goes silent", t_watchdog, False),
    ("a port that is taken, a bad option", t_port_taken, True),
    ("SIGUSR1 lets go of the radio", t_release, True),
    ("SIGTERM", t_term, True),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", help="the pirate-websdr binary to start (with --sim)")
    ap.add_argument("--url", help="test what listens at ws://host:port/ instead (the wire protocol only)")
    ap.add_argument("--only", help="run only the tests whose name contains this")
    args = ap.parse_args()
    if bool(args.bin) == bool(args.url):
        ap.error("give --bin or --url")

    failed = 0
    ran = 0

    def run(name, fn, target, srv=None):
        nonlocal failed, ran
        if args.only and args.only not in name:
            return
        ran += 1
        try:
            fn(target)
            print("ok - websdr: " + name)
        except (Failed, Gone, Refused, TimeoutError, OSError, KeyError, IndexError, ValueError,
                TypeError, struct.error, subprocess.SubprocessError) as e:
            failed += 1
            print("FAIL - websdr: %s: %s: %s" % (name, type(e).__name__, e))
            shown = srv or Bridge.last
            log = shown.log_text() if shown else ""
            if log:
                print("  the bridge's log, its end:")
                for line in log.splitlines()[-40:]:
                    print("    " + line)
        sys.stdout.flush()

    if args.url:
        srv = Remote(args.url)
        for name, fn in PORTABLE:
            run(name, fn, srv)
    else:
        binary = os.path.abspath(args.bin)
        if not os.path.exists(binary):
            print("FAIL - websdr: no binary at %s" % binary)
            return 1
        srv = Bridge(binary, "--linger", "30")      # one device session for the lot: no waits between tests
        try:
            for name, fn in PORTABLE + ON_MAIN:
                run(name, fn, srv, srv)
        finally:
            srv.stop()
        for name, fn, posix_only in OWN:
            if posix_only and not POSIX:
                if not args.only or args.only in name:
                    print("ok - websdr: %s # SKIP (not on this system)" % name)
                continue
            run(name, fn, binary)

    print("%d tests, %d failed" % (ran, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
