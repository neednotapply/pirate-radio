#!/usr/bin/env python3
"""The bridge's side of a real radio (source_soapy.c), with a stand-in for the
SoapySDR library behind it (fake_soapy.c): a HackRF and an RTL-SDR that are
not there, behind a driver as unforgiving as the HackRF's own. A stream of it
that is stopped and started again hands out old samples from then on, as
fast as they are asked for; and each of its samples tells which it is, so
that what reaches a listener can be held against what the radio made.

    python3 tests/websdr/test_radio.py --bin <pirate-websdr, built with fake_soapy.c>

tests/websdr/run.sh builds that binary, where SoapySDR's headers are
installed, and runs this. The wire protocol and the bridge's own rules are
test_bridge.py's, with the simulated radio; here it is what the bridge asks
of a driver.

Python's standard library only. Prints "ok - ..." and "FAIL - ..." lines;
exit status 1 when anything failed.
"""

import argparse
import os
import struct
import subprocess
import sys
import time

from test_bridge import Bridge, Failed, Gone, Refused, check

PERIOD = 251 * 251                      # the stand-in's samples are numbered to within this
COMPLAINT = "fake radio:"               # how it says, in the bridge's log, what a driver should not be asked


def which(f, k):
    """Which sample the k-th of a frame is (fake_soapy.c: fake_fill)."""
    i, q = f.samples[2 * k], f.samples[2 * k + 1]
    i = i - 256 if i > 127 else i
    q = q - 256 if q > 127 else q
    return (i + 125) + 251 * (q + 125)


def in_order(frames, what):
    """Every sample follows the one before it: within each frame, and from
    one frame to the next. (Frames this reader was too slow for are another
    matter: the bridge flags the one after them, and its number skips.)"""
    joins = 0
    prev = None
    for f in frames:
        first = which(f, 0)
        for k in (1, f.count // 3, f.count // 2, f.count - 1):
            check(which(f, k) == (first + k) % PERIOD,
                  "%s: a frame's samples follow one another (frame %d, at %d)" % (what, f.seq, k))
        if prev is not None and f.seq == prev.seq + 1 and not f.discont:
            check(first == (which(prev, prev.count - 1) + 1) % PERIOD,
                  "%s: frame %d goes on where frame %d ended" % (what, f.seq, prev.seq))
            joins += 1
        prev = f
    check(joins >= 3, "%s: frames in a row to tell by (%d of %d)" % (what, joins, len(frames)))


def steady(ws, rate, what, seconds=1.0):
    """The stream as a radio makes it: at the radio's pace (by the frames'
    numbers, so a frame this reader missed is not held against it), and
    every sample in its place."""
    frames = [ws.iq()]
    t0 = t1 = time.monotonic()
    while t1 - t0 < seconds:
        frames.append(ws.iq())
        t1 = time.monotonic()
    got, took = (frames[-1].seq - frames[0].seq) * frames[0].count, t1 - t0
    check(0.7 * rate * took < got < 1.3 * rate * took,
          "%s: samples at the radio's pace (%d in %.2f s, from a radio making %d a second)" % (what, got, took, rate))
    in_order(frames, what)


def opens(srv):
    return srv.log_text().count(": open (")


# ---------- with one bridge, its radio kept open between listeners ----------

def t_hackrf(srv):
    ws = srv.connect()
    try:
        ws.wait("hello")
        ws.cmd(cmd="open", radio="hackrf", freq=98000000, rate=2400000)
        info = ws.wait("info", timeout=10)
        check(info["label"] == "HackRF One", "the radio is called what its driver calls it: %s" % info["label"])
        check([g["name"] for g in info["gains"]] == ["LNA", "AMP", "VGA"], "its gain stages, in the driver's order")
        check([g["value"] for g in info["gains"]] == [24, 0, 20], "at the values the other jobs here use")
        check(info["range"] == [1000000, 7250000000], "what it tunes is the driver's, from 1 MHz: %s" % info["range"])
        first = ws.iq()
        check(first.discont and first.count == 48000, "the first frame: 48000 samples, flagged as a start")
        steady(ws, 2400000, "a HackRF")
        ws.cmd(cmd="gain", name="LNA", value=30)
        ws.wait("status", lambda m: m["gains"]["LNA"] == 32)        # (its steps are 8 dB)
        ws.cmd(cmd="freq", hz=433920000)
        ws.wait("status", lambda m: m["freq"] == 433920000)
        steady(ws, 2400000, "a HackRF, tuned elsewhere", 0.5)
    finally:
        ws.close()


def t_restart(srv):
    """Stop, and start again while the radio is still open: what the Listen
    page's Stop and Start do. The stream that comes is a new one."""
    ws = srv.connect()
    try:
        ws.open_radio("hackrf", 98000000, 2400000)
        ws.iq()
        before = opens(srv)
        for n in (1, 2, 3):
            ws.cmd(cmd="close")
            ws.wait("closed")
            ws.cmd(cmd="open", radio="hackrf")
            ws.wait("info")
            check(ws.iq().discont, "the first frame after a start is flagged")
            steady(ws, 2400000, "after stop and start (%d)" % n, 0.8)
        ws.close()                                  # hanging up, and somebody else coming
        time.sleep(0.7)
        ws = srv.connect()
        ws.open_radio("hackrf", 98000000, 2400000)
        steady(ws, 2400000, "for who comes after a listener hung up")
        check(opens(srv) == before, "the radio itself stayed open all the while")
    finally:
        ws.close()


def t_span(srv):
    """Another sample rate: the stream stops for it, and a new one starts."""
    ws = srv.connect()
    try:
        ws.open_radio("hackrf", 98000000, 2400000)
        ws.iq()
        before = opens(srv)
        for rate in (4800000, 2400000, 4800000, 2400000):
            ws.cmd(cmd="rate", hz=rate)
            ws.wait("info", lambda m: m["rate"] == rate)
            steady(ws, rate, "a HackRF at %d samples a second" % rate, 0.6)
        check(opens(srv) == before, "the radio itself stayed open")
    finally:
        ws.close()


def t_rtlsdr(srv):
    """The other radio: its buffers asked for at 20 ms, anew for every rate."""
    ws = srv.connect()
    try:
        info = ws.open_radio("rtlsdr", 100000000, 240000)       # (the HackRF goes: 2 s between the two)
        check(info["label"] == "RTL-SDR (R820T)", "the radio is called by its tuner: %s" % info["label"])
        check([g["name"] for g in info["gains"]] == ["TUNER"], "its one gain")
        check(ws.iq().count == 4800, "frames of 20 ms")
        steady(ws, 240000, "an RTL-SDR")
        for rate in (960000, 240000):
            ws.cmd(cmd="rate", hz=rate)
            ws.wait("info", lambda m: m["rate"] == rate)
            steady(ws, rate, "an RTL-SDR at %d samples a second" % rate, 0.6)
        ws.cmd(cmd="close")
        ws.wait("closed")
        ws.cmd(cmd="open", radio="rtlsdr")
        ws.wait("info")
        steady(ws, 240000, "an RTL-SDR, after stop and start", 0.6)
    finally:
        ws.close()


def t_asked_rightly(srv):
    """Last of the lot with this bridge: nothing in all of the above was
    asked of the driver that a driver should not be asked."""
    lines = [l for l in srv.log_text().splitlines() if COMPLAINT in l]
    check(not lines, "the stand-in for the driver had this to say: %s" % " | ".join(lines))


# ---------- each with a bridge of its own ----------

def failing(binary, call):
    return Bridge(binary, sim=False, env={"FAKE_SOAPY_FAIL": call})


def t_no_device(binary):
    srv = failing(binary, "make")
    try:
        ws = srv.connect()
        ws.wait("hello")
        ws.cmd(cmd="open", radio="hackrf")
        err = ws.wait("error", timeout=8)
        check(err["code"] == "nodevice", "a radio that is not there is nodevice, not %s" % err["code"])
        check("HackRF" in err["message"] and "no device found" in err["message"],
              "the message names it, and gives the driver's reason: %s" % err["message"])
        check(not any(ev[0] == "iq" for ev in ws.collect(0.3)), "no frames follow")
    finally:
        srv.stop()


def no_stream(binary, call, reason):
    srv = failing(binary, call)
    try:
        ws = srv.connect()
        ws.wait("hello")
        ws.cmd(cmd="open", radio="hackrf")
        err = ws.wait("error", timeout=8)
        check(err["code"] == "failed", "a radio that opens and will not stream is failed, not %s" % err["code"])
        check(reason in err["message"], "with the driver's reason: %s" % err["message"])
        closed = ws.wait("closed")
        check(closed["reason"] == "the radio's stream did not start", "and the listener is told it is closed: %s" % closed["reason"])
        check(not any(ev[0] == "iq" for ev in ws.collect(0.3)), "no frames follow")
        other = srv.connect()
        check(other.wait("hello")["open"] is None, "the radio is let go of")
        other.close()
        ws.cmd(cmd="ping", t=7)
        check(ws.wait("pong")["t"] == 7, "the bridge itself goes on")
        check(COMPLAINT not in srv.log_text(), "let go of in order: %s" % srv.log_text()[-300:])
    finally:
        srv.stop()


def t_no_stream(binary):
    no_stream(binary, "setup", "no memory for its buffers")


def t_no_start(binary):
    no_stream(binary, "activate", "the radio would not start receiving")


SHARED = [
    ("a HackRF: its name, its gains, its samples in order and in time", t_hackrf),
    ("stop and start: a new stream, not the old one again", t_restart),
    ("another span: a new stream at the new rate", t_span),
    ("an RTL-SDR: its buffers, its rates, stop and start", t_rtlsdr),
    ("the driver is asked nothing it should not be", t_asked_rightly),
]

OWN = [
    ("a radio that is not there", t_no_device),
    ("a radio that gives no stream", t_no_stream),
    ("a radio whose stream does not start", t_no_start),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", required=True, help="pirate-websdr, built with fake_soapy.c in SoapySDR's place")
    ap.add_argument("--only", help="run only the tests whose name contains this")
    args = ap.parse_args()
    binary = os.path.abspath(args.bin)
    if not os.path.exists(binary):
        print("FAIL - websdr radio: no binary at %s" % binary)
        return 1

    failed = 0
    ran = 0

    def run(name, fn, target, srv=None):
        nonlocal failed, ran
        if args.only and args.only not in name:
            return
        ran += 1
        try:
            fn(target)
            print("ok - websdr radio: " + name)
        except (Failed, Gone, Refused, TimeoutError, OSError, KeyError, IndexError, ValueError,
                TypeError, struct.error, subprocess.SubprocessError) as e:
            failed += 1
            print("FAIL - websdr radio: %s: %s: %s" % (name, type(e).__name__, e))
            shown = srv or Bridge.last
            log = shown.log_text() if shown else ""
            if log:
                print("  the bridge's log, its end:")
                for line in log.splitlines()[-40:]:
                    print("    " + line)
        sys.stdout.flush()

    srv = Bridge(binary, "--linger", "30", sim=False)
    try:
        for name, fn in SHARED:
            run(name, fn, srv, srv)
    finally:
        srv.stop()
    for name, fn in OWN:
        run(name, fn, binary)

    print("%d tests, %d failed" % (ran, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
