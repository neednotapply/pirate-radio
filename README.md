# pirate-radio

OpenWrt firmware that turns a **GL.iNet GL-AR750S(-EXT) "Slate"** into
**Pirate Radio**, a receiver station for an **RTL-SDR** and a **HackRF** on
its USB port. It decodes and logs to the **microSD card** by itself, and it
shares both radios over the network with SDR software on a computer. On its
network it answers at **`http://pirateradio.local/`**.

(This project was called slate-sdr. An upgrade that keeps settings carries
them over, and a card labelled `SLATESDR` keeps working.)

Nothing in this firmware transmits. HackRF boards with a dead transmit path
work fine.

| Job | Radio | What | Live | On the card |
|---|---|---|---|---|
| `soapy` | both | SoapySDR network server for SDR++, GQRX, CubicSDR, SDRangel, GNU Radio | `tcp://<router>:55132` | – |
| `rtltcp` | RTL-SDR | rtl_tcp server (SDR#, SDR++, GQRX) | `<router>:1234` | – |
| `adsb` | RTL-SDR | aircraft, 1090 MHz (dump1090) | map on `:8080`, SBS `:30003`, Beast `:30005` | aircraft table every minute |
| `ism` | RTL-SDR | sensors, remotes, meters on 433/868/915 MHz (rtl_433, 200+ protocols) | `:8433` | JSON lines |
| `ais` | RTL-SDR | ships, 162 MHz (rtl_ais) | NMEA on TCP `:10110` (OpenCPN) | NMEA |
| `survey` | HackRF | spectrum sweep 1 MHz – 6 GHz (hackrf_sweep) | – | CSV, hourly, gzipped |
| `rtlsurvey` | RTL-SDR | spectrum sweep 24 MHz – 1.7 GHz (rtl_power) | – | CSV, hourly, gzipped |
| `iq` | either | raw IQ recording, continuous, in segments | – | SigMF (`.sigmf-data` + `.sigmf-meta`) |
| `wifi` | built-in Wi-Fi | spectral scan of the 2.4 GHz (ath9k) and 5 GHz (ath10k) radios | – | raw FFT samples |

Out of the box, `soapy`, `adsb` (RTL-SDR) and `survey` (HackRF, one sweep a
minute) are on. Each radio runs one job at a time. Between survey sweeps the
HackRF is free for network clients.

## How this relates to w1700k-sdr

[w1700k-sdr](https://github.com/h0m3us3r/w1700k-sdr) gets raw IQ out of a
Wi-Fi 7 chip (the MT7996). That chip has an internal capture engine and
radio firmware that can be replaced, and the router has 10 GbE to carry
1.28 GB/s. The Slate's Qualcomm Atheros radios have neither feature, and a
775 MHz MIPS CPU with USB 2.0 and gigabit Ethernet could not carry that rate
anyway. What these radios do have is hardware **spectral scan**: FFT power
readings rather than IQ. The `wifi` job uses it. Real IQ comes from the USB
radios.

## What you need

- GL-AR750S or GL-AR750S-EXT. This firmware is OpenWrt's `NOR/NAND` variant,
  which fits the layout of GL.iNet's firmware 3.x and later.
- RTL-SDR and/or HackRF. The router has **one USB port**, so for both
  radios use a **powered USB hub**: the HackRF draws about 500 mA by itself.
- microSD card, **formatted exFAT and named `PIRATERADIO`** (format it on any
  computer). FAT32 and ext4 also work. Without the card, jobs keep serving
  the network and write nothing to the router's flash.
- Antennas suited to what you want to receive: 1090 MHz for ADS-B, 433 or
  868/915 MHz for ISM, 162 MHz for AIS.

## Build

Two builds, from the same packages:

| | `./build.sh` | `./build-full.sh` |
|---|---|---|
| How | OpenWrt SDK + ImageBuilder in Docker | full OpenWrt source build |
| Time | ~10 min | ~40 min on GitHub's 4-core runners, ~20 GB disk |
| Kernel | OpenWrt 25.12.6 release kernel | rebuilt with `CONFIG_RELAY` |
| Wi-Fi spectral (`wifi` job) | no | yes |
| 5 GHz driver | ath10k-ct (OpenWrt default) | upstream ath10k + Qualcomm firmware |

```sh
./build.sh                     # needs Docker
ls out/firmware/*sysupgrade.bin

./build-full.sh --config-only  # check the configuration (minutes)
./build-full.sh                # needs OpenWrt's build prerequisites, not as root
ls out/firmware-full/*sysupgrade.bin
```

**Lean by default.** The image carries only what the device uses, and includes
`zram-swap` (compressed RAM swap) to give the 128 MB box headroom under the
SDR + recon load. Optional extras live in `config/packages-extra.txt` and are
left out unless you ask for them — currently just the MQTT broker:

```sh
PIRATE_EXTRAS=1 ./build.sh          # "complete" image: adds the MQTT broker
PIRATE_EXTRAS=1 ./build-full.sh     # same, full source build
```

**On GitHub:** every push to `main` runs the *Build firmware* workflow,
which builds both images and uploads them as artifacts:
`pirate-radio-firmware` after about 5 minutes (with the tests), and
`pirate-radio-firmware-full` after about 40 minutes. Pull requests get the quick build
only, and a newer push cancels the builds of an older one. *Actions → Build
firmware → Run workflow* starts both by hand.

Which to flash: the quick image keeps OpenWrt's release kernel, so kernel
modules from OpenWrt's repository (`apk add kmod-…`) install on it. The full
image has its own kernel, so modules for it have to be added to the build.
Its 5 GHz radio also runs upstream ath10k instead of OpenWrt's default
ath10k-ct. The radios, decoders and logging are the same in both.

## Install

1. In GL.iNet's admin page, save a backup of your settings, and download
   GL.iNet's stock firmware for your model so you can go back.
2. **Upgrade → Local upgrade**: upload the `…-sysupgrade.bin` and **untick
   "Keep settings"**. Alternatively, copy it over SSH and run
   `sysupgrade -n /tmp/<file>`.
3. The router comes back at `192.168.1.1`, named PirateRadio, with Wi-Fi off.
   Open the Pirate Radio UI at `http://pirateradio.local/` (or
   `http://192.168.1.1/`): on a fresh flash it asks you to set a root password
   before anything else. That password is then the UI and SSH login
   (`ssh root@pirateradio.local`); change it later on the Router tab, or with `passwd` over
   SSH. A password kept from earlier settings can't be reset from the UI: if
   it's forgotten, SSH in with a key and run `passwd`, or flash without keeping
   settings.

If it doesn't boot, GL.iNet's U-Boot has a recovery web page: hold reset
while powering on, set your computer to `192.168.1.2/24`, open
`http://192.168.1.1`, and upload the stock firmware. GL.iNet's "debrick"
guide has the exact LED sequence for your U-Boot version. The
[OpenWrt page for the GL-AR750S](https://openwrt.org/toh/gl.inet/gl-ar750s)
covers both directions.

**Later upgrades, from the Slate itself:** the Pirate Radio UI has a **Firmware** tab
that uploads (or fetches by URL) a `…-sysupgrade.bin`, checks it against this
device with `sysupgrade -T`, and flashes only if that check passes — so the box
can update itself without LuCI. It can also write a config backup first. The
U-Boot recovery page above stays the backstop if a flash ever goes wrong.

## Use

**Plug and play:** nothing runs for a device that isn't plugged in, so the
128 MB of RAM goes to what is. An enabled job starts when its radio (an
RTL-SDR or a HackRF) is plugged in and stops when it's removed; the SoapySDR
server runs while either radio is in, and the aircraft map on port 8080 only
while the ADS-B job runs. gpsd starts when a USB GPS appears (the devices in
`/etc/config/gpsd`) and stops when it goes. DreamPi runs only while its USB
modem is in: its modem daemon, the Dreamcast's DNS server and the Dreamcast
Now helper, with its packet fixes, `dreampi.local` and (if on) the DMZ; they
all go when the modem does. A USB Wi-Fi adapter is OpenWrt's own (netifd), and
the microSD card mounts when it goes in. Jobs whose radio is missing show
as *waiting*. Other USB devices are left alone; the supported radios are
listed in `pirate_radio_kind` (`/usr/share/pirate-radio/lib.sh`). A HackRF with a
PortaPack on Mayhem firmware is only a USB serial console until you switch it
to HackRF mode; the status page and the Pirate Radio UI say so, and gpsd doesn't
take that console for a GPS.

**Status page:** `http://192.168.1.1/cgi-bin/pirate-radio` shows the radios,
card and jobs, with links to the aircraft map, the ISM live view and the
recorded files (`http://192.168.1.1:8081/pirate-radio/`).

**In the Pirate Radio UI** (`http://192.168.1.1/`): the *Radios & SDR* tab has the
same status with every address the receivers serve, the aircraft map, the ISM
devices rtl_433 has decoded (one row per device, with its latest readings) and
the recorded files; using a radio hands the RTL-SDR to that job. The Dashboard,
Hosts, Wi-Fi Survey, Threats, Router, Capture, Handshake and Firmware tabs cover
the network, the router and firmware, and the DreamPi tab the Dreamcast (below).

**Over SSH:**

```sh
pirate-radio status                          # radios, card, jobs
pirate-radio enable ism                      # (also: disable)
pirate-radio record hackrf 433.92M 2M 30     # 30 s of IQ to the card, SigMF
pirate-radio record rtlsdr 1090M 2.4M 10 --gain 40
pirate-radio spectral                        # one Wi-Fi spectral scan (full build)
pirate-radio log
```

Jobs are set in `/etc/config/pirate-radio` (frequencies, gains, intervals,
rotation, `extra_args` for any receiver option). Run
`/etc/init.d/pirate-radio restart` after editing. Only one job runs per radio:
for example, to use the RTL-SDR for ISM, disable `adsb` and enable `ism`.

**From a computer:**

- **SDR++:** add a SoapySDR source with `driver=remote,remote=tcp://192.168.1.1:55132`,
  or with the `rtltcp` job on, an RTL-TCP source at `192.168.1.1:1234`.
  GQRX takes the same device string. SoapyRemote must be installed on the
  computer.
- The radio must be free: disable the job that holds it, or catch the
  HackRF between `survey` sweeps.
- Over the network, keep the HackRF at 8–10 Msps or below. USB 2.0 and the
  router's CPU limit the rate; samples are sent in their native 8-bit
  format, so the router does no conversion.

**Also in the image:**

- **Ad blocking** for the router's clients (on/off on the Pirate Radio UI's *Router*
  tab). On a router with 128 MB of RAM, start with one list such as OISD small.
- **MQTT broker** (mosquitto, set up over SSH) — in the **complete**
  build only (`PIRATE_EXTRAS=1`, see *Build*). rtl_433 publishes what it decodes
  to it with `option extra_args '-F mqtt://127.0.0.1:1883,retain=1'` in the
  `ism` job, under `rtl_433/<hostname>/`. Leave that option out on the default
  (lean) image: it has no broker, and rtl_433 would keep trying to reach one.
- **tcpdump** (mini) and **horst**, a Wi-Fi analyzer for monitor mode.
- **Network recon** (the Pirate Radio UI's *Hosts*, *Wi-Fi Survey* and *Threats* tabs):
  - **Dashboard:** one glance at where the Slate is and what it sees — the
    joined network and whether it is online, hosts and access points logged,
    GPS, threats, the radios and the running SDR jobs, each tile linking to
    its tab.
  - **Hosts:** what is on the network this router has joined — passive host
    discovery with arp-scan (IP, MAC, vendor), and a short nmap port scan of
    one host you pick. Discovery is passive; a port scan runs only against the
    host whose button you click.
  - **Wi-Fi Survey:** a wardriving-style log of the access points the Slate
    hears, scanned on a free radio (the USB adapter by default, so the uplink
    and the Pirate Radio AP keep running) and kept with first/last seen,
    strongest signal, channel and security. The image bundles **gpsd** and the
    USB GPS kernel drivers (CDC-ACM and the common serial chips), enabled on
    first boot: plug in a USB GPS and each sighting is tagged with a position,
    with a live GPS status shown on the tab.
  - **Threats:** passive threat detection. A rogue-AP check over the survey
    data flags an SSID advertised both open and secured (an evil twin) and
    your own network names being impersonated; a deauth watch listens on the
    2.4 GHz monitor radio for the management-frame floods a jamming or
    handshake-capture attack sends. Both only listen.

  Saved to the card under `recon/` and `survey/`. Receive/observe only — no
  attack features.
- **DreamPi** (the Pirate Radio UI's *DreamPi* tab): a Sega Dreamcast gets online
  through its own dial-up modem, as with a [DreamPi](https://github.com/Kazade/dreampi)
  on a Raspberry Pi, using the same USB voice modem (Conexant RD02-D400 /
  Dell NW147, Zoom 3095, …; listed in `/usr/share/dreampi/modems`). Cable:
  Dreamcast → line voltage inducer → USB modem → the Slate's USB port (the
  powered hub if a radio is plugged in too). When the modem is plugged in,
  the Slate plays a dial tone into the line, hears the number the Dreamcast
  dials, and answers. Set up the Dreamcast's ISP as for a DreamPi: any phone
  number, user name and password.
  - **PPP calls** (the default) run pppd here as DreamPi does: the Dreamcast
    is `192.168.169.2` on a link of its own (`dc0`, firewall zone
    `dreamcast`: out to the internet, and to the router only for DNS), with
    DreamPi's DNS servers (which point retired game servers at their
    revivals), its fixes for games' hard-coded server addresses (the
    `dcnatrules` list, refreshed from DreamPi's source), TTL 64, and the
    PowerSmash SYN fix.
  - **DCNet** ([Flycast's](https://github.com/flyinghead/flycast) online
    network, for DCNet-patched games): dial `*69` before the number for one
    call, or make it the default on the tab.
  - **Dreamcast Now** (on by default, as on a DreamPi): during PPP calls,
    [dreamcast.online/now](https://dreamcast.online/now) is told what is being
    played: a hash of the router's MAC address and of the game server names
    looked up, from which the site works out the game. Name the listing on
    the tab, or on [the site's configure page](http://dreamcast.online/now/configure/)
    as with a DreamPi: the Slate runs DreamPi's helper for it on port 1998
    and answers to `dreampi.local` on its network (browsers may ask before
    letting the page reach it). The site shows `Unnamed_` and an id until a
    name is set, and a name belongs to one Dreamcast: to carry on as the
    DreamPi you had, under its name, give the tab its MAC address or id.

  - **DMZ** (off by default; a tick on the tab): everything that comes in
    from the internet unasked goes to the Dreamcast, as DreamPi's guides
    advise for games that take incoming connections. Behind another router,
    make the Slate that router's DMZ host too; the tab shows its address
    there.

  Not ported: DreamPi's Netlink (peer-to-peer modem games and XBAND), its
  VPN, its UPnP port forwarding, and its per-game helpers `dcgamespy`,
  `dc2k2` and `dcvoip`, which DreamPi ships only as Raspberry Pi binaries.
  Settings are in `/etc/config/dreampi`; `logread -e dreampi -e pppd` shows the
  calls.

**On the card** (`pirate-radio/<job>/<date>/`):

| Files | Open with |
|---|---|
| `iq-*.sigmf-data/-meta` | inspectrum, Universal Radio Hacker, SigDigger, GNU Radio |
| `sweep-*.csv.gz` | rtl_power/hackrf_sweep CSV: `heatmap.py`, QSpectrumAnalyzer |
| `ism-*.json` | one JSON object per decoded message |
| `aircraft-*.json(.gz)` | concatenated dump1090 `aircraft.json` snapshots (`jq`) |
| `ais-*.nmea` | OpenCPN, gpsd, any AIS decoder |
| `wifi/*/2g-*.bin`, `5g-*.bin` | [FFT_eval](https://github.com/simonwunderlich/FFT_eval) |

## Good to know

- **Clock:** the router has no real-time clock. File times are right once
  it has synced over NTP (it needs internet access through its WAN port).
- **Data rates to the card:** 2 Msps of IQ is 4 MB/s (14 GB an hour). The
  card reader is on USB 2.0; check what your card sustains before
  recording faster. Jobs stop writing below `min_free_mb` (256 MiB).
- **Wi-Fi spectral scan** needs the full build, and a radio that isn't
  serving an access point (OpenWrt ships with Wi-Fi off). Set your country
  with `option country` in the `wifi` job.
- **Monitor mode:** the built-in 2.4 GHz radio (ath9k) does it, and both
  images include the driver for USB Wi-Fi adapters on Ralink's RT2800 chips
  (RT3070, RT5370, RT5372, such as Panda's PAU05 and PAU06). The adapter
  shares the USB port with the radios, so use the powered hub.
- **The law:** what you may receive, decode and record differs by country.

## Tested so far, and what isn't

Tested in this repository's tests and builds:

- All packages cross-compile with the OpenWrt 25.12.6 SDK for this router
  (`mips_24kc`). The binaries run on OpenWrt 25.12.6's MIPS userland under
  QEMU, and SoapySDR loads its HackRF and RTL-SDR modules.
- `tests/rootfs-test.sh` covers every job, the init script, the CLI, the
  status page, the SDR and Network Recon backends (including the Wi-Fi survey
  database, GPS status, threat detection, the dashboard and the nmap scan
  profiles) and the rest of the web UI's backends
  (pirate-router, pirate-capture, pirate-handshake and pirate-firmware: their rpcd
  plugins, input validation and JSON shapes, including the set-password, Wi-Fi
  join/scan/status and firmware verify/apply/upload methods — the flasher runs
  against a mock sysupgrade, so no real flash is ever attempted), and plug and
  play (jobs held back while their radio is unplugged, the USB and tty hotplug
  hooks, gpsd started and stopped with the GPS, the map server living and
  dying with the ADS-B job), and DreamPi (the modem daemon against
  `tests/fakemodem`, a modem with a Dreamcast dialling on a pseudo-terminal;
  the call script, NAT rules, Dreamcast Now with its name form and the
  port-1998 configure helper, init script, hotplug hook, DMZ and the UI's
  backend), against mock radios and tools on that same userland, and the rename from
  slate-sdr (settings, card mount, card folder) and pirateradio.local: 310
  checks.
- Both images build on GitHub Actions, and the tests pass there.
- The full build's configuration resolves: `./build-full.sh --config-only`
  keeps `CONFIG_KERNEL_RELAY`, the spectral options and upstream ath10k.

Not yet run:

- Most of the radio work on a real GL-AR750S. So far, rtl_433 decodes from a
  real RTL-SDR there, and hackrf_sweep surveys 1 MHz – 6 GHz from a real
  HackRF (a PortaPack in HackRF mode) in under a second per sweep. Untested
  there: high-rate streaming over the router's USB (raw IQ capture, rtl_tcp,
  SoapySDR clients), the card reader's write speed, and Wi-Fi spectral scan on
  this hardware. `ath10k` spectral on the QCA9887 specifically has not been
  confirmed.
- Plug and play: pulling out a HackRF, a real USB GPS, and the boot-time start
  with a radio already plugged in. On the device, a real RTL-SDR has been
  plugged in and pulled out (the ISM job and the SoapySDR server started and
  stopped with it), and a real HackRF plugged in (the survey job and SoapySDR
  started); a PortaPack in Mayhem mode was rightly taken for neither a radio
  nor a GPS. The GPS hook was driven only with a stand-in `/dev/ttyACM0`:
  gpsd started and stopped through procd as expected.
- The rename: a device on slate-sdr was flashed with the pirate-radio full
  build, settings kept. Its settings, its SLATESDR card (mount and folder),
  DreamPi and the UI's backends came back under the new names, and
  `pirateradio.local` answered over both mDNS and the router's DNS.
- DreamPi has had one real call: a Dreamcast through a Conexant RD02-D400
  (`0572:1324`) on the device, answered at 33600 bps, online over PPP for 18
  minutes (browsing, DNS through DreamPi's servers, listed on Dreamcast Now as
  playing the web browser, later Quake III Arena), then hung up and back to
  listening. Not yet run with real hardware: DCNet, and naming on Dreamcast
  Now (the site refused a name another Dreamcast had, and the Slate reports
  that; the device now reports as a real DreamPi, under its name, but no
  call has been made that way yet). The port-1998 helper
  answered from a computer on the network; the site's configure page itself
  hasn't been tried in a browser that lets it reach the Slate. Against
  `tests/fakemodem` on the device: `*69` to DCNet (with a stand-in DCNet
  client) and the service stopped mid-call.
- The web UI's first-run screen on a freshly flashed device (settings not
  kept). It relies on rpcd accepting any password while root's is unset, so an
  empty-password sign-in that succeeds means "set one first". On a device that
  has a password, the sign-in path has been run on the hardware.

## Layout

| Path | |
|---|---|
| `feed/` | OpenWrt package feed: `fftw3f`, `hackrf`, `soapysdr`, `soapy-hackrf`, `soapy-rtlsdr`, `soapy-remote`, `pirate-radio`, `pirate-radio-ui`, `dreampi` |
| `feed/utils/pirate-radio/files/` | the service: job runner, init script, CLI, status page, default config |
| `feed/net/dreampi/` | DreamPi: the modem daemon and DCNet client (`src/`), the call script, NAT rules, Dreamcast Now, init script and hotplug hook (`files/`) |
| `feed/utils/pirate-radio-ui/files/` | the web UI (`index.html`, `app.js`, `style.css`) and the firmware-upload CGI, served at `/` |
| `feed/utils/pirate-radio-ui/root/` | the UI's rpcd/ubus backends: router basics, firmware, capture, handshake, and the SDR (`pirate.sdr`) and recon (`pirate-recon` / `pirate-survey` / `pirate-threats` / `pirate-dashboard`) tools |
| `config/packages.txt` | what goes into the image on top of OpenWrt's defaults |
| `config/full.config` | full-build options (spectral scan, ath10k) |
| `build.sh`, `scripts/` | the Docker build (SDK, then ImageBuilder) |
| `build-full.sh` | the full source build |
| `tests/` | runtime tests on OpenWrt's MIPS userland under QEMU |

rtl-sdr, rtl_433, dump1090 and rtl-ais come from OpenWrt's own package
feed.

## Licence

The scripts in `feed/utils/pirate-radio/files/` and `tests/`, and the build
scripts, are MIT. The OpenWrt package Makefiles follow OpenWrt's
GPL-2.0. Each packaged program keeps its own licence (in its Makefile's
`PKG_LICENSE`). In `feed/net/dreampi/`, `src/dreampi.c`, `src/dcnow-config.c`
and the scripts are MIT (ports of DreamPi's modem code and Dreamcast Now
config server, MIT, © Luke Benstead); `src/dcnet.c` is Flycast's DCNet
client, GPL-2.0-or-later.
