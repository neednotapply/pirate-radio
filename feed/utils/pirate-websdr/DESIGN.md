# pirate-websdr: a receiver in the web UI

The Listen page of the web UI is a software-defined radio receiver that runs
in the browser: a spectrum, a waterfall and audio (FM, AM, SSB, CW), from the
HackRF or the RTL-SDR on the router's USB port. This file is the contract
between its three pieces.

## Why it is built this way

The router (GL-AR750S: one MIPS 74Kc core at 775 MHz, no FPU, about 27 MB of
free RAM) cannot do signal processing: an FFT or a filter at 2.4 million
samples a second is far beyond it, which rules out OpenWebRX and its kind.
What it does well is move bytes, as it already does for desktop SDR programs
through the SoapySDR server. So:

- the **bridge** (`pirate-websdr`, C, on the router) only moves the radio's raw
  8-bit IQ samples into a WebSocket and takes tuning commands back. No DSP.
- the **engine** (JavaScript, in a Web Worker in the browser) does all the
  signal processing: FFT for the display, channel filter, demodulation, audio.
- the **page** (JavaScript, main thread) draws and takes the user's input.

```
 HackRF/RTL-SDR --USB--> pirate-websdr ==WebSocket (binary IQ, JSON control)==> engine (worker) --postMessage--> page
                          router, C                                             browser, JS                    browser, JS
```

| Piece | Files | Owner |
|---|---|---|
| bridge | `feed/utils/pirate-websdr/` (`Makefile`, `src/`), tests in `tests/websdr/` | bridge |
| engine | `feed/utils/pirate-radio-ui/files/sdr/dsp.js`, `siggen.js`, `worker.js`; tests and the mock bridge in `tests/sdr/` | engine |
| page | `feed/utils/pirate-radio-ui/files/sdr/receiver.js`, `app.js`, `style.css` | page |

The web UI is served over plain HTTP on the LAN, so the page is **not a secure
context**: no AudioWorklet, no SharedArrayBuffer, no `wss://`. Workers,
`ws://`, typed arrays, `AudioContext` and `AudioBufferSourceNode` all work.

---

## Part 1. The wire protocol (bridge <-> engine), version 1

WebSocket (RFC 6455) over plain TCP. Default port **8073**. Any request path.
No subprotocol, no extensions (the bridge never negotiates permessage-deflate).

### Text frames, client to bridge: commands

One JSON object per frame, **flat** (string, number and boolean values only;
no nesting, no arrays), at most 512 bytes. Unknown keys are ignored.

| `cmd` | Fields | Effect |
|---|---|---|
| `open` | `radio`: `"hackrf"` or `"rtlsdr"`; optional `freq` (Hz), `rate` (Hz, one of that radio's: see *Sample rates*) | Open that radio (or join it if somebody is listening to it already) and start sending IQ frames to this client. Answer: `info`, then `status`, then frames. `freq` and `rate` are for the client who has the radio to itself; a joiner takes it as it is. A `freq` outside what the radio tunes becomes the nearest it has. |
| `freq` | `hz` | Tune the centre frequency. |
| `rate` | `hz` | Change the sample rate; must be one of `rates` in `info`. |
| `gain` | `name`, `value` | Set one gain element (dB), clamped to its range. |
| `close` | | Stop the frames to this client. The socket stays open. |
| `ping` | `t` (number) | Answered with `pong` carrying the same `t`. |

`freq`, `rate` and `gain` need the client to have a radio open (else `error`
`badrequest`). Every streaming client may tune: the radio is shared, and
everybody gets the resulting `status`.

One radio at a time: `open` for the other radio is `busy` while anybody else
listens to the first; with nobody else on it, the first is let go and the one
asked for is opened. A radio the bridge is only keeping open for a while
after its last listener (see Part 3) is nobody's: `hello` says `"open":null`,
and the next `open` sets its `freq` and `rate`.

### Text frames, bridge to client

JSON objects (these may nest).

```json
{"type":"hello","proto":1,"server":"pirate-websdr 0.1.1","sim":false,"open":null}
```
Sent once, right after the handshake. `open` is the radio this bridge has open
now (`"hackrf"`, `"rtlsdr"`) or `null`. `sim` is true when the bridge runs with
`--sim` (a simulated radio stands in for both kinds).

```json
{"type":"info","radio":"hackrf","label":"HackRF One","freq":98000000,"rate":2400000,
 "frame":48000,"rates":[2400000,4800000,9600000],"range":[1000000,7250000000],
 "gains":[{"name":"LNA","min":0,"max":40,"step":8,"value":24},
          {"name":"AMP","min":0,"max":14,"step":14,"value":0},
          {"name":"VGA","min":0,"max":62,"step":2,"value":20}]}
```
What the radio is. Sent to a client when it opens or joins, and to every
streaming client when the sample rate changes (`frame` changes with it).
`frame` is the number of IQ samples in each binary frame. `range` is the
tunable range in Hz, as the radio's driver has it (never below 1 MHz). The
gains are the radio's own stages, in its driver's order. `step` 0 means
continuous; a stage whose `step` is its whole range is a switch.

```json
{"type":"status","freq":98000000,"rate":2400000,"gains":{"LNA":24,"VGA":20,"AMP":0},
 "clients":1,"dropped":0,"overflows":0}
```
The radio's settings now. Sent to every streaming client after any change of
`freq`, `rate` or a gain, and about once a second. `clients`: streaming
clients. `dropped`: IQ frames not sent to *this* client since it opened
(it was too slow). `overflows`: times the radio's own buffer overflowed since
the device was opened.

**Ordering rule.** A `status` that carries a new `freq` or `rate` is written
to a client *before* the first IQ frame captured after the change, and that
frame has the discontinuity flag set. So: every IQ frame is at the settings of
the latest `info`/`status` before it.

```json
{"type":"error","code":"busy","message":"the RTL-SDR is in use here: one radio at a time"}
```
A command failed. Codes: `badrequest` (malformed, unknown, not allowed now,
or a rate the radio does not offer), `nodevice` (that radio is not there, or
would not open: `message` carries SoapySDR's reason), `busy` (somebody else
is listening to the other radio), `failed` (the radio refused a setting, or
the frequency is outside what it tunes). An `error` does not change whether
frames flow. (Too many clients is not an `error`: the handshake itself is
answered 503.)

```json
{"type":"closed","reason":"the radio was handed to another job"}
```
Frames to this client have stopped: it asked (`close`), the radio failed, or
the radio was taken away (SIGUSR1). The socket stays open; the client may
`open` again.

```json
{"type":"pong","t":1234}
```

### Binary frames, bridge to client: IQ

```
byte 0      0x01          frame kind: IQ, interleaved signed 8-bit
byte 1      flags         bit 0 (0x01): discontinuity - frames were dropped
                          before this one, or the tuning or rate changed
bytes 2-3   0             reserved
bytes 4-7   sequence      unsigned 32-bit, little-endian; +1 for every frame the
                          radio produced (a gap = frames this client missed)
bytes 8...  samples       I0 Q0 I1 Q1 ... as int8; count = (length - 8) / 2
```
Each frame holds `frame` samples (from `info`): about 20 ms of signal, at most
48000 samples. `frame = min(rate / 50, 48000)`.

Clients send no binary frames (the bridge closes the socket with 1003).

### Sample rates

All offered rates are multiples of 240000, so the engine comes down by whole
numbers to 240 kHz (where wide FM is demodulated) and to 48 kHz audio:

- HackRF: 2400000, 4800000, 9600000
- RTL-SDR: 240000, 960000, 1200000, 1920000, 2400000

Network cost is 2 bytes a sample: 2.4 Msps is 4.8 MB/s.

---

## Part 2. The engine's messages (engine <-> page)

The page starts the engine with `new Worker("sdr/worker.js?v=<ui-version>")`
and talks to it with `postMessage`. The engine owns the WebSocket: IQ never
touches the main thread.

### Page to engine

```js
{ type: "start",
  url: "ws://10.69.4.20:8073/",   // ignored when demo
  radio: "hackrf",                 // "hackrf" | "rtlsdr"
  demo: false,                     // true: no socket, a simulated band (siggen.js)
  settings: { ... } }              // any of the "set" keys below; missing ones take defaults
{ type: "stop" }                   // close the radio and the socket; the worker stays alive, may start again
{ type: "set", ...settings }       // change any subset, at any time (before start too)
```

Settings:

| Key | Meaning | Default |
|---|---|---|
| `center` | radio centre frequency, Hz | 98000000 |
| `rate` | sample rate, Hz (one of the radio's `rates`) | 2400000 |
| `gains` | `{ name: dB, ... }`, any subset of the radio's gain elements | radio's own |
| `vfo` | the frequency being listened to, Hz (absolute) | `center + rate / 8` |
| `mode` | `"wfm"`, `"nfm"`, `"am"`, `"usb"`, `"lsb"`, `"cw"` | `"wfm"` |
| `bw` | channel bandwidth, Hz (whole channel, both sides for wfm/nfm/am; the sideband's width for usb/lsb/cw). For wfm the filter is flat across it; for the others it is the width at -6 dB, so that the next channel is 50 dB down | per mode: 180000, 12500, 8000, 2700, 2700, 500 |
| `squelch` | open above this channel level in dBFS; `null` = always open | `null` |
| `agc` | audio AGC for am/usb/lsb/cw | `true` |
| `deemph` | FM de-emphasis, microseconds: 75, 50 or 0 (wfm only) | 75 |
| `cwPitch` | CW tone, Hz | 700 |
| `audio` | `false`: skip demodulation entirely (display only, saves CPU) | `true` |
| `fftSize` | power of two, 1024 to 32768 | 4096 |
| `fps` | spectrum lines a second, 5 to 40 | 20 |

`center`, `rate` and `gains` go to the radio (the bridge); the engine applies
the rest itself. When `|vfo - center| + bw/2 > rate/2` the channel is outside
what the radio sees: the engine sends no audio and says so in `meter.outside`
(moving `center` is the page's job). A `mode` without a `bw` takes that mode's
default width. A setting that cannot be (a rate the radio has not, a gain
stage it has not) is answered with an `error` and left out.

### Engine to page

```js
{ type: "conn", state: "connecting" | "open" | "streaming" | "closed" | "error", message: "..." }
```
`open`: socket up, radio not yet. `streaming`: IQ is flowing. `closed`: stopped
on purpose or by the bridge (`message` says why). `error`: could not connect,
the radio would not open (`message`; `code` when the bridge gave one), or the
engine itself failed.
The engine does **not** reconnect by itself: opening and closing the radio
quickly, over and over, upsets the HackRF. The page offers a Retry.

```js
{ type: "info", radio, label, center, rate, rates: [...], range: [lo, hi],
  gains: [{ name, min, max, step, value }, ...], sim: false }
```
After the radio opens, and again whenever the bridge reports a change of
centre, rate or gains (other clients can tune it too).

```js
{ type: "fft", bins: Float32Array, center: Hz, rate: Hz }
```
One spectrum line, `fps` times a second. `bins.length == fftSize`; `bins[i]`
is the power in dBFS (0 dBFS = a full-scale sine) at
`center - rate/2 + i * rate/fftSize` (so already "fftshifted": lowest
frequency first). Each line is the average (in power) of up to eight FFTs
taken since the last one; lines come `fps` times a second of signal, counted
in samples. The window is a Blackman-Harris: noise reads 3 dB higher in a
bin than its share of the band. The buffer is transferred.

```js
{ type: "audio", samples: Float32Array, rate: 48000 }
```
Mono audio, -1..1, in pieces of 40 ms, transferred. Nothing is sent while
the squelch is closed, the channel is outside, or `audio` is false. After a
retune, a change of rate, mode or width, or lost frames, it starts again
with a short silence and a fade-in, not a click.

```js
{ type: "meter", level: -42.5, squelched: false, outside: false,
  dropped: 0, load: 0.12, clients: 1, overflows: 0 }
```
About 5 a second. `level`: power in the channel filter's passband, dBFS.
`dropped`: IQ frames lost since start: on the way (sequence gaps), or let go
by the engine itself when it fell behind (it would rather skip than be heard
late). `load`: time the DSP took / time the samples span (above ~0.9 it
cannot keep up).

The squelch is the page's to set: the engine only compares. The page sets it
by itself (unless told a level by hand) a little above the noise the channel
would hold with no signal in it, which it works out from the spectrum lines,
taken as power: the noise in a bin beside the channel (or the whole line's,
where that is less), less the window's 3 dB, times the bins the channel is
wide. A line that comes after the radio has moved can still hold what was
heard before. The first two or three do, because the engine marks a line
with the centre it was told of and the samples on their way were taken at
the old one. On the HackRF a line here and there does again for most of a
second: SoapyHackRF takes its next buffer to fill from where its reader is
and how many it holds, and counts the one being read twice while it is
being read; filled then, a buffer lands one place on, and the place skipped
is read later with what it held 15 buffers before (0.8 s, at 2.4 MHz). That
happens when the bridge reads late, as it does while it moves the radio.
The page does not ease the first three lines after a move into what it
measures on, and begins its long average a second after. (The bridge could
keep the driver from it by reading whole buffers, so that none is ever left
half read between two calls. It does not yet.)

```js
{ type: "error", message: "..." }   // a bad setting, or something unexpected; the stream goes on
```

---

## Part 3. The bridge

`pirate-websdr [--port 8073] [--bind ADDR] [--state-file PATH] [--sim] [--linger SEC] [--max-clients N] [--any-origin] [--verbose]`

- One process, one thread, `poll()`. No dependencies but libc and SoapySDR
  (its C API: `SoapySDR/Device.h`, `SoapySDR/Formats.h`; SoapySDR 0.8 API as
  in the feed's 0.9.0). The WebSocket side (handshake, SHA-1, base64, framing)
  is its own code. `SOAPY=0` builds it without SoapySDR (simulated radio only),
  for tests on any machine.
- Listens on all addresses (IPv6 dual-stack, falling back to IPv4), as the
  other SDR servers do; the firewall keeps the WAN out.
- **Origin check**: a browser says which page asks (`Origin`), and only the
  router's own pages may. A handshake with an `Origin` whose host is not the
  request's `Host` host (ports ignored) is refused with 403; so is one where
  the two agree but the host is a name that is not the router's (somebody
  else's DNS pointed at it: DNS rebinding) — the host has to be an address,
  `localhost`, or the router's host name, alone or with `.local` or `.lan`.
  No `Origin` (a script, a test) is fine: that is not a browser being used
  by a page. `--any-origin` switches the check off. A request that is not a
  WebSocket upgrade gets a short plain-text 426 saying what this port is.
- At most `--max-clients` (4) sockets; one more gets `503`.
- **One radio at a time.** `open` maps `hackrf` to `driver=hackrf`, `rtlsdr`
  to `driver=rtlsdr`. Stream format CS8 (native on both). Defaults on open:
  2.4 Msps, 98 MHz, automatic gain off; HackRF LNA 24, VGA 20, AMP 0; any other
  element at 60 % of its range.
- **Gentle on the radio** (a HackRF/PortaPack opened and closed in quick
  succession can drop off USB until it is replugged):
  - after the last streaming client leaves, the stream is stopped and the
    device kept open for `--linger` seconds (5) before it is closed, so a page
    reload reuses it;
  - at least 2 s between closing a device and opening one, and half a second
    between stopping its stream and starting one again;
  - `deactivateStream`, `closeStream`, `unmake`, in that order, always:
    on `SIGTERM`/`SIGINT` too.
- **A stream is started once.** Stopping it closes it (`deactivateStream`,
  `closeStream`); the next start, and a change of sample rate, make a new one
  (`setupStream`, `activateStream`) on the device, which stays open. A
  driver's stream need not survive a stop and a start: SoapyHackRF's keeps
  the buffer it had half handed out and from the next start counts its ring
  of buffers one too few (below zero, in an unsigned count, when none has
  arrived yet). Its reads then never wait for the radio again: they return
  old samples over and over, as fast as they are asked for.
- **SIGUSR1**: let go of the radio now (another job wants it): every streaming
  client gets `closed`, the device is closed at once (no linger).
- `--state-file PATH`: while a device is open the file holds its radio kind
  (`hackrf` or `rtlsdr`) and a newline; it is removed when the device closes
  and on exit.
- **A slow client never delays the others, or the radio.** Sockets are
  non-blocking. Each client has room for one frame being sent, plus the
  kernel's socket buffer (kept to roughly 150 ms of stream). A new frame for a
  client still sending the last one is dropped for that client: counted, and
  its next frame flagged as a discontinuity. Text messages queue in order and
  are never dropped; a client that lets that queue fill, or takes nothing for
  10 s, is hung up on.
- The HackRF hands its samples over 262144 bytes at a time, so at 2.4 Msps
  frames reach a client in bursts every 55 ms: whoever plays the sound keeps
  that much, and some, in hand. The RTL-SDR's buffers are asked for at 20 ms.
- **Watchdog**: no samples for 3 s while streaming: the device is closed and
  the clients told (`closed`, "the radio stopped answering"). It is not
  reopened until a client asks.
- `--sim`: no SoapySDR device is touched. Both radio kinds open a simulated
  radio that produces, in real time, noise and a few steady signals at fixed
  absolute frequencies (so tuning moves them): in every megahertz a carrier,
  a tone on wide FM, one on AM and one on narrow FM. Cheap enough to run on
  the router itself (integer NCOs, a sine table).
- Logs to stderr (procd sends it to the system log): clients coming and going,
  the device opening and closing, errors.

---

## Part 4. The engine

- `dsp.js`: the signal processing, with no I/O: loads with `importScripts` in
  the worker (one global, `PirateDSP`) and with `require` in Node (tests).
- `siggen.js`: a simulated band (stations at fixed absolute frequencies: FM
  broadcast, airband AM, narrow FM, SSB, a carrier), for the UI's demo mode
  and for tests; same loading as `dsp.js` (global `PirateSigGen`).
- `worker.js`: the engine: the WebSocket client for Part 1, the pipeline,
  the demo source, the messages of Part 2.
- No dependencies, no build step, plain script files a browser loads as they
  are. Fast paths are typed-array loops, written for the JIT: mixed down at
  the radio's rate, then brought down in stages of 2 and 5 (the sharp filter
  last, at the low rate) to 240 kHz for wide FM, 48 kHz for narrow FM and AM,
  12 kHz for sideband and Morse. A 2.4 Msps stream with wide FM audio takes
  about a twelfth of one desktop core, 9.6 Msps under a fifth
  (`node tests/sdr/bench.js`).

## Tests

- `node tests/sdr/run.js`: the engine. The signal processing against signals
  made by the formula, the simulated band, and the engine in demo mode and
  against a mock of the bridge (`tests/sdr/mock-bridge.js`, which is also a
  radio for trying the page with no router).
- `sh tests/websdr/run.sh`: the bridge, built for this machine with its
  simulated radio. The protocol end to end (`test_bridge.py`), then the
  engine against the bridge (`tests/sdr/bridge.test.js`: the bridge's
  stations have to be heard as the tones they carry), then the protocol again
  under the sanitizers.
- `tests/rootfs-test.sh` (the firmware's own tests, on the router's userland
  under QEMU): the bridge as built for the router answers a handshake; the
  `websdr` job, its place among the others, and the radio taken back from a
  listening page.
