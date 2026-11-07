#!/bin/sh
# shellcheck disable=SC2034,SC2009  # STORE_* are read by the sourced lib.sh
# Runs inside openwrt/rootfs:mips_24kc (under QEMU user mode) with the built
# packages unpacked over it: checks that the binaries run on the router's
# userland, and drives pirate-radio's scripts against mock radios.

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $*"; }
nok() { FAIL=$((FAIL + 1)); echo "FAIL - $*"; }
near() { [ $(($1 - $2)) -ge -1 ] && [ $(($1 - $2)) -le 1 ]; }
check() {
	local desc="$1"
	shift
	if "$@"; then ok "$desc"; else nok "$desc"; fi
}
has() { grep -q -- "$2" "$1" 2>/dev/null; }

T=/tmp/pirate-test
rm -rf "$T"
mkdir -p "$T"

echo "# binaries on the target userland"
# No USB bus in the container: hackrf_info gets as far as libusb's init.
check "hackrf_info runs" sh -c 'hackrf_info 2>&1 | grep -q -e "hackrf_info version" -e "hackrf_init()"'
check "hackrf_sweep runs" sh -c 'hackrf_sweep -h 2>&1 | grep -q "Usage"'
check "hackrf_sweep takes -P estimate (the survey job uses it)" sh -c 'hackrf_sweep -h 2>&1 | grep -q -- "-P estimate"'
check "hackrf_transfer runs" sh -c 'hackrf_transfer -h 2>&1 | grep -q "Usage"'
check "SoapySDR loads the HackRF module" sh -c 'SoapySDRUtil --info 2>&1 | grep -q "Available factories.*hackrf"'
check "SoapySDR loads the RTL-SDR module" sh -c 'SoapySDRUtil --info 2>&1 | grep -q "Available factories.*rtlsdr"'
check "SoapySDRServer runs" sh -c 'SoapySDRServer --help 2>&1 | grep -q "Soapy Server"'
check "rtl_433 runs" sh -c 'rtl_433 -V 2>&1 | grep -q "rtl_433 version"'
check "rtl_power runs" sh -c 'rtl_power 2>&1 | grep -q "No frequency range provided"'
check "rtl_ais runs" sh -c 'rtl_ais -x 2>&1 | grep -q "rtl_ais"'
check "shell has 64-bit arithmetic" [ $((20000000 * 3600)) = 72000000000 ]

echo "# lib.sh"
. /lib/functions.sh
. /usr/share/pirate-radio/lib.sh
check "to_hz 433.92M" [ "$(pirate_to_hz 433.92M)" = 433920000 ]
check "to_hz 2.4G" [ "$(pirate_to_hz 2.4G)" = 2400000000 ]
check "to_hz 100k" [ "$(pirate_to_hz 100k)" = 100000 ]
check "to_hz 1090000000" [ "$(pirate_to_hz 1090000000)" = 1090000000 ]
check "to_hz rejects 12abc" sh -c '. /usr/share/pirate-radio/lib.sh; ! pirate_to_hz 12abc'
b=$(pirate_secs_to_boundary hour)
e=$((3600 - $(date +%s) % 3600))
check "seconds to the next hour ($b)" near "$b" "$e"
b=$(pirate_secs_to_boundary day)
e=$((86400 - $(date +%s) % 86400))
check "seconds to midnight ($b, UTC)" near "$b" "$e"

# Two radios on a fake USB bus, plus a root hub that must be ignored.
mkusb() {
	mkdir -p "$T/sys/bus/usb/devices/$1"
	echo "$2" > "$T/sys/bus/usb/devices/$1/idVendor"
	echo "$3" > "$T/sys/bus/usb/devices/$1/idProduct"
	[ -n "$4" ] && echo "$4" > "$T/sys/bus/usb/devices/$1/serial"
	[ -n "$5" ] && echo "$5" > "$T/sys/bus/usb/devices/$1/product"
}
mkusb usb1 1d6b 0002
mkusb 1-1 0bda 2838 00000001 RTL2838UHIDIR
mkusb 1-2 1d50 6089 0000000000000000a06063c8234e925f "HackRF One"
export PIRATE_SYSFS="$T/sys"
check "finds both radios" [ "$(pirate_usb_radios | wc -l)" = 2 ]
check "rtlsdr present" pirate_radio_present rtlsdr
check "hackrf present" pirate_radio_present hackrf
check "HackRF product name" sh -c '. /usr/share/pirate-radio/lib.sh; pirate_usb_radios | grep -q "^hackrf 1d50:6089 0000000000000000a06063c8234e925f HackRF One$"'

# A fake /proc/mounts: card in or out.
export PIRATE_PROC="$T/proc"
mkdir -p "$PIRATE_PROC" /mnt/sdcard
card_out() { echo "rootfs / rootfs rw 0 0" > "$PIRATE_PROC/mounts"; }
card_in() { card_out; echo "/dev/sda1 /mnt/sdcard exfat rw,noatime 0 0" >> "$PIRATE_PROC/mounts"; }

cp /etc/config/pirate-radio "$T/pirate-radio.default"
card_out
config_load pirate-radio
pirate_storage_load
check "no card -> nocard" [ "$(pirate_storage_state)" = nocard ]
card_in
check "card in -> ok" [ "$(pirate_storage_state)" = ok ]
STORE_MIN_FREE_MB=999999999
check "card full -> full" [ "$(pirate_storage_state)" = full ]

echo "# mock radios"
M="$T/mock"
mkdir -p "$M"
mock() {
	{
		echo '#!/bin/sh'
		echo "echo \"\$(basename \"\$0\") \$*\" >> $T/calls.log"
		echo 'trap "exit 0" TERM INT'
		cat
	} > "$M/$1"
	chmod +x "$M/$1"
}
# Its messages on stderr as the real one's; MOCK_SWEEP_FAIL (a file) makes it fail.
mock hackrf_sweep <<-'EOF'
	[ -e "${MOCK_SWEEP_FAIL:-/nonexistent}" ] && { echo "hackrf_open() failed: Resource busy (-1000)" >&2; exit 1; }
	echo "call hackrf_sample_rate_set(20.000 MHz)" >&2
	case " $* " in *" -1 "*) echo "2026-10-24, 12:00:00, 1000000, 6000000, 1000000.00, 20, -60.1, -61.2"; echo "Total sweeps: 1 in 0.80275 seconds (1.25 sweeps/second)" >&2; exit 0 ;; esac
	while :; do echo "2026-10-24, 12:00:00, 1000000, 6000000, 1000000.00, 20, -60.1"; echo "1 total sweeps completed, 1.00 sweeps/second" >&2; sleep 1; done
EOF
mock rtl_power <<-'EOF'
	case " $* " in *" -1 "*) echo "2026-10-24, 12:00:00, 24000000, 26000000, 250000, 4, -30.1"; exit 0 ;; esac
	while :; do echo "2026-10-24, 12:00:00, 24000000, 26000000, 250000, 4, -30.1"; sleep 1; done
EOF
mock hackrf_transfer <<-'EOF'
	f=; n=
	while [ $# -gt 0 ]; do case "$1" in -r) f=$2; shift ;; -n) n=$2; shift ;; esac; shift; done
	if [ -n "$n" ]; then head -c 4096 /dev/zero > "$f"; exit 0; fi
	while :; do head -c 4096 /dev/zero >> "$f"; sleep 1; done
EOF
mock rtl_sdr <<-'EOF'
	for f; do :; done
	while :; do head -c 4096 /dev/zero >> "$f"; sleep 1; done
EOF
mock rtl_433 <<-'EOF'
	f=
	for a; do case "$a" in json:*) f=${a#json:} ;; esac; done
	while :; do echo '{"time":"2026-10-24T12:00:00Z","model":"Mock-Sensor","id":1}' >> "$f"; sleep 1; done
EOF
mock rtl_ais <<-'EOF'
	while :; do echo '!AIVDM,1,1,,A,13u?etPv2;0n:dDPwUM1U1Cb069D,0*23' >&2; sleep 1; done
EOF
mock dump1090 <<-'EOF'
	while :; do echo '{ "now" : 1, "aircraft" : [ { "hex" : "abc123" } ] }' > /var/run/dump1090/aircraft.json; sleep 1; done
EOF
mock uhttpd <<-'EOF'
	while :; do sleep 1; done
EOF
mock SoapySDRServer <<-'EOF'
	while :; do sleep 1; done
EOF
export PATH="$M:$PATH"

# set_job <section> <option=value>...
set_job() {
	local s="$1"
	shift
	for kv; do uci set "pirate-radio.$s.$kv"; done
	uci commit pirate-radio
}
# run_job <section> <seconds>: run the runner, stop it, return its output.
# SIGPIPE is ignored, as procd leaves it for the jobs it starts.
run_job() {
	sh -c 'trap "" PIPE; exec /usr/libexec/pirate-radio-job "$1"' _ "$1" > "$T/$1.out" 2>&1 &
	local pid=$!
	sleep "$2"
	kill -TERM "$pid"
	local i=0
	while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done
	if kill -0 "$pid" 2>/dev/null; then
		nok "$1: runner did not stop within 20 s of TERM"
		kill -KILL "$pid"
	else
		ok "$1: runner stops on TERM"
	fi
}
no_strays() {
	sleep 2
	! ps w | grep -v grep | grep -q "$M/"
}
DATA=/mnt/sdcard/pirate-radio
TODAY=$(date +%Y-%m-%d)
# Runtime state (/var/run/pirate-radio on the device).
export PIRATE_STATE="$T/state"
card_in

echo "# job: iq (hackrf, 12 s segments)"
set_job iq segment=12
run_job iq 30
check "iq: hackrf_transfer arguments" has "$T/calls.log" "hackrf_transfer -r $DATA/iq/$TODAY/iq-hackrf-433920000Hz-2000000sps-.*.sigmf-data -f 433920000 -s 2000000 -l 16 -g 20 -a 0"
n=$(ls "$DATA/iq/$TODAY/"*.sigmf-data 2>/dev/null | wc -l)
check "iq: at least 2 segments ($n)" [ "$n" -ge 2 ]
meta=$(ls "$DATA/iq/$TODAY/"*.sigmf-meta | head -n 1)
check "iq: SigMF datatype ci8" [ "$(jsonfilter -i "$meta" -e '@.global["core:datatype"]')" = ci8 ]
check "iq: SigMF frequency" [ "$(jsonfilter -i "$meta" -e '@.captures[0]["core:frequency"]')" = 433920000 ]
check "iq: SigMF sample rate" [ "$(jsonfilter -i "$meta" -e '@.global["core:sample_rate"]')" = 2000000 ]
check "iq: every recording has metadata" [ "$(ls "$DATA/iq/$TODAY/"*.sigmf-meta | wc -l)" = "$n" ]
check "iq: no stray receivers" no_strays

echo "# job: iq (rtlsdr)"
: > "$T/calls.log"
set_job iq radio=rtlsdr rate=2.4M gain=30
run_job iq 5
check "iq: rtl_sdr arguments" has "$T/calls.log" "rtl_sdr -d 0 -f 433920000 -s 2400000 -g 30 $DATA/iq/$TODAY/iq-rtlsdr-"
meta=$(ls -t "$DATA/iq/$TODAY/"iq-rtlsdr-*.sigmf-meta | head -n 1)
check "iq: SigMF datatype cu8 for RTL-SDR" [ "$(jsonfilter -i "$meta" -e '@.global["core:datatype"]')" = cu8 ]

echo "# job: survey (hackrf, one sweep every 5 s)"
: > "$T/calls.log"
set_job survey interval=5
run_job survey 17
check "survey: hackrf_sweep arguments" has "$T/calls.log" "hackrf_sweep -f 1:6000 -w 1000000 -l 16 -g 20 -a 0 -P estimate -1"
n=$(grep -c hackrf_sweep "$T/calls.log")
check "survey: 3 or 4 sweeps in 17 s ($n)" sh -c "[ $n -ge 3 ] && [ $n -le 4 ]"
csv=$DATA/survey/$TODAY/sweep-hackrf-$(date +%Y%m%d-%H)00.csv
check "survey: sweeps appended to the hour's CSV" [ "$(grep -c '^2026' "$csv")" -ge 3 ]
check "survey: a working sweep's messages stay out of the log" sh -c "! grep -q -e 'call hackrf' -e 'Total sweeps' '$T/survey.out'"
export MOCK_SWEEP_FAIL="$T/sweep-fail"
: > "$MOCK_SWEEP_FAIL"
run_job survey 13
rm -f "$MOCK_SWEEP_FAIL"
check "survey: a failed sweep is logged" has "$T/survey.out" "survey: sweep failed (exit 1):"
check "survey: with its messages" has "$T/survey.out" "hackrf_open() failed: Resource busy"
check "survey: its message file is cleaned up" [ ! -e "$PIRATE_STATE/survey.sweep-err" ]
check "survey: no write errors from the watchdog it cut short" sh -c "! grep -q 'Broken pipe' '$T/survey.out'"
set_job survey interval=0
run_job survey 4
check "survey without pause: start-up messages logged" has "$T/survey.out" "call hackrf_sample_rate_set"
check "survey without pause: progress lines are not" sh -c "! grep -q 'total sweeps completed' '$T/survey.out'"
check "survey without pause: no stray receivers" no_strays
set_job survey interval=60

echo "# job: rtlsurvey (continuous, files rotated every 12 s and compressed)"
: > "$T/calls.log"
set_job rtlsurvey interval=0 rotate=12
run_job rtlsurvey 32
check "rtlsurvey: rtl_power arguments" has "$T/calls.log" "rtl_power -d 0 -f 24M:1766M:250k -i 10 -"
check "rtlsurvey: a closed segment was compressed" sh -c "ls $DATA/rtlsurvey/$TODAY/*.csv.gz >/dev/null 2>&1"
gz=$(ls "$DATA/rtlsurvey/$TODAY/"*.csv.gz 2>/dev/null | head -n 1)
check "rtlsurvey: compressed CSV is intact" sh -c "gzip -dc '$gz' | grep -q '^2026'"
check "rtlsurvey: no stray receivers" no_strays

echo "# job: ism (two frequencies)"
: > "$T/calls.log"
uci add_list pirate-radio.ism.frequency=868M
uci commit pirate-radio
run_job ism 6
check "ism: rtl_433 arguments" has "$T/calls.log" "rtl_433 -d 0 -M time:iso:utc -M level -M protocol -F json:$DATA/ism/$TODAY/ism-$(date +%Y%m%d).json -F http:0.0.0.0:8433 -f 433.92M -f 868M -H 600"
check "ism: events logged" [ "$(grep -c Mock-Sensor "$DATA/ism/$TODAY/ism-$(date +%Y%m%d).json")" -ge 3 ]

echo "# job: ism without a card, then the card goes in"
: > "$T/calls.log"
card_out
/usr/libexec/pirate-radio-job ism > "$T/ism2.out" 2>&1 &
pid=$!
sleep 5
check "ism: runs without a card (to /dev/null)" has "$T/calls.log" "json:/dev/null"
before=$(grep -c Mock-Sensor "$DATA/ism/$TODAY/ism-$(date +%Y%m%d).json")
card_in
sleep 38
after=$(grep -c Mock-Sensor "$DATA/ism/$TODAY/ism-$(date +%Y%m%d).json")
check "ism: logs to the card once it is in ($before -> $after)" [ "$after" -gt "$before" ]
check "ism: says so" has "$T/ism2.out" "microSD card ready"
kill -TERM "$pid"
wait "$pid" 2>/dev/null

echo "# job: ais"
: > "$T/calls.log"
run_job ais 5
check "ais: rtl_ais arguments" has "$T/calls.log" "rtl_ais -d 0 -T -P 10110 -n"
check "ais: NMEA logged" has "$DATA/ais/$TODAY/ais-$(date +%Y%m%d).nmea" "^!AIVDM"

echo "# job: adsb (snapshot every 3 s)"
: > "$T/calls.log"
set_job adsb log_every=3 lat=51.5 lon=-0.1
run_job adsb 11
check "adsb: dump1090 arguments" has "$T/calls.log" "dump1090 --quiet --net --device-index 0 --write-json /var/run/dump1090 --lat 51.5 --lon -0.1"
n=$(grep -c abc123 "$DATA/adsb/$TODAY/aircraft-$(date +%Y%m%d).json" 2>/dev/null)
check "adsb: aircraft snapshots on the card ($n)" [ "${n:-0}" -ge 2 ]
check "adsb: map server runs with the job" has "$T/calls.log" "uhttpd -f -h /usr/share/dump1090 .*-p 0.0.0.0:8080"
check "adsb: no stray receivers (map server stopped too)" no_strays

echo "# job: soapy server"
: > "$T/calls.log"
run_job soapy 3
check "soapy: SoapySDRServer --bind" has "$T/calls.log" "SoapySDRServer --bind$"

echo "# configuration errors"
uci set pirate-radio.bogus=job
uci set pirate-radio.bogus.type=nonsense
uci commit pirate-radio
run_job bogus 3
check "unknown type is reported" has "$T/bogus.out" "unknown type 'nonsense'"
set_job iq frequency=abc
run_job iq 3
check "bad frequency is reported" has "$T/iq.out" "set a frequency"

echo "# Wi-Fi spectral sweep (fake debugfs)"
export PIRATE_DEBUGFS="$T/dbg"
mkdir -p "$T/dbg/ieee80211/phy0/ath9k" "$T/dbg/ieee80211/phy1/ath10k" "$T/spec"
for d in phy0/ath9k phy1/ath10k; do
	: > "$T/dbg/ieee80211/$d/spectral_scan_ctl"
	printf 'FFTDATA' > "$T/dbg/ieee80211/$d/spectral_scan0"
done
mock iw <<-'EOF'
	exit 0
EOF
mock ip <<-'EOF'
	exit 0
EOF
: > "$T/calls.log"
pirate_spectral_sweep "$T/spec" "2g 5g" 2> "$T/spec.err"
check "spectral: finds both radios" [ "$(pirate_spectral_dirs | wc -l)" = 2 ]
check "spectral: 2.4 GHz samples saved" sh -c "cat $T/spec/2g-*.bin | grep -q FFTDATA"
check "spectral: 5 GHz samples saved" sh -c "cat $T/spec/5g-*.bin | grep -q FFTDATA"
check "spectral: scan disabled afterwards" [ "$(cat "$T/dbg/ieee80211/phy0/ath9k/spectral_scan_ctl")" = disable ]
check "spectral: temporary interface added and removed" sh -c "grep -q 'iw phy phy0 interface add sdrphy0 type managed' $T/calls.log && grep -q 'iw dev sdrphy0 del' $T/calls.log"
rm -f "$T/spec/"*
pirate_spectral_sweep "$T/spec" "5g" 2>/dev/null
check "spectral: band filter" sh -c "! ls $T/spec/2g-* >/dev/null 2>&1 && ls $T/spec/5g-* >/dev/null 2>&1"

echo "# init script (procd calls stubbed)"
cp "$T/pirate-radio.default" /etc/config/pirate-radio
cat > "$T/init-harness.sh" <<-'EOF'
	. /lib/functions.sh
	procd_open_instance() { printf 'instance %s:' "$1"; }
	procd_set_param() { [ "$1" = command ] && shift && printf ' %s' "$*"; }
	procd_close_instance() { echo; }
	logger() { shift 2; echo "log: $*"; }
	. /etc/init.d/pirate-radio
	start_service
EOF
PIRATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "init: default jobs soapy, adsb, survey" sh -c "grep -c '^instance' $T/init.out | grep -qx 3 && grep -q 'instance soapy: /usr/libexec/pirate-radio-job soapy' $T/init.out && grep -q 'instance adsb:' $T/init.out && grep -q 'instance survey:' $T/init.out"
uci set pirate-radio.ism.enabled=1
uci set pirate-radio.wifi.enabled=1
uci commit pirate-radio
PIRATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "init: second job on the RTL-SDR is refused" sh -c "grep -q \"job 'ism' not started: its rtlsdr is taken\" $T/init.out && ! grep -q 'instance ism' $T/init.out"
check "init: wifi job skipped without spectral scan" grep -q "job 'wifi' not started: this firmware has no Wi-Fi spectral scan" "$T/init.out"
sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "init: wifi job starts with spectral scan" grep -q "instance wifi:" "$T/init.out"

echo "# plug and play: jobs run only while their radio is on USB"
cp "$T/pirate-radio.default" /etc/config/pirate-radio
check "pnp: supported radio kinds, others ignored" sh -c '. /usr/share/pirate-radio/lib.sh; [ "$(pirate_radio_kind 0bda 2838) $(pirate_radio_kind 1d50 6089) x$(pirate_radio_kind 148f 5370)" = "rtlsdr hackrf x" ]'
rm -f "$T/state/active"
PIRATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "pnp: start marks the service active (for the hotplug hook)" [ -e "$T/state/active" ]
mv "$T/sys/bus/usb/devices/1-2" "$T/hackrf-unplugged"
PIRATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "pnp: HackRF job waits while the HackRF is unplugged" sh -c "grep -q \"job 'survey' waits: no hackrf on USB\" $T/init.out && ! grep -q 'instance survey' $T/init.out"
check "pnp: RTL-SDR and SoapySDR jobs still start" sh -c "grep -q 'instance adsb:' $T/init.out && grep -q 'instance soapy:' $T/init.out"
mv "$T/sys/bus/usb/devices/1-1" "$T/rtlsdr-unplugged"
PIRATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "pnp: no radios, no jobs (SoapySDR server included)" sh -c "! grep -q '^instance' $T/init.out && grep -q \"job 'soapy' waits: no SDR on USB\" $T/init.out"
mock ubus <<-'EOF'
	echo '{"pirate-radio":{"instances":{}}}'
EOF
pirate-radio status > "$T/status-pnp.out" 2>&1
check "pnp: status shows enabled jobs without their radio as waiting" sh -c "grep -q 'adsb .*adsb .*rtlsdr .*waiting' $T/status-pnp.out && grep -q 'soapy .*soapy_server .*- .*waiting' $T/status-pnp.out && grep -q 'ism .*ism .*rtlsdr .*off' $T/status-pnp.out"

# The USB hotplug hook (hotplug-call sources it; here it runs under sh).
HP=/etc/hotplug.d/usb/20-pirate-radio
cat > "$T/fake-init" <<-'EOF'
	#!/bin/sh
	echo "$*" >> "$PIRATE_TEST_CALLS"
EOF
chmod +x "$T/fake-init"
hp() { : > "$T/hp.log"; env PIRATE_INIT="$T/fake-init" PIRATE_TEST_CALLS="$T/hp.log" "$@" sh "$HP" > /dev/null 2>&1; cat "$T/hp.log"; }
: > "$T/state/active"
check "pnp hotplug: RTL-SDR plugged in reloads pirate-radio" [ "$(hp ACTION=add DEVTYPE=usb_device PRODUCT=bda/2838/100)" = reload ]
check "pnp hotplug: HackRF removed reloads pirate-radio" [ "$(hp ACTION=remove DEVTYPE=usb_device PRODUCT=1d50/6089/101 DEVPATH=/devices/gone/1-2)" = reload ]
check "pnp hotplug: other USB devices are ignored" [ -z "$(hp ACTION=add DEVTYPE=usb_device PRODUCT=148f/5370/101)" ]
check "pnp hotplug: interface events are ignored" [ -z "$(hp ACTION=add DEVTYPE=usb_interface PRODUCT=bda/2838/100)" ]
rm -f "$T/state/active"
check "pnp hotplug: nothing until the service has started" [ -z "$(hp ACTION=add DEVTYPE=usb_device PRODUCT=bda/2838/100)" ]
mv "$T/hackrf-unplugged" "$T/sys/bus/usb/devices/1-2"
mv "$T/rtlsdr-unplugged" "$T/sys/bus/usb/devices/1-1"

echo "# command line and status page"
cp "$T/pirate-radio.default" /etc/config/pirate-radio
mock ubus <<-'EOF'
	echo '{"pirate-radio":{"instances":{"soapy":{"running":true},"adsb":{"running":true}}}}'
EOF
pirate-radio status > "$T/status.out" 2>&1
check "status: radios" sh -c "grep -q 'rtlsdr  0bda:2838' $T/status.out && grep -q 'hackrf  1d50:6089' $T/status.out"
check "status: card" grep -q "mounted, .* MiB free, data in /mnt/sdcard/pirate-radio" "$T/status.out"
check "status: running job" grep -q "adsb .*adsb .*rtlsdr .*running" "$T/status.out"
check "status: stopped job" grep -q "survey .*sweep .*hackrf .*stopped" "$T/status.out"
check "status: disabled job" grep -q "ism .*ism .*rtlsdr .*off" "$T/status.out"
pirate-radio record hackrf 433.92M 2M 1 > "$T/record.out" 2>&1
check "record: writes a SigMF pair" sh -c "ls $DATA/recordings/$TODAY/iq-hackrf-433920000Hz-2000000sps-*.sigmf-data >/dev/null 2>&1 && ls $DATA/recordings/$TODAY/iq-hackrf-433920000Hz-2000000sps-*.sigmf-meta >/dev/null 2>&1"
check "record: hackrf_transfer sample count" grep -q -- "-n 2000000" "$T/calls.log"
check "record: rejects a bad radio" sh -c "! pirate-radio record airspy 100M 2M 1 2>/dev/null"
card_out
check "record: refuses without a card" sh -c "pirate-radio record hackrf 100M 2M 1 2>&1 | grep -q 'missing or full'"
card_in
HTTP_HOST='x"><script>alert(1)</script>' /www/cgi-bin/pirate-radio > "$T/cgi.out" 2>&1
check "cgi: hostile Host header is not echoed" sh -c "! grep -q '<script>' $T/cgi.out && grep -q 'http://192.168.1.1:8080/' $T/cgi.out"
HTTP_HOST="$(printf 'evil<b>\n10.0.0.5')" /www/cgi-bin/pirate-radio > "$T/cgi.out" 2>&1
check "cgi: multi-line Host header is not echoed" sh -c "! grep -q 'evil' $T/cgi.out"
HTTP_HOST='[fd00::1]:80' /www/cgi-bin/pirate-radio > "$T/cgi.out" 2>&1
check "cgi: IPv6 host" grep -q 'http://\[fd00::1\]:8080/' "$T/cgi.out"
HTTP_HOST='10.0.0.5:80' /www/cgi-bin/pirate-radio > "$T/cgi.out" 2>&1
check "cgi: links use the browser's host" grep -q 'remote=tcp://10.0.0.5:55132' "$T/cgi.out"
check "cgi: status is HTML-escaped" grep -q 'Jobs:' "$T/cgi.out"

echo "# SDR backend (pirate-radio-ui, was pirate-sdr)"
cp "$T/pirate-radio.default" /etc/config/pirate-radio
P=/usr/libexec/rpcd/pirate.sdr
check "sdr: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/pirate-sdr.json -e '@' -q
check "luci: plugin offers use and devices" [ "$("$P" list | jsonfilter -e '@.use.job') $("$P" list | jsonfilter -t '@.devices')" = "str object" ]

# use_job <name>: the rpcd call, with the init script's reload stubbed
use_job() { echo "{\"job\":\"$1\"}" | PIRATE_INIT=true "$P" call use > "$T/use.out"; }
use_field() { jsonfilter -i "$T/use.out" -e "@.$1"; }
use_job ism
check "luci use: hands the RTL-SDR to ism, stopping adsb" [ "$(use_field switched) $(use_field 'stopped[0]')" = "true adsb" ]
check "luci use: config switched, HackRF job untouched" [ "$(uci get pirate-radio.ism.enabled)$(uci get pirate-radio.adsb.enabled)$(uci get pirate-radio.survey.enabled)" = 101 ]
use_job ism
check "luci use: nothing changes when the job holds the radio" [ "$(use_field switched)" = false ]
use_job 'x; reboot'
check "luci use: rejects a bad job name" [ "$(use_field error)" = "invalid job name" ]
use_job nosuch
check "luci use: rejects an unknown job" [ "$(use_field error)" = "no job 'nosuch' in /etc/config/pirate-radio" ]
cp "$T/pirate-radio.default" /etc/config/pirate-radio

# Two days of rtl_433 JSON lines, with a broken line and a cut-off one.
I="$T/ism"
mkdir -p "$I/2026-10-23" "$I/2026-10-24"
cat > "$I/2026-10-23/ism-20261023.json" <<-'EOF'
	{"time":"2026-10-23T22:00:00Z","model":"Acurite-Tower","id":1234,"channel":"A","battery_ok":1,"humidity":50,"freq":433.92}
EOF
cat > "$I/2026-10-24/ism-20261024.json" <<-'EOF'
	{"time":"2026-10-24T12:00:00Z","model":"Acurite-Tower","id":1234,"channel":"A","battery_ok":1,"humidity":47,"freq":433.91}
	not json
	{"time":"2026-10-24T12:01:00Z","model":"Schrader","type":"TPMS","id":"1A2B3C4D","pressure_kPa":227,"freq":315.02}
	{"time":"2026-10-24T12:02:00Z","model":"Acurite-Tower","id":1234,"cha
EOF
PIRATE_ISM_DIR="$I" /usr/libexec/pirate-radio-devices > "$T/devices.out" 2>&1
dev() { jsonfilter -i "$T/devices.out" -e "@.$1"; }
check "luci devices: one row per device, broken lines skipped" [ "$(dev decoded) $(dev 'devices[*].model' | xargs)" = "3 Acurite-Tower Schrader" ]
check "luci devices: merged across days, latest readings" [ "$(dev 'devices[0].count') $(dev 'devices[0].readings.humidity') $(dev 'devices[0].first')" = "2 47 2026-10-23T22:00:00Z" ]
check "luci devices: the ISM job's bands" [ "$(dev 'frequencies[0]') $(dev hop_interval)" = "433.92M 600" ]

echo "# network recon (pirate-radio-ui, was pirate-recon)"
RP=/usr/libexec/rpcd/pirate.recon
check "recon: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/pirate-recon.json -e '@' -q
check "recon: plugin offers uplink, discover, hosts, ports" sh -c '"'"$RP"'" list | jsonfilter -e "@.ports.target" | grep -qx str && "'"$RP"'" list | jsonfilter -e "@.uplink" >/dev/null'
# A valid target with no nmap present still yields valid JSON and no ports.
pirate-recon ports 203.0.113.1 > "$T/ports.out" 2>&1
check "recon: port scan output is valid JSON" jsonfilter -i "$T/ports.out" -e '@.target' -q
check "recon: port scan target echoed" [ "$(jsonfilter -i "$T/ports.out" -e '@.target')" = 203.0.113.1 ]
check "recon: rejects a shell-injection target" sh -c 'pirate-recon ports "x; reboot" | jsonfilter -e "@.error" | grep -q "give one host"'
check "recon: rejects an empty target" sh -c 'pirate-recon ports "" | jsonfilter -e "@.error" >/dev/null'
check "recon: hosts with no scan is valid JSON" sh -c 'PIRATE_RECON_STORE=/nonexistent pirate-recon hosts | jsonfilter -e "@.hosts" >/dev/null'
check "recon: unknown command fails" sh -c '! pirate-recon wat 2>/dev/null'

echo "# Wi-Fi survey (pirate-survey-merge database)"
M=/usr/libexec/pirate-survey-merge
SV="$T/survey"
rm -rf "$SV"
check "recon: plugin offers the survey methods" sh -c '"'"$RP"'" list | jsonfilter -e "@.survey_scan" >/dev/null && "'"$RP"'" list | jsonfilter -e "@.survey_clear" >/dev/null'
# First scan: two access points, one hidden.
printf '%s\n%s\n' \
	'{"bssid":"aa:bb:cc:dd:ee:ff","ssid":"Home","freq":2412,"channel":1,"signal":-60,"security":"WPA2"}' \
	'{"bssid":"11:22:33:44:55:66","ssid":"","freq":5180,"channel":36,"signal":-70,"security":"WPA3"}' |
	PIRATE_SURVEY_STORE="$SV" PIRATE_SURVEY_TIME=2026-10-24T12:00:00Z PIRATE_SURVEY_PHY=phy1 "$M" scan > "$T/sv1.out"
check "survey: first scan saved both" sh -c '[ "$(jsonfilter -i '"$T"'/sv1.out -e "@.found") $(jsonfilter -i '"$T"'/sv1.out -e "@.total") $(jsonfilter -i '"$T"'/sv1.out -e "@.saved")" = "2 2 true" ]'
check "survey: no GPS -> null position" sh -c '[ "$(jsonfilter -i '"$T"'/sv1.out -e "@.gps")" = "" ]'
# Second scan: Home again, stronger, plus a broken line that must be skipped.
printf '%s\n%s\n%s\n' \
	'{"bssid":"aa:bb:cc:dd:ee:ff","ssid":"Home","freq":2412,"channel":1,"signal":-45,"security":"WPA2"}' \
	'not json' \
	'{"bssid":"99:99:99:99:99:99","ssid":"Cafe","freq":2437,"channel":6,"signal":-80,"security":"Open"}' |
	PIRATE_SURVEY_STORE="$SV" PIRATE_SURVEY_TIME=2026-10-24T12:05:00Z PIRATE_SURVEY_PHY=phy1 "$M" scan > "$T/sv2.out"
check "survey: broken line skipped, new AP added" sh -c '[ "$(jsonfilter -i '"$T"'/sv2.out -e "@.found") $(jsonfilter -i '"$T"'/sv2.out -e "@.total")" = "2 3" ]'
PIRATE_SURVEY_STORE="$SV" "$M" networks > "$T/svn.out"
check "survey: three networks logged, newest first" sh -c '[ "$(jsonfilter -i '"$T"'/svn.out -e "@.total") $(jsonfilter -i '"$T"'/svn.out -e "@.networks[0].bssid")" = "3 aa:bb:cc:dd:ee:ff" ]'
check "survey: Home merged (count 2, strongest -45, first kept)" sh -c '[ "$(jsonfilter -i '"$T"'/svn.out -e "@.networks[0].count") $(jsonfilter -i '"$T"'/svn.out -e "@.networks[0].best_signal") $(jsonfilter -i '"$T"'/svn.out -e "@.networks[0].first")" = "2 -45 2026-10-24T12:00:00Z" ]'
check "survey: wardrive log has a line per sighting" sh -c '[ "$(wc -l < "$(ls '"$SV"'/survey-*.ndjson)")" = 4 ]'
check "survey: clear empties the database" sh -c 'PIRATE_SURVEY_STORE="'"$SV"'" "'"$M"'" clear >/dev/null; [ "$(PIRATE_SURVEY_STORE="'"$SV"'" "'"$M"'" networks | jsonfilter -e "@.total")" = 0 ]'
check "survey: unknown command fails" sh -c '! "'"$M"'" wat 2>/dev/null'

echo "# Wi-Fi survey GPS (pirate-survey gps, gpspipe mocked)"
GM="$T/gpsmock"; mkdir -p "$GM"
# gpspipe is not installed in the test image, so a plain call reports that.
check "gps: reports not installed when gpspipe is missing" sh -c '[ "$(pirate-survey gps | jsonfilter -e "@.installed")" = false ]'
# gpsd not reachable: gpspipe prints nothing.
printf '#!/bin/sh\nexit 0\n' > "$GM/gpspipe"; chmod +x "$GM/gpspipe"
check "gps: gpsd down -> running false" sh -c "[ \"\$(PATH=$GM:\$PATH pirate-survey gps | jsonfilter -e '@.running')\" = false ]"
# gpsd up, no fix: VERSION/DEVICES/WATCH only.
printf '#!/bin/sh\nprintf "%%s\\n" %s %s %s\n' \
	"'{\"class\":\"VERSION\"}'" "'{\"class\":\"DEVICES\",\"devices\":[]}'" "'{\"class\":\"WATCH\"}'" > "$GM/gpspipe"
chmod +x "$GM/gpspipe"
check "gps: running, no fix" sh -c "[ \"\$(PATH=$GM:\$PATH pirate-survey gps | jsonfilter -e '@.running') \$(PATH=$GM:\$PATH pirate-survey gps | jsonfilter -e '@.fix')\" = 'true none' ]"
# gpsd up, 3D fix with satellites and a position.
{
	echo '#!/bin/sh'
	echo 'cat <<EOF'
	echo '{"class":"VERSION"}'
	echo '{"class":"DEVICES","devices":[{"class":"DEVICE","path":"/dev/ttyACM0"}]}'
	echo '{"class":"SKY","nSat":11,"uSat":7}'
	echo '{"class":"TPV","device":"/dev/ttyACM0","mode":3,"lat":37.421998,"lon":-122.084000,"alt":12.3}'
	echo 'EOF'
} > "$GM/gpspipe"
chmod +x "$GM/gpspipe"
PATH="$GM:$PATH" pirate-survey gps > "$T/gps.out"
check "gps: 3D fix with device and satellites" sh -c "[ \"\$(jsonfilter -i $T/gps.out -e '@.fix') \$(jsonfilter -i $T/gps.out -e '@.device') \$(jsonfilter -i $T/gps.out -e '@.sats_used')\" = '3D /dev/ttyACM0 7' ]"
check "gps: 3D fix reports the position" sh -c "[ \"\$(jsonfilter -i $T/gps.out -e '@.lat') \$(jsonfilter -i $T/gps.out -e '@.lon')\" = '37.421998 -122.084000' ]"
# A scan sighting with a GPS position tags the network.
printf '%s\n' '{"bssid":"de:ad:be:ef:00:01","ssid":"Mobile","freq":2412,"channel":1,"signal":-55,"security":"WPA2"}' |
	PIRATE_SURVEY_STORE="$T/gpssurv" PIRATE_SURVEY_TIME=2026-10-24T13:00:00Z PIRATE_SURVEY_LAT=37.42 PIRATE_SURVEY_LON=-122.08 "$M" scan > "$T/gpsm.out"
check "gps: a located sighting tags the network" sh -c "[ \"\$(jsonfilter -i $T/gpsm.out -e '@.gps.lat') \$(jsonfilter -i $T/gpsm.out -e '@.networks[0].lat')\" = '37.420 37.420' ]"
# Or a MeshCore radio's GPS (pirate-meshcore's position), while gpsd has no fix
echo '{ "state": "ready", "available": true, "enabled": true, "live": true, "lat": 37.421926, "lon": -122.084103, "source": "LilyGo T-Echo" }' > "$T/mcpos.json"
echo '{ "state": "ready", "available": true, "enabled": true, "live": false }' > "$T/mcstale.json"
check "gps: gpsd's fix first" sh -c "[ \"\$(PATH=$GM:\$PATH PIRATE_MESHCORE_POSITION=$T/mcpos.json pirate-survey gps | jsonfilter -e '@.fix' -e '@.source' | tr '\n' ' ')\" = '3D ' ]"
printf '#!/bin/sh\nprintf "%%s\\n" %s %s %s\n' \
	"'{\"class\":\"VERSION\"}'" "'{\"class\":\"DEVICES\",\"devices\":[]}'" "'{\"class\":\"WATCH\"}'" > "$GM/gpspipe"
PATH="$GM:$PATH" PIRATE_MESHCORE_POSITION="$T/mcpos.json" pirate-survey gps > "$T/mcg.out"
check "gps: gpsd without a fix: the MeshCore radio's" [ "$(jsonfilter -i "$T/mcg.out" -e '@.source' -e '@.fix' -e '@.device' | tr '\n' '|')" = "meshcore|2D|LilyGo T-Echo's GPS|" ]
check "gps: its position" sh -c "jsonfilter -i $T/mcg.out -e '@.lat' -e '@.lon' | tr '\n' ' ' | grep -qx '37.421926 -122.084103 '"
check "gps: no gpsd at all: the MeshCore radio's" [ "$(PIRATE_MESHCORE_POSITION="$T/mcpos.json" pirate-survey gps | jsonfilter -e '@.source')" = meshcore ]
check "gps: a position not moving isn't a fix" [ "$(PIRATE_MESHCORE_POSITION="$T/mcstale.json" pirate-survey gps | jsonfilter -e '@.installed' -e '@.source' | tr '\n' ' ')" = "false " ]

echo "# threat detection (rogue analysis + deauth parser)"
TR="$T/threats"; mkdir -p "$TR"
cat > "$TR/networks.json" <<'JSON'
{
 "aa:aa:aa:aa:aa:01":{"bssid":"aa:aa:aa:aa:aa:01","ssid":"HomeNet","security":"WPA2","best_signal":-50,"channel":6,"count":3,"first":"x","last":"y"},
 "bb:bb:bb:bb:bb:02":{"bssid":"bb:bb:bb:bb:bb:02","ssid":"HomeNet","security":"Open","best_signal":-40,"channel":6,"count":1,"first":"x","last":"y"},
 "cc:cc:cc:cc:cc:03":{"bssid":"cc:cc:cc:cc:cc:03","ssid":"MyNet","security":"Open","best_signal":-60,"channel":1,"count":1,"first":"x","last":"y"},
 "dd:dd:dd:dd:dd:04":{"bssid":"dd:dd:dd:dd:dd:04","ssid":"Cafe","security":"Open","best_signal":-70,"channel":11,"count":1,"first":"x","last":"y"}
}
JSON
printf '%s\n' MyNet | PIRATE_SURVEY_STORE="$TR" PIRATE_SURVEY_TIME=2026-10-24T18:00:00Z "$M" threats > "$TR/out.json"
check "threats: evil-twin and impersonation both flagged" sh -c "[ \"\$(jsonfilter -i $TR/out.json -e '@.threats[*].type' | sort | tr '\n' ' ')\" = 'evil_twin impersonation ' ]"
check "threats: the flagged SSIDs are HomeNet and MyNet" sh -c "[ \"\$(jsonfilter -i $TR/out.json -e '@.threats[*].ssid' | sort | tr '\n' ' ')\" = 'HomeNet MyNet ' ]"
check "threats: a legitimate open network is not flagged" sh -c "! jsonfilter -i $TR/out.json -e '@.threats[*].ssid' | grep -qx Cafe"
check "threats: reports the protected SSID" sh -c "[ \"\$(jsonfilter -i $TR/out.json -e '@.protected[0]')\" = MyNet ]"
# Deauth parser: sample tcpdump -e frames on stdin (no monitor radio needed).
printf '%s\n' 'a SA:de:ad:be:ef:00:01 DeAuthentication x' 'a SA:de:ad:be:ef:00:01 DeAuthentication x' 'a SA:ca:fe:00:00:00:02 Disassociation x' |
	pirate-threats deauth-report 15 6 mon0 > "$TR/d.json"
check "threats: deauth parser counts frames by type" sh -c "[ \"\$(jsonfilter -i $TR/d.json -e '@.total') \$(jsonfilter -i $TR/d.json -e '@.deauth') \$(jsonfilter -i $TR/d.json -e '@.disassoc')\" = '3 2 1' ]"
check "threats: deauth parser aggregates the top source" sh -c "[ \"\$(jsonfilter -i $TR/d.json -e '@.sources[0].mac') \$(jsonfilter -i $TR/d.json -e '@.sources[0].count')\" = 'de:ad:be:ef:00:01 2' ]"
check "threats: a deauth flood raises the alert" sh -c 'for i in $(seq 12); do echo "x SA:ba:ad:00:00:00:0f DeAuthentication y"; done | pirate-threats deauth-report 20 6 mon0 | jsonfilter -e "@.alert" | grep -qx true'
check "threats: quiet air does not alert" sh -c 'printf "" | pirate-threats deauth-report 15 6 mon0 | jsonfilter -e "@.alert" | grep -qx false'
check "threats: deauth rejects a bad window" sh -c 'pirate-threats deauth abc | jsonfilter -e "@.error" >/dev/null'

echo "# recon dashboard (pirate-dashboard)"
pirate-dashboard > "$T/dash.json" 2>/dev/null
check "dashboard: output is valid JSON" jsonfilter -i "$T/dash.json" -e '@.uplink' -q
check "dashboard: has all the sections" sh -c "[ \"\$(jsonfilter -i $T/dash.json -e '@.uplink' -e '@.hosts' -e '@.survey' -e '@.threats' -e '@.gps' -e '@.radios' | wc -l)\" -ge 6 ]"
# Radios parse from iwinfo: the real Mode, not the trailing "HT Mode:".
DM="$T/dashmock"; mkdir -p "$DM"
{
	echo '#!/bin/sh'
	echo 'cat <<EOX'
	echo 'mon0      ESSID: unknown'
	echo '          Mode: Monitor  Channel: 10 (2.457 GHz)  HT Mode: null'
	echo 'wlan0     ESSID: "Pirate Radio"'
	echo '          Mode: Master  Channel: 36 (5.180 GHz)  HT Mode: VHT80'
	echo 'EOX'
} > "$DM/iwinfo"
chmod +x "$DM/iwinfo"
PATH="$DM:$PATH" pirate-dashboard > "$T/dash2.json" 2>/dev/null
check "dashboard: radios take the Mode, not the HT Mode" sh -c "[ \"\$(jsonfilter -i $T/dash2.json -e '@.radios[*].mode' | tr '\n' ' ')\" = 'Monitor Master ' ]"
check "dashboard: radios keep the SSID and channel" sh -c "[ \"\$(jsonfilter -i $T/dash2.json -e '@.radios[1].ssid') \$(jsonfilter -i $T/dash2.json -e '@.radios[0].channel')\" = 'Pirate Radio 10' ]"

echo "# recon scan profiles (pirate-recon scan, nmap mocked)"
check "scan: valid JSON without nmap" sh -c 'pirate-recon scan quick 203.0.113.1 | jsonfilter -e "@.profile" -q'
check "scan: rejects a shell-injection target" sh -c 'pirate-recon scan quick "x; reboot" | jsonfilter -e "@.error" | grep -q "give a host"'
check "scan: rejects an unknown profile" sh -c 'pirate-recon scan bogus 203.0.113.1 | jsonfilter -e "@.error" | grep -q "unknown profile"'
check "scan: rpcd plugin offers scan" sh -c '"'"$RP"'" list | jsonfilter -e "@.scan.profile" | grep -qx str'
# A mock nmap emitting grepable output, so the parser can be checked.
NM="$T/nmapmock"; mkdir -p "$NM"
cat > "$NM/nmap" <<'NMAP'
#!/bin/sh
out=; prev=
for a in "$@"; do [ "$prev" = "-oN" ] && out=$a; prev=$a; done
gen() {
	case " $* " in
	*" -sn "*) printf 'Host: 192.168.1.10 ()\tStatus: Up\nHost: 192.168.1.23 ()\tStatus: Up\n' ;;
	*" -sV "*) printf 'Host: 192.168.1.10 ()\tPorts: 22/open/tcp//ssh//OpenSSH 9.6/\tIgnored State: closed (99)\n' ;;
	*) printf 'Host: 192.168.1.10 ()\tPorts: 22/open/tcp//ssh//, 80/open/tcp//http//\tIgnored State: closed (98)\n' ;;
	esac
}
[ -n "$out" ] && gen "$@" > "$out"
gen "$@"
NMAP
chmod +x "$NM/nmap"
PATH="$NM:$PATH" pirate-recon scan quick 192.168.1.10 > "$T/scanq.out"
check "scan: parses hosts and ports" sh -c "[ \"\$(jsonfilter -i $T/scanq.out -e '@.hosts[0].ip') \$(jsonfilter -i $T/scanq.out -e '@.hosts[0].ports[*].service' | tr '\n' ' ')\" = '192.168.1.10 ssh http ' ]"
check "scan: service profile removed (nmap -sV OOMs on 128 MB)" sh -c 'pirate-recon scan service 192.168.1.10 | jsonfilter -e "@.error" | grep -q "unknown profile"'
PATH="$NM:$PATH" pirate-recon scan ping 192.168.1.0/24 > "$T/scanp.out"
check "scan: ping sweep lists hosts up" sh -c "[ \"\$(jsonfilter -i $T/scanp.out -e '@.hosts[*].ip' | tr '\n' ' ')\" = '192.168.1.10 192.168.1.23 ' ]"
RS="$T/reconstore"; mkdir -p "$RS"
PATH="$NM:$PATH" PIRATE_RECON_STORE="$RS" pirate-recon scan quick 192.168.1.10 >/dev/null
check "scan: saves a readable copy and a JSON log" sh -c "ls '$RS'/scan-quick-*.txt >/dev/null 2>&1 && [ -s '$RS/scans.ndjson' ]"

echo "# pirate-radio-ui: router basics (pirate-router)"
RR=/usr/libexec/rpcd/pirate.router
check "router: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/pirate-router.json -e '@' -q
check "router: rpcd plugin offers status, clients, adblock" sh -c '"'"$RR"'" list | jsonfilter -e "@.status" >/dev/null && "'"$RR"'" list | jsonfilter -e "@.clients" >/dev/null && "'"$RR"'" list | jsonfilter -e "@.adblock" >/dev/null'
check "router: status has a positive memory total" sh -c '[ "$(pirate-router status | jsonfilter -e "@.memory.total")" -gt 0 ]'
check "router: status online is a boolean" sh -c 'pirate-router status | jsonfilter -e "@.online" | grep -qxE "true|false"'
printf '%s\n' '1700000000 b8:27:eb:aa:bb:cc 192.168.1.10 raspberrypi *' '1700000000 3c:22:fb:12:34:56 192.168.1.23 * *' > "$T/leases"
PIRATE_LEASES="$T/leases" pirate-router clients > "$T/clients.out"
check "router: clients parsed from the leases (unknown host -> -)" sh -c "[ \"\$(jsonfilter -i $T/clients.out -e '@.clients[0].host') \$(jsonfilter -i $T/clients.out -e '@.clients[0].ip') \$(jsonfilter -i $T/clients.out -e '@.clients[1].host')\" = 'raspberrypi 192.168.1.10 -' ]"
check "router: no leases file -> empty list" sh -c "[ \"\$(PIRATE_LEASES=/nonexistent pirate-router clients | jsonfilter -e '@.clients[*].ip' | wc -l)\" = 0 ]"
check "router: adblock reports installed false when absent" sh -c 'pirate-router adblock | jsonfilter -e "@.installed" | grep -qx false'
check "router: unknown command yields an error" sh -c 'pirate-router wat | jsonfilter -e "@.error" >/dev/null'
check "router: rpcd offers set_password, wifi_status/scan/join" sh -c '"'"$RR"'" list | jsonfilter -e "@.set_password.password" | grep -qx str && "'"$RR"'" list | jsonfilter -e "@.wifi_join.ssid" | grep -qx str'
check "router: wifi_status is valid JSON" sh -c 'pirate-router wifi_status | jsonfilter -e "@" >/dev/null'
check "router: wifi_scan is valid JSON" sh -c 'pirate-router wifi_scan | jsonfilter -e "@" >/dev/null'
check "router: wifi_join rejects a missing SSID" sh -c 'pirate-router wifi_join "" psk2 </dev/null | jsonfilter -e "@.error" | grep -q "no SSID"'
check "router: wifi_join needs a password for a secured network" sh -c 'echo "" | pirate-router wifi_join MyNet psk2 | jsonfilter -e "@.error" | grep -q "needs a password"'
check "router: set_password rejects an empty password" sh -c 'echo "" | pirate-router set_password | jsonfilter -e "@.error" | grep -q "empty"'
check "router: set_password rejects a short password" sh -c 'printf abc | pirate-router set_password | jsonfilter -e "@.error" | grep -q "at least 5"'
# Its ports and radios, a GL-AR750S's: swconfig, iw and sysfs faked
HM="$T/hwmock"; HS="$T/hwsys"
mkdir -p "$HM" "$HS/class/ieee80211/phy0" "$HS/class/ieee80211/phy1" "$HS/drivers/ath10k_pci" "$HS/drivers/ath9k" \
	"$HS/devices/pci0000:00/0000:00:00.0" "$HS/devices/platform/ahb/18100000.wmac" \
	"$HS/devices/usb2/2-1/2-1.1/host1" "$HS/bus/usb/devices/1-1" "$HS/bus/usb/devices/1-1:1.0" "$HS/block/sdb"
ln -s "$HS/drivers/ath10k_pci" "$HS/devices/pci0000:00/0000:00:00.0/driver"
ln -s "$HS/drivers/ath9k" "$HS/devices/platform/ahb/18100000.wmac/driver"
ln -s "$HS/devices/pci0000:00/0000:00:00.0" "$HS/class/ieee80211/phy0/device"
ln -s "$HS/devices/platform/ahb/18100000.wmac" "$HS/class/ieee80211/phy1/device"
ln -s "$HS/devices/usb2/2-1/2-1.1/host1" "$HS/block/sdb/device"
echo 62333952 > "$HS/block/sdb/size"
printf '0483\n' > "$HS/bus/usb/devices/1-1/idVendor"
printf '5740\n' > "$HS/bus/usb/devices/1-1/idProduct"
printf 'Flipper Devices Inc.\n' > "$HS/bus/usb/devices/1-1/manufacturer"
printf 'Rolet\n' > "$HS/bus/usb/devices/1-1/product"
printf '02\n' > "$HS/bus/usb/devices/1-1/bDeviceClass"
cat > "$HM/swconfig" <<-'EOF'
	#!/bin/sh
	printf '\tlink: port:0 link:up speed:1000baseT full-duplex\n\tlink: port:1 link:down\n'
	printf '\tlink: port:2 link:up speed:1000baseT full-duplex txflow rxflow auto\n\tlink: port:3 link:up speed:100baseT half-duplex\n'
EOF
cat > "$HM/iw" <<-'EOF'
	#!/bin/sh
	[ "$1" = dev ] || exit 0
	printf 'phy#1\n\tInterface mon0\n\t\ttype monitor\n\t\tchannel 10 (2457 MHz), width: 20 MHz\n'
	printf 'phy#0\n\tInterface phy0-sta0\n\t\tssid NoInternetHere-5\n\t\ttype managed\n\t\tchannel 36 (5180 MHz)\n'
	printf '\tInterface phy0-ap0\n\t\tssid Pirate Radio\n\t\ttype AP\n\t\tchannel 36 (5180 MHz)\n\tInterface phy0-ap1\n\t\ttype AP\n'
EOF
chmod 755 "$HM/swconfig" "$HM/iw"
PATH="$HM:$PATH" PIRATE_SWCONFIG="$HM/swconfig" PIRATE_SYSFS="$HS" pirate-router ports > "$T/ports.json"
pj() { jsonfilter -i "$T/ports.json" -e "$1"; }
check "router: ports: the WAN jack, unplugged" [ "$(pj '@.ethernet[0].name') $(pj '@.ethernet[0].iface') $(pj '@.ethernet[0].link')" = "WAN eth0.2 false" ]
check "router: ports: LAN 1, 1000 Mb/s full duplex" [ "$(pj '@.ethernet[1].name') $(pj '@.ethernet[1].iface') $(pj '@.ethernet[1].link') $(pj '@.ethernet[1].speed') $(pj '@.ethernet[1].full_duplex')" = "LAN 1 eth0.1 true 1000 true" ]
check "router: ports: LAN 2, 100 half" [ "$(pj '@.ethernet[2].name') $(pj '@.ethernet[2].speed') $(pj '@.ethernet[2].full_duplex')" = "LAN 2 100 false" ]
check "router: ports: the 5 GHz radio, a QCA9887" [ "$(pj '@.radios[0].phy') $(pj '@.radios[0].band') $(pj '@.radios[0].chip') $(pj '@.radios[0].driver') $(pj '@.radios[0].usb')" = "phy0 5 GHz QCA9887 ath10k_pci false" ]
check "router: ports: its uplink and access points" [ "$(pj '@.radios[0].interfaces[*].name' | tr '\n' ' ')" = "phy0-sta0 phy0-ap0 phy0-ap1 " ]
check "router: ports: their types, channels and networks" [ "$(pj '@.radios[0].interfaces[0].type') $(pj '@.radios[0].interfaces[0].channel') $(pj '@.radios[0].interfaces[1].ssid')" = "managed 36 Pirate Radio" ]
check "router: ports: an interface with no channel" [ "$(pj '@.radios[0].interfaces[2].type'):$(pj '@.radios[0].interfaces[2].channel')" = "AP:" ]
check "router: ports: the monitor, on the 2.4 GHz radio (QCA9563)" [ "$(pj '@.radios[1].band') $(pj '@.radios[1].chip') $(pj '@.radios[1].interfaces[0].name') $(pj '@.radios[1].interfaces[0].type') $(pj '@.radios[1].interfaces[0].channel')" = "2.4 GHz QCA9563 mon0 monitor 10" ]
check "router: ports: what is on the USB port" [ "$(pj '@.usb[*].id') / $(pj '@.usb[0].name')" = "0483:5740 / Flipper Devices Inc. Rolet" ]
check "router: ports: a card in the microSD slot" [ "$(pj '@.card.present') $(pj '@.card.device')" = "true sdb" ]
echo 0 > "$HS/block/sdb/size"
check "router: ports: an empty slot" [ "$(PATH="$HM:$PATH" PIRATE_SWCONFIG="$HM/swconfig" PIRATE_SYSFS="$HS" pirate-router ports | jsonfilter -e '@.card.present')" = false ]
check "router: rpcd offers ports" sh -c '"'"$RR"'" list | jsonfilter -e "@.ports" >/dev/null'
# The root password: changed only with the current one proved (a sign-in's
# session, fresh), unless there is none yet. ubus and passwd mocked.
PM="$T/pwmock"; mkdir -p "$PM"
cat > "$PM/ubus" <<-'EOF'
	#!/bin/sh
	# ubus call session list|destroy '{ "ubus_rpc_session": "<sid>" }'
	sid=$(echo "$4" | sed -n 's/.*"\([0-9a-f]\{32\}\)".*/\1/p')
	echo "$3 $sid" >> "$PW_T/ubus.log"
	[ "$3" = destroy ] && exit 0
	case "$sid" in
	aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) echo '{ "timeout": 60, "expires": 52, "data": { "username": "root" } }' ;;
	bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) echo '{ "timeout": 3600, "expires": 2000, "data": { "username": "root" } }' ;;
	cccccccccccccccccccccccccccccccc) echo '{ "timeout": 60, "expires": 60, "data": { } }' ;;
	*) exit 4 ;;
	esac
EOF
cat > "$PM/passwd" <<-'EOF'
	#!/bin/sh
	echo "passwd $*: $(head -n 1)" >> "$PW_T/passwd.log"
EOF
cat > "$PM/router" <<-'EOF'
	#!/bin/sh
	cat > "$PW_T/router.in"
	echo '{ "ok": true }'
EOF
chmod 755 "$PM/ubus" "$PM/passwd" "$PM/router"
echo 'root:$5$salt$hash:20000:0:99999:7:::' > "$PM/shadow"
: > "$PM/passwd.log"; : > "$PM/ubus.log"
export PW_T="$PM"
PA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PD=dddddddddddddddddddddddddddddddd
spw() { printf '%s\n%s\n%s\n' "$1" "$2" "$3" | PATH="$PM:$PATH" PIRATE_UBUS="$PM/ubus" PIRATE_SHADOW="$PM/shadow" pirate-router set_password | jsonfilter -e '@.error' -e '@.ok'; }
PWE="enter the current password to change it"
check "router: set_password: the current password needed" [ "$(spw newpass1 '' "$PD")" = "$PWE" ]
check "router: set_password: not a session" [ "$(spw newpass1 0123abc "$PD")" = "$PWE" ]
check "router: set_password: a session no one has" [ "$(spw newpass1 eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee "$PD")" = "$PWE" ]
check "router: set_password: an old sign-in isn't proof" [ "$(spw newpass1 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "$PD")" = "$PWE" ]
check "router: set_password: nor a session no one signed in to" [ "$(spw newpass1 cccccccccccccccccccccccccccccccc "$PD")" = "$PWE" ]
check "router: set_password: nor the caller's own" [ "$(spw newpass1 "$PA" "$PA")" = "$PWE" ]
check "router: set_password: nothing set without proof" [ ! -s "$PM/passwd.log" ]
check "router: set_password: a fresh sign-in is proof" [ "$(spw newpass1 "$PA" "$PD")" = true ]
check "router: set_password: the new password set" grep -qx 'passwd root: newpass1' "$PM/passwd.log"
check "router: set_password: the proof spent" grep -qx "destroy $PA" "$PM/ubus.log"
echo 'root:::0:0:99999:7:::' > "$PM/shadow"; : > "$PM/passwd.log"
check "router: set_password: the first one needs no proof" [ "$(spw firstpass '' "$PD")" = true ]
check "router: set_password: and is set" grep -qx 'passwd root: firstpass' "$PM/passwd.log"
echo "{\"password\":\"newpass1\",\"proof\":\"$PA\",\"ubus_rpc_session\":\"$PD\"}" | PIRATE_ROUTER="$PM/router" "$RR" call set_password > /dev/null
check "router: rpcd: the password, proof and caller's session on stdin" [ "$(tr '\n' ' ' < "$PM/router.in")" = "newpass1 $PA $PD " ]

echo "# pirate-radio-ui: access (pirate-access: SSH, sign-ins, the terminal)"
RA=/usr/libexec/rpcd/pirate.access
AC="$T/access"; AB="$AC/bin"; AP="$AC/proc"
mkdir -p "$AB" "$AP" "$AC/hostkeys"
export ACC_T="$AC"
check "access: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/pirate-access.json -e '@' -q
check "access: rpcd plugin offers SSH, sessions and the terminal" sh -c '"'"$RA"'" list | jsonfilter -e "@.ssh_set.port" | grep -qx 22 && "'"$RA"'" list | jsonfilter -e "@.ssh_key_add.key" | grep -qx str && "'"$RA"'" list | jsonfilter -e "@.session_end.pid" | grep -qx 0 && "'"$RA"'" list | jsonfilter -e "@.term_set.enabled" | grep -qx true'
# Two sessions to end (real processes, faked in /proc as dropbear's and
# ttyd's), and one that is neither
sleep 300 & S1=$!
sleep 300 & S2=$!
sleep 300 & S3=$!
mkst() { mkdir -p "$AP/$1"; printf 'Name:\t%s\nPPid:\t%s\n' "$2" "$3" > "$AP/$1/status"; echo "$1 ($2) S $3 $1 $1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 $4 1376256 0" > "$AP/$1/stat"; }
echo '1000.00 900.00' > "$AP/uptime"
mkst 6042 dropbear 1937 50000
mkst "$S1" dropbear 1937 60000
mkst "$S2" ash 4242 90000
mkst "$S3" sh 1 90000
cat > "$AB/pidof" <<-'EOF'
	#!/bin/sh
	case "$1" in ttyd) echo 4242 ;; dropbear) echo 1937 ;; *) exit 1 ;; esac
EOF
FP1=SHA256:y0Er8ulxKFhLeqneIJqQBkQkSCl3Vv1GF3dmxrjXSMU
FP2=SHA256:sNIAzx6YYwB8XVn4c9avCjnUWWgXtXTT3ki7q9gzo/s
K1='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP2XEHhUfV+Qf66vWJqdL1rd8ynDPC02Bv7PwREszCg2 test@pc'
K2='ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCsQfpo/GPfYcfLoYTjZ+pYziNo5416yHhiJAIx2T8nVzyHBtnJuHBkhyyNP4CnhjW7Q8bqwgmGT1T5sQs+YFm9r1Qall+AShLUGzquFpwiA6BFhVbGzMNAS4crwioqd1qwp5uZWXoEL6/H1djCMf4A1yih1ayC7kQ2LNi671ClNxpXTB3ATPz0xCM5gh00FxjFrbIu2gXXOAvPNGW1Bz8UD2EfW9/lis4CG520CCrg2PzwG1Z7Sm0PkXNmGioTjNlo1qrRha1qX08bNncZqeknqG41ZF+Adr3Ss3qmoGVBqLzu2C/xSXY2zt38vvfzQs7YRkfPhQ5/qyZuFkcTQLzQ6tVChanM1nBI6XMvQgqqTkbAR2kGBimEj08rQlqkocUW58/4rSHswPwzRmVwcMMJPgXHdq8HFqiNf0bZlbiin1nCkgYKYbufVxtnyXVHOuLhQW1WcZ3kZgPHYOxZauVU9fxLm3yPI6NCl0qcJUVLKUf0HH5YidUDBcVyKgRY3Ik= laptop key'
cat > "$AC/log" <<-EOF
	Thu Nov  5 16:49:22 2026 [1793926162.203] authpriv.info dropbear[6042]: Child connection from 10.69.4.181:57699
	Thu Nov  5 16:49:22 2026 [1793926162.467] authpriv.notice dropbear[6042]: Pubkey auth succeeded for 'root' with ssh-ed25519 key $FP1 from 10.69.4.181:57699
	Thu Nov  5 16:50:01 2026 [1793926201.000] authpriv.warn dropbear[6050]: Bad password attempt for 'root' from 10.69.4.99:40000
	Thu Nov  5 16:50:05 2026 [1793926205.000] authpriv.notice dropbear[6051]: Password auth succeeded for 'root' from 10.69.4.99:40002
	Thu Nov  5 16:50:30 2026 [1793926230.000] authpriv.info dropbear[6051]: Exit (root) from <10.69.4.99:40002>: Disconnect received
	Thu Nov  5 16:51:00 2026 [1793926260.000] daemon.notice ttyd[4242]: [2026/11/05 16:51:00:0000] N: WS   /ws - 10.69.4.181, clients: 1
	Thu Nov  5 16:51:00 2026 [1793926260.100] daemon.notice ttyd[4242]: [2026/11/05 16:51:00:1000] N: started process, pid: $S2
	Thu Nov  5 16:52:00 2026 [1793926320.000] auth.info login[$S2]: root login on 'pts/0'
	Thu Nov  5 16:53:00 2026 [1793926380.000] auth.warn login[7002]: invalid password for 'root' on 'pts/1'
EOF
cat > "$AB/logread" <<-'EOF'
	#!/bin/sh
	cat "$ACC_T/log"
EOF
cat > "$AB/netstat" <<-'EOF'
	#!/bin/sh
	echo 'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name'
	echo 'tcp        0      0 10.69.4.20:22           10.69.4.181:57699       ESTABLISHED 6042/dropbear'
	echo 'tcp        0      0 10.69.4.20:80           10.69.4.181:57700       ESTABLISHED 1500/uhttpd'
	echo 'tcp        0      0 10.69.4.20:7681         10.69.4.181:57800       ESTABLISHED 4242/ttyd'
	echo 'tcp        0      0 10.69.4.20:22           10.69.4.99:40010        TIME_WAIT   -'
EOF
cat > "$AB/init" <<-'EOF'
	#!/bin/sh
	echo "$(basename "$0") $1" >> "$ACC_T/init.log"
	[ "$1" = enabled ] && [ -e "$ACC_T/enabled" ] && exit 0
	[ "$1" = enabled ] && exit 1
	[ "$1" = enable ] && : > "$ACC_T/enabled"
	[ "$1" = disable ] && rm -f "$ACC_T/enabled"
	exit 0
EOF
printf '#!/bin/sh\nexit 0\n' > "$AB/ttyd"
cp "$AB/init" "$AB/dropbear-init"
chmod 755 "$AB/pidof" "$AB/logread" "$AB/netstat" "$AB/init" "$AB/dropbear-init" "$AB/ttyd"
: > "$AC/init.log"
pa() { PATH="$AB:$PATH" PIRATE_KEYS="$AC/keys" PIRATE_HOSTKEYS="$AC/hostkeys" PIRATE_PROC="$AP" \
	PIRATE_LOGREAD="$AB/logread" PIRATE_NETSTAT="$AB/netstat" PIRATE_DROPBEAR_INIT="$AB/dropbear-init" \
	PIRATE_TTYD_INIT="$AB/init" PIRATE_TTYD="$AB/ttyd" pirate-access "$@"; }
pae() { pa "$@" | jsonfilter -e '@.error'; }
uci -q set 'dropbear.@dropbear[0].Port=22'; uci -q set 'dropbear.@dropbear[0].PasswordAuth=on'
uci -q set 'dropbear.@dropbear[0].RootPasswordAuth=on'; uci -q commit dropbear
check "access: no keys yet" [ "$(pa ssh_status | jsonfilter -e '@.keys[*].type' | wc -l)" = 0 ]
check "access: add a key" [ "$(echo "$K1" | pa ssh_key_add | jsonfilter -e '@.fingerprint')" = "$FP1" ]
check "access: and an RSA one (fingerprints as ssh-keygen's)" [ "$(echo "$K2" | pa ssh_key_add | jsonfilter -e '@.fingerprint')" = "$FP2" ]
check "access: a key once only" [ "$(echo "$K1" | pae ssh_key_add)" = "that key is here already" ]
check "access: not a key" [ "$(echo 'hello there' | pae ssh_key_add)" = "key: paste a public key's line, such as ssh-ed25519 AAAA… you@computer" ]
check "access: not a whole key" [ "$(echo 'ssh-ed25519 AAAAC3NzaC1lZDI1 x' | pae ssh_key_add)" = "key: that isn't a whole public key" ]
check "access: no options before a key" [ "$(echo "command=\"ls\" $K1" | pae ssh_key_add)" = "key: paste a public key's line, such as ssh-ed25519 AAAA… you@computer" ]
check "access: the keys file, as dropbear reads it" [ "$(cat "$AC/keys")" = "$(printf '%s\n%s' "$K1" "$K2")" ]
pa ssh_status > "$AC/status.json"
aj() { jsonfilter -i "$AC/status.json" -e "$1"; }
check "access: status: port, passwords, running" [ "$(aj '@.port') $(aj '@.passwords') $(aj '@.running')" = "22 true true" ]
check "access: status: the keys, their names and fingerprints" [ "$(aj '@.keys[*].comment' | tr '\n' '|')$(aj '@.keys[*].fingerprint' | tr '\n' '|')" = "test@pc|laptop key|$FP1|$FP2|" ]
check "access: status: an SSH session, its key and age" [ "$(aj '@.sessions[0].kind') $(aj '@.sessions[0].pid') $(aj '@.sessions[0].from') $(aj '@.sessions[0].how') $(aj '@.sessions[0].key') $(aj '@.sessions[0].age')" = "ssh 6042 10.69.4.181 key $FP1 500" ]
check "access: status: a terminal, from its address in ttyd's log" [ "$(aj '@.sessions[1].kind') $(aj '@.sessions[1].pid') $(aj '@.sessions[1].from') $(aj '@.sessions[1].how') $(aj '@.sessions[1].age')" = "terminal $S2 10.69.4.181 password 100" ]
check "access: status: those two only" [ "$(aj '@.sessions[*].pid' | wc -l)" = 2 ]
check "access: status: sign-ins, newest first" [ "$(aj '@.recent[*].event' | tr '\n' ' ')" = "refused in out in refused in " ]
check "access: status: the terminal's" [ "$(aj '@.recent[0].how') $(aj '@.recent[1].how')" = "terminal terminal" ]
check "access: status: SSH's, by key and by password" [ "$(aj '@.recent[5].how') $(aj '@.recent[5].key') $(aj '@.recent[5].from') $(aj '@.recent[3].how') $(aj '@.recent[3].from') $(aj '@.recent[4].how') $(aj '@.recent[2].from')" = "key $FP1 10.69.4.181 password 10.69.4.99 password 10.69.4.99" ]
check "access: status: when" [ "$(aj '@.recent[0].time') $(aj '@.recent[5].time')" = "1793926380 1793926162" ]
dropbearkey -t ed25519 -f "$AC/hostkeys/dropbear_ed25519_host_key" > /dev/null 2>&1
check "access: status: the router's own key, as dropbearkey has it" [ "$(pa ssh_status | jsonfilter -e '@.host_keys[0].fingerprint')" = "$(dropbearkey -y -f "$AC/hostkeys/dropbear_ed25519_host_key" | sed -n 's/^Fingerprint: //p')" ]
check "access: ssh_set: a port is a number" [ "$(pae ssh_set abc on)" = "port: a number, 1 to 65535" ]
check "access: ssh_set: 1 to 65535" [ "$(pae ssh_set 70000 on)" = "port: a number, 1 to 65535" ]
check "access: ssh_set: not another service's port" [ "$(pae ssh_set 80 on)" = "port: 80 is another service's here" ]
check "access: ssh_set: passwords on or off" [ "$(pae ssh_set 22 maybe)" = "passwords: on or off" ]
check "access: ssh_set: passwords off" [ "$(pa ssh_set 2222 off | jsonfilter -e '@.ok' -e '@.port' -e '@.passwords' | tr '\n' ' ')" = "true 2222 false " ]
check "access: ssh_set: in dropbear's settings" [ "$(uci -q get 'dropbear.@dropbear[0].Port') $(uci -q get 'dropbear.@dropbear[0].PasswordAuth') $(uci -q get 'dropbear.@dropbear[0].RootPasswordAuth')" = "2222 off off" ]
sleep 2
check "access: ssh_set: dropbear restarted" grep -qx 'dropbear-init restart' "$AC/init.log"
check "access: remove a key" [ "$(pa ssh_key_remove "$FP2" | jsonfilter -e '@.ok')" = true ]
check "access: not the last, with passwords off" [ "$(pae ssh_key_remove "$FP1")" = "that's the last key, and SSH takes no passwords: turn passwords on first" ]
check "access: no such key" [ "$(pae ssh_key_remove SHA256:nope)" = "no such key" ]
check "access: the other key left" [ "$(cat "$AC/keys")" = "$K1" ]
pa ssh_set 22 on > /dev/null
check "access: the last, with passwords on" [ "$(pa ssh_key_remove "$FP1" | jsonfilter -e '@.ok')" = true ]
check "access: passwords off needs a key" [ "$(pae ssh_set 22 off)" = "add a key first: with passwords off and no key, nobody could sign in over SSH" ]
check "access: end an SSH session" [ "$(pa session_end "$S1" | jsonfilter -e '@.ok')" = true ]
check "access: end a terminal" [ "$(pa session_end "$S2" | jsonfilter -e '@.ok')" = true ]
sleep 1
check "access: both ended" sh -c "! kill -0 $S1 2>/dev/null && ! kill -0 $S2 2>/dev/null"
check "access: not another process" [ "$(pae session_end "$S3")" = "that isn't an SSH or terminal session" ]
check "access: nor the one that listens" [ "$(pae session_end 1)" = "that isn't an SSH or terminal session" ]
check "access: a PID is a number" [ "$(pae session_end 12x)" = "pid: a session's, as the list shows it" ]
check "access: that other process kept" kill -0 "$S3"
kill "$S3" 2>/dev/null
check "access: no ttyd, no terminal" [ "$(PIRATE_TTYD=/nonexistent pirate-access term_status | jsonfilter -e '@.installed')" = false ]
check "access: no ttyd, nothing to turn on" [ "$(PIRATE_TTYD=/nonexistent pirate-access term_set on | jsonfilter -e '@.error')" = "the terminal (ttyd) isn't installed" ]
rm -f /etc/config/ttyd
pa term_set on > "$AC/term.json"
check "access: terminal on" [ "$(jsonfilter -i "$AC/term.json" -e '@.installed' -e '@.enabled' -e '@.port' | tr '\n' ' ')" = "true true 7681 " ]
check "access: terminal: on the LAN, root's password asked" [ "$(uci -q get 'ttyd.@ttyd[0].interface') $(uci -q get 'ttyd.@ttyd[0].command') $(uci -q get 'ttyd.@ttyd[0].enable')" = "@lan /bin/login root 1" ]
check "access: terminal: its own pages only, two at a time, no IPv6" [ "$(uci -q get 'ttyd.@ttyd[0].check_origin') $(uci -q get 'ttyd.@ttyd[0].max_clients') $(uci -q get 'ttyd.@ttyd[0].ipv6') $(uci -q get 'ttyd.@ttyd[0].url_arg')" = "1 2 0 0" ]
check "access: terminal: dark, as the UI is" sh -c "uci -q get 'ttyd.@ttyd[0].client_option' | grep -q 'theme={\"background\":\"#0e1012\"'"
check "access: terminal: started, and at boot" sh -c "grep -qx 'init enable' '$AC/init.log' && grep -qx 'init restart' '$AC/init.log'"
check "access: terminal: set up twice, one section" [ "$(pa term_setup; uci -q show ttyd | grep -c '=ttyd$')" = 1 ]
check "access: terminal off" [ "$(pa term_set off | jsonfilter -e '@.enabled')" = false ]
check "access: terminal off: stopped, and not at boot" sh -c "grep -qx 'init stop' '$AC/init.log' && grep -qx 'init disable' '$AC/init.log' && [ \"\$(uci -q get 'ttyd.@ttyd[0].enable')\" = 0 ]"
rm -f /etc/config/ttyd

echo "# pirate-radio-ui: capture workbench (pirate-capture)"
RC=/usr/libexec/rpcd/pirate.capture
check "capture: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/pirate-capture.json -e '@' -q
check "capture: rpcd plugin offers start and status" sh -c '"'"$RC"'" list | jsonfilter -e "@.start.iface" | grep -qx str && "'"$RC"'" list | jsonfilter -e "@.status" >/dev/null'
check "capture: interfaces is valid JSON" sh -c 'pirate-capture interfaces | jsonfilter -e "@" >/dev/null'
check "capture: idle status" sh -c 'pirate-capture status | jsonfilter -e "@.running" | grep -qx false'
check "capture: list is valid JSON" sh -c 'pirate-capture list | jsonfilter -e "@" >/dev/null'
check "capture: start rejects an unknown interface" sh -c 'pirate-capture start nosuchif0 "" "" | jsonfilter -e "@.error" | grep -q "no such interface"'
check "capture: start rejects a filter with metacharacters" sh -c 'pirate-capture start lo "; reboot" "" | jsonfilter -e "@.error" | grep -q "disallowed"'

echo "# pirate-radio-ui: passive handshake capture (pirate-handshake)"
RH=/usr/libexec/rpcd/pirate.handshake
check "handshake: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/pirate-handshake.json -e '@' -q
check "handshake: rpcd plugin offers start and radios" sh -c '"'"$RH"'" list | jsonfilter -e "@.start.channel" | grep -qx str && "'"$RH"'" list | jsonfilter -e "@.radios" >/dev/null'
check "handshake: radios is valid JSON" sh -c 'pirate-handshake radios | jsonfilter -e "@" >/dev/null'
check "handshake: idle status" sh -c 'pirate-handshake status | jsonfilter -e "@.running" | grep -qx false'
check "handshake: start rejects a non-numeric channel" sh -c 'pirate-handshake start phy0 abc "" | jsonfilter -e "@.error" | grep -q "channel must be a number"'
check "handshake: start rejects a channel out of range" sh -c 'pirate-handshake start phy0 999 "" | jsonfilter -e "@.error" | grep -q "out of range"'
check "handshake: start rejects an unknown radio" sh -c 'pirate-handshake start nosuchphy 6 "" | jsonfilter -e "@.error" | grep -q "no such radio"'

echo "# pirate-radio-ui: firmware flasher (pirate-firmware)"
RF=/usr/libexec/rpcd/pirate.firmware
IMGF="$T/fw.img"
# A mock sysupgrade so no real flash is ever attempted: -T fails only when
# MOCK_SYSUP_FAIL is set, -b writes a dummy backup, apply is a no-op.
FWM="$T/fwmock"; mkdir -p "$FWM"
cat > "$FWM/sysupgrade" <<'EOF'
#!/bin/sh
prev=; bkp=
for a; do [ "$prev" = "-b" ] && bkp=$a; prev=$a; done
if [ -n "$bkp" ]; then echo backup-data > "$bkp"; exit 0; fi
case " $* " in *" -T "*) [ -n "$MOCK_SYSUP_FAIL" ] && exit 1; exit 0 ;; esac
exit 0
EOF
chmod +x "$FWM/sysupgrade"
export PIRATE_FIRMWARE_IMG="$IMGF"
export PIRATE_SYSUPGRADE="$FWM/sysupgrade"
export PIRATE_FIRMWARE_BACKUPS="$T"
rm -f "$IMGF" "$IMGF.ok"
check "firmware: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/pirate-firmware.json -e '@' -q
check "firmware: rpcd plugin offers status, verify, apply, fetch" sh -c '"'"$RF"'" list | jsonfilter -e "@.status" >/dev/null && "'"$RF"'" list | jsonfilter -e "@.verify" >/dev/null && "'"$RF"'" list | jsonfilter -e "@.apply.mode" | grep -qx str && "'"$RF"'" list | jsonfilter -e "@.fetch.url" | grep -qx str'
check "firmware: status with nothing staged" sh -c 'pirate-firmware status | jsonfilter -e "@.staged" | grep -qx false'
check "firmware: verify with no image errors" sh -c 'pirate-firmware verify | jsonfilter -e "@.error" | grep -q "no image staged"'
check "firmware: apply with no image refuses" sh -c 'pirate-firmware apply keep | jsonfilter -e "@.error" | grep -q "no image staged"'
check "firmware: fetch rejects a non-http URL" sh -c 'pirate-firmware fetch ftp://x/y | jsonfilter -e "@.error" | grep -q "http"'
head -c 4096 /dev/zero > "$IMGF"
check "firmware: verify accepts a good image" sh -c 'pirate-firmware verify | jsonfilter -e "@.ok" | grep -qx true'
check "firmware: status shows staged and verified" sh -c 'pirate-firmware status | jsonfilter -e "@.verified" | grep -qx true'
check "firmware: apply reports flashing for a verified image" sh -c 'pirate-firmware apply keep | jsonfilter -e "@.message" | grep -q "flashing now"'
check "firmware: verify rejects a bad image" sh -c 'MOCK_SYSUP_FAIL=1 pirate-firmware verify | jsonfilter -e "@.ok" | grep -qx false'
check "firmware: apply refuses an unverifiable image" sh -c 'MOCK_SYSUP_FAIL=1 pirate-firmware apply keep | jsonfilter -e "@.error" | grep -q "not flashing"'
check "firmware: backup writes an archive and reports its size" sh -c '[ "$(pirate-firmware backup | jsonfilter -e "@.size")" -gt 0 ]'
check "firmware: clear discards the staged image" sh -c 'pirate-firmware clear >/dev/null; pirate-firmware status | jsonfilter -e "@.staged" | grep -qx false'
check "upload CGI: stages the posted body" sh -c 'printf hello | CONTENT_LENGTH=5 sh /www/cgi-bin/pirate-upload | tail -1 | jsonfilter -e "@.ok" | grep -qx true && [ -s "$PIRATE_FIRMWARE_IMG" ]'
check "upload CGI: rejects an empty body" sh -c 'CONTENT_LENGTH=0 sh /www/cgi-bin/pirate-upload </dev/null | tail -1 | jsonfilter -e "@.error" | grep -q "no data"'
check "upload CGI: rejects an oversize body" sh -c 'CONTENT_LENGTH=100 PIRATE_UPLOAD_MAX=10 sh /www/cgi-bin/pirate-upload </dev/null | tail -1 | jsonfilter -e "@.error" | grep -q "too large"'

echo "# pirate-radio-ui: GPS plug and play (pirate-gps)"
[ -f /etc/config/gpsd ] || : > /etc/config/gpsd
uci -q batch <<-'EOF'
	set gpsd.core=gpsd
	delete gpsd.core.devices
	add_list gpsd.core.devices=/dev/ttyACM0
	add_list gpsd.core.devices=/dev/ttyUSB0
	commit gpsd
EOF
GD="$T/gpsdev"; mkdir -p "$GD/dev"
cat > "$T/fake-gpsd" <<-'EOF'
	#!/bin/sh
	echo "$*" >> "$PIRATE_TEST_CALLS"
EOF
chmod +x "$T/fake-gpsd"
gsync() { : > "$T/gsync.log"; env PIRATE_GPSD_INIT="$T/fake-gpsd" PIRATE_DEV_ROOT="$GD" PIRATE_TEST_CALLS="$T/gsync.log" pirate-gps sync "$@" > /dev/null 2>&1; cat "$T/gsync.log"; }
check "gps pnp: no GPS plugged in -> gpsd stopped" [ "$(gsync)" = stop ]
: > "$GD/dev/ttyACM0"
check "gps pnp: GPS plugged in -> gpsd started" [ "$(gsync)" = start ]
check "gps pnp: the device being removed counts as gone" [ "$(gsync /dev/ttyACM0)" = stop ]
check "gps pnp: present reports a plugged-in GPS" env PIRATE_DEV_ROOT="$GD" pirate-gps present
# The tty hotplug hook (hotplug-call sources it; here it runs under sh).
GH=/etc/hotplug.d/tty/20-pirate-gps
ghp() { : > "$T/gsync.log"; env PIRATE_GPS_ACTIVE="$T/gps.active" PIRATE_GPSD_INIT="$T/fake-gpsd" PIRATE_DEV_ROOT="$GD" PIRATE_TEST_CALLS="$T/gsync.log" "$@" sh "$GH" > /dev/null 2>&1; cat "$T/gsync.log"; }
: > "$T/gps.active"
check "gps hotplug: GPS plugged in starts gpsd" [ "$(ghp ACTION=add DEVNAME=ttyACM0)" = start ]
check "gps hotplug: GPS removed stops gpsd" [ "$(ghp ACTION=remove DEVNAME=ttyACM0)" = stop ]
check "gps hotplug: other serial devices are ignored" [ -z "$(ghp ACTION=add DEVNAME=ttyS1)" ]
# A PortaPack on Mayhem firmware: its USB console takes /dev/ttyACM0.
mkusb 1-3 1d50 6018 "" "PortaPack Mayhem"
mkdir -p "$T/sys/bus/usb/devices/1-3/1-3:1.0" "$T/sys/class/tty/ttyACM0"
ln -s "$T/sys/bus/usb/devices/1-3/1-3:1.0" "$T/sys/class/tty/ttyACM0/device"
check "gps pnp: a PortaPack's console is not a GPS" [ "$(gsync)" = stop ]
check "gps hotplug: a PortaPack plugged in leaves gpsd stopped" [ "$(ghp ACTION=add DEVNAME=ttyACM0)" = stop ]
: > "$GD/dev/ttyUSB0"
check "gps pnp: a GPS beside a PortaPack starts gpsd" [ "$(gsync)" = start ]
rm -f "$GD/dev/ttyUSB0"
check "status: notes a PortaPack in Mayhem mode" sh -c 'pirate-radio status | grep -q "^  note: PortaPack (1d50:6018) is in Mayhem mode"'
check "status: a PortaPack in Mayhem mode is not a radio" sh -c '. /usr/share/pirate-radio/lib.sh; ! pirate_usb_radios | grep -q 1d50:6018'
rm -f "$T/gps.active"
check "gps hotplug: nothing while pirate-gps is stopped" [ -z "$(ghp ACTION=add DEVNAME=ttyACM0)" ]

echo "# DreamPi (dreampi; tests/fakemodem plays the modem and the Dreamcast)"
DP="$T/dp"
mkdir -p "$DP/bin" "$DP/run"
# (DP too: the mocks below read their canned replies from it)
export DP DREAMPI_RUN="$DP/run" DP_CALLS="$DP/calls"
# A Conexant USB modem (Dell NW147) on ttyACM1, a u-blox GPS on ttyACM2
mkusb 1-4 0572 1340 "" "USB Modem"
mkusb 1-5 1546 01a7 "" "u-blox 7 - GPS/GNSS Receiver"
for p in 1-4:ttyACM1 1-5:ttyACM2; do
	mkdir -p "$T/sys/bus/usb/devices/${p%:*}/${p%:*}:1.0" "$T/sys/class/tty/${p#*:}"
	ln -s "$T/sys/bus/usb/devices/${p%:*}/${p%:*}:1.0" "$T/sys/class/tty/${p#*:}/device"
done
for m in nft pppd dcnet uclient-fetch init firewall dnsmasq-init; do
	cat > "$DP/bin/$m" <<-'EOF'
		#!/bin/sh
		# A mock: records how it was called (nft: its rules, from stdin)
		m=${0##*/}
		case "$m $1" in
		"init enabled") exit 0 ;;
		"nft -f") cat >> "$DP_CALLS.nft" ;;
		esac
		echo "$m $*" >> "$DP_CALLS"
	EOF
	chmod +x "$DP/bin/$m"
done
dpenv() { env PATH="$DP/bin:$PATH" DREAMPI_INIT="$DP/bin/init" DREAMPI_FIREWALL="$DP/bin/firewall" DREAMPI_DNSMASQ_INIT="$DP/bin/dnsmasq-init" "$@"; }
DPMODEM="/dev/ttyACM1 0572:1340 Conexant USB modem (Dell NW147, Lenovo RD02-D400, TRENDnet TFM-561U)"
check "dreampi: daemon and DCNet client run" sh -c 'dreampi -h 2>&1 | grep -q "usage: dreampi" && dcnet -x 2>&1 | grep -q Usage'
check "dreampi: finds the modem, not the GPS or the PortaPack" [ "$(. /usr/share/dreampi/lib.sh; dreampi_modems)" = "$DPMODEM" ]
uci add_list gpsd.core.devices=/dev/ttyACM1
: > "$GD/dev/ttyACM1"
check "gps pnp: a DreamPi modem is not a GPS" [ "$(gsync)" = stop ]
rm -f "$GD/dev/ttyACM1"
uci revert gpsd

# DreamPi's NAT fixes; the list is someone else's, so lines that aren't
# "<from> <to> [port [tcp|udp]]" never reach nft
printf '%s\n' '# a comment' '172.17.18.2 146.185.135.179 9500' '172.16.0.21 146.185.135.179 9500 udp' \
	'63.251.242.131 146.185.135.179' '1.2.3.4 5.6.7.8 80 tcp; flush ruleset' '1.2.3.4 5.6.7.8 80 icmp' \
	'1.2.3.4 5.6.7.8 99999' '01.2.3.4 5.6.7.8 80' '1.2.3 5.6.7.8 80' '1.2.3.4 $(reboot) 80' > "$DP/run/dnat.txt"
dpenv /usr/libexec/dreampi/nat apply
check "nat: a TCP rule" has "$DP_CALLS.nft" 'iifname "dc0" ip daddr 172.17.18.2 tcp dport 9500 dnat to 146.185.135.179:9500$'
check "nat: a UDP rule" has "$DP_CALLS.nft" 'iifname "dc0" ip daddr 172.16.0.21 udp dport 9500 dnat to 146.185.135.179:9500$'
check "nat: an every-port rule" has "$DP_CALLS.nft" 'iifname "dc0" ip daddr 63.251.242.131 meta l4proto tcp dnat to 146.185.135.179$'
check "nat: malformed lines skipped" [ "$(grep -c ' dnat to ' "$DP_CALLS.nft")" = 3 ]
check "nat: TTL 64 and the PowerSmash SYN fix" sh -c "grep -q 'iifname \"dc0\" ip ttl set 64' '$DP_CALLS.nft' && grep -q 'tcp sport 3200-3205 add @syn_seen' '$DP_CALLS.nft'"
rm -f "$DP/run/dnat.txt" "$DP_CALLS.nft"
dpenv /usr/libexec/dreampi/nat apply
check "nat: the shipped list when none was fetched" [ "$(grep -c ' dnat to ' "$DP_CALLS.nft")" = "$(grep -c '^[0-9]' /usr/share/dreampi/dnat.txt)" ]

# The call script (pppd, the DCNet client and Dreamcast Now mocked)
uci set dreampi.main.dcnow=0
uci commit dreampi
: > "$DP_CALLS"
dpenv DREAMPI_TTY=/dev/ttyACM1 DREAMPI_BAUD=57600 /usr/libexec/dreampi/call ppp 5551234
check "call: pppd as DreamPi runs it" has "$DP_CALLS" "^pppd /dev/ttyACM1 57600 192.168.169.1:192.168.169.2 nodetach auth ms-dns 192.168.169.1 ktune noccp noipv6 ifname dc0$"
dpenv DREAMPI_TTY=/dev/ttyACM1 DREAMPI_BAUD=57600 /usr/libexec/dreampi/call dcnet 5551234
check "call: DCNet on its first port" has "$DP_CALLS" "^dcnet -t /dev/ttyACM1 -b 57600 -p 7654$"
dpenv DREAMPI_TTY=/dev/ttyACM1 DREAMPI_BAUD=57600 /usr/libexec/dreampi/call dcnet 005360010013
check "call: DCNet's second-port numbers" has "$DP_CALLS" "^dcnet -t /dev/ttyACM1 -b 57600 -p 7656$"

# Dreamcast Now: id = sha256 of the MAC address in capitals; the name last
# looked up (appspot excluded), and a shared name only once per call
mkdir -p "$T/sys/class/net/br-lan"
echo 94:83:c4:90:c2:d4 > "$T/sys/class/net/br-lan/address"
: > "$DP_CALLS"
env PATH="$DP/bin:$PATH" DREAMPI_DCNOW_INTERVAL=1 /usr/libexec/dreampi/dcnow report &
dcn=$!
sleep 2
q() { echo "Nov  2 16:39:24 dnsmasq[1]: query[A] $1 from 192.168.169.2" >> "$DP/run/dns.log"; }
q master.quake3arena.com
sleep 2
q dcnow-2016.appspot.com
sleep 2
q gameloft.example.net
sleep 3
kill "$dcn"
wait "$dcn" 2> /dev/null
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
check "dcnow: posts under the MAC's hash" has "$DP_CALLS" "https://dcnow-2016.appspot.com/api/update/$(sha 94:83:C4:90:C2:D4)/"
check "dcnow: an empty update before any lookup" has "$DP_CALLS" "--post-data= "
check "dcnow: the game server's hash" has "$DP_CALLS" "--post-data=dns_query=$(sha master.quake3arena.com) "
check "dcnow: appspot lookups are not reported" sh -c "! grep -q '$(sha dcnow-2016.appspot.com)' '$DP_CALLS'"
check "dcnow: a shared name once" [ "$(grep -c "$(sha gameloft.example.net)" "$DP_CALLS")" = 1 ]

# The name on the list: the site's configure form, over plain HTTP (nc
# mocked as dreamcast.online: the form for a GET; for a POST, the form with
# the name sent, kept unless site-ignore says not (the real site's answer for
# a name another Dreamcast has), or a 403 when told to refuse)
cat > "$DP/bin/nc" <<-'EOF'
	#!/bin/sh
	req=$(cat)
	echo "$req" >> "$DP_CALLS.nc"
	case "$req" in
	GET*) name=$(cat "$DP/site-name") ;;
	POST*)
		[ -e "$DP/site-refuse" ] && { printf 'HTTP/1.0 403 Forbidden\r\n\r\n'; exit 0; }
		name=$(cat "$DP/site-name-next")
		[ -e "$DP/site-ignore" ] || echo "$name" > "$DP/site-name"
		;;
	esac
	printf 'HTTP/1.0 200 OK\r\nContent-Type: text/html\r\nset-cookie: csrftoken=COOKIE123; expires=x; Path=/\r\n\r\n'
	printf '<form method="POST" action="/now/configure/x/">\n<input type="hidden" name="csrfmiddlewaretoken" value="TOKEN456">\n'
	printf '<input type="text" name="username" value="%s" maxlength="500" required id="id_username">\n</form>\n' "$name"
EOF
chmod +x "$DP/bin/nc"
echo Unnamed_2bec1b > "$DP/site-name"
echo "Pirate Radio &amp; Co" > "$DP/site-name-next"
dcn_fails() { ! dpenv /usr/libexec/dreampi/dcnow name "$1" > /dev/null 2>&1; }
check "dcnow: the id is the MAC's hash" [ "$(dpenv /usr/libexec/dreampi/dcnow id)" = "$(sha 94:83:C4:90:C2:D4)" ]
check "dcnow: reads the name it's listed under" [ "$(dpenv /usr/libexec/dreampi/dcnow name)" = Unnamed_2bec1b ]
: > "$DP_CALLS.nc"
check "dcnow: sets a new name" [ "$(dpenv /usr/libexec/dreampi/dcnow name 'Pirate Radio & Co')" = "Pirate Radio & Co" ]
check "dcnow: with the form's cookie and token, the name encoded" sh -c "grep -q '^Cookie: csrftoken=COOKIE123' '$DP_CALLS.nc' && grep -q '^csrfmiddlewaretoken=TOKEN456&username=%50%69%72%61%74%65%20%52%61%64%69%6F%20%26%20%43%6F&email_hash=$' '$DP_CALLS.nc'"
echo "Taken Name" > "$DP/site-name-next"
: > "$DP/site-ignore"
check "dcnow: a name the site shows back but doesn't keep is an error" dcn_fails "Taken Name"
rm -f "$DP/site-ignore"
: > "$DP/site-refuse"
check "dcnow: a refused name is an error" dcn_fails "Pirate Radio"
rm -f "$DP/site-refuse"
echo Unnamed_2bec1b > "$DP/site-name"

# Reporting as a DreamPi: its MAC address, hashed as DreamPi does, or its id
uci set dreampi.main.dcnow_id=B8:27:EB:12:34:56
check "dcnow: as a DreamPi, by its MAC address" [ "$(dpenv /usr/libexec/dreampi/dcnow id)" = "$(sha B8:27:EB:12:34:56)" ]
uci set dreampi.main.dcnow_id="$(sha x)"
check "dcnow: as a DreamPi, by its id" [ "$(dpenv /usr/libexec/dreampi/dcnow id)" = "$(sha x)" ]
uci delete dreampi.main.dcnow_id

# DreamPi's configuration helper on port 1998, for the site's configure page
uci set dreampi.main.dcnow=1
uci commit dreampi
check "dcnow: config reports the id and the setting" [ "$(dpenv /usr/libexec/dreampi/dcnow config)" = "{\"mac_address\": \"$(sha 94:83:C4:90:C2:D4)\", \"is_enabled\": true}" ]
dcnow-config -p 18998 > "$DP/helper.log" 2>&1 &
dch=$!
sleep 1
# (requests piped straight in: $(...) would drop the blank line that ends
# the headers)
hreq() { /bin/busybox nc 127.0.0.1 18998 | tr -d '\r' > "$DP/helper.out"; }
printf 'GET / HTTP/1.0\r\nHost: dreampi.local:1998\r\nOrigin: http://dreamcast.online\r\n\r\n' | hreq
check "helper: a GET gets the id, open to the site" sh -c "grep -qx 'Access-Control-Allow-Origin: \\*' '$DP/helper.out' && grep -q '\"mac_address\": \"$(sha 94:83:C4:90:C2:D4)\"' '$DP/helper.out'"
printf 'OPTIONS / HTTP/1.0\r\nOrigin: http://dreamcast.online\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Private-Network: true\r\n\r\n' | hreq
check "helper: the private-network preflight is allowed" sh -c "head -n 1 '$DP/helper.out' | grep -q ' 204 ' && grep -qx 'Access-Control-Allow-Private-Network: true' '$DP/helper.out'"
printf 'POST /toggle/ HTTP/1.0\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 32\r\n\r\ndisable=Disable+Dreamcast+Now%%21' | hreq
check "helper: the site's Disable button turns reporting off" sh -c "grep -q '\"is_enabled\": false' '$DP/helper.out' && [ \"\$(uci get dreampi.main.dcnow)\" = 0 ]"
printf 'POST /toggle/ HTTP/1.0\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 30\r\n\r\nenable=Enable+Dreamcast+Now%%21' | hreq
check "helper: and Enable on" sh -c "grep -q '\"is_enabled\": true' '$DP/helper.out' && [ \"\$(uci get dreampi.main.dcnow)\" = 1 ]"
kill "$dch"
uci set dreampi.main.dcnow=0
uci commit dreampi

# The init script (procd calls stubbed)
cat > "$DP/init-harness.sh" <<-'EOF'
	. /lib/functions.sh
	procd_open_instance() { printf 'instance %s:' "$1"; }
	procd_set_param() { [ "$1" = command ] && shift && printf ' %s' "$*"; }
	procd_append_param() { [ "$1" = command ] && shift && printf ' %s' "$*"; }
	procd_close_instance() { echo; }
	. /etc/init.d/dreampi
	start_service
	wait
EOF
: > /dev/ttyACM1
dpinit() { dpenv DREAMPI_PAP_SECRETS="$DP/pap-secrets" sh "$DP/init-harness.sh" > "$DP/init.out" 2>&1; }
dpinit
dpinit
check "init: the modem daemon on the modem" has "$DP/init.out" "^instance modem: /usr/sbin/dreampi -t /dev/ttyACM1 -b 57600 -s ppp -c /usr/libexec/dreampi/call -S $DP/run/state$"
check "init: the Dreamcast's DNS server" has "$DP/init.out" "^instance dns: /usr/sbin/dnsmasq -k -C $DP/run/dnsmasq.conf$"
check "init: DNS on the link, through DreamPi's servers" sh -c "grep -qx 'listen-address=192.168.169.1' '$DP/run/dnsmasq.conf' && grep -qx 'server=46.101.91.123' '$DP/run/dnsmasq.conf' && grep -qx 'server=209.50.50.129' '$DP/run/dnsmasq.conf'"
check "init: PAP takes any login, added once" [ "$(grep -c '^\*[[:space:]]\*[[:space:]]""[[:space:]]\*$' "$DP/pap-secrets")" = 1 ]
uci set dreampi.main.dial_tone=0
uci set dreampi.main.service=dcnet
uci commit dreampi
dpinit
check "init: service and dial tone settings" has "$DP/init.out" "^instance modem: .* -s dcnet .* -n$"
uci set dreampi.main.enabled=0
uci commit dreampi
dpinit
check "init: nothing runs when turned off" sh -c "! grep -q instance '$DP/init.out'"
uci set dreampi.main.enabled=1
uci set dreampi.main.dial_tone=1
uci set dreampi.main.service=ppp
uci commit dreampi
dpinit
check "init: the Dreamcast Now helper with the modem" has "$DP/init.out" "^instance config: /usr/sbin/dcnow-config$"

# dreampi.local, where the site's configure page looks, is this router
[ -f /etc/config/network ] || : > /etc/config/network
uci set network.lan=interface
uci set network.lan.ipaddr=10.69.4.20/24
uci commit network
uci -q delete dhcp.dreampi_local
uci commit dhcp
: > "$DP_CALLS"
dpinit
check "init: dreampi.local is this router" sh -c "[ \"\$(uci get dhcp.dreampi_local.name) \$(uci get dhcp.dreampi_local.ip)\" = 'dreampi.local 10.69.4.20' ] && grep -qx 'dnsmasq-init reload' '$DP_CALLS'"
: > "$DP_CALLS"
dpinit
check "init: dnsmasq left alone when that's unchanged" sh -c "! grep -q dnsmasq-init '$DP_CALLS'"

# DMZ: a firewall redirect of everything from the internet to the Dreamcast,
# the firewall reloaded only when that changes
[ -f /etc/config/firewall ] || : > /etc/config/firewall
check "init: no DMZ by default" sh -c "! uci -q get firewall.dreamcast_dmz"
uci set dreampi.main.dmz=1
uci commit dreampi
: > "$DP_CALLS"
dpinit
check "init: DMZ to the Dreamcast" sh -c "[ \"\$(uci get firewall.dreamcast_dmz.dest_ip) \$(uci get firewall.dreamcast_dmz.proto) \$(uci get firewall.dreamcast_dmz.src)\" = '192.168.169.2 all wan' ] && grep -qx 'firewall reload' '$DP_CALLS'"
: > "$DP_CALLS"
dpinit
check "init: the firewall left alone when the DMZ is unchanged" sh -c "! grep -q firewall '$DP_CALLS'"

# The modem pulled out: everything DreamPi runs or set up stops, and comes
# back when it's plugged in again
rm -f /dev/ttyACM1
: > "$DP_CALLS"
dpinit
check "unplugged: nothing runs" sh -c "! grep -q '^instance' '$DP/init.out'"
check "unplugged: no DMZ, no dreampi.local" sh -c "! uci -q get firewall.dreamcast_dmz && ! uci -q get dhcp.dreampi_local && grep -qx 'firewall reload' '$DP_CALLS' && grep -qx 'dnsmasq-init reload' '$DP_CALLS'"
check "unplugged: the packet fixes are cleared" grep -q '^nft delete table ip dreampi' "$DP_CALLS"
: > /dev/ttyACM1
dpinit
check "plugged in again: all back" sh -c "[ \"\$(grep -c '^instance' '$DP/init.out')\" = 3 ] && uci -q get firewall.dreamcast_dmz > /dev/null && uci -q get dhcp.dreampi_local > /dev/null"
uci set dreampi.main.enabled=0
uci commit dreampi
dpinit
check "init: no DMZ when turned off" sh -c "! uci -q get firewall.dreamcast_dmz && ! grep -q '^instance' '$DP/init.out'"
uci set dreampi.main.enabled=1
uci set dreampi.main.dmz=0
uci commit dreampi
rm -f /dev/ttyACM1

# The hotplug hook: a modem plugged in, any serial device gone
dphp() { : > "$DP_CALLS"; dpenv "$@" sh /etc/hotplug.d/tty/30-dreampi > /dev/null 2>&1; cat "$DP_CALLS"; }
check "hotplug: a modem plugged in starts answering" [ "$(dphp ACTION=add DEVNAME=ttyACM1)" = "init reload" ]
check "hotplug: a GPS plugged in is not a modem" [ -z "$(dphp ACTION=add DEVNAME=ttyACM2)" ]
check "hotplug: a serial device removed: check again" [ "$(dphp ACTION=remove DEVNAME=ttyACM1)" = "init reload" ]
check "hotplug: other devices ignored" [ -z "$(dphp ACTION=add DEVNAME=ttyS0)" ]

# The UI backend
RD=/usr/libexec/rpcd/pirate.dreampi
check "ui: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/pirate-dreampi.json -e '@' -q
check "ui: rpcd plugin offers status, log, set" sh -c '"'"$RD"'" list | jsonfilter -e "@.status" >/dev/null && "'"$RD"'" list | jsonfilter -e "@.log" >/dev/null && "'"$RD"'" list | jsonfilter -e "@.set.service" | grep -qx str'
dpenv pirate-dreampi status > "$DP/status.json"
check "ui: status lists the modem" [ "$(jsonfilter -i "$DP/status.json" -e '@.modems[0].id') $(jsonfilter -i "$DP/status.json" -e '@.modems[0].device')" = "0572:1340 /dev/ttyACM1" ]
check "ui: modem plugged in, daemon not running -> starting" [ "$(jsonfilter -i "$DP/status.json" -e '@.state')" = starting ]
check "ui: set rejects an unknown service" sh -c 'pirate-dreampi set "" bogus "" "" | jsonfilter -e "@.error" | grep -q "ppp or dcnet"'
: > "$DP_CALLS"
dpenv pirate-dreampi set 0 dcnet "" 1 > "$DP/status.json"
check "ui: set saves and reloads" sh -c "[ \"\$(uci get dreampi.main.service) \$(uci get dreampi.main.enabled)\" = 'dcnet 0' ] && grep -qx 'init reload' '$DP_CALLS'"
check "ui: turned off -> off" [ "$(jsonfilter -i "$DP/status.json" -e '@.state')" = off ]
dpenv pirate-dreampi set "" "" "" "" 1 > "$DP/status.json"
check "ui: DMZ saved" sh -c "[ \"\$(uci get dreampi.main.dmz)\" = 1 ] && [ \"\$(jsonfilter -i '$DP/status.json' -e '@.dmz')\" = true ]"
check "ui: rpcd plugin takes DMZ" sh -c '"'"$RD"'" list | jsonfilter -e "@.set.dmz" | grep -qx true'
uci set dreampi.main.enabled=1
uci set dreampi.main.service=ppp
uci set dreampi.main.dmz=0
uci commit dreampi
check "ui: log is valid JSON" sh -c 'pirate-dreampi log | jsonfilter -e "@.lines" >/dev/null'
check "ui: rpcd plugin offers the Dreamcast Now name" sh -c '"'"$RD"'" list | jsonfilter -e "@.dcnow_name.name" | grep -qx str && "'"$RD"'" list | jsonfilter -e "@.dcnow" >/dev/null'
check "ui: listed under the site's default name until one is set" [ "$(dpenv pirate-dreampi status | jsonfilter -e '@.dcnow_name')" = "Unnamed_$(sha 94:83:C4:90:C2:D4 | cut -c1-6)" ]
check "ui: a name with a trailing space is refused" sh -c 'pirate-dreampi dcnow_name "Pirate " | jsonfilter -e "@.error" | grep -q "trailing"'
check "ui: a name over 40 characters is refused" sh -c 'pirate-dreampi dcnow_name "$(printf "%041d" 0)" | jsonfilter -e "@.error" | grep -q "40"'
echo "Pirate Radio" > "$DP/site-name-next"
check "ui: sets the name on the site, and keeps it" sh -c "[ \"\$(env PATH='$DP/bin:$PATH' pirate-dreampi dcnow_name 'Pirate Radio' | jsonfilter -e '@.name')\" = 'Pirate Radio' ] && [ \"\$(uci get dreampi.main.dcnow_name)\" = 'Pirate Radio' ]"
check "ui: status shows the name set" [ "$(dpenv pirate-dreampi status | jsonfilter -e '@.dcnow_name')" = "Pirate Radio" ]
echo Someone > "$DP/site-name"
check "ui: the site's own name for this router" [ "$(dpenv pirate-dreampi dcnow | jsonfilter -e '@.name')" = Someone ]
check "ui: a DreamPi identity that isn't a MAC address or id is refused" sh -c 'pirate-dreampi dcnow_id nonsense | jsonfilter -e "@.error" | grep -q "MAC address"'
dpenv pirate-dreampi dcnow_id b8-27-eb-12-34-56 > "$DP/dcnow.json"
check "ui: report as a DreamPi, by its MAC address, under its name" sh -c "[ \"\$(uci get dreampi.main.dcnow_id)\" = B8:27:EB:12:34:56 ] && [ \"\$(jsonfilter -i '$DP/dcnow.json' -e '@.id')\" = '$(sha B8:27:EB:12:34:56)' ] && [ \"\$(env PATH='$DP/bin:$PATH' pirate-dreampi status | jsonfilter -e '@.dcnow_name')\" = Someone ]"
dpenv pirate-dreampi dcnow_id "" > /dev/null
check "ui: and back to this router's own id" sh -c "! uci -q get dreampi.main.dcnow_id && [ \"\$(env PATH='$DP/bin:$PATH' pirate-dreampi status | jsonfilter -e '@.dcnow_id')\" = '$(sha 94:83:C4:90:C2:D4)' ]"
uci -q delete dreampi.main.dcnow_name
uci commit dreampi

# The modem daemon against the fake modem: *69 then a number goes to DCNet,
# a Netlink number is ignored, a plain number to PPP; each call ends with
# "+++" and ATH0, and listening starts over
cat > "$DP/call" <<-'EOF'
	#!/bin/sh
	echo "call $1 $2 $DREAMPI_TTY $DREAMPI_BAUD" >> "$DP_CALLS"
	sleep 1
EOF
chmod +x "$DP/call"
: > "$DP_CALLS"
failed_before=$FAIL
fakemodem -l "$DP/modem" -n "*69,5551234,0,5550000" -c 2 > "$DP/fakemodem.log" 2>&1 &
fm=$!
sleep 1
dreampi -t "$DP/modem" -c "$DP/call" -S "$DP/run/state" -w 1 > "$DP/dreampi.log" 2>&1 &
dpd=$!
i=0
while [ $i -lt 150 ] && [ "$(grep -c '^call' "$DP_CALLS")" -lt 2 ]; do sleep 1; i=$((i + 1)); done
i=0
while [ $i -lt 30 ] && ! grep -q "^state=listening" "$DP/run/state" 2>/dev/null; do sleep 1; i=$((i + 1)); done
check "dreampi: voice mode as DreamPi sets it up" sh -c "grep -q '^cmd AT+FCLASS=8' '$DP/fakemodem.log' && grep -q '^cmd AT+VLS=1' '$DP/fakemodem.log' && grep -q '^cmd AT+VSM=1,8000' '$DP/fakemodem.log' && grep -q '^cmd AT+VTX' '$DP/fakemodem.log'"
check "dreampi: a dial tone with no stray DLE" grep -qE '^tone [1-9][0-9]+ dle 0$' "$DP/fakemodem.log"
check "dreampi: *69 then a number -> DCNet" has "$DP_CALLS" "^call dcnet 5551234 $DP/modem 57600$"
check "dreampi: a Netlink number is ignored" has "$DP/dreampi.log" "heard 0: Netlink"
check "dreampi: a plain number -> PPP" has "$DP_CALLS" "^call ppp 5550000 $DP/modem 57600$"
check "dreampi: after a call, +++ and ATH0" sh -c "[ \"\$(grep -c '^escape' '$DP/fakemodem.log')\" = 2 ]"
check "dreampi: listening again after the calls" grep -q "^state=listening" "$DP/run/state"
kill "$dpd"
wait "$dpd"
check "dreampi: stopped cleanly, state file gone" [ ! -e "$DP/run/state" ]
kill "$fm"
# What the modem and the daemon said, when something above failed
if [ "$FAIL" != "$failed_before" ]; then
	sed 's/^/  dreampi: /' "$DP/dreampi.log"
	tail -n 40 "$DP/fakemodem.log" | sed 's/^/  fakemodem: /'
fi

echo "# the rename from slate-sdr (an upgrade that kept its settings)"
cp /etc/config/pirate-radio "$T/pirate-radio.now"
printf "config storage 'storage'\n\toption mountpoint '/mnt/sdcard'\n\toption dir 'slate-sdr'\n\nconfig job 'ism'\n\toption type 'ism'\n\toption enabled '1'\n" > /etc/config/slate-sdr
for c in fstab uhttpd; do [ -f "/etc/config/$c" ] || : > "/etc/config/$c"; done
uci -q batch <<-'EOF'
	set fstab.slatesdr=mount
	set fstab.slatesdr.target='/mnt/sdcard'
	set fstab.slatesdr.label='SLATESDR'
	set uhttpd.slatesdr=uhttpd
	add_list uhttpd.slatesdr.listen_http='0.0.0.0:8081'
	commit fstab
	commit uhttpd
EOF
sh /etc/uci-defaults/10-pirate-radio-migrate
check "rename: the old settings become pirate-radio's" sh -c '[ ! -e /etc/config/slate-sdr ] && [ "$(uci get pirate-radio.ism.enabled)" = 1 ]'
check "rename: the card folder setting follows" [ "$(uci get pirate-radio.storage.dir)" = pirate-radio ]
check "rename: a card labelled SLATESDR still mounts" sh -c '[ "$(uci get fstab.sdcard_slatesdr.label)" = SLATESDR ] && ! uci -q get fstab.slatesdr'
check "rename: the card's file server keeps its settings" sh -c '[ "$(uci get uhttpd.pirateradio.listen_http)" = 0.0.0.0:8081 ] && ! uci -q get uhttpd.slatesdr'
cp "$T/pirate-radio.now" /etc/config/pirate-radio
uci -q delete fstab.sdcard_slatesdr
uci -q delete uhttpd.pirateradio
uci commit fstab
uci commit uhttpd
# A card written before the rename: its slate-sdr/ folder moves over
mkdir -p "$T/card/slate-sdr/ism"
echo old > "$T/card/slate-sdr/ism/old.json"
uci set pirate-radio.storage.mountpoint="$T/card"
uci commit pirate-radio
echo "/dev/sdb1 $T/card exfat rw 0 0" >> "$PIRATE_PROC/mounts"
sh -c '. /lib/functions.sh; . /usr/share/pirate-radio/lib.sh; config_load pirate-radio; pirate_storage_load'
check "rename: a card's slate-sdr folder becomes pirate-radio" sh -c "[ -f '$T/card/pirate-radio/ism/old.json' ] && [ ! -e '$T/card/slate-sdr' ]"
cp "$T/pirate-radio.now" /etc/config/pirate-radio
card_in

echo "# pirateradio.local: the hostname, and the router's DNS"
[ -f /etc/config/system ] || printf "config system\n\toption hostname 'OpenWrt'\n" > /etc/config/system
uci set system.@system[0].hostname=OpenWrt
uci commit system
sh /etc/uci-defaults/95-pirate-radio-ui > /dev/null 2>&1
check "local: a fresh install is named PirateRadio" [ "$(uci get system.@system[0].hostname)" = PirateRadio ]
uci set system.@system[0].hostname=Galleon
uci commit system
sh /etc/uci-defaults/95-pirate-radio-ui > /dev/null 2>&1
check "local: a name already given is kept" [ "$(uci get system.@system[0].hostname)" = Galleon ]
uci set system.@system[0].hostname=PirateRadio
uci commit system
: > "$DP_CALLS"
lhp() { env PIRATE_DNSMASQ_INIT="$DP/bin/dnsmasq-init" "$@" sh /etc/hotplug.d/iface/30-pirate-local; }
lhp ACTION=ifup INTERFACE=lan
check "local: pirateradio.local on the router's DNS" sh -c "[ \"\$(uci get dhcp.pirate_local.name) \$(uci get dhcp.pirate_local.ip)\" = 'pirateradio.local 10.69.4.20' ] && grep -qx 'dnsmasq-init reload' '$DP_CALLS'"
: > "$DP_CALLS"
lhp ACTION=ifup INTERFACE=lan
lhp ACTION=ifup INTERFACE=wan
check "local: dnsmasq left alone when nothing changed, other interfaces ignored" [ ! -s "$DP_CALLS" ]

echo "# pirate-radio-ui: USB drives plug and play (pirate-usb)"
U="$T/usb"
UM="$U/bin"
mkdir -p "$UM" "$U/blk" "$U/dev" "$U/mnt" "$U/run"
: > "$U/mounts"
export USB_T="$U"
# Mocks: block info (canned per device), mount and umount (a fake
# /proc/mounts), df, logger, the ksmbd and wsdd2 init scripts, ksmbd.adduser,
# and the pirate-usb init script (a reload scans and shares, as its
# start_service does).
cat > "$UM/block" <<-'EOF'
	#!/bin/sh
	[ "$1" = info ] && [ -f "$USB_T/blk/${2#/dev/}" ] && cat "$USB_T/blk/${2#/dev/}"
	exit 0
EOF
cat > "$UM/mount" <<-'EOF'
	#!/bin/sh
	# mount -t <fs> -o <options> <device> <folder>; mount -o bind <folder> <folder>
	echo "mount $*" >> "$USB_T/calls"
	if [ "$1 $2" = "-o bind" ]; then
		l=$(awk -v s="$3" '$2 == s { print $1, $3, $4; exit }' "$PIRATE_MOUNTS")
		[ -n "$l" ] || exit 32
		set -- $l "$4"
		echo "$1 $4 $2 $3 0 0" >> "$PIRATE_MOUNTS"
		exit 0
	fi
	case "$4" in rw,*) [ -e "$USB_T/rofail.${5#/dev/}" ] && exit 32 ;; esac
	echo "$5 $6 $2 $4 0 0" >> "$PIRATE_MOUNTS"
EOF
cat > "$UM/umount" <<-'EOF'
	#!/bin/sh
	echo "umount $*" >> "$USB_T/calls"
	lazy=
	[ "$1" = -l ] && { lazy=1; shift; }
	[ -z "$lazy" ] && [ -e "$USB_T/busy" ] && exit 1
	grep -v " $1 " "$PIRATE_MOUNTS" > "$PIRATE_MOUNTS.new"
	mv "$PIRATE_MOUNTS.new" "$PIRATE_MOUNTS"
EOF
cat > "$UM/df" <<-'EOF'
	#!/bin/sh
	echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
	echo "/dev/x 1000 400 600 40% $2"
EOF
cat > "$UM/logger" <<-'EOF'
	#!/bin/sh
	echo "$*" >> "$USB_T/log"
EOF
cat > "$UM/ksmbd-init" <<-'EOF'
	#!/bin/sh
	n=${0##*/}
	case "$1" in
	running) [ -e "$USB_T/$n.on" ] ;;
	start | restart) echo "$n $1" >> "$USB_T/calls"; : > "$USB_T/$n.on" ;;
	stop) echo "$n $1" >> "$USB_T/calls"; rm -f "$USB_T/$n.on" ;;
	esac
EOF
cp "$UM/ksmbd-init" "$UM/wsdd2-init"
cat > "$UM/adduser" <<-'EOF'
	#!/bin/sh
	# ksmbd.adduser -P <db> -C <conf> [-d] <user>; the password, typed and
	# retyped, on stdin
	echo "adduser $*" >> "$USB_T/calls"
	db= del=
	while [ $# -gt 1 ]; do
		case "$1" in -P) db=$2; shift 2 ;; -C) shift 2 ;; -d) del=1; shift ;; *) shift ;; esac
	done
	if [ -n "$del" ]; then grep -v "^$1:" "$db" > "$db.new"; mv "$db.new" "$db"; exit 0; fi
	read -r a; read -r b
	[ "$a" = "$b" ] || exit 1
	echo "$a" > "$USB_T/pw-got"
	{ grep -v "^$1:" "$db" 2> /dev/null; echo "$1:hash"; } > "$db.new"
	mv "$db.new" "$db"
EOF
cat > "$UM/pirate-usb-init" <<-'EOF'
	#!/bin/sh
	echo "init $*" >> "$USB_T/calls"
	[ "$1" = reload ] && pirate-usb scan && pirate-usb share
	exit 0
EOF
chmod +x "$UM"/*
uenv() {
	env PATH="$UM:$PATH" PIRATE_USB_ROOT="$U/mnt/usb" PIRATE_USB_RUN="$U/run" PIRATE_SYSFS="$U/sys" \
		PIRATE_DEV_ROOT="$U" PIRATE_MOUNTS="$U/mounts" PIRATE_USB_INIT="$UM/pirate-usb-init" \
		PIRATE_KSMBD_INIT="$UM/ksmbd-init" PIRATE_WSDD2_INIT="$UM/wsdd2-init" PIRATE_KSMBD_ADDUSER="$UM/adduser" \
		PIRATE_KSMBD_SHARES="$U/run/config/ksmbd" PIRATE_KSMBD_PWDDB="$U/ksmbdpwd.db" PIRATE_CARD_MP="$U/sdcard" "$@"
}
pu() { uenv pirate-usb "$@"; }
# mkdisk <disk> <usb|mmc> <vendor> <model>; mkpart <disk> <partition> <block info>
mkdisk() {
	local d="$U/sys/devices/platform/ahb/mmc0/block/$1"
	[ "$2" = usb ] && d="$U/sys/devices/platform/ahb/1b000000.usb/usb1/1-1/1-1:1.0/host1/block/$1"
	mkdir -p "$d/device" "$U/sys/class/block" "$U/sys/block"
	printf '%-8s\n' "$3" > "$d/device/vendor"
	printf '%-16s\n' "$4" > "$d/device/model"
	: > "$d/device/delete"
	ln -sfn "$d" "$U/sys/class/block/$1"
	ln -sfn "$d" "$U/sys/block/$1"
	: > "$U/dev/$1"
}
mkpart() {
	local d
	d="$(readlink -f "$U/sys/block/$1")/$2"
	mkdir -p "$d"
	echo "${2#"$1"}" > "$d/partition"
	ln -sfn "$d" "$U/sys/class/block/$2"
	: > "$U/dev/$2"
	echo "/dev/$2: $3" > "$U/blk/$2"
}
# The microSD card (fstab's, by its label) with swap on it; a flash drive; an
# NTFS disk with the flash drive's label; a disk that isn't on USB; a drive
# that only mounts read-only, with a name ksmbd keeps; a disk without
# partitions.
[ -f /etc/config/fstab ] || : > /etc/config/fstab
uci set fstab.pirateradio=mount
uci set fstab.pirateradio.label=PIRATERADIO
uci set fstab.pirateradio.target=/mnt/sdcard
uci commit fstab
mkdisk sda usb Generic "STORAGE DEVICE"
mkpart sda sda1 'UUID="9279-E51D" LABEL="PIRATERADIO" VERSION="1.0" TYPE="exfat"'
mkpart sda sda2 'VERSION="1" TYPE="swap"'
mkdisk sdb usb Kingston "DataTraveler 3.0"
mkpart sdb sdb1 'UUID="1234-ABCD" LABEL="My Stick!" VERSION="FAT32" TYPE="vfat"'
mkdisk sdc usb WD Elements
mkpart sdc sdc1 'UUID="01D9F00DCAFE" LABEL="My Stick" TYPE="ntfs"'
mkdisk sdd mmc Generic Internal
mkpart sdd sdd1 'UUID="b6c2" TYPE="ext4"'
mkdisk sde usb SanDisk Cruzer
mkpart sde sde1 'UUID="AAAA-BBBB" LABEL="GLOBAL" TYPE="exfat"'
: > "$U/rofail.sde1"
mkdisk sdf usb Seagate Expansion
echo '/dev/sdf: UUID="77d1" TYPE="ext4"' > "$U/blk/sdf"
mkdir -p "$U/mnt/usb/stale" "$U/mnt/usb/kept"
: > "$U/mnt/usb/kept/file"
pu scan
check "usb: a flash drive is mounted under its label, for anyone to write" grep -q "^/dev/sdb1 $U/mnt/usb/My_Stick vfat rw,noatime,umask=0000,utf8,shortname=mixed,flush," "$U/mounts"
check "usb: the microSD card (fstab's) is left to block-mount" sh -c "! grep -q '^/dev/sda1 ' '$U/mounts'"
check "usb: swap isn't mounted" sh -c "! grep -q '^/dev/sda2 ' '$U/mounts'"
check "usb: a disk not on USB is left alone" sh -c "! grep -q '^/dev/sdd1 ' '$U/mounts'"
check "usb: NTFS mounts with ntfs3; the same label gets a name of its own" grep -q "^/dev/sdc1 $U/mnt/usb/My_Stick_sdc1 ntfs3 rw,noatime," "$U/mounts"
check "usb: a drive that won't mount for writing mounts read-only; a name ksmbd keeps is changed" grep -q "^/dev/sde1 $U/mnt/usb/GLOBAL_sde1 exfat ro," "$U/mounts"
check "usb: a disk without partitions is mounted under its device's name" grep -q "^/dev/sdf $U/mnt/usb/sdf ext4 rw,noatime " "$U/mounts"
check "usb: a partitioned disk itself isn't mounted" sh -c "! grep -q '^/dev/sdb ' '$U/mounts'"
check "usb: empty folders left behind are cleared, others kept" sh -c "[ ! -e '$U/mnt/usb/stale' ] && [ -f '$U/mnt/usb/kept/file' ]"
check "usb: drives lists the four" [ "$(pu drives | wc -l)" = 4 ]
n=$(wc -l < "$U/mounts")
pu scan
check "usb: scanning again mounts nothing twice" [ "$(wc -l < "$U/mounts")" = "$n" ]
pu status > "$U/status.json"
ujs() { jsonfilter -i "$U/status.json" -e "$1"; }
check "usb status: the drive, its model and space" [ "$(ujs '@.drives[0].name') $(ujs '@.drives[0].fs') $(ujs '@.drives[0].model') $(ujs '@.drives[0].size') $(ujs '@.drives[0].free')" = "My_Stick vfat Kingston DataTraveler 3.0 1024000 614400" ]
check "usb status: the read-only drive says so" [ "$(ujs '@.drives[@.name="GLOBAL_sde1"].readonly') $(ujs '@.drives[0].readonly')" = "true false" ]
check "usb status: not sharing yet, no password" [ "$(ujs '@.installed') $(ujs '@.sharing') $(ujs '@.password') $(ujs '@.user')" = "true false false pirate" ]

: > "$U/calls"
pu share
sleep 1
check "usb share: ksmbd and wsdd2 started" sh -c "grep -qx 'ksmbd-init start' '$U/calls' && grep -qx 'wsdd2-init start' '$U/calls'"
check "usb share: one guest share per drive" sh -c "[ \$(grep -c '^config share' '$U/run/config/ksmbd') = 4 ] && [ \$(grep -c \"guest_ok 'yes'\" '$U/run/config/ksmbd') = 4 ] && grep -q \"path '$U/mnt/usb/My_Stick'\" '$U/run/config/ksmbd'"
check "usb share: the read-only drive is shared read-only" sh -c "grep -A5 \"name 'GLOBAL_sde1'\" '$U/run/config/ksmbd' | grep -q \"read_only 'yes'\""
: > "$U/calls"
pu share
check "usb share: nothing restarts when nothing changed" [ ! -s "$U/calls" ]
check "usb status: sharing" [ "$(pu status | jsonfilter -e '@.sharing')" = true ]

DR="$U/mnt/usb/My_Stick"
mkdir -p "$DR/Photos/2026"
: > "$DR/b.txt"
printf 12345 > "$DR/A.txt"
ln -s /etc "$DR/etc-link"
ln -s Photos "$DR/pics"
pu list My_Stick "" > "$U/list.json"
check "usb list: folders, then files, by name; links out of the drive left out" [ "$(jsonfilter -i "$U/list.json" -e '@.entries[*].name' | tr '\n' ' ')" = "Photos pics A.txt b.txt " ]
check "usb list: a file's size" [ "$(jsonfilter -i "$U/list.json" -e '@.entries[@.name="A.txt"].size')" = 5 ]
check "usb list: a folder on the drive" [ "$(pu list My_Stick Photos | jsonfilter -e '@.path') $(pu list My_Stick Photos | jsonfilter -e '@.entries[0].name')" = "Photos 2026" ]
check "usb list: .. is refused" [ "$(pu list My_Stick 'Photos/../..' | jsonfilter -e '@.error')" = "no such folder" ]
check "usb list: a link out of the drive is refused" [ "$(pu list My_Stick etc-link | jsonfilter -e '@.error')" = "no such folder" ]
check "usb list: only drives mounted here" [ "$(pu list .. | jsonfilter -e '@.error'), $(pu list nothere | jsonfilter -e '@.error')" = "no such drive, no such drive" ]

# The block hotplug hook (hotplug-call sources it; here it runs under sh)
UH=/etc/hotplug.d/block/05-pirate-usb
uhp() { : > "$U/calls"; uenv PIRATE_USB_ACTIVE="$U/active" "$@" sh "$UH" > /dev/null 2>&1; cat "$U/calls"; }
mkdisk sdg usb Lexar JumpDrive
mkpart sdg sdg1 'UUID="C0DE-0001" LABEL="PHOTOS" TYPE="vfat"'
rm -f "$U/active"
check "usb hotplug: nothing while pirate-usb is stopped" [ -z "$(uhp ACTION=add DEVNAME=sdg1)" ]
: > "$U/active"
check "usb hotplug: a disk with partitions plugged in: nothing to mount" [ -z "$(uhp ACTION=add DEVNAME=sdg)" ]
o=$(uhp ACTION=add DEVNAME=sdg1)
check "usb hotplug: its partition is mounted and shared" sh -c "echo '$o' | grep -q '^mount -t vfat .* /dev/sdg1 $U/mnt/usb/PHOTOS$' && echo '$o' | grep -qx 'init reload' && grep -q \"name 'PHOTOS'\" '$U/run/config/ksmbd'"
check "usb hotplug: other block devices are ignored" [ -z "$(uhp ACTION=add DEVNAME=mtdblock3)" ]
# Pulled out: the kernel's devices are gone by the time the hook runs
rm -rf "$U/sys/class/block/sdg1" "$U/sys/class/block/sdg" "$U/dev/sdg1" "$U/dev/sdg"
o=$(uhp ACTION=remove DEVNAME=sdg1)
check "usb hotplug: pulled out, it is detached at once and no longer shared" sh -c "echo '$o' | grep -qx 'umount -l $U/mnt/usb/PHOTOS' && echo '$o' | grep -qx 'init reload' && [ ! -e '$U/mnt/usb/PHOTOS' ] && ! grep -q \"name 'PHOTOS'\" '$U/run/config/ksmbd'"
check "usb hotplug: its disk going away: nothing to unmount, the shares checked again" [ "$(uhp ACTION=remove DEVNAME=sdg)" = "init reload" ]
# block-mount's hook (10-mount) unmounts what is pulled out too: run first,
# and if it got there first all the same, the drive still stops being shared
first=
for f in /etc/hotplug.d/block/*; do
	case "${f##*/}" in 00-*) ;; *) first=${f##*/}; break ;; esac
done
check "usb hotplug: it runs before block-mount's hook" [ "$first" = 05-pirate-usb ]
mkdisk sdg usb Lexar JumpDrive
mkpart sdg sdg1 'UUID="C0DE-0001" LABEL="PHOTOS" TYPE="vfat"'
uhp ACTION=add DEVNAME=sdg1 > /dev/null
check "usb hotplug: plugged in again, shared again" sh -c "grep -q '^/dev/sdg1 $U/mnt/usb/PHOTOS ' '$U/mounts' && grep -q \"name 'PHOTOS'\" '$U/run/config/ksmbd'"
grep -v " $U/mnt/usb/PHOTOS " "$U/mounts" > "$U/mounts.new" && mv "$U/mounts.new" "$U/mounts"
rmdir "$U/mnt/usb/PHOTOS"
rm -rf "$U/sys/class/block/sdg1" "$U/sys/class/block/sdg" "$U/dev/sdg1" "$U/dev/sdg"
o=$(uhp ACTION=remove DEVNAME=sdg1)
check "usb hotplug: pulled out and unmounted by something else first, it is no longer shared" sh -c "echo '$o' | grep -qx 'init reload' && ! echo '$o' | grep -q umount && ! grep -q \"name 'PHOTOS'\" '$U/run/config/ksmbd'"

: > "$U/busy"
pu eject My_Stick > "$U/eject.json"
check "usb eject: a drive in use stays mounted and shared" sh -c "jsonfilter -i '$U/eject.json' -e '@.error' | grep -q 'in use' && grep -q '^/dev/sdb1 ' '$U/mounts' && grep -q \"name 'My_Stick'\" '$U/run/config/ksmbd' && ! grep -qx sdb '$U/run/ejected'"
rm -f "$U/busy"
: > "$U/calls"
pu eject My_Stick > "$U/eject.json"
check "usb eject: unmounted, unshared and powered down" sh -c "[ \"\$(jsonfilter -i '$U/eject.json' -e '@.ok')\" = true ] && ! grep -q '^/dev/sdb1 ' '$U/mounts' && ! grep -q \"name 'My_Stick'\" '$U/run/config/ksmbd' && [ \"\$(cat '$U/sys/block/sdb/device/delete')\" = 1 ] && grep -qx 'init reload' '$U/calls'"
pu scan
check "usb eject: an ejected drive isn't mounted again until plugged in again" sh -c "! grep -q '^/dev/sdb1 ' '$U/mounts'"
pu add sdb1
check "usb eject: plugged in again, it is mounted again" sh -c "grep -q '^/dev/sdb1 $U/mnt/usb/My_Stick ' '$U/mounts' && ! grep -qx sdb '$U/run/ejected'"
pu share
o=$(pu remove sdc1; echo "rc=$?")
check "usb: remove unmounts a drive that was pulled out" sh -c "! grep -q '^/dev/sdc1 ' '$U/mounts' && [ ! -e '$U/mnt/usb/My_Stick_sdc1' ] && echo '$o' | grep -qx rc=0"
check "usb: remove of a drive not mounted here does nothing" sh -c "! env PATH='$UM:$PATH' PIRATE_USB_ROOT='$U/mnt/usb' PIRATE_MOUNTS='$U/mounts' pirate-usb remove sda1"

: > "$U/calls"
check "usb password: too short is refused" [ "$(printf abc | pu set_password | jsonfilter -e '@.error')" = "use at least 5 characters" ]
printf 'S3cret pass' | pu set_password > "$U/pw.json"
check "usb password: set through ksmbd.adduser's stdin, never its command line" sh -c "[ \"\$(cat '$U/pw-got')\" = 'S3cret pass' ] && ! grep -q S3cret '$U/calls'"
check "usb password: the shares want it now" sh -c "[ \"\$(jsonfilter -i '$U/pw.json' -e '@.password')\" = true ] && ! grep -q \"guest_ok 'yes'\" '$U/run/config/ksmbd' && grep -q \"users 'pirate'\" '$U/run/config/ksmbd'"
check "usb password: ksmbd restarted to take it" grep -qx 'ksmbd-init restart' "$U/calls"
: > "$U/calls"
printf 'N3w secret' | pu set_password > /dev/null
check "usb password: a new one restarts ksmbd too" grep -qx 'ksmbd-init restart' "$U/calls"
printf '' | pu set_password > "$U/pw.json"
check "usb password: removed, guests get in again" sh -c "[ \"\$(jsonfilter -i '$U/pw.json' -e '@.password')\" = false ] && grep -q 'adduser .*-d pirate' '$U/calls' && grep -q \"guest_ok 'yes'\" '$U/run/config/ksmbd'"

: > "$U/calls"
pu set 0 > "$U/set.json"
check "usb set: sharing off stops ksmbd and wsdd2" sh -c "[ \"\$(jsonfilter -i '$U/set.json' -e '@.enabled')\" = false ] && grep -qx 'ksmbd-init stop' '$U/calls' && grep -qx 'wsdd2-init stop' '$U/calls' && [ ! -e '$U/run/config/ksmbd' ]"
check "usb set: the drives stay mounted for the web UI" [ "$(pu drives | wc -l)" = 4 ]
check "usb set: rejects anything but on and off" [ "$(pu set maybe | jsonfilter -e '@.error')" = "enabled: true or false" ]
: > "$U/calls"
pu set 1 > /dev/null
check "usb set: sharing on starts ksmbd again" grep -qx 'ksmbd-init start' "$U/calls"

# The microSD card (block-mount's, at a mount point of its own): shared only
# when asked to, from a bind mount at $ROOT/microSD; never ejected
mkdir -p "$U/sdcard"
echo "/dev/sda1 $U/sdcard exfat rw,noatime 0 0" >> "$U/mounts"
pu scan
pu status > "$U/status.json"
check "usb card: not shared unless asked to" sh -c "! grep -q '^/dev/sda1 $U/mnt/usb/' '$U/mounts' && [ ! -e '$U/mnt/usb/microSD' ]"
check "usb card: the status says it is in, not shared" [ "$(ujs '@.card') $(ujs '@.card_in')" = "false true" ]
: > "$U/calls"
pu set '' 1 > "$U/status.json"
check "usb card: asked to, it is shared as microSD" sh -c "grep -qx 'mount -o bind $U/sdcard $U/mnt/usb/microSD' '$U/calls' && grep -q '^/dev/sda1 $U/mnt/usb/microSD exfat ' '$U/mounts' && grep -q \"name 'microSD'\" '$U/run/config/ksmbd'"
check "usb card: the status marks it, and sharing stays on" [ "$(ujs '@.card') $(ujs '@.enabled') $(ujs '@.drives[@.name="microSD"].card') $(ujs '@.drives[@.name="microSD"].model') $(ujs '@.drives[@.name="My_Stick"].card')" = "true true true microSD card false" ]
check "usb card: it can't be ejected" [ "$(pu eject microSD | jsonfilter -e '@.error')" = "the microSD card can't be ejected here: turn off sharing it instead" ]
check "usb card: still shared after that, its reader left on" sh -c "grep -q '^/dev/sda1 $U/mnt/usb/microSD ' '$U/mounts' && [ ! -s '$U/sys/block/sda/device/delete' ]"
pu scan
check "usb card: scanning again shares it once" [ "$(grep -c "^/dev/sda1 $U/mnt/usb/" "$U/mounts")" = 1 ]
check "usb card: set rejects anything but on and off for it" [ "$(pu set '' maybe | jsonfilter -e '@.error')" = "card: true or false" ]
# Taken out: the drives' hook (05) runs before block-mount's, which has yet
# to unmount it from its own mount point
rm -f "$U/sys/class/block/sda1" "$U/dev/sda1"
o=$(uhp ACTION=remove DEVNAME=sda1)
check "usb card: taken out, it is unshared at once" sh -c "echo '$o' | grep -qx 'umount -l $U/mnt/usb/microSD' && echo '$o' | grep -qx 'init reload' && [ ! -e '$U/mnt/usb/microSD' ] && [ ! -e '$U/run/card' ] && ! grep -q \"name 'microSD'\" '$U/run/config/ksmbd'"
grep -v "^/dev/sda1 " "$U/mounts" > "$U/mounts.new" && mv "$U/mounts.new" "$U/mounts"
# Put back in: the drives' hook first (not one of its drives), then
# block-mount mounts it, then the card's hook (20) shares it again
mkpart sda sda1 'UUID="9279-E51D" LABEL="PIRATERADIO" VERSION="1.0" TYPE="exfat"'
check "usb card: put back in, the drives' hook leaves it to block-mount" [ -z "$(uhp ACTION=add DEVNAME=sda1)" ]
echo "/dev/sda1 $U/sdcard exfat rw,noatime 0 0" >> "$U/mounts"
uhc() { : > "$U/calls"; uenv PIRATE_USB_ACTIVE="$U/active" "$@" sh /etc/hotplug.d/block/20-pirate-usb-card > /dev/null 2>&1; cat "$U/calls"; }
o=$(uhc ACTION=add DEVNAME=sda1)
check "usb card: mounted again by block-mount, it is shared again" sh -c "echo '$o' | grep -qx 'init reload' && grep -q '^/dev/sda1 $U/mnt/usb/microSD ' '$U/mounts' && grep -q \"name 'microSD'\" '$U/run/config/ksmbd'"
check "usb card: its hook ignores drives, a card shared already, and removals" [ -z "$(uhc ACTION=add DEVNAME=sdb1)$(uhc ACTION=add DEVNAME=sda1)$(uhc ACTION=remove DEVNAME=sda1)" ]
: > "$U/calls"
pu set '' 0 > "$U/status.json"
check "usb card: turned off, it is unshared" sh -c "! grep -q '^/dev/sda1 $U/mnt/usb/' '$U/mounts' && [ ! -e '$U/mnt/usb/microSD' ] && [ ! -e '$U/run/card' ] && ! grep -q \"name 'microSD'\" '$U/run/config/ksmbd' && grep -q '^/dev/sda1 $U/sdcard ' '$U/mounts'"
check "usb card: turned off, the status says so" [ "$(ujs '@.card') $(ujs '@.card_in') $(ujs '@.drives[@.name="microSD"].name')" = "false true " ]
check "usb card: turned off, putting it in shares nothing" [ -z "$(uhc ACTION=add DEVNAME=sda1)" ]

check "usb rpcd: its methods" sh -c '/usr/libexec/rpcd/pirate.usb list | jsonfilter -e "@.set_password.password" | grep -qx str'
check "usb rpcd: list" [ "$(echo '{"name":"My_Stick","path":"Photos"}' | uenv /usr/libexec/rpcd/pirate.usb call list | jsonfilter -e '@.entries[0].name')" = 2026 ]
check "usb rpcd: the password goes through on stdin" [ "$(echo '{"password":"abc"}' | uenv /usr/libexec/rpcd/pirate.usb call set_password | jsonfilter -e '@.error')" = "use at least 5 characters" ]
echo '{"card":true}' | uenv /usr/libexec/rpcd/pirate.usb call set > "$U/set.json"
check "usb rpcd: set the card alone" sh -c "[ \"\$(jsonfilter -i '$U/set.json' -e '@.card') \$(jsonfilter -i '$U/set.json' -e '@.enabled')\" = 'true true' ] && grep -q '^/dev/sda1 $U/mnt/usb/microSD ' '$U/mounts'"

pu unmount_all
# (My_Stick's folder keeps the files put in it above: here it was never
# really a mount point)
check "usb: unmount_all unmounts every drive" sh -c "[ -z \"\$(env PIRATE_USB_ROOT='$U/mnt/usb' PIRATE_MOUNTS='$U/mounts' pirate-usb drives)\" ] && [ ! -e '$U/mnt/usb/sdf' ] && [ ! -e '$U/mnt/usb/GLOBAL_sde1' ]"
check "usb: unmount_all lets the card go too, from its share only" sh -c "[ ! -e '$U/mnt/usb/microSD' ] && [ ! -e '$U/run/card' ] && grep -q '^/dev/sda1 $U/sdcard ' '$U/mounts'"
check "usb: first boot, without ksmbd installed" sh /etc/uci-defaults/96-pirate-usb

echo "# Flipper Zero (pirate-flipper; tests/fakeflipper plays the Flipper)"
FZ="$T/flipper"
mkdir -p "$FZ"
check "flipper: ACL is valid JSON" sh -c 'jsonfilter -i /usr/share/rpcd/acl.d/pirate-flipper.json -e "@" > /dev/null'
# The tests call it through ubusd, with the real ubus CLI: the one on PATH
# here is the mock for pirate-radio's tests
FZ_UBUS=$(PATH=/usr/sbin:/usr/bin:/sbin:/bin command -v ubus)
check "flipper: ubusd and the ubus CLI are there" sh -c "command -v ubusd > /dev/null && [ -x '$FZ_UBUS' ]"
# A Flipper's CLI takes /dev/ttyACM0, as a GPS would: gpsd keeps off it
mkusb 1-4 0483 5740 "" "Flipper Zero"
mkdir -p "$T/sys/bus/usb/devices/1-4/1-4:1.0"
rm -f "$T/sys/class/tty/ttyACM0/device"
ln -s "$T/sys/bus/usb/devices/1-4/1-4:1.0" "$T/sys/class/tty/ttyACM0/device"
check "gps pnp: a Flipper Zero's CLI is not a GPS" [ "$(gsync)" = stop ]
ubusd -s "$FZ/ubus.sock" > "$FZ/ubusd.log" 2>&1 &
FZ_UBUSD=$!
fakeflipper -l "$FZ/tty" > "$FZ/fake.log" 2>&1 &
FZ_FAKE=$!
i=0
while [ ! -e "$FZ/tty" ] && [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done
pirate-flipper -d "$FZ/tty" -u "$FZ/ubus.sock" > "$FZ/daemon.log" 2>&1 &
FZ_DAEMON=$!
fz() { "$FZ_UBUS" -s "$FZ/ubus.sock" -t 30 call pirate.flipper "$@" 2> /dev/null; }
fzs() { fz status | jsonfilter -e "$1"; }
fze() { fz "$@" | jsonfilter -e '@.error'; }
# Wait (up to 30 s) for the state to be $1
fz_state() {
	i=0
	while [ $i -lt 30 ]; do
		[ "$(fzs '@.state')" = "$1" ] && return 0
		sleep 1
		i=$((i + 1))
	done
	return 1
}
# Read a file into memory: busy, then ready (or an error)
fz_read() {
	i=0
	while [ $i -lt 30 ]; do
		r=$(fz read "{\"path\":\"$1\"}")
		[ "$(echo "$r" | jsonfilter -e '@.busy')" = true ] || break
		sleep 1
		i=$((i + 1))
	done
	echo "$r"
}
# Base64 for 3 * $1 bytes of "A"
fz_b64() {
	s=
	i=0
	while [ $i -lt "$1" ]; do s="${s}QUFB"; i=$((i + 1)); done
	echo "$s"
}
# fz_ok <method> [json]: the call answers {"ok": true}
fz_ok() { [ "$(fz "$@" | jsonfilter -e '@.ok')" = true ]; }
check "flipper: connects and starts an RPC session" fz_state ready
check "flipper: start_rpc_session typed at its CLI" grep -q '^cli start_rpc_session$' "$FZ/fake.log"
check "flipper: status: name, model, firmware" [ "$(fzs '@.name') / $(fzs '@.model') / $(fzs '@.firmware') / $(fzs '@.branch')" = "Pirate / Flipper Zero / 1.3.4 / release" ]
check "flipper: status: battery" [ "$(fzs '@.battery') $(fzs '@.charging')" = "87 charging" ]
check "flipper: status: SD card, protobuf version" [ "$(fzs '@.sd') $(fzs '@.sd_total') $(fzs '@.sd_free') $(fzs '@.protobuf')" = "true 31914983424 30000000000 0.25" ]
fz info > "$FZ/info.json"
check "flipper: info: all of it, dots made underscores" [ "$(jsonfilter -i "$FZ/info.json" -e '@.info.firmware_commit') $(jsonfilter -i "$FZ/info.json" -e '@.info.radio_alive') $(jsonfilter -i "$FZ/info.json" -e '@.power.battery_voltage')" = "a1b2c3d4 true 4.05" ]
check "flipper: list /: its storages" [ "$(fz list '{"path":"/"}' | jsonfilter -e '@.files[*].name' | tr '\n' ' ')" = "int ext " ]
fz list '{"path":"/ext"}' > "$FZ/list.json"
fl() { jsonfilter -i "$FZ/list.json" -e "$1"; }
check "flipper: list /ext" [ "$(fl '@.files[*].name' | tr '\n' ' ')" = "subghz infrared notes.txt many " ]
check "flipper: list: folders, sizes" [ "$(fl '@.files[0].dir') $(fl '@.files[2].dir') $(fl '@.files[2].size') $(fl '@.path')" = "true false 14 /ext" ]
check "flipper: list: a folder over two messages" [ "$(fz list '{"path":"/ext/many"}' | jsonfilter -e '@.files[*].name' | wc -l)" = 10 ]
check "flipper: list: no such folder" [ "$(fze list '{"path":"/ext/nope"}')" = "no such file or folder" ]
check "flipper: paths: whole ones only" [ "$(fze list '{"path":"ext"}')" = "path: give a full path, such as /ext/subghz" ]
check "flipper: paths: no .." [ "$(fze list '{"path":"/ext/../int"}')" = "path: no . or .. parts" ]
check "flipper: paths: no / at the end" [ "$(fze delete '{"path":"/ext/many/"}')" = "path: no / at the end" ]
check "flipper: mkdir" fz_ok mkdir '{"path":"/ext/new"}'
check "flipper: mkdir: there already" [ "$(fze mkdir '{"path":"/ext/new"}')" = "already exists" ]
check "flipper: mkdir, delete, rename: never a whole storage" [ "$(fze mkdir '{"path":"/ext"}')" = "path: not a whole storage, such as /ext" ]
p1=$(fz_b64 200)
p2=$(fz_b64 300)
check "flipper: write: the first piece" [ "$(fz write "{\"path\":\"/ext/new/a.txt\",\"offset\":0,\"data\":\"$p1\",\"more\":true}" | jsonfilter -e '@.received')" = 600 ]
check "flipper: write: a piece out of place" [ "$(fze write "{\"path\":\"/ext/new/a.txt\",\"offset\":10,\"data\":\"$p2\"}")" = "offset: the next piece goes at 600" ]
check "flipper: write: one file at a time" [ "$(fze write '{"path":"/ext/new/b.txt","offset":0,"data":"QUFB"}')" = "a file is being sent to the Flipper already: wait for it to finish" ]
check "flipper: write: the last piece" [ "$(fz write "{\"path\":\"/ext/new/a.txt\",\"offset\":600,\"data\":\"$p2\",\"more\":false}" | jsonfilter -e '@.size')" = 1500 ]
check "flipper: write: 1500 bytes, 512 a message" grep -q '^write /ext/new/a.txt 1500 3$' "$FZ/fake.log"
check "flipper: write: an empty file" [ "$(fz write '{"path":"/ext/new/empty","offset":0,"data":""}' | jsonfilter -e '@.size')" = 0 ]
check "flipper: write: an empty file, one message" grep -q '^write /ext/new/empty 0 1$' "$FZ/fake.log"
check "flipper: write: not base64" [ "$(fze write '{"path":"/ext/new/c","offset":0,"data":"*"}')" = "data: not base64" ]
r=$(fz_read /ext/new/a.txt)
check "flipper: read: into memory" [ "$(echo "$r" | jsonfilter -e '@.ready') $(echo "$r" | jsonfilter -e '@.size')" = "true 1500" ]
r=$(fz read '{"path":"/ext/new/a.txt","offset":1200}')
check "flipper: read: from an offset" [ "$(echo "$r" | jsonfilter -e '@.data') $(echo "$r" | jsonfilter -e '@.more')" = "$(fz_b64 100) false" ]
check "flipper: read: done once the end is read" [ "$(fze read '{"path":"/ext/new/a.txt","offset":0}')" = "read the file first (without an offset)" ]
fz_read /ext/new/a.txt > /dev/null
check "flipper: read: the whole file" [ "$(fz read '{"path":"/ext/new/a.txt","offset":0}' | jsonfilter -e '@.data')" = "$(fz_b64 500)" ]
check "flipper: read: no such file" [ "$(fz_read /ext/new/nope | jsonfilter -e '@.error')" = "no such file or folder" ]
check "flipper: rename" fz_ok rename '{"path":"/ext/new/a.txt","to":"/ext/new/b.txt"}'
check "flipper: renamed" [ "$(fz list '{"path":"/ext/new"}' | jsonfilter -e '@.files[*].name' | tr '\n' ' ')" = "b.txt empty " ]
check "flipper: delete: a folder with files in it" [ "$(fze delete '{"path":"/ext/new"}')" = "the folder isn't empty" ]
check "flipper: delete: and all in it" fz_ok delete '{"path":"/ext/new","recursive":true}'
check "flipper: delete: gone" [ "$(fze list '{"path":"/ext/new"}')" = "no such file or folder" ]
# Pieces like the page's: more than the daemon holds unsent at once (8 KiB),
# which a port that takes it all at once mustn't leave stuck
fz_b64x() { s=QUFB; i=1; while [ $i -lt "$1" ]; do s="$s$s"; i=$((i * 2)); done; echo "$s"; }
p1=$(fz_b64x 8192)
p2=$(fz_b64x 4096)
check "flipper: write: a 24 KiB piece" [ "$(fz write "{\"path\":\"/ext/big.bin\",\"offset\":0,\"data\":\"$p1\",\"more\":true}" | jsonfilter -e '@.received')" = 24576 ]
check "flipper: write: and 12 KiB more" [ "$(fz write "{\"path\":\"/ext/big.bin\",\"offset\":24576,\"data\":\"$p2\",\"more\":false}" | jsonfilter -e '@.size')" = 36864 ]
check "flipper: write: 36 KiB, 72 messages" grep -q '^write /ext/big.bin 36864 72$' "$FZ/fake.log"
r=$(fz_read /ext/big.bin)
check "flipper: read: 36 KiB" [ "$(echo "$r" | jsonfilter -e '@.size')" = 36864 ]
check "flipper: read: 36 KiB, as written" [ "$(fz read '{"path":"/ext/big.bin","offset":0}' | jsonfilter -e '@.data')" = "$p1$p2" ]
fz delete '{"path":"/ext/big.bin"}' > /dev/null
check "flipper: storage" [ "$(fz storage '{"path":"/int"}' | jsonfilter -e '@.total') $(fz storage '{"path":"/int"}' | jsonfilter -e '@.free')" = "262144 131072" ]
r=$(fz screen '{"seq":0}')
s1=$(echo "$r" | jsonfilter -e '@.seq')
f1=$(echo "$r" | jsonfilter -e '@.frame')
check "flipper: screen: streamed, a frame" [ "$s1" -ge 1 ] 2> /dev/null
check "flipper: screen: 1024 bytes, base64" [ "${#f1}" = 1368 ]
check "flipper: screen: the stream asked for" grep -q '^stream on$' "$FZ/fake.log"
check "flipper: screen: its orientation" [ "$(echo "$r" | jsonfilter -e '@.orientation')" = horizontal ]
check "flipper: input: a click" fz_ok input '{"key":"ok","type":"click"}'
check "flipper: input: press, short, release" [ "$(grep '^input ' "$FZ/fake.log" | tr '\n' ' ')" = "input ok press input ok short input ok release " ]
r=$(fz screen "{\"seq\":$s1}")
s2=$(echo "$r" | jsonfilter -e '@.seq')
f2=$(echo "$r" | jsonfilter -e '@.frame')
check "flipper: screen: a new frame, for the click" [ "$s2" -gt "$s1" ] 2> /dev/null
check "flipper: screen: the click shows" [ -n "$f2" -a "$f2" != "$f1" ]
r=$(fz screen "{\"seq\":$s2}")
check "flipper: screen: nothing new: no frame, after a wait" [ "$(echo "$r" | jsonfilter -e '@.seq')/$(echo "$r" | jsonfilter -e '@.frame')" = "$s2/" ]
fz input '{"key":"back","type":"hold"}' > /dev/null
fz input '{"key":"up","type":"press+repeat+release"}' > /dev/null
check "flipper: input: hold, and events one by one" [ "$(grep '^input ' "$FZ/fake.log" | tail -n 6 | tr '\n' ' ')" = "input back press input back long input back release input up press input up repeat input up release " ]
check "flipper: input: a bad key" [ "$(fze input '{"key":"middle"}')" = "key: up, down, left, right, ok or back" ]
check "flipper: input: a bad type" [ "$(fze input '{"key":"ok","type":"tap"}')" = "type: press, release, short, long or repeat (or click, hold)" ]
check "flipper: alert" fz_ok alert
check "flipper: alert: asked for" grep -q '^alert$' "$FZ/fake.log"
check "flipper: time" fz_ok time '{"year":2026,"month":11,"day":4,"hour":7,"minute":30,"second":5,"weekday":3}'
check "flipper: time: set" grep -q '^time 2026-11-04 07:30:05 3$' "$FZ/fake.log"
check "flipper: time: out of range" [ "$(fze time '{"year":2026,"month":13,"day":4,"hour":7,"minute":30,"second":5,"weekday":3}')" = "month: 1 to 12" ]
check "flipper: time: the router's clock, by default" fz_ok time
check "flipper: time: set twice" [ "$(grep -c '^time ' "$FZ/fake.log")" = 2 ]
# The screen stream stops 10 s after the screen was last asked for
sleep 13
check "flipper: screen: the stream stops when no one looks" grep -q '^stream off$' "$FZ/fake.log"
check "flipper: reboot: a bad mode" [ "$(fze reboot '{"mode":"bios"}')" = "mode: os, dfu or update" ]
check "flipper: reboot" fz_ok reboot
check "flipper: reboot: asked for" grep -q '^reboot os$' "$FZ/fake.log"
check "flipper: unplugged (restarting): absent" fz_state absent
check "flipper: unplugged: nothing to list" [ "$(fze list '{"path":"/ext"}')" = "no Flipper is plugged in" ]
check "flipper: the daemon is still running" kill -0 "$FZ_DAEMON"
if [ "$FAIL" != 0 ]; then
	tail -n 30 "$FZ/daemon.log" | sed 's/^/  pirate-flipper: /'
	tail -n 30 "$FZ/fake.log" | sed 's/^/  fakeflipper: /'
	tail -n 10 "$FZ/ubusd.log" | sed 's/^/  ubusd: /'
	"$FZ_UBUS" -s "$FZ/ubus.sock" list 2>&1 | head -n 5 | sed 's/^/  ubus list: /'
fi
kill "$FZ_DAEMON" "$FZ_FAKE" "$FZ_UBUSD" 2> /dev/null

echo "# MeshCore (pirate-meshcore; tests/fakemeshcore plays the radio)"
MC="$T/meshcore"
mkdir -p "$MC"
check "meshcore: ACL is valid JSON" sh -c 'jsonfilter -i /usr/share/rpcd/acl.d/pirate-meshcore.json -e "@" > /dev/null'
# An nRF52 radio on Adafruit's bootloader takes /dev/ttyACM0 too: gpsd keeps off it
mkusb 1-5 239a 8029 "" "NRF52 DK"
mkdir -p "$T/sys/bus/usb/devices/1-5/1-5:1.0"
rm -f "$T/sys/class/tty/ttyACM0/device"
ln -s "$T/sys/bus/usb/devices/1-5/1-5:1.0" "$T/sys/class/tty/ttyACM0/device"
check "gps pnp: a MeshCore radio is not a GPS" [ "$(gsync)" = stop ]
ubusd -s "$MC/ubus.sock" > "$MC/ubusd.log" 2>&1 &
MC_UBUSD=$!
mc() { "$FZ_UBUS" -s "$MC/ubus.sock" -t 30 call pirate.meshcore "$@" 2> /dev/null; }
mcs() { mc status | jsonfilter -e "$1"; }
mce() { mc "$@" | jsonfilter -e '@.error'; }
mc_ok() { [ "$(mc "$@" | jsonfilter -e '@.ok')" = true ]; }
# Wait (up to $3 s, default 30) for a jsonfilter expression on status to be $2
mc_wait() {
	i=0
	while [ $i -lt "${3:-30}" ]; do
		[ "$(mcs "$1")" = "$2" ] && return 0
		sleep 1
		i=$((i + 1))
	done
	return 1
}
mc_tty() {
	i=0
	while [ ! -e "$MC/tty" ] && [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done
}
# A message's field, by its text: "$(mc_msg <conv> <text> <field>)"
mc_msg() { mc messages "{\"conv\":\"$1\"}" | jsonfilter -e "@.messages[@.text='$2'].$3"; }
# First a Bluetooth build, which says nothing over USB
rm -f "$MC/tty"
fakemeshcore -s -l "$MC/tty" > "$MC/silent.log" 2>&1 &
MC_FAKE=$!
mc_tty
pirate-meshcore -d "$MC/tty" -m "$MC/messages" -u "$MC/ubus.sock" -p 1000 -a 1500 > "$MC/daemon.log" 2>&1 &
MC_DAEMON=$!
check "meshcore: a Bluetooth build: no answer, and why" mc_wait '@.error' "no answer from the radio: it needs a MeshCore companion build for USB (the Bluetooth one says nothing over USB)"

# Then a USB build
kill "$MC_FAKE" 2> /dev/null
rm -f "$MC/tty"
fakemeshcore -l "$MC/tty" -c "$MC/ctl" > "$MC/fake.log" 2>&1 &
MC_FAKE=$!
mc_tty
check "meshcore: connects" mc_wait '@.state' ready 40
check "meshcore: its details asked for, its clock set" sh -c "grep -q '^query$' '$MC/fake.log' && grep -q '^start$' '$MC/fake.log' && grep -q '^time [0-9]' '$MC/fake.log'"
mc status > "$MC/status.json"
mj() { jsonfilter -i "$MC/status.json" -e "$1"; }
check "meshcore: status: model, firmware, protocol" [ "$(mj '@.model') / $(mj '@.firmware') / $(mj '@.protocol') / $(mj '@.max_channels')" = "LilyGo T-Echo / v1.18.0 / 9 / 8" ]
check "meshcore: status: its name and key" [ "$(mj '@.name') $(mj '@.key')" = "PirateTest eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ]
check "meshcore: status: its radio" [ "$(mj '@.radio.freq_khz') $(mj '@.radio.bw_hz') $(mj '@.radio.sf') $(mj '@.radio.cr') $(mj '@.radio.tx_power')" = "910525 62500 7 5 22" ]
check "meshcore: status: battery and storage" [ "$(mj '@.battery_mv') $(mj '@.storage_used_kb') $(mj '@.storage_total_kb')" = "4012 128 4096" ]
check "meshcore: status: a GPS, off" [ "$(mj '@.gps.available') $(mj '@.gps.enabled') $(mj '@.gps.live')" = "true false false" ]
check "meshcore: status: not sharing its location" [ "$(mj '@.share_location')" = false ]
mc contacts > "$MC/contacts.json"
cj() { jsonfilter -i "$MC/contacts.json" -e "$1"; }
check "meshcore: contacts" [ "$(cj '@.contacts[*].name' | tr '\n' '|')" = "Alice|Bob|Hilltop Repeater|" ]
check "meshcore: contacts: types" [ "$(cj '@.contacts[*].type' | tr '\n' ' ')" = "chat chat repeater " ]
check "meshcore: contacts: routes" [ "$(cj '@.contacts[0].hops') $(cj '@.contacts[1].flood')" = "2 true" ]
check "meshcore: contacts: keys" [ "$(cj '@.contacts[0].key') $(cj '@.contacts[0].conv')" = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1 ca1a1a1a1a1a1" ]
check "meshcore: contacts: a position" sh -c "[ -n \"\$(jsonfilter -i $MC/contacts.json -e '@.contacts[0].lat')\" ] && [ -z \"\$(jsonfilter -i $MC/contacts.json -e '@.contacts[1].lat')\" ]"
mc channels > "$MC/channels.json"
hj() { jsonfilter -i "$MC/channels.json" -e "$1"; }
check "meshcore: channels: Public and #test" [ "$(hj '@.channels[*].name' | tr '\n' '|')" = "Public|#test|" ]
check "meshcore: channels: their keys" [ "$(hj '@.channels[0].secret') $(hj '@.channels[1].secret')" = "8b3387e9c5cdea6ac9e5edbaa115cd72 9cd8fcf22a47333b591d96a2b848b73f" ]
check "meshcore: channels: the first free slot" [ "$(hj '@.free')" = 2 ]
check "meshcore: messages it kept: fetched" [ "$(mc_msg ca1a1a1a1a1a1 'hello router' from)" = Alice ]
check "meshcore: a contact's: SNR, hops" [ "$(mc_msg ca1a1a1a1a1a1 'hello router' snr | awk '{ print $1 + 0 }') $(mc_msg ca1a1a1a1a1a1 'hello router' hops)" = "10 1" ]
check "meshcore: a channel's: who sent it" [ "$(mc_msg '#0' 'hi all' from) $(mc_msg '#0' 'hi all' snr | awk '{ print $1 + 0 }')" = "Bob -5.5" ]
check "meshcore: unread: two" [ "$(mcs '@.unread')" = 2 ]
check "meshcore: unread: on the contact" [ "$(mc contacts | jsonfilter -e '@.contacts[0].unread')" = 1 ]
check "meshcore: read" mc_ok read '{"conv":"ca1a1a1a1a1a1"}'
check "meshcore: read: one left" [ "$(mcs '@.unread') $(mc channels | jsonfilter -e '@.channels[0].unread')" = "1 1" ]
mc_ok read '{"conv":"#0"}'
check "meshcore: read: none" [ "$(mcs '@.unread')" = 0 ]
S0=$(mcs '@.seq')
# A message to Alice: sent, then delivered (she answers)
check "meshcore: send to a contact" mc_ok send '{"to":"a1a1a1a1a1a1","text":"hi alice"}'
check "meshcore: send: the radio told" grep -qx 'send a1a1a1a1a1a1 0 hi alice' "$MC/fake.log"
sleep 2
check "meshcore: send: delivered" [ "$(mc_msg ca1a1a1a1a1a1 'hi alice' status) $(mc_msg ca1a1a1a1a1a1 'hi alice' trip_ms)" = "delivered 850" ]
check "meshcore: send: by its conv too" mc_ok send '{"to":"cb0b0b0b0b0b0","text":"hi bob"}'
check "meshcore: send: flooded to Bob" [ "$(mc_msg cb0b0b0b0b0b0 'hi bob' flood)" = true ]
check "meshcore: send: Bob doesn't answer: unconfirmed" sh -c "sleep 7; [ \"\$('$FZ_UBUS' -s '$MC/ubus.sock' call pirate.meshcore messages '{\"conv\":\"cb0b0b0b0b0b0\"}' | jsonfilter -e '@.messages[0].status')\" = unconfirmed ]"
I=$(mc_msg cb0b0b0b0b0b0 'hi bob' id)
check "meshcore: resend" mc_ok resend "{\"id\":$I}"
check "meshcore: resend: the next attempt" grep -qx 'send b0b0b0b0b0b0 1 hi bob' "$MC/fake.log"
check "meshcore: resend: on its way, not again" sh -c "[ \"\$('$FZ_UBUS' -s '$MC/ubus.sock' call pirate.meshcore resend '{\"id\":$I}' | jsonfilter -e '@.error')\" = 'it is on its way: wait for it' ]"
check "meshcore: send to a channel" mc_ok send '{"to":"#0","text":"hello mesh"}'
check "meshcore: send to a channel: the radio told" grep -qx 'chan 0 hello mesh' "$MC/fake.log"
sleep 1
check "meshcore: send to a channel: sent, from us" [ "$(mc_msg '#0' 'hello mesh' status) $(mc_msg '#0' 'hello mesh' from)" = "sent PirateTest" ]
check "meshcore: send: no text" [ "$(mce send '{"to":"#0"}')" = "text: the message" ]
check "meshcore: send: no such contact" [ "$(mce send '{"to":"ffffffffffff","text":"x"}')" = "to: no such contact" ]
check "meshcore: send: no such channel" [ "$(mce send '{"to":"#5","text":"x"}')" = "to: no such channel" ]
check "meshcore: send: too long" [ "$(mce send "{\"to\":\"#0\",\"text\":\"$(printf '%0200d' 0)\"}")" = "text: 150 bytes at most" ]
check "meshcore: poll: what changed" [ "$(mc poll "{\"since\":$S0}" | jsonfilter -e '@.messages[*].text' | sort -u | tr '\n' '|')" = "hello mesh|hi alice|hi bob|" ]
# Heard: a message (the radio tells there is one waiting), an advert
S1=$(mcs '@.seq')
echo "msg are you there" > "$MC/ctl"
sleep 2
check "meshcore: a message comes: fetched" sh -c "'$FZ_UBUS' -s '$MC/ubus.sock' call pirate.meshcore poll '{\"since\":$S1}' | jsonfilter -e '@.messages[*].text' | grep -qx 'are you there'"
echo "chan anyone about" > "$MC/ctl"
sleep 2
check "meshcore: a channel's comes" [ "$(mc_msg '#0' 'anyone about' from)" = Bob ]
# Replies, as MeshCore's apps write them ("@[Name] " first): ours to a
# message; theirs to the newest of that name's before it, or (MeshCore
# Open's, with a time) to the one nearest that time
RB=$(mc_msg '#0' 'anyone about' id)
check "meshcore: reply" mc_ok send "{\"to\":\"#0\",\"text\":\"right here\",\"reply\":$RB}"
check "meshcore: reply: the radio told, @[Name] first" grep -qxF 'chan 0 @[Bob] right here' "$MC/fake.log"
sleep 1
check "meshcore: reply: to that message" [ "$(mc_msg '#0' '@[Bob] right here' reply)" = "$RB" ]
check "meshcore: reply: what it answers, with it" [ "$(mc_msg '#0' '@[Bob] right here' reply_from)|$(mc_msg '#0' '@[Bob] right here' reply_text)" = "Bob|anyone about" ]
check "meshcore: reply: to another conversation's" [ "$(mce send "{\"to\":\"#1\",\"text\":\"x\",\"reply\":$RB}")" = "reply: a message in that conversation" ]
check "meshcore: reply: too long, with @[Name]" [ "$(mce send "{\"to\":\"a1a1a1a1a1a1\",\"text\":\"$(printf '%0145d' 0)\",\"reply\":$(mc_msg ca1a1a1a1a1a1 'hello router' id)}")" = "text: too long, with @[Alice] before it" ]
echo "chan @[PirateTest] good to hear" > "$MC/ctl"
sleep 2
check "meshcore: a reply comes: to our newest" [ "$(mc_msg '#0' '@[PirateTest] good to hear' reply)" = "$(mc_msg '#0' '@[Bob] right here' id)" ]
check "meshcore: a reply comes: to ours, it says" [ "$(mc_msg '#0' '@[PirateTest] good to hear' reply_out)" = true ]
KT=$(( $(mc_msg '#0' 'hello mesh' ts) * 1000 + 417 ))
echo "chan @[PirateTest#$KT] still on?" > "$MC/ctl"
sleep 2
check "meshcore: a reply with a time: to the one then" [ "$(mc_msg '#0' "@[PirateTest#$KT] still on?" reply)|$(mc_msg '#0' "@[PirateTest#$KT] still on?" reply_text)" = "$(mc_msg '#0' 'hello mesh' id)|hello mesh" ]
echo "chan @[Nobody] hello?" > "$MC/ctl"
sleep 2
check "meshcore: a mention of no one here: no reply" [ -z "$(mc_msg '#0' '@[Nobody] hello?' reply)" ]
# Reactions, as MeshCore One sends them ("@[Name]emoji", the message's hash
# a line down) and meshcore-open ("r:hash:ii"): the hashes as theirs (their
# own examples), one come and found its message, one sent
check "meshcore: reaction hashes, as MeshCore One's" [ "$(pirate-meshcore -H mc1 1704067200 Hello) $(pirate-meshcore -H mc1 1760000000 'café 👍 ok') $(pirate-meshcore -H mc1 1704067200 '👍')" = "b45pc4ek 8b5qzwf6 z5kxjbn0" ]
check "meshcore: reaction hashes, as meshcore-open's" [ "$(pirate-meshcore -H mco 1700000000 Bob hello) $(pirate-meshcore -H mco 1700000000 - hi) $(pirate-meshcore -H mco 1704067200 A 'abcd😀')" = "e779 b5bd 917f" ]
RT=$(mc_msg '#0' 'anyone about' ts)
RH=$(pirate-meshcore -H mc1 "$RT" 'anyone about')
U1=$(mc channels | jsonfilter -e '@.channels[0].unread')
printf '%s\n' "chan @[Bob]👍\\n$RH" > "$MC/ctl"
MH=$(pirate-meshcore -H mco "$RT" Bob 'anyone about')
printf '%s\n' "chan r:$MH:05" > "$MC/ctl"
sleep 2
check "meshcore: a reaction comes: to its message" [ "$(mc messages '{"conv":"#0"}' | jsonfilter -e "@.messages[@.emoji='👍'].react")" = "$RB" ]
check "meshcore: a reaction comes: not a reply" [ -z "$(mc messages '{"conv":"#0"}' | jsonfilter -e "@.messages[@.emoji='👍'].reply")" ]
check "meshcore: meshcore-open's: its emoji, its message" [ "$(mc_msg '#0' "r:$MH:05" emoji)|$(mc_msg '#0' "r:$MH:05" react)" = "🔥|$RB" ]
check "meshcore: reactions aren't news" [ "$(mc channels | jsonfilter -e '@.channels[0].unread')" = "$U1" ]
TA=$(mc_msg ca1a1a1a1a1a1 'hi alice' ts)
printf '%s\n' "msg ❤️\\n$(pirate-meshcore -H mc1 "$TA" 'hi alice')" > "$MC/ctl"
sleep 2
check "meshcore: a reaction comes, to ours, between two" [ "$(mc messages '{"conv":"ca1a1a1a1a1a1"}' | jsonfilter -e "@.messages[@.emoji='❤️'].react")" = "$(mc_msg ca1a1a1a1a1a1 'hi alice' id)" ]
# Ours go as MeshCore One's, or, to someone whose own come as meshcore-open's
# (Bob's newest did), as that, an emoji its table has (🎉 is its 3rd):
# meshcore-open before 9.5.2 reads no other
check "meshcore: react" mc_ok react "{\"id\":$RB,\"emoji\":\"🎉\"}"
check "meshcore: react: in meshcore-open's form, to one whose come in it" grep -qxF "chan 0 r:$MH:03" "$MC/fake.log"
check "meshcore: react: kept as one, to its message" [ "$(mc messages '{"conv":"#0"}' | jsonfilter -e "@.messages[@.emoji='🎉'].react")" = "$RB" ]
check "meshcore: react: an emoji meshcore-open hasn't: MeshCore One's form, said" [ "$(mc react "{\"id\":$RB,\"emoji\":\"👀\"}" | jsonfilter -e '@.note')" = "👀 isn't one of meshcore-open's emoji: it went in MeshCore One's form, which meshcore-open before 9.5.2 shows as text" ]
sleep 1
check "meshcore: react: as MeshCore One's, on the air" sh -c "grep -qxF 'chan 0 @[Bob]👀' '$MC/fake.log' && grep -qxF '$RH' '$MC/fake.log'"
check "meshcore: react, between two" sh -c "'$FZ_UBUS' -s '$MC/ubus.sock' -t 30 call pirate.meshcore react '{\"id\":$(mc_msg ca1a1a1a1a1a1 'hello router' id),\"emoji\":\"👍\"}' | jsonfilter -e '@.ok' | grep -qx true && grep -qxF 'send a1a1a1a1a1a1 0 👍' '$MC/fake.log'"
check "meshcore: react: one emoji" [ "$(mce react "{\"id\":$RB,\"emoji\":\"ok\"}")" = "emoji: one emoji" ]
# (Between two, only to theirs: meshcore-open looks for a DM's reaction
# only among what it sent, and would show one to ours as its text)
NS=$(grep -c '^send ' "$MC/fake.log")
check "meshcore: react, between two: to theirs only, nothing sent" [ "$(mce react "{\"id\":$(mc_msg ca1a1a1a1a1a1 'hi alice' id),\"emoji\":\"👍\"}")|$(grep -c '^send ' "$MC/fake.log")" = "id: in a DM, one of their messages (meshcore-open can't show a reaction to your own)|$NS" ]
# (Alice's come as meshcore-open's now: ours to her follow)
AR=r:$(pirate-meshcore -H mco "$TA" - 'hi alice'):01
printf '%s\n' "msg $AR" > "$MC/ctl"
sleep 2
check "meshcore: meshcore-open's, between two: to its message" [ "$(mc_msg ca1a1a1a1a1a1 "$AR" emoji)|$(mc_msg ca1a1a1a1a1a1 "$AR" react)" = "❤️|$(mc_msg ca1a1a1a1a1a1 'hi alice' id)" ]
AH=$(pirate-meshcore -H mco "$(mc_msg ca1a1a1a1a1a1 'hello router' ts)" - 'hello router')
check "meshcore: react, between two, in meshcore-open's form" mc_ok react "{\"id\":$(mc_msg ca1a1a1a1a1a1 'hello router' id),\"emoji\":\"🔥\"}"
sleep 1
check "meshcore: react, between two, in meshcore-open's form: on the air" grep -qxF "send a1a1a1a1a1a1 0 r:$AH:05" "$MC/fake.log"
# (Reacting read the channel, as sending does: news again, for what's kept)
printf '%s\n' "chan still there?" > "$MC/ctl"
sleep 2
# Binary channel data, as MCO Advanced sends its images (MCOimg): kept in
# their text form, as a text message would bring them; its other kinds, and
# MeshCore Open's, as MCO Advanced's placeholder; anything else not at all.
# The payloads and their text are MCO Advanced's own test fixtures
check "meshcore: MCOimg's basE91, as its fixtures" [ "$(pirate-meshcore -H b91 137a018d0042be01) $(pirate-meshcore -H b91 b82008065340b26602) $(pirate-meshcore -H b91 1340002163a0e43301)" = 'g/5WjAL`NA CC&tj68MFSB TAYL>iBNGbA' ]
N0=$(mc messages '{"conv":"#0","limit":200}' | jsonfilter -e '@.messages[*].id' | wc -l)
printf '%s\n' "data 0 0120 04446f7261137a018d0042be01" > "$MC/ctl"
printf '%s\n' "data 0 fff0 03457665b82008065340b26602" > "$MC/ctl"
printf '%s\n' "data 0 0120 04446f726114010203" > "$MC/ctl"
printf '%s\n' "data 0 0120 04446f72613100" > "$MC/ctl"
printf '%s\n' "data 0 0100 deadbeef" > "$MC/ctl"
printf '%s\n' "data 0 0130 0102" > "$MC/ctl"
sleep 3
check "meshcore: MCOimg v3 as channel data: its im3: text, its sender" [ "$(mc_msg '#0' 'im3:g/5WjAL`NA' from)|$(mc_msg '#0' 'im3:g/5WjAL`NA' snr | awk '{ print $1 + 0 }')" = "Dora|7.5" ]
check "meshcore: MCOimg v1/v2 as channel data: its im: text" [ "$(mc_msg '#0' 'im:CC&tj68MFSB' from)" = Eve ]
check "meshcore: MCOimg v4 as channel data: its im4: text" [ "$(mc_msg '#0' 'im4:6FYA' from)" = Dora ]
check "meshcore: MCO Advanced's other kinds: its placeholder" [ "$(mc_msg '#0' 'mcoapp-unknown:0x0120:3.1' from)" = Dora ]
check "meshcore: MeshCore Open's: its placeholder" [ -n "$(mc_msg '#0' 'mcoapp-unknown:0x0100' id)" ]
check "meshcore: channel data not for a chat: nothing" [ "$(mc messages '{"conv":"#0","limit":200}' | jsonfilter -e '@.messages[*].id' | wc -l)" = $((N0 + 5)) ]
echo "advert" > "$MC/ctl"
sleep 1
check "meshcore: an advert: a new contact" [ "$(mc contacts | jsonfilter -e '@.contacts[*].name' | tr '\n' '|')" = "Alice|Bob|Hilltop Repeater|Carol|" ]
# A contact's route, a trace along it, a route found, telemetry (as the
# Messenger's profiles ask them): Alice is two hops off, through the
# repeater and one it doesn't know
check "meshcore: a route: its hops, named where known" [ "$(mc contacts | jsonfilter -e "@.contacts[@.name='Alice'].path[*].id" | tr '\n' ' ')|$(mc contacts | jsonfilter -e "@.contacts[@.name='Alice'].path[0].name")" = "c2 77 |Hilltop Repeater" ]
mc trace '{"key":"a1a1a1a1a1a1"}' > "$MC/trace.json"
check "meshcore: trace: there and back" grep -qx 'trace c2 77 c2' "$MC/fake.log"
check "meshcore: trace: each hop" [ "$(jsonfilter -i "$MC/trace.json" -e '@.hops[*].id' | tr '\n' ' ')" = "c2 77 c2 " ]
check "meshcore: trace: hops named where known" [ "$(jsonfilter -i "$MC/trace.json" -e '@.hops[0].name')|$(jsonfilter -i "$MC/trace.json" -e '@.hops[1].name')" = "Hilltop Repeater|" ]
check "meshcore: trace: the SNR each heard at, then ours" [ "$(jsonfilter -i "$MC/trace.json" -e '@.hops[*].snr' -e '@.snr_back' | awk '{ printf "%s ", $1 + 0 }')" = "8 7 6 5.5 " ]
check "meshcore: trace: a repeater, to it and back" sh -c "'$FZ_UBUS' -s '$MC/ubus.sock' -t 30 call pirate.meshcore trace '{\"key\":\"c2c2c2c2c2c2\"}' | jsonfilter -e '@.ok' | grep -qx true && grep -qx 'trace c2' '$MC/fake.log'"
check "meshcore: trace: no route known" [ "$(mce trace '{"key":"b0b0b0b0b0b0"}')" = "no route known to trace: discover one first" ]
mc discover '{"key":"b0b0b0b0b0b0"}' > "$MC/discover.json"
sleep 1
check "meshcore: discover: asked" grep -qx 'discover b0b0b0b0b0b0' "$MC/fake.log"
check "meshcore: discover: the route found, both ways" [ "$(jsonfilter -i "$MC/discover.json" -e '@.out[0].id' -e '@.in[0].id' -e '@.out[0].name' | tr '\n' '|')" = "c2|c2|Hilltop Repeater|" ]
check "meshcore: discover: kept as Bob's" grep -qx 'path b0b0b0b0b0b0 1 c2' "$MC/fake.log"
check "meshcore: discover: Bob has a route now" [ "$(mc contacts | jsonfilter -e "@.contacts[@.name='Bob'].hops")" = 1 ]
mc telemetry '{"key":"a1a1a1a1a1a1"}' > "$MC/telemetry.json"
check "meshcore: telemetry: asked" grep -qx 'telemetry a1a1a1a1a1a1' "$MC/fake.log"
check "meshcore: telemetry: battery, temperature" [ "$(jsonfilter -i "$MC/telemetry.json" -e "@.readings[@.kind='voltage'].value" -e "@.readings[@.kind='temperature'].value" | awk '{ printf "%s ", $1 + 0 }')" = "4.12 21.5 " ]
check "meshcore: telemetry: units" [ "$(jsonfilter -i "$MC/telemetry.json" -e "@.readings[@.kind='voltage'].unit")" = V ]
check "meshcore: telemetry: a position" [ "$(jsonfilter -i "$MC/telemetry.json" -e "@.readings[@.kind='gps'].lat" -e "@.readings[@.kind='gps'].lon" -e "@.readings[@.kind='gps'].alt" | awk '{ printf "%s ", $1 + 0 }')" = "37.422 -122.084 12 " ]
check "meshcore: telemetry: no answer" [ "$(mce telemetry '{"key":"c2c2c2c2c2c2"}')" = "no answer: they may not share telemetry with you, or be out of reach" ]
# Channels: a hashtag one (its key from its name), a private one, one with a key, cleared
check "meshcore: channel: a hashtag one" mc_ok channel_set '{"index":2,"name":"#pirates"}'
check "meshcore: channel: its key, from its name" grep -qx 'channel 2 #pirates 6ea268a7936a8b03d5abda223c429af0' "$MC/fake.log"
check "meshcore: channel: listed" [ "$(mc channels | jsonfilter -e '@.channels[@.index=2].secret')" = 6ea268a7936a8b03d5abda223c429af0 ]
check "meshcore: channel: a private one" mc_ok channel_set '{"index":3,"name":"Crew"}'
check "meshcore: channel: a random key" sh -c "grep '^channel 3 Crew ' '$MC/fake.log' | grep -qv ' 00000000000000000000000000000000\$'"
check "meshcore: channel: one with a key given" mc_ok channel_set '{"index":4,"name":"Team","secret":"00112233445566778899aabbccddeeff"}'
check "meshcore: channel: that key" grep -qx 'channel 4 Team 00112233445566778899aabbccddeeff' "$MC/fake.log"
check "meshcore: channel: a bad key" [ "$(mce channel_set '{"index":4,"name":"Team","secret":"xyz"}')" = "secret: 32 hex digits (16 bytes)" ]
check "meshcore: channel: cleared" mc_ok channel_set '{"index":3,"name":""}'
check "meshcore: channel: cleared on the radio" grep -qx 'channel 3 - 00000000000000000000000000000000' "$MC/fake.log"
sleep 1
check "meshcore: channel: gone from the list" [ "$(mc channels | jsonfilter -e '@.channels[*].name' | tr '\n' '|')" = "Public|#test|#pirates|Team|" ]
check "meshcore: channel: a slot past the radio's" [ "$(mce channel_set '{"index":9,"name":"x"}')" = "index: a channel slot, 0 up" ]
# Its name, adverts
check "meshcore: set its name" mc_ok set_name '{"name":"Pirate Two"}'
check "meshcore: set its name: told" grep -qx 'name Pirate Two' "$MC/fake.log"
check "meshcore: set its name: shown" [ "$(mcs '@.name')" = "Pirate Two" ]
check "meshcore: advert, to its neighbours" mc_ok advert
check "meshcore: advert, flooded" mc_ok advert '{"flood":true}'
check "meshcore: adverts: told" [ "$(grep '^advert ' "$MC/fake.log" | tr '\n' ' ')" = "advert 0 advert 1 " ]
# Its GPS: on, its position moves (a fix), then off
check "meshcore: GPS on" mc_ok gps '{"enabled":true}'
check "meshcore: GPS on: told" grep -qx 'var gps:1' "$MC/fake.log"
check "meshcore: GPS on: a fix, as its position moves" mc_wait '@.gps.live' true 15
mc position > "$MC/pos.json"
check "meshcore: position, for the survey" sh -c "[ \"\$(jsonfilter -i $MC/pos.json -e '@.live') \$(jsonfilter -i $MC/pos.json -e '@.source')\" = 'true LilyGo T-Echo' ] && jsonfilter -i $MC/pos.json -e '@.lat' | grep -q '^37\\.42192'"
check "meshcore: the survey takes it, with no gpsd" [ "$(PIRATE_MESHCORE_POSITION="$MC/pos.json" pirate-survey gps | jsonfilter -e '@.source')" = meshcore ]
check "meshcore: GPS off" mc_ok gps '{"enabled":false}'
check "meshcore: GPS off: no fix" [ "$(mc position | jsonfilter -e '@.enabled' -e '@.live' | tr '\n' ' ')" = "false false " ]
check "meshcore: GPS: true or false" [ "$(mce gps '{}')" = "enabled: true or false" ]
# Contacts: a route forgotten, one removed
check "meshcore: forget a route" mc_ok contact_reset_path '{"key":"b0b0b0b0b0b0"}'
check "meshcore: forget a route: told" grep -qx 'reset b0b0b0b0b0b0' "$MC/fake.log"
check "meshcore: remove a contact" mc_ok contact_remove '{"key":"c2c2c2c2c2c2"}'
check "meshcore: remove a contact: told, gone" sh -c "grep -qx 'remove c2c2c2c2c2c2' '$MC/fake.log' && [ \"\$('$FZ_UBUS' -s '$MC/ubus.sock' call pirate.meshcore contacts | jsonfilter -e '@.contacts[*].name' | tr '\n' '|')\" = 'Alice|Bob|Carol|' ]"
check "meshcore: remove: no such contact" [ "$(mce contact_remove '{"key":"999999999999"}')" = "no such contact" ]
check "meshcore: refresh" mc_ok refresh
# Kept: the messages and what became of them, after a restart
N=$(mc messages '{"conv":"ca1a1a1a1a1a1"}' | jsonfilter -e '@.messages[*].id' | wc -l)
U0=$(mc channels | jsonfilter -e '@.channels[0].unread')
kill "$MC_DAEMON"
sleep 1
pirate-meshcore -d "$MC/tty" -m "$MC/messages" -u "$MC/ubus.sock" -p 1000 -a 1500 > "$MC/daemon2.log" 2>&1 &
MC_DAEMON=$!
check "meshcore: restarted, connects again" mc_wait '@.state' ready 40
check "meshcore: kept: the messages" [ "$(mc messages '{"conv":"ca1a1a1a1a1a1"}' | jsonfilter -e '@.messages[*].id' | wc -l)" = "$N" ]
check "meshcore: kept: delivered stays delivered" [ "$(mc_msg ca1a1a1a1a1a1 'hi alice' status)" = delivered ]
check "meshcore: kept: something unread, to keep" [ "$U0" -gt 0 ]
check "meshcore: kept: what was read" [ "$(mc channels | jsonfilter -e '@.channels[0].unread')" = "$U0" ]
check "meshcore: kept: what a reply answers" [ "$(mc_msg '#0' '@[Bob] right here' reply)" = "$RB" ]
check "meshcore: kept: what a reaction is to" [ "$(mc messages '{"conv":"#0"}' | jsonfilter -e "@.messages[@.emoji='👍'].react")" = "$RB" ]
# Unplugged
kill "$MC_FAKE"
check "meshcore: unplugged: absent" mc_wait '@.state' absent
check "meshcore: unplugged: nothing to send with" [ "$(mce send '{"to":"#0","text":"x"}')" = "no MeshCore radio is plugged in" ]
check "meshcore: the daemon is still running" kill -0 "$MC_DAEMON"
if [ "$FAIL" != 0 ]; then
	tail -n 30 "$MC/daemon.log" "$MC/daemon2.log" 2> /dev/null | sed 's/^/  pirate-meshcore: /'
	tail -n 40 "$MC/fake.log" | sed 's/^/  fakemeshcore: /'
fi
kill "$MC_DAEMON" "$MC_UBUSD" 2> /dev/null

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
