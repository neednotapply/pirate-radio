# pirate-radio

OpenWrt firmware that turns a **GL.iNet GL-AR750S(-EXT) "Slate"** into
**Pirate Radio**, a receiver station for an **RTL-SDR** and a **HackRF** on
its USB port. It decodes and logs to the **microSD card** by itself, it has a
**receiver in its own web page** (a spectrum, a waterfall and sound, in the
browser), and it shares both radios over the network with SDR software on a
computer. On its network it answers at **`http://pirateradio.local/`**.

(This project was called slate-sdr. An upgrade that keeps settings carries
them over, and a card labelled `SLATESDR` keeps working.)

The radios only receive: nothing in this firmware transmits with them, and
HackRF boards with a dead transmit path work fine. One thing sends, and
says so: a Bluetooth dongle from before Low Energy, which can only find
what is about by asking (see *A Bluetooth dongle*).

| Job | Radio | What | Live | On the card |
|---|---|---|---|---|
| `soapy` | both | SoapySDR network server for SDR++, GQRX, CubicSDR, SDRangel, GNU Radio | `tcp://<router>:55132` | – |
| `websdr` | both | the receiver in the web UI (its *Listen* page): the radio's raw samples to the browser, which does the rest | `ws://<router>:8073` | – |
| `rtltcp` | RTL-SDR | rtl_tcp server (SDR#, SDR++, GQRX) | `<router>:1234` | – |
| `adsb` | RTL-SDR (or HackRF) | aircraft, 1090 MHz (dump1090; readsb on the HackRF) | map on `:8080`, SBS `:30003`, Beast `:30005` | aircraft table every minute |
| `ism` | RTL-SDR (or HackRF) | sensors, remotes, meters on 433/868/915 MHz (rtl_433, 200+ protocols) | `:8433` | JSON lines |
| `ais` | RTL-SDR (or HackRF) | ships, 162 MHz (rtl_ais; AIS-catcher on the HackRF) | NMEA on TCP `:10110` (OpenCPN) | NMEA |
| `survey` | HackRF | spectrum sweep 1 MHz – 6 GHz (hackrf_sweep) | – | CSV, hourly, gzipped |
| `rtlsurvey` | RTL-SDR | spectrum sweep 24 MHz – 1.7 GHz (rtl_power) | – | CSV, hourly, gzipped |
| `iq` | either | raw IQ recording, continuous, in segments | – | SigMF (`.sigmf-data` + `.sigmf-meta`) |
| `wifi` | built-in Wi-Fi | spectral scan of the 2.4 GHz (ath9k) and 5 GHz (ath10k) radios | – | raw FFT samples |

Out of the box, `soapy`, `websdr`, `adsb` (RTL-SDR) and `survey` (HackRF, one
sweep a minute) are on. Each radio runs one job at a time; `soapy` and
`websdr` hold no radio until somebody listens. Between survey sweeps the
HackRF is free for network clients.

The three decoder jobs default to the RTL-SDR but take `option radio 'hackrf'`
to run from a HackRF instead — ADS-B through readsb, ISM through rtl_433's
SoapySDR backend, AIS through AIS-catcher, all via SoapySDR's `driver=hackrf`.
A HackRF is less sensitive at these frequencies than a purpose-tuned RTL-SDR,
and decoding its wider minimum stream is heavier on the 775 MHz CPU, so reach
for this mainly when a HackRF is the only SDR on hand.

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
| USB port's power | always on | switched off and on from the Status page, and by itself at boot |

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
ath10k-ct, and it can switch its USB port's power (its device tree is
patched to: `config/full-patches`). The radios, decoders and logging are
the same in both.

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
   (`ssh root@pirateradio.local`); change it later on the Access page (it asks
   for the current one first), or with `passwd` over
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
all go when the modem does. A USB flash drive or disk is mounted and shared
while it is in, and sharing stops when the last one is pulled out (below). A
USB Wi-Fi adapter is OpenWrt's own (netifd), and the microSD card mounts when
it goes in. Jobs whose radio is missing show
as *waiting*. Other USB devices are left alone; the supported radios are
listed in `pirate_radio_kind` (`/usr/share/pirate-radio/lib.sh`). A HackRF with a
PortaPack on Mayhem firmware, in its device (console) mode, is a USB serial
console, not a radio the SDR jobs can use: the status page and the Receivers
page say so, and gpsd doesn't take that console for a GPS. But the **PortaPack**
tab drives it there over that console — its screen, buttons, files and firmware,
as hackrf.app does — and can switch it into HackRF mode for the SDR jobs (below).

**Status page:** `http://192.168.1.1/cgi-bin/pirate-radio` shows the radios,
card and jobs, with links to the aircraft map, the ISM live view and the
recorded files (`http://192.168.1.1:8081/pirate-radio/`).

**In the Pirate Radio UI** (`http://192.168.1.1/`): its pages are grouped down
the left (on a phone, the menu button at the top opens them):

| Group | Pages |
|---|---|
| Overview | Dashboard, Messenger (a MeshCore radio's messages, below) |
| Radio | Receivers (pick a feature for each radio, and where to reach it), Listen (a receiver in the page: the band on screen, and its sound), Sensors (what rtl_433 has decoded) |
| Wi-Fi | Survey, Threats, Handshakes |
| Network | Uplink (the network it joins), Clients (its own network's, and ad blocking), Hosts, Capture |
| USB devices | Drives, Phone, Flipper, PortaPack, DreamPi |
| System | Status (its system, jacks, radios and slots), Access, Terminal, Firmware |

*Receivers* lists each radio it detects and the features it can do in plain
language — *Listen in the browser*, *Live SDR on my computer*, *Decode
aircraft/sensors/ships*, *Spectrum sweep*, *Record raw IQ*, *rtl_tcp server*.
Pick one and it switches the radio to it (one at a time per radio); a *Where
to connect* panel shows the live addresses. A PortaPack in Mayhem mode is
offered as a HackRF: choosing a feature switches it to HackRF mode first.

*Listen* is a receiver in the page, for either radio: the band as a spectrum
and a waterfall, and its sound — broadcast FM, narrow FM, AM, sideband and
Morse. Click a signal to tune to it, drag to move along the band, scroll to
zoom, or type a frequency; the buttons above the display go to places worth a
listen (FM radio, aircraft, weather radio, marine, the amateur bands). The
two buttons outside the step buttons, ⏮ and ⏭, begin a scan, down the dial
or up it: it stays five seconds on every signal that stands
out from the noise beside it (6 dB over it in its channel; the squelch, when
it sets itself, opens a dB under that, so what a scan stops on is heard),
then goes on to the next, until it is stopped. A signal is taken as wide as
it is: a broadcast station is one stop, at its middle, whether it is being
listened to as wide FM or 8 kHz at a time, and the scan goes on from where
the signal ends. What was in the channel listened to at a stop has been
heard, and is not a stop of its own: of two carriers 7 kHz apart, listened
to 12.5 kHz at a time, a scan up stops on the first. The dial goes to the
nearest of its steps when the
signal's middle is well inside the channel there; where the steps are wider
than the channel (25 kHz, for 12.5 kHz of narrow FM) it can be between two,
and the dial then goes to a finer step, where the signal is. Where the scan
sees something it looks for a second before it
says what (a station's carrier moves with its sound, and in less it is a
dozen lumps); where it sees nothing it moves on at once. A scan is stopped
by the button that began it (lit, while it runs), which leaves the dial on
the signal it is on (or has just left), or by tuning by hand; the other
button turns it round. With no signal in what the radio takes in, the radio
itself goes on, a span at a time. In one of those bands, listened to the
band's own way (broadcast FM in wide FM, aircraft in AM, the two-way bands in
narrow FM), the scan keeps to the band and goes round it, from signal to
signal; a band with nothing else in it is left behind, and the scan goes on
beyond it, as it does anywhere else. The star beside the
frequency keeps the channel the dial is on as a favourite, under a name (its
frequency, how it is listened to and how wide): favourites sit in a row above
the display, a click goes back to one, and the star on one that is kept
renames or removes it. They are kept in the browser, not on the router, as
the rest of what the page remembers is: another browser, or the router under
another address, starts without them. Between stations it
is quiet: the squelch sets itself a little above the noise (or is set by
hand). It needs the radio to itself: when a job holds it the page says which, and stops it on request,
and a PortaPack in Mayhem mode is switched to HackRF mode first. Giving the
radio to a job on the Receivers page takes it back from a listening page,
which says so.

The router does none of the signal processing — one 775 MHz core without an
FPU could not, which is why this is not OpenWebRX. `pirate-websdr` passes the
radio's raw 8-bit samples into a WebSocket (port 8073) and takes the tuning
back, as the SoapySDR server does for a program on a computer, and the page
does the rest in the browser: the FFT for the display, the channel filter,
the demodulator. So it wants a reasonable computer, and a network that
carries 4.8 MB/s for the default 2.4 MHz span (the HackRF's narrowest; the
RTL-SDR goes down to 240 kHz, which a phone manages). Several pages can
listen at once, to the same radio at the same tuning. The port answers on
the router's own network, like the other SDR ports, and to the router's own
pages only, reached by its address or its own name: a page from another site
is refused (`option extra_args '--any-origin'` in the `websdr` job lifts
that, for a router reached by some other name). The page comes over plain
HTTP, so the stream is plain too (`ws://`).

*Sensors* has one row per device
rtl_433 has decoded, with its latest readings. Ports and radios go by what they are on the
GL-AR750S: the WAN jack and LAN 1 and 2, the 5 GHz radio (QCA9887: the
access point and the uplink) and the 2.4 GHz one (QCA9563: monitor mode),
the USB port and the microSD slot, with the system's own names (`phy0-sta0`,
`eth0.2`) beside them, small.

**Access:** the root password (changing it needs the current one: the page
signs in with it again, and the router takes that fresh sign-in as proof
before it changes anything); SSH's port and whether it takes passwords; the
keys it takes (paste a public key's line), with their fingerprints and the
router's own; who is signed in now over SSH or the terminal, each with an
*End* button; and recent sign-ins from the log, with the key or password
each used. Passwords can't go off while there is no key, nor the last key go
while they are off.

**Terminal:** a shell on the router in the page (ttyd). It asks for root's
password, as SSH does; only the router's own network (its LAN jacks and the
Pirate Radio access point) reaches it, on port 7681, and only its own page
can open it, two at a time. *Turn it off* stops it, and it stays off.

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

- **Ad blocking** for the router's clients (on/off on the Pirate Radio UI's *Clients*
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

**USB drives:** plug a flash drive or disk into the USB port (through the hub
if a radio is in too) and within a few seconds it is mounted at
`/mnt/usb/<its label>` and shared:

- **On the network**, over SMB: `\\pirateradio.local\<label>` in Windows'
  File Explorer (the router also shows under Network), `smb://pirateradio.local`
  in macOS's Finder (Go → Connect to Server), or a phone's file manager. The
  server is the kernel's ksmbd, with wsdd2 so that Windows lists it, and only
  the router's own network reaches it. Until a share password is set, anyone
  on that network can read and write the drives. **Windows 11 won't connect
  without a password**: set one on the Drives tab and sign in as `pirate`
  with it.
- **On the Drives tab**: each drive, its free space and network paths, a file
  browser, and links that open files from the router (port 8082, behind the
  router's own sign-in, root and its password). **Eject** stops sharing a
  drive, unmounts it and powers it down, ready to pull out.

Pull it out and it is unmounted and no longer shared; with no drive left,
the SMB server and port 8082 stop. FAT32, exFAT, NTFS and ext4 drives work;
one that won't mount for writing (NTFS that Windows didn't shut down
cleanly) is shared read-only. Anything `/etc/config/fstab` names is left to
block-mount. Turn sharing off on the tab to keep the drives to the Drives
tab; the settings are in `/etc/config/pirate-usb`, and `logread -e
pirate-usb` shows drives coming and going.

**The microSD card** is shared too if you tick "Share the microSD card too"
on the Drives tab (`pirate-usb.share.card`; off at first). It shows up as
`microSD`, on the network (`\\pirateradio.local\microSD`) and on the tab,
like a drive, but it can't be ejected there. It holds Pirate Radio's
recordings and captures, Wi-Fi handshakes included, so share it with a share
password set, or only on a network you trust. Take the card out and it stops
being shared; put it back and it is shared again once it mounts. (Its files
are also on port 8081, in the browser.)

**An Android phone:** plug one into the USB port and the **Phone** tab turns
each of the phone's "USB controlled by" options into something the Slate can
use. You pick the mode **on the phone** (swipe down the USB notification, or
Settings → Connected devices → USB); the router recognises each one straight
from the USB bus and sets it up here — no USB debugging needed. Each mode and
what the Slate makes of it:

- **USB tethering** — the phone becomes a **WAN uplink**: the router routes its
  traffic out through the phone's connection, and hands the route back to
  Wi-Fi/ethernet when you stop. Modern Android tethers over **CDC NCM** (not
  classic RNDIS), so the image carries `kmod-usb-net-cdc-ncm` (and
  rndis/cdc-ether for other devices).
- **Webcam** (Android 14+) — the phone's camera, streamed as MJPEG in the
  browser (`kmod-video-uvc` + ustreamer, on port 8083).
- **MIDI** — the phone's ALSA MIDI port (`kmod-usb-audio`).
- **File transfer** (MTP) and **PTP** — recognised and told apart; browsing the
  phone's `/sdcard` and downloading files is an **optional** extra over `adb`
  (OpenWrt has no MTP tooling), which asks the phone for a single Allow dialog
  only when you start it.
- **No data transfer** — charging only; the phone is still recognised.

The mode is read from the phone's USB interface classes (and the product id to
tell MTP from PTP apart), so the status never runs `adb` and the phone is not
prompted while the tab is open. The backend is `pirate-phone` (its rpcd plugin
`pirate.phone`); `pirate-phone-dl` serves a pulled file; a usb hotplug hook
drops the tether uplink and webcam stream when the phone is unplugged.

**A Flipper Zero:** plug one into the USB port with a data cable (through the
hub if a drive is in too) and the **Flipper** tab shows it, as qFlipper would
on a computer:

- **Its screen**, live, with its buttons beside it to press (hold one for a
  long press); or click the screen and use the arrow keys, Enter and
  Backspace. *Save a screenshot* keeps a PNG.
- **Its files**, on the SD card (`ext`) and inside (`int`): browse, download
  (8 MB at most a file), upload, rename, delete, make folders.
- **Its details**: name, firmware, battery, SD card space, and everything else
  it reports; it can beep and blink (to find it), take this computer's time
  for its clock, and restart.

`pirate-flipper` (its own package) holds the Flipper's RPC session, as
qFlipper does: `start_rpc_session` at the Flipper's CLI, then its protobuf
messages ([flipperzero-protobuf](https://github.com/flipperdevices/flipperzero-protobuf)
has their definitions; the code here is Pirate Radio's own). It waits while no
Flipper is plugged in, and gpsd leaves the Flipper's serial port alone. A
Flipper locked with a PIN gives no answer until it is unlocked; one in DFU
(recovery) mode is shown as such, for qFlipper to repair. Firmware updates
aren't done here yet. `logread -e pirate-flipper` shows it connecting.

**A MeshCore radio:** plug one into the USB port (a LilyGo T-Echo, or another
nRF52 board on Adafruit's bootloader) running MeshCore's companion firmware
*for USB* (for the T-Echo, "Companion (USB)" on
[MeshCore's flasher](https://flasher.meshcore.co.uk); the Bluetooth build
says nothing over USB, and the page says so) and the **Messenger** tab is its
app, as MeshCore's is on a phone, laid out as Discord is:

- **The list down the left**, filling the window beside the open
  conversation (on a phone, one or the other): a search (Ctrl+K) that finds
  channels, conversations and anyone to start one with; *Channels* and
  *Direct messages*, each collapsible, with unread counts and those with
  news in bold; *Contacts*; and your radio at the foot (its battery and
  GPS; the gear opens its settings).
- **A thread laid out as a chat app's**: each sender with a colour of their
  own (from their name, the same everywhere) and a face (the first emoji in
  their name, or its first letter), one sender's run of messages under one
  header, a line between days and one where the news starts; older messages
  come a page at a time as you scroll up, and a pill jumps back to the
  newest. Each message's SNR and hops, and for yours whether it was sent,
  delivered (with the round trip) or not confirmed (*retry* sends it again,
  as the same message).
- **Replies**, as in a chat app: *Reply* on a message (hover, or tap on a
  phone) and the composer says whom you're answering; a reply carries the
  start of what it answers above it (click it to go there), and one to you
  is lit. MeshCore has no reply in its protocol, so a reply goes as its
  apps send one, `@[Name] ` first, which every MeshCore app shows. The
  router keeps which message each of yours answers; for one that comes,
  it's the newest of that person's before it (as MeshCore's app means it),
  or, from MeshCore Open (which adds the time, `@[Name#…]`), the one of
  theirs at that time. `@[Name]` answering nothing here is a mention, and
  a `@[Name]` anywhere in the words — some apps bracket mentions mid-text —
  shows as an `@Name` you can click, not the raw brackets. Some apps also
  paste the start of what they answer as a `>`-quoted first line; it's
  already shown above, so that leading quote is dropped from the body.
- **Profiles**, as Discord's: click a face or a name (in a thread, a
  mention, a conversation's head, Contacts, your radio at the foot) for
  their card: who they are (their key, when they were last heard); their
  route, through which repeaters, with *Trace route* (MeshCore's trace:
  each repeater's SNR, there and back) and *Find a route* (MeshCore's path
  discovery; the route found is used from then on); where they are, from
  their advert (how far and which way from you, a map), and *Ask for
  telemetry* (their battery, and their position and sensors if they share
  them with you); *Message*, *Mention* (`@[Name]` in the composer),
  *Remove*. Someone in a channel who isn't a contact can be mentioned.
- **Reactions**, as Discord's: a chip each emoji under the message it's
  to, how many, who on hover, yours lit; click one to add yours, or the
  face on a message's toolbar for a picker (or any emoji typed). MeshCore
  has none in its protocol: its apps send a reaction as a message.
  MeshCore One's (`@[Name]👍` and, a line down, an 8-character hash of the
  message: its text and its sender's time, through SHA-256, in Crockford's
  base 32) are read and sent (meshcore-open reads them too, from 9.5.2);
  meshcore-open's (`r:hash:index`, into its table of emoji) are read. The
  router finds each one's message, keeps one that comes before its
  message until that does (as MeshCore One does), and counts none as
  news. In a DM you react to their messages, not your own: a DM's
  reaction names no one, so meshcore-open and MCO Advanced look for it
  only among the messages they sent (one to yours would show there as its
  text). In a channel, any message. The official MeshCore app has no
  reactions: it shows anyone's, from any app, as their text.
- **Links**, clickable; **media from common sites shown under the words**,
  as Discord does: YouTube, Vimeo, Spotify and SoundCloud as a player you
  press play on (nothing external loads until you do); X/Twitter as a card;
  Giphy's GIFs (a `giphy.com/gifs/…` page or meshcore-open's `g:ID`) and
  links to an image file (`.gif`, `.png`, `.jpg`, `.webp`…) as the picture.
  A message that's only one of these shows just the embed. It all loads in
  the browser viewing the page (with no referrer, and a player not until
  you press play), so it is offline-safe: with no connection, or the thing
  gone, the link stays.
- **An emoji and GIF picker** on the composer (the ☺ button), as Discord's:
  an **emoji** tab (searchable, categorised; plain Unicode, so it works
  offline) and a **GIF** tab that searches **Giphy** — a free API key,
  pasted once and kept in that browser (the search is debounced and its
  results cached, to stay easy on the key's hourly quota). A pick is sent as
  a direct `.gif` URL, so every client shows a tappable GIF and this UI and
  meshcore-open preview it inline; a `g:ID` from meshcore-open is still read.
- **MCOimg**, MCO Advanced's one-packet images (the meshcore-open fork's
  pixel art: `im3:` for v3, `im:` for v1 and v2, by a text message or as a
  channel's binary data), drawn with MCO Advanced's own decoder, sharp, at
  a whole multiple of their size. v4 drawings (`im4:`) have no JavaScript
  decoder yet: they say so. MCO Advanced's other kinds of channel data
  (its compressed text, MCMP and MCOtxt) show as the placeholder MCO
  Advanced shows for a kind it can't read.
- **MeshMapper's wardriving pings** (in #wardriving: `MM:` and a
  10-character tag), shown as pings, each with how it was heard (its SNR,
  its hops). The tag is keyed, so only MeshMapper's server reads it (it
  names the sender's session and ping, not where they are); a ping sent
  with its sender's position (`MM:tag:lat,lon`, MeshMapper's "Broadcast My
  Coordinates") shows that, how far from you, and a map.
- **Channels** (# for public and #hashtag ones, a lock for private ones):
  add a #hashtag one (its key comes from its name), a private one (a random
  key) or one whose key you were given; a channel's gear shows its key, to
  share it, or removes it.
- **Contacts**, from adverts heard, on a page of their own: by kind
  (people, repeaters, rooms), searched, sorted (heard recently or longest
  ago, by name, by hops), a page at a time; message one, forget a route,
  remove one (when the radio's list is full, the page says so). *Advert*
  announces the radio to its neighbours or to the whole mesh; *Rename*
  changes the name it announces.
- **Favourites**: the radio's own mark on a contact (the lowest bit of its
  flags, so whichever app set it), starred in Contacts and the direct
  messages, with a tab of their own. Star or unstar one in Contacts or its
  profile: the radio keeps it, the contact's other flags (what it may ask
  of you) as they were, and when its list is full and it makes room for
  someone new, it keeps its favourites.
- **Its GPS**, on or off. With it on and a fix, its position tags the
  **Wi-Fi survey**'s sightings when no USB GPS (gpsd) has one: no separate
  GPS needed for wardriving. **Whether the adverts carry its position** is a
  toggle on this page: off keeps it private (only the radio's name goes out),
  on lets the mesh see where the radio is (a warning shows while it's on, as
  MeshCore's own app keeps it off). Turning it off also stops its telemetry
  telling anyone who asks where it is (MeshCore keeps the two apart): only
  the contacts you allow still can, and a warning shows if its telemetry
  tells anyone while sharing is off. *Match the mesh* sets it to whatever most
  radios you've heard do — only other people's radios count, since repeaters
  and rooms nearly always carry theirs.
- **Its settings**, on its own page (the gear at your radio): how it's doing
  (its battery, uptime and queue; the noise it hears and the last packet's
  signal; its airtime; the packets it has heard and sent), and all an app
  can set. Its radio: frequency, bandwidth, spreading factor and coding rate,
  MeshCore's own settings for each region to pick from (with a warning: a
  radio on other settings than its mesh's goes quiet), and its TX power.
  Where it is: sharing it, the GPS, a position set by hand. Who may ask for
  its telemetry (its battery, where it is, its sensors: no one, the contacts
  you allow, or anyone). The contacts it adds by itself: which kinds, from
  how far, and whether a full list makes room. Extra acks, its tuning, a
  restart. An editor open stays as it is while the page keeps up.
- **A command line** (the `>_` at your radio): MeshCore's own, your radio's
  (from MeshCore 1.14) — `ver`, `get radio`, `set tx 20`… — what it sets shown
  on the settings page too. Or a repeater's, room's or sensor's, over the
  mesh: log in (its admin password, or as a guest, who MeshCore asks to log
  in over a route rather than flooded), its status (battery, uptime, noise,
  airtime, packets, duplicates), and its commands (`neighbors`, `clock`,
  `stats-radio`…). Each one's lines are kept apart, and its answers out of
  the conversation; one that comes after its command gave up shows too.
  Restarting, powering off, erasing or retuning one asks first.
- **The packets it hears** (the wave at your radio): every packet the radio
  hears, from any radio in range, with its SNR and RSSI, read as far as that
  goes without keys — an advert's who, what kind and where; the rest, which
  way they came (flooded or direct, through which repeaters) and whom they're
  between, by the bytes of keys they carry (a contact's name where one
  matches, a channel's by its hash). Newest first, by kind, paused, or opened
  to its bytes; the router keeps the last 256.

`pirate-meshcore` (its own package) speaks MeshCore's companion protocol over
USB, after MeshCore's documentation and firmware (both MIT; the code here is
Pirate Radio's own): its messages and contacts, and its settings, its own
command line (`CMD_RUN_CLI_COMMAND`), repeaters' remote admin (a login, their
status, their command line as CLI data) and the raw packets it hears (its RX
log). Its reactions follow MeshCore One's documented format
and meshcore-open's; meshcore-open's table of reaction emoji
(`src/mco_emoji.h`) is its own, MIT. A channel's binary data (MeshCore's
GROUP_DATA) is read as MCO Advanced lays it out (its `CHANNEL_APP_DATA`):
an MCOimg kept in its text form, so the page draws it as it would a text
message's. Messages are kept on the router in
`/etc/pirate-meshcore/messages`, through a flash that keeps settings, as the
radio passes each on once. It waits while no radio is plugged in, and gpsd
leaves its serial port alone. MeshCore reports no satellites or fix, so a
position counts as a fix while it moves (a GPS's does, by a little, from one
reading to the next). `logread -e pirate-meshcore` shows it connecting.

**A HackRF with a PortaPack, on Mayhem firmware:** plug it into the USB port
(through the hub if a radio is in too) in its **device (console) mode** — the
mode Mayhem shows over USB as a serial console (`1d50:6018`), not HackRF mode —
and the **PortaPack** tab is [hackrf.app](https://hackrf.app) (MayhemHub) on the
router:

- **Its screen**, live, scaled to fit, with a D-pad, a select button and the
  rotary dial beside it to press; or click the screen to tap where you click.
  Focus the screen and the arrow keys, Enter (select) and Backspace work the
  buttons, and typing sends characters to its on-screen keyboard. *Save a
  screenshot* keeps a PNG.
- **Its files**, on the SD card: browse, download (4 MB at most a file),
  upload, make folders, delete. Names are plain ASCII and short (Mayhem's shell
  takes 64-character command lines, so paths are kept to 48).
- **Its details**: the model, firmware version, board revision and screen size
  it reports, and everything else from Mayhem's `info`.
- **Firmware**: update to the latest stable or nightly Mayhem build — fetched
  in the browser from [hackrf.app](https://hackrf.app)'s own API (the Mayhem
  project's), for the right device (HackRF One, HackRF Pro or PortaRF) — or
  flash a `.bin` or Mayhem `.ppfw.tar` you pick. The PortaPack reboots when it's
  done. It reboots to OS or DFU too.
- **Switch it into HackRF mode**: Mayhem's own `hackrf` command, so the
  PortaPack leaves the console and comes back as a HackRF the SDR jobs (survey,
  SoapySDR, IQ…) can use. Put it back into device mode on the PortaPack itself.

`pirate-portapack` (its own package) speaks Mayhem's serial command shell over
USB, after Mayhem's firmware and MayhemHub (both GPL-2.0; the code here is
Pirate Radio's own): a line a command, each answer ending at the `ch> ` prompt
(`info`, `screenframeshort`, `button`/`touch`/`keyboard`, the `fopen`/`fread`/
`fwb` file commands, `flash`, `hackrf`, `reboot`). It holds that console on ubus
as `pirate.portapack`, scales each screen frame down so a live view fits the
network, and sends uploads to the PortaPack a piece at a time. It waits while no
PortaPack in device mode is plugged in, and gpsd leaves its serial port alone.
Nothing here transmits; flashing writes only what you choose. `logread -e
pirate-portapack` shows it connecting.

**A Bluetooth dongle:** plug one into the USB port and the **Bluetooth** tab
shows the Bluetooth devices around, as a scanner app on a phone would: a
line a device, with how strongly it is heard, its name where it says one,
what kind of thing it is, its maker, its address, and when it was last
heard.

- **What they are:** phones, computers and watches; headphones and speakers;
  beacons (iBeacon and Eddystone, with what they carry); sensors (a
  RuuviTag's readings); keyboards and mice; and whatever else advertises.
  The list can be searched, ordered, and kept to one kind.
- **Trackers** are marked (an AirTag and the others on Apple's Find My
  network, a Tile, a SmartTag, a Chipolo, those on Google's network), and
  marked again when they say they are away from their owner.
- **A line pressed** shows the rest: how often the device advertises, how
  strongly it was heard over the last two minutes, everything its
  advertisement says, and the advertisement as it was sent.

With a dongle of Bluetooth 4.0 or later it only listens. The adapter scans
passively for Low Energy advertising: it asks nothing of the devices it
hears and connects to none. So a device that does not advertise is not
seen, a name that a device gives only when asked is not shown, and
nothing that is seen can tell. What a device is taken for is a reading of
what it advertises, no more: a name is its own word, a maker is whoever's
number is on its data. Phones, watches and trackers change their address
every few minutes, and are a line for each address they had until one not
heard for five minutes is let go. Nothing is kept or written: the list is
the page's, and goes with it.

An older dongle (Bluetooth 2.0, 2.1 or 3.0) has no Low Energy, which is
what nearly everything advertises with now, and so nothing to listen to.
With one the page searches the older way, and says that it does: ten
seconds at a time the dongle sends an inquiry, which the devices that are
set to be found answer with their address and their class (a phone, a TV,
headphones), and each one found is then asked its name. **That
transmits**, and a device that is asked its name can tell by whom. It
also finds far less: most phones answer only while their Bluetooth
settings are open, headphones and speakers while they wait to be paired,
many TVs and printers at any time; trackers, beacons and watches not at
all. What is found this way is marked *classic*. **Stop** ends the
searching within ten seconds, as leaving the page does.

The router does none of the reckoning. `pirate-bluetooth` (its own package)
has the kernel's adapter (`hci0`, through an HCI socket; nothing of BlueZ)
scan while a page looks, puts it down again ten seconds after the last one
asked, and hands on what the adapter reports as it is, on ubus as
`pirate.bluetooth`. The page (`bt/scanner.js`) makes devices of that, with
the names of makers and services from Nordic Semiconductor's
[bluetooth-numbers-database](https://github.com/NordicSemiconductor/bluetooth-numbers-database)
(`bt/names.js`, made by `scripts/bt-names.py`). An adapter that takes only
Bluetooth 5's extended scan commands is given those; one from before
Bluetooth 4.0 is given inquiries and name requests, whose answers are
handed on in the same way; a dongle the kernel has no driver for is said
to be one. `logread -e pirate-bluetooth` shows it starting and stopping.

**The USB port's power:** a device on the USB port that has stopped
answering wants pulling out and plugging in again. The full image does
that without a hand on it: **Status → USB port → Switch off and on** cuts
the port's power for three seconds (over SSH, `pirate-router
usb_power_cycle`). Drives on the port are ejected first, and it is not
done while one of them is in use; what else is plugged in goes and comes
back as if replugged. What a hub with its own power feeds keeps that
power.

At boot the router does the same by itself, early on and before its jobs
start, if what is plugged in has not answered when the kernel asked what
it was. The port is switched off and on, twice at most, and only when
nothing on it has answered, so nothing that works is interrupted;
`logread -e pirate-router` says when it was. The Status page says when
the last thing plugged in did not answer. It is a second try and no more:
the Bluetooth dongle it was written for, silent since a reboot, stayed
silent whatever its power did, and was at fault itself.

The quick image has no such switch: OpenWrt's kernel holds the line that
powers the port on for good. The full build's device tree hands the line
over instead, by name (`/sys/class/gpio/usb_power`), as OpenWrt's does for
the GL-AR300M.

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
- **Bluetooth:** both images include the kernel's Bluetooth support and
  its driver for USB dongles (`kmod-bluetooth`, `kmod-btusb`), and
  `pirate-bluetooth` for the Bluetooth page. Nothing of BlueZ is in the
  image: there is no `bluetoothctl` or `hcitool`. A dongle of Bluetooth
  4.0 or later is the one to have: it listens, sends nothing and hears
  nearly everything. An older one can only search by inquiry, which
  transmits and finds little. The dongle shares the USB port with the
  radios, so use the powered hub.
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
  against a mock sysupgrade, so no real flash is ever attempted), the router's
  jacks, radios and slots on a faked GL-AR750S, its USB port's power (with
  the switch a full build has and without it; a device that answered, one
  that did not, and one still being set up; off and on, with the drives
  ejected first, not while one is in use; at boot, only when what is
  plugged in has not answered, then twice at most), the password change and its
  proof (old, foreign and forged sessions refused), Access (pirate-access:
  SSH's settings and keys, with fingerprints as ssh-keygen and dropbearkey
  print them, the lockout guards, sessions and their ending, sign-ins from the
  log, and the terminal's setup), and plug and
  play (jobs held back while their radio is unplugged, the USB and tty hotplug
  hooks, gpsd started and stopped with the GPS, the map server living and
  dying with the ADS-B job), and DreamPi (the modem daemon against
  `tests/fakemodem`, a modem with a Dreamcast dialling on a pseudo-terminal;
  the call script, NAT rules, Dreamcast Now with its name form and the
  port-1998 configure helper, init script, hotplug hook, DMZ and the UI's
  backend), USB drives (mounting by label and filesystem, the microSD card
  and swap left alone unless the card is to be shared, read-only fallback,
  the shares and share password, the card shared, taken out and put back,
  the folder listing and its limits, eject, and the block hotplug hook), a
  Flipper Zero (pirate-flipper against `tests/fakeflipper`, a Flipper's CLI
  and RPC session on a pseudo-terminal: connecting, its details, folders over
  several messages, uploads in pieces and downloads in slices, renaming and
  deleting, the screen stream and its stop, buttons, the clock, restarting,
  and gpsd keeping off its port), a MeshCore radio (pirate-meshcore against
  `tests/fakemeshcore`, a companion radio on a pseudo-terminal: a Bluetooth
  build's silence, connecting, its details, contacts and channels, the
  messages it kept and those that come, sending to contacts and channels,
  delivery and its absence, a retry, replies sent and received (MeshCore's
  app's and MeshCore Open's), reactions (MeshCore One's and meshcore-open's
  hashes against their own examples, reactions come, found and kept
  (meshcore-open's in a DM too), one sent, in a DM only to theirs, none
  counted as news), MCOimg come as
  channel data (MCO Advanced's fixtures: v3, v1/v2, v4, its other kinds,
  MeshCore Open's, and data that isn't a chat's), hashtag, private and
  keyed channels,
  adverts, its name, its GPS and the survey taking its position,
  favourites (as the radio has them, made and unmade, the rest of their
  flags kept, through a route found and a restart), contacts' routes,
  traces along them (to a person and to a repeater), a route found and
  kept, telemetry and its absence, removal, the messages kept through a
  restart, and gpsd keeping off its port),
  an Android phone on the USB port (pirate-phone with a fake adb and sysfs:
  the phone recognised and its USB mode told apart for each composition —
  charging, file transfer, PTP, tethering over CDC NCM, MIDI and webcam —
  authoritative over adb and read from sysfs without it, the file listing
  keeping spaces in names, a mode switch asking adb for the right function,
  and the paths outside shared storage it refuses),
  a HackRF/PortaPack on Mayhem firmware (pirate-portapack against
  `tests/fakeportapack`, the Mayhem command shell on a pseudo-terminal:
  connecting and reading its model, firmware, board and screen size; its info;
  listing the SD card and a folder, folders flagged; whole-path and no-`..`
  checks; mkdir, "already exists", and listed; uploading a file and reading it
  back, a missing file refused; delete; buttons mapped to Mayhem's switch
  numbers, touch in screen pixels, the keyboard sent as hex; the screen scaled,
  a frame coming, changing when the menu moves and unchanged frames held back;
  reboot and flash input checks; switching to HackRF mode leaving the console;
  and gpsd keeping off its port),
  a Bluetooth dongle (pirate-bluetooth against `tests/fakebt`, an adapter
  on a Unix socket that speaks HCI as the kernel's does: none, and a dongle
  the kernel has no driver for said to be one; an adapter left alone until
  a page asks, then a passive scan that leaves no advertisement out; its
  address and versions; what it hears handed on as it came, a record an
  event, to be asked for from where the last answer ended; more than is
  held, and how many were let go; the scan switched off and the adapter
  let go when nobody asks, and when the daemon stops; an adapter that takes
  only the extended scan commands; one from before Bluetooth 4.0, which is
  sent no Low Energy command but inquiries, one after another, a name
  asked for once of a device that tells it, twice of one that answers no
  page and never of one that said it, what was found and told handed on
  as it came, and the inquiry called off when nobody asks; one that
  answers nothing, one that goes away while it listens; unplugged),
  against mock radios and tools on that same userland, and the rename from
  slate-sdr (settings, card mount, card folder) and pirateradio.local, and
  the web UI's receiver (the bridge as built for the router, answering a
  handshake with its simulated radio; its job among the others; the radio
  taken back from a page that listens; old settings given the job): 939
  checks.
- The receiver in the web UI has tests of its own that need no router (the
  workflow's `websdr` job): the engine's signal processing against signals
  made by the formula, the engine against a stand-in for the bridge, and
  the page's own reckoning: the noise in a line of the spectrum; the
  signals in it, each as wide as it is, where the dial goes for one, and
  where a scan looks next, up the dial or down it; the squelch that sets
  itself by the same noise; the lines that come after the radio has
  moved, which are not measured on; and what is made of the favourites a
  browser kept (`node tests/sdr/run.js`, 94 tests); and the
  bridge, built for the machine
  at hand with its simulated radio, through its protocol end to end, then
  with the engine run against it, then again under the address and
  undefined-behaviour sanitizers (`sh tests/websdr/run.sh`, 30 and 6 tests);
  and the bridge's source for the real radios with a stand-in for the
  SoapySDR library behind it, whose driver spoils a stream that is stopped
  and started again, as the HackRF's does (8 tests, in the same run).
- The Bluetooth page's own reckoning has tests that need no router either
  (`node tests/bt/run.js`, 23 tests, in the same job): the advertising
  reports in what the router hands on, in the form every LE adapter has
  and in Bluetooth 5's; an advertisement's structures and what they say
  of a device, made a byte at a time after the Bluetooth specification
  and the makers' published formats (its name; a beacon's contents; an
  AirTag with its owner and without; whose a tracker is; headphones by
  the model they say; a RuuviTag's readings, by Ruuvi's own example);
  the devices heard, one for an address, how strongly and how often;
  what an adapter from before Low Energy finds by asking, in each of the
  forms an inquiry's results come in, with the names it is told, each
  device a line of its own by its class and then its name; and the
  made-up neighbourhood of the UI's demo mode, which goes through the
  same reckoning as a real one.
- Both images build on GitHub Actions, and the tests pass there.
- The full build's configuration resolves: `./build-full.sh --config-only`
  keeps `CONFIG_KERNEL_RELAY`, the spectral options and upstream ath10k.

Not yet run:

- Most of the radio work on a real GL-AR750S. So far, rtl_433 decodes from a
  real RTL-SDR there, hackrf_sweep surveys 1 MHz – 6 GHz from a real
  HackRF (a PortaPack in HackRF mode) in under a second per sweep, SDR++ on a
  computer has listened to that HackRF through the SoapySDR server, and the
  web receiver's bridge has streamed it at 2.4 Msps with nothing lost (next).
  Untested there: raw IQ capture to the card, rtl_tcp, rates above 2.4 Msps,
  the card reader's write speed, and Wi-Fi spectral scan on this hardware.
  `ath10k` spectral on the QCA9887 specifically has not been confirmed.
- The Listen page on the device, beyond a first use. In a browser, against
  the router's bridge and a real HackRF (a PortaPack in HackRF mode) at
  2.4 Msps, the page has taken the radio from the survey job and broadcast FM
  has been listened to. That use found a fault: Stop, then Start within the
  5 s the radio is kept open, could bring sound that stutters. The HackRF's
  driver does not survive its stream being stopped and started again (when
  the stop falls on a buffer half read, one in four or so, it hands out old
  samples from then on, as fast as they are asked for: three times the
  radio's pace, as measured here), and that is what the bridge did. The
  bridge now makes a new stream for every start (0.1.1). That is tested
  against a stand-in for the driver, and has been run on the device with the
  page's engine driven from Node: eight Stops and Starts in a row with the
  radio kept open, each at the radio's pace with nothing lost, and the span
  changed between 2.4 and 4.8 MHz four times, the frames coming 50 and 100 a
  second as they should. Listened to in the browser since, Stop and Start
  sound right; and favourites have been kept and recalled there. The Scan
  button's first form (to the next signal at a press) was run on that
  HackRF with the page in a browser on a computer, the stream relayed to
  it: from 96.9 MHz to the next stations up, 100.7 and 102.5, and from
  there round the top of the FM band to 96.9 again in 2.4 s (they are the
  three that stand 10 dB over the noise there). Tried in the router's own
  page at 160 MHz, it came back to where it began: it kept to the marine
  band, which had nothing else in it. The scan as it is now (staying on each
  signal and going on by itself, and leaving a band with nothing else in
  it) has been run in a browser against the simulated band, and then tried
  in the router's own page on that HackRF, where it worked, but went past
  stations that could be heard. It wanted a channel 8 dB over the noise,
  where the squelch, by a rougher reckoning off the picture, let through
  what was 6 dB over (and less, zoomed in); and it took the noise from the
  whole line. Both now go by one measure, taken on the lines as power: the
  noise beside the channel, the scan stopping 6 dB over it and the squelch
  opening a dB under that (the squelch by the whole line's noise too, where
  that is less, so that nothing it let through before is shut out). That
  was worked out on lines recorded from that HackRF (54 looks along six
  bands), and then run on it with the page in a browser on a computer, the
  stream relayed, at the gains the page had been used with: round the FM
  band the scan stayed on six or seven stations where it had stayed on
  four, the squelch open on each. What those lines also showed, and a scan
  does not allow for: this HackRF's own carriers stand as signals (at
  multiples of 10, 3.125 and 0.8 MHz; 125 MHz is 28 dB over the noise,
  120 and 160 MHz 23 to 25, 444 MHz 18), and a strong signal just
  outside what the radio takes in shows inside it, at the other end (one
  0.24 MHz outside, 14 dB down: at 2.4 MHz the HackRF's filter is not
  steep). A scan stops on both as it would on a station. Tried in the
  router's own page with the dial left in AM among the broadcast stations,
  that scan stopped several times on one station (100.25, 100.29, 100.30,
  100.305 MHz): 8 kHz at a time, each lump of a station was a signal, and
  the scan went on from half a step above the last. A signal is now a
  stretch of the line, as wide as it is; the scan stops on it once, at its
  middle, and goes on from where it ends. What that takes was found on
  lines recorded from that HackRF (with a better aerial by then: twelve
  stations 6 dB over the noise, and the weather station on 162.55 MHz): a
  second of the spectrum, not a fifth of one, which is why the scan looks
  twice. They showed one thing more. After the radio moves, the spectrum
  still shows what was there before: for two or three lines, as the
  samples on their way arrive; and again for a tenth of a second here and
  there until 0.9 s after, because the HackRF's driver (SoapyHackRF), read
  late as it is while the radio is being moved, hands out a buffer it
  filled 0.8 s before as if it were new (34 moves looked at: the old
  picture in the first line of every one, in none after the 19th). The
  page now waits a second after a move before it averages; the bridge
  could spare it that by never leaving the driver with part of a buffer,
  and does not yet. Run on that HackRF with the page in a browser on a
  computer, the stream relayed: from 100.295 MHz in AM, inside a station,
  the first stop was the next station, 100.7; round the FM band in wide
  FM, sixteen stops, each once, the squelch open on every one; from 162
  MHz in narrow FM, the weather stations. Five or six of those sixteen
  (87.7, 90.0, 91.5, 93.0, 94.5 and perhaps 93.7 MHz) are where the
  recordings show no station but a hump of noise that the aerial picks
  up from something near it, one every 0.72 MHz and by then 10 dB over
  the rest: as wide as a station and as strong as a weak one, a scan
  cannot tell them from one. That scan was then run in the router's own
  page, in a browser signed in to it. In AM from under the station it had
  stopped on four times: one stop on it (100.3 MHz), one on the next
  (100.7), and so on up, 33 stops in two runs and no signal twice. Twice
  round the FM band in wide FM: the same ten stations each time, the
  squelch open on every one. In narrow FM, from the weather station on
  162.55 MHz, it showed two faults. The scan stopped on that station
  again as it left the band: it went on from the band's top, and that is
  the station's own frequency. And two of the 21 stops above the band
  were silent, the squelch shut: the dial's steps there are 25 kHz, wider
  than the 12.5 kHz listened to, and the dial went to the nearest, 180.300
  MHz for a television station's pilot on 180.310, where the channel
  holds none of it (in the aircraft band, 8 kHz on steps of 25, three
  stops of nine). The scan now goes on from above the signal it began on.
  And the dial goes to a step only when the signal's middle is well inside
  the channel there (within three eighths of the channel's width), or else
  to a finer one. Of the signals in the lines recorded from that HackRF,
  listened to the aircraft band's way, 51 of 178 had the squelch shut at
  the dial, and now none; the weather band's way, 27 of 145, and now two,
  each within a dB of opening it; and listened to as they were recorded
  (wide FM, AM on steps of 5 kHz, narrow FM on steps of 2.5), no dial is
  changed. Run on the HackRF again, from a computer: the pilot found on
  180.3125 MHz and heard; seven stops in the aircraft band, all heard;
  twelve round the FM band and the AM scan as before. (The first of the
  two faults is mended by a test's showing, not the air's: by then a
  second weather station, on 162.45 MHz, was strong enough to keep the
  scan in the band, going from one to the other.) What that run in narrow
  FM also showed is how little of what a scan stops on above the
  broadcast band is a station, on this HackRF: 19 of those 21 stops were
  the carriers at multiples of 0.8, 3.125 and 10 MHz, and the other two
  the pilots of television stations. A scan from each of the page's band
  buttons in turn, on that HackRF, showed one fault more: from the 433
  MHz button, a stop on 437.500 MHz and then one on 437.505. It was taken
  at first for one carrier between two of the dial's 5 kHz steps, which a
  look can put on either (with each carrier in the recorded lines put
  half-way between two steps, a scan over two looks at it had stopped on
  it twice in 15 runs of 154), and mended as that: a signal whose middle
  lies in what the scan began on or last stayed on is that signal again.
  On the air the scan did as before. The lines the page had seen there,
  kept and gone through, held two carriers, on 437.4979 and 437.5047 MHz,
  each a signal, and both inside the 12.5 kHz listened to at the first
  stop. What a scan has behind it is now the signal it stayed on and the
  channel it listened to there, and what has its middle in either is not
  stopped on: on the air, one stop there, and on to 438.4 MHz. The scan
  then got its two buttons, one for each way along the dial, in place of
  the one that went up, and was run on that HackRF down the dial: once
  round the FM band in wide FM, eleven stations, each once, in the order
  a scan up finds them turned about; turned round while on a station, on
  to the next one the other way; in AM from inside a broadcast station,
  the first stop the station under it; from the one signal in the 433 MHz
  band, on under the band; and between the two weather stations. Before
  that, the receiver's two halves were run there with the page's engine
  driven from Node on a computer on the LAN: against the bridge's simulated
  radio (every simulated station heard as the tone it carries, no frame lost
  at 2.4 Msps, the router about 28 % busy and the bridge at 3 MB), and in one
  session of 22 s on the HackRF: no frame lost, no overflow, broadcast FM
  stations found along the band and one of them demodulated to programme
  audio, the radio closed 5 s after the listener left. Untested: sound at
  spans wider than 2.4 MHz (4.8 MHz has only been streamed, 3 s at a time,
  with nothing lost), several listeners on the real radio, the RTL-SDR
  through the bridge, a job taking the radio back from a page that listens,
  and a phone.
- The HackRF decoder paths (`option radio 'hackrf'`): ADS-B through readsb, ISM
  through rtl_433's SoapySDR backend, AIS through AIS-catcher, all on
  `driver=hackrf`. The packages cross-compile and the job wiring is covered by
  the QEMU tests against mock decoders. Of the three, only ISM has met a real
  HackRF: rtl_433 opened it through SoapySDR and streamed, but decoded
  nothing in several minutes, most likely for want of gain (the job sets
  none, and a HackRF starts at 0 dB). Real-time decode at the HackRF's
  2 MS/s minimum may be CPU-bound on the 775 MHz MIPS core, and a HackRF is
  less sensitive at these frequencies than a purpose-tuned RTL-SDR.
- Plug and play: pulling out a HackRF, a real USB GPS, and the boot-time start
  with a radio already plugged in. On the device, a real RTL-SDR has been
  plugged in and pulled out (the ISM job and the SoapySDR server started and
  stopped with it), and a real HackRF plugged in (the survey job and SoapySDR
  started); a PortaPack in Mayhem mode was rightly taken for neither a radio
  nor a GPS. The GPS hook was driven only with a stand-in `/dev/ttyACM0`:
  gpsd started and stopped through procd as expected.
- The PortaPack tab on a real HackRF/PortaPack: not yet run on hardware. Its
  daemon and page are tested only against `tests/fakeportapack` (the Mayhem
  shell on a pseudo-terminal) and the UI's demo mode. Untested on a device: the
  live screen's speed and colours over the real console, large uploads and the
  firmware flash, and the switch into HackRF mode.
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
- The Bluetooth page hearing anything. Its page is tested against made-up
  advertisements and its daemon against `tests/fakebt`. On the device two
  dongles have been tried, both under CSR's number (`0a12:0001`). The
  first, a "CSR8510 A10", answered when it was plugged into the running
  router and never after the next reboot (`device descriptor read/64,
  error -71`): not at boot, not with its power cut (ten times, once for
  30 seconds), not pulled out and plugged in by hand. The second answers
  at once on the same port, so the fault is the first dongle's. The
  kernel's driver sets the second up as an adapter of CSR's own, of
  Bluetooth 2.0, and the daemon brought it up through the kernel's HCI
  socket, read its address and versions, and stopped there: it had
  nothing then for an adapter without Low Energy. It has now, the search
  by inquiry, which no dongle has been through yet: it is tested against
  `tests/fakebt` and made-up results alone. So the driver, the socket and
  the daemon's first steps have run on the device, and neither kind of
  scan has.
- The USB port's power, beyond a first use. On the device it has been
  used at boot (the router found the first dongle silent, switched the
  port off and on by itself, twice, and said so) and by hand, through
  rpcd as the Status page calls it. The kernel sees what is plugged in go
  and come back, a dongle that works is set up again within four
  seconds, and the microSD card stays mounted through it: its reader is
  on the other USB controller and keeps its power. It has not brought
  back a device that had stopped answering: the one it was tried on was
  at fault itself. Not run there: the button on the Status page, and a
  drive on the port being ejected first.

## Layout

| Path | |
|---|---|
| `feed/` | OpenWrt package feed: `fftw3f`, `hackrf`, `soapysdr`, `soapy-hackrf`, `soapy-rtlsdr`, `soapy-remote`, `rtl433-soapy`, `readsb-soapy`, `ais-catcher`, `pirate-websdr`, `pirate-radio`, `pirate-radio-ui`, `dreampi`, `pirate-flipper`, `pirate-meshcore`, `pirate-portapack`, `pirate-bluetooth` |
| `feed/utils/pirate-radio/files/` | the service: job runner, init script, CLI, status page, default config |
| `feed/net/dreampi/` | DreamPi: the modem daemon and DCNet client (`src/`), the call script, NAT rules, Dreamcast Now, init script and hotplug hook (`files/`) |
| `feed/utils/pirate-flipper/` | the Flipper tab's daemon (`src/pirate-flipper.c`: a Flipper Zero's RPC session, on ubus as `pirate.flipper`) and its init script |
| `feed/utils/pirate-meshcore/` | the Messenger tab's daemon (`src/pirate-meshcore.c`: a MeshCore radio's companion protocol, on ubus as `pirate.meshcore`) and its init script |
| `feed/utils/pirate-portapack/` | the PortaPack tab's daemon (`src/pirate-portapack.c`: a PortaPack/Mayhem serial command shell, on ubus as `pirate.portapack`) and its init script |
| `feed/utils/pirate-bluetooth/` | the Bluetooth tab's daemon (`src/pirate-bluetooth.c`: the kernel's Bluetooth adapter set to listen, and what it reports handed on, on ubus as `pirate.bluetooth`) and its init script |
| `feed/utils/pirate-websdr/` | the Listen page's bridge on the router (`src/`: a radio's samples into a WebSocket, through SoapySDR, and the tuning back), and `DESIGN.md`: how the bridge, the engine and the page fit together, and what they say to each other |
| `feed/utils/pirate-radio-ui/files/` | the web UI (`index.html`, `app.js`, `style.css`) and the firmware-upload CGI, served at `/` |
| `feed/utils/pirate-radio-ui/files/sdr/` | the Listen page's receiver: the page's part (`receiver.js`) and the signal processing, which runs in a worker (`worker.js`, `dsp.js`; `siggen.js` is the simulated band of the demo mode) |
| `feed/utils/pirate-radio-ui/files/bt/` | the Bluetooth page's scanner (`scanner.js`: what the dongle hears made into devices) and the names of makers and services it shows (`names.js`, made by `scripts/bt-names.py`) |
| `feed/utils/pirate-radio-ui/root/` | the UI's rpcd/ubus backends: router basics, its ports and the USB port's power (`pirate-router`, with the `pirate-usbport` init script for boot), access (`pirate-access`: SSH, sign-ins, the terminal), firmware, capture, handshake, DreamPi, USB drives (`pirate-usb`, with its init script and block hotplug hook), and the SDR (`pirate.sdr`) and recon (`pirate-recon` / `pirate-survey` / `pirate-threats` / `pirate-dashboard`) tools |
| `config/packages.txt` | what goes into the image on top of OpenWrt's defaults |
| `config/full.config` | full-build options (spectral scan, ath10k) |
| `config/full-patches/` | the full build's changes to OpenWrt's own source, put on by `build-full.sh` (the GL-AR750S's device tree: the USB port's power switchable) |
| `build.sh`, `scripts/` | the Docker build (SDK, then ImageBuilder) |
| `build-full.sh` | the full source build |
| `tests/` | runtime tests on OpenWrt's MIPS userland under QEMU; `tests/sdr/` and `tests/websdr/`: the Listen page's engine and bridge, which run on any machine; `tests/bt/`: the Bluetooth page's reckoning, which does too |

rtl-sdr, rtl_433, dump1090 and rtl-ais come from OpenWrt's own package feed and
drive the RTL-SDR paths. The HackRF decoder paths add separate SoapySDR-enabled
builds packaged here under distinct names, so they don't collide with OpenWrt's:
rtl433-soapy (rtl_433 for ISM), readsb-soapy (readsb for ADS-B) and ais-catcher
(AIS).

## Licence

The scripts in `feed/utils/pirate-radio/files/` and `tests/`, and the build
scripts, are MIT. The OpenWrt package Makefiles follow OpenWrt's
GPL-2.0. Each packaged program keeps its own licence (in its Makefile's
`PKG_LICENSE`). In `feed/net/dreampi/`, `src/dreampi.c`, `src/dcnow-config.c`
and the scripts are MIT (ports of DreamPi's modem code and Dreamcast Now
config server, MIT, © Luke Benstead); `src/dcnet.c` is Flycast's DCNet
client, GPL-2.0-or-later. `feed/utils/pirate-meshcore/src/mco_emoji.h` is
meshcore-open's table of reaction emoji, MIT, © 2025 zjs81.
`feed/utils/pirate-radio-ui/files/mcoimg/` is MCO Advanced's MCOimg decoder
(from HDDen/meshcore-open, its README there says from where exactly), MIT,
© 2025 zjs81. `feed/utils/pirate-portapack/` is Pirate Radio's own, GPL-2.0-or-later
(it follows Mayhem's and MayhemHub's serial command shell, both GPL-2.0).
