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
PortaPack on Mayhem firmware is only a USB serial console until you switch it
to HackRF mode; the status page and the Pirate Radio UI say so, and gpsd doesn't
take that console for a GPS.

**Status page:** `http://192.168.1.1/cgi-bin/pirate-radio` shows the radios,
card and jobs, with links to the aircraft map, the ISM live view and the
recorded files (`http://192.168.1.1:8081/pirate-radio/`).

**In the Pirate Radio UI** (`http://192.168.1.1/`): its pages are grouped down
the left (on a phone, the menu button at the top opens them):

| Group | Pages |
|---|---|
| Overview | Dashboard, Messenger (a MeshCore radio's messages, below) |
| Radio | Receivers (the SDR jobs and their addresses), Sensors (what rtl_433 has decoded) |
| Wi-Fi | Survey, Threats, Handshakes |
| Network | Uplink (the network it joins), Clients (its own network's, and ad blocking), Hosts, Capture |
| USB devices | Drives, Phone, Flipper, DreamPi |
| System | Status (its system, jacks, radios and slots), Access, Terminal, Firmware |

*Receivers* has the same status as the status page, with every address the
receivers serve, the aircraft map and the recorded files; using a radio hands
the RTL-SDR to that job. *Sensors* has one row per device rtl_433 has decoded,
with its latest readings. Ports and radios go by what they are on the
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
  theirs at that time. `@[Name]` answering nothing here is a mention.
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
  pasted once and kept in that browser — and drops the pick in as
  meshcore-open's compact `g:ID`, which both apps show.
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
  GPS needed for wardriving. The radio's adverts carry its position only if
  it is set to share its location (off by default; the page warns if it is
  on).

`pirate-meshcore` (its own package) speaks MeshCore's companion protocol over
USB, after MeshCore's documentation and firmware (both MIT; the code here is
Pirate Radio's own). Its reactions follow MeshCore One's documented format
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
  against a mock sysupgrade, so no real flash is ever attempted), the router's
  jacks, radios and slots on a faked GL-AR750S, the password change and its
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
  against mock radios and tools on that same userland, and the rename from
  slate-sdr (settings, card mount, card folder) and pirateradio.local: 700
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
| `feed/` | OpenWrt package feed: `fftw3f`, `hackrf`, `soapysdr`, `soapy-hackrf`, `soapy-rtlsdr`, `soapy-remote`, `pirate-radio`, `pirate-radio-ui`, `dreampi`, `pirate-flipper`, `pirate-meshcore` |
| `feed/utils/pirate-radio/files/` | the service: job runner, init script, CLI, status page, default config |
| `feed/net/dreampi/` | DreamPi: the modem daemon and DCNet client (`src/`), the call script, NAT rules, Dreamcast Now, init script and hotplug hook (`files/`) |
| `feed/utils/pirate-flipper/` | the Flipper tab's daemon (`src/pirate-flipper.c`: a Flipper Zero's RPC session, on ubus as `pirate.flipper`) and its init script |
| `feed/utils/pirate-meshcore/` | the Messenger tab's daemon (`src/pirate-meshcore.c`: a MeshCore radio's companion protocol, on ubus as `pirate.meshcore`) and its init script |
| `feed/utils/pirate-radio-ui/files/` | the web UI (`index.html`, `app.js`, `style.css`) and the firmware-upload CGI, served at `/` |
| `feed/utils/pirate-radio-ui/root/` | the UI's rpcd/ubus backends: router basics and its ports (`pirate-router`), access (`pirate-access`: SSH, sign-ins, the terminal), firmware, capture, handshake, DreamPi, USB drives (`pirate-usb`, with its init script and block hotplug hook), and the SDR (`pirate.sdr`) and recon (`pirate-recon` / `pirate-survey` / `pirate-threats` / `pirate-dashboard`) tools |
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
client, GPL-2.0-or-later. `feed/utils/pirate-meshcore/src/mco_emoji.h` is
meshcore-open's table of reaction emoji, MIT, © 2025 zjs81.
`feed/utils/pirate-radio-ui/files/mcoimg/` is MCO Advanced's MCOimg decoder
(from HDDen/meshcore-open, its README there says from where exactly), MIT,
© 2025 zjs81.
