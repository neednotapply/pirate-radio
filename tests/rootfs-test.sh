#!/bin/sh
# shellcheck disable=SC2034,SC2009  # STORE_* are read by the sourced lib.sh
# Runs inside openwrt/rootfs:mips_24kc (under QEMU user mode) with the built
# packages unpacked over it: checks that the binaries run on the router's
# userland, and drives slate-sdr's scripts against mock radios.

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

T=/tmp/slate-test
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
. /usr/share/slate-sdr/lib.sh
check "to_hz 433.92M" [ "$(slate_to_hz 433.92M)" = 433920000 ]
check "to_hz 2.4G" [ "$(slate_to_hz 2.4G)" = 2400000000 ]
check "to_hz 100k" [ "$(slate_to_hz 100k)" = 100000 ]
check "to_hz 1090000000" [ "$(slate_to_hz 1090000000)" = 1090000000 ]
check "to_hz rejects 12abc" sh -c '. /usr/share/slate-sdr/lib.sh; ! slate_to_hz 12abc'
b=$(slate_secs_to_boundary hour)
e=$((3600 - $(date +%s) % 3600))
check "seconds to the next hour ($b)" near "$b" "$e"
b=$(slate_secs_to_boundary day)
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
export SLATE_SYSFS="$T/sys"
check "finds both radios" [ "$(slate_usb_radios | wc -l)" = 2 ]
check "rtlsdr present" slate_radio_present rtlsdr
check "hackrf present" slate_radio_present hackrf
check "HackRF product name" sh -c '. /usr/share/slate-sdr/lib.sh; slate_usb_radios | grep -q "^hackrf 1d50:6089 0000000000000000a06063c8234e925f HackRF One$"'

# A fake /proc/mounts: card in or out.
export SLATE_PROC="$T/proc"
mkdir -p "$SLATE_PROC" /mnt/sdcard
card_out() { echo "rootfs / rootfs rw 0 0" > "$SLATE_PROC/mounts"; }
card_in() { card_out; echo "/dev/sda1 /mnt/sdcard exfat rw,noatime 0 0" >> "$SLATE_PROC/mounts"; }

cp /etc/config/slate-sdr "$T/slate-sdr.default"
card_out
config_load slate-sdr
slate_storage_load
check "no card -> nocard" [ "$(slate_storage_state)" = nocard ]
card_in
check "card in -> ok" [ "$(slate_storage_state)" = ok ]
STORE_MIN_FREE_MB=999999999
check "card full -> full" [ "$(slate_storage_state)" = full ]

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
	for kv; do uci set "slate-sdr.$s.$kv"; done
	uci commit slate-sdr
}
# run_job <section> <seconds>: run the runner, stop it, return its output.
# SIGPIPE is ignored, as procd leaves it for the jobs it starts.
run_job() {
	sh -c 'trap "" PIPE; exec /usr/libexec/slate-sdr-job "$1"' _ "$1" > "$T/$1.out" 2>&1 &
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
DATA=/mnt/sdcard/slate-sdr
TODAY=$(date +%Y-%m-%d)
# Runtime state (/var/run/slate-sdr on the device).
export SLATE_STATE="$T/state"
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
check "survey: its message file is cleaned up" [ ! -e "$SLATE_STATE/survey.sweep-err" ]
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
uci add_list slate-sdr.ism.frequency=868M
uci commit slate-sdr
run_job ism 6
check "ism: rtl_433 arguments" has "$T/calls.log" "rtl_433 -d 0 -M time:iso:utc -M level -M protocol -F json:$DATA/ism/$TODAY/ism-$(date +%Y%m%d).json -F http:0.0.0.0:8433 -f 433.92M -f 868M -H 600"
check "ism: events logged" [ "$(grep -c Mock-Sensor "$DATA/ism/$TODAY/ism-$(date +%Y%m%d).json")" -ge 3 ]

echo "# job: ism without a card, then the card goes in"
: > "$T/calls.log"
card_out
/usr/libexec/slate-sdr-job ism > "$T/ism2.out" 2>&1 &
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
uci set slate-sdr.bogus=job
uci set slate-sdr.bogus.type=nonsense
uci commit slate-sdr
run_job bogus 3
check "unknown type is reported" has "$T/bogus.out" "unknown type 'nonsense'"
set_job iq frequency=abc
run_job iq 3
check "bad frequency is reported" has "$T/iq.out" "set a frequency"

echo "# Wi-Fi spectral sweep (fake debugfs)"
export SLATE_DEBUGFS="$T/dbg"
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
slate_spectral_sweep "$T/spec" "2g 5g" 2> "$T/spec.err"
check "spectral: finds both radios" [ "$(slate_spectral_dirs | wc -l)" = 2 ]
check "spectral: 2.4 GHz samples saved" sh -c "cat $T/spec/2g-*.bin | grep -q FFTDATA"
check "spectral: 5 GHz samples saved" sh -c "cat $T/spec/5g-*.bin | grep -q FFTDATA"
check "spectral: scan disabled afterwards" [ "$(cat "$T/dbg/ieee80211/phy0/ath9k/spectral_scan_ctl")" = disable ]
check "spectral: temporary interface added and removed" sh -c "grep -q 'iw phy phy0 interface add sdrphy0 type managed' $T/calls.log && grep -q 'iw dev sdrphy0 del' $T/calls.log"
rm -f "$T/spec/"*
slate_spectral_sweep "$T/spec" "5g" 2>/dev/null
check "spectral: band filter" sh -c "! ls $T/spec/2g-* >/dev/null 2>&1 && ls $T/spec/5g-* >/dev/null 2>&1"

echo "# init script (procd calls stubbed)"
cp "$T/slate-sdr.default" /etc/config/slate-sdr
cat > "$T/init-harness.sh" <<-'EOF'
	. /lib/functions.sh
	procd_open_instance() { printf 'instance %s:' "$1"; }
	procd_set_param() { [ "$1" = command ] && shift && printf ' %s' "$*"; }
	procd_close_instance() { echo; }
	logger() { shift 2; echo "log: $*"; }
	. /etc/init.d/slate-sdr
	start_service
EOF
SLATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "init: default jobs soapy, adsb, survey" sh -c "grep -c '^instance' $T/init.out | grep -qx 3 && grep -q 'instance soapy: /usr/libexec/slate-sdr-job soapy' $T/init.out && grep -q 'instance adsb:' $T/init.out && grep -q 'instance survey:' $T/init.out"
uci set slate-sdr.ism.enabled=1
uci set slate-sdr.wifi.enabled=1
uci commit slate-sdr
SLATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "init: second job on the RTL-SDR is refused" sh -c "grep -q \"job 'ism' not started: its rtlsdr is taken\" $T/init.out && ! grep -q 'instance ism' $T/init.out"
check "init: wifi job skipped without spectral scan" grep -q "job 'wifi' not started: this firmware has no Wi-Fi spectral scan" "$T/init.out"
sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "init: wifi job starts with spectral scan" grep -q "instance wifi:" "$T/init.out"

echo "# plug and play: jobs run only while their radio is on USB"
cp "$T/slate-sdr.default" /etc/config/slate-sdr
check "pnp: supported radio kinds, others ignored" sh -c '. /usr/share/slate-sdr/lib.sh; [ "$(slate_radio_kind 0bda 2838) $(slate_radio_kind 1d50 6089) x$(slate_radio_kind 148f 5370)" = "rtlsdr hackrf x" ]'
rm -f "$T/state/active"
SLATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "pnp: start marks the service active (for the hotplug hook)" [ -e "$T/state/active" ]
mv "$T/sys/bus/usb/devices/1-2" "$T/hackrf-unplugged"
SLATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "pnp: HackRF job waits while the HackRF is unplugged" sh -c "grep -q \"job 'survey' waits: no hackrf on USB\" $T/init.out && ! grep -q 'instance survey' $T/init.out"
check "pnp: RTL-SDR and SoapySDR jobs still start" sh -c "grep -q 'instance adsb:' $T/init.out && grep -q 'instance soapy:' $T/init.out"
mv "$T/sys/bus/usb/devices/1-1" "$T/rtlsdr-unplugged"
SLATE_DEBUGFS="$T/nodbg" sh "$T/init-harness.sh" > "$T/init.out" 2>&1
check "pnp: no radios, no jobs (SoapySDR server included)" sh -c "! grep -q '^instance' $T/init.out && grep -q \"job 'soapy' waits: no SDR on USB\" $T/init.out"
mock ubus <<-'EOF'
	echo '{"slate-sdr":{"instances":{}}}'
EOF
slate-sdr status > "$T/status-pnp.out" 2>&1
check "pnp: status shows enabled jobs without their radio as waiting" sh -c "grep -q 'adsb .*adsb .*rtlsdr .*waiting' $T/status-pnp.out && grep -q 'soapy .*soapy_server .*- .*waiting' $T/status-pnp.out && grep -q 'ism .*ism .*rtlsdr .*off' $T/status-pnp.out"

# The USB hotplug hook (hotplug-call sources it; here it runs under sh).
HP=/etc/hotplug.d/usb/20-slate-sdr
cat > "$T/fake-init" <<-'EOF'
	#!/bin/sh
	echo "$*" >> "$SLATE_TEST_CALLS"
EOF
chmod +x "$T/fake-init"
hp() { : > "$T/hp.log"; env SLATE_INIT="$T/fake-init" SLATE_TEST_CALLS="$T/hp.log" "$@" sh "$HP" > /dev/null 2>&1; cat "$T/hp.log"; }
: > "$T/state/active"
check "pnp hotplug: RTL-SDR plugged in reloads slate-sdr" [ "$(hp ACTION=add DEVTYPE=usb_device PRODUCT=bda/2838/100)" = reload ]
check "pnp hotplug: HackRF removed reloads slate-sdr" [ "$(hp ACTION=remove DEVTYPE=usb_device PRODUCT=1d50/6089/101 DEVPATH=/devices/gone/1-2)" = reload ]
check "pnp hotplug: other USB devices are ignored" [ -z "$(hp ACTION=add DEVTYPE=usb_device PRODUCT=148f/5370/101)" ]
check "pnp hotplug: interface events are ignored" [ -z "$(hp ACTION=add DEVTYPE=usb_interface PRODUCT=bda/2838/100)" ]
rm -f "$T/state/active"
check "pnp hotplug: nothing until the service has started" [ -z "$(hp ACTION=add DEVTYPE=usb_device PRODUCT=bda/2838/100)" ]
mv "$T/hackrf-unplugged" "$T/sys/bus/usb/devices/1-2"
mv "$T/rtlsdr-unplugged" "$T/sys/bus/usb/devices/1-1"

echo "# command line and status page"
cp "$T/slate-sdr.default" /etc/config/slate-sdr
mock ubus <<-'EOF'
	echo '{"slate-sdr":{"instances":{"soapy":{"running":true},"adsb":{"running":true}}}}'
EOF
slate-sdr status > "$T/status.out" 2>&1
check "status: radios" sh -c "grep -q 'rtlsdr  0bda:2838' $T/status.out && grep -q 'hackrf  1d50:6089' $T/status.out"
check "status: card" grep -q "mounted, .* MiB free, data in /mnt/sdcard/slate-sdr" "$T/status.out"
check "status: running job" grep -q "adsb .*adsb .*rtlsdr .*running" "$T/status.out"
check "status: stopped job" grep -q "survey .*sweep .*hackrf .*stopped" "$T/status.out"
check "status: disabled job" grep -q "ism .*ism .*rtlsdr .*off" "$T/status.out"
slate-sdr record hackrf 433.92M 2M 1 > "$T/record.out" 2>&1
check "record: writes a SigMF pair" sh -c "ls $DATA/recordings/$TODAY/iq-hackrf-433920000Hz-2000000sps-*.sigmf-data >/dev/null 2>&1 && ls $DATA/recordings/$TODAY/iq-hackrf-433920000Hz-2000000sps-*.sigmf-meta >/dev/null 2>&1"
check "record: hackrf_transfer sample count" grep -q -- "-n 2000000" "$T/calls.log"
check "record: rejects a bad radio" sh -c "! slate-sdr record airspy 100M 2M 1 2>/dev/null"
card_out
check "record: refuses without a card" sh -c "slate-sdr record hackrf 100M 2M 1 2>&1 | grep -q 'missing or full'"
card_in
HTTP_HOST='x"><script>alert(1)</script>' /www/cgi-bin/slate-sdr > "$T/cgi.out" 2>&1
check "cgi: hostile Host header is not echoed" sh -c "! grep -q '<script>' $T/cgi.out && grep -q 'http://192.168.1.1:8080/' $T/cgi.out"
HTTP_HOST="$(printf 'evil<b>\n10.0.0.5')" /www/cgi-bin/slate-sdr > "$T/cgi.out" 2>&1
check "cgi: multi-line Host header is not echoed" sh -c "! grep -q 'evil' $T/cgi.out"
HTTP_HOST='[fd00::1]:80' /www/cgi-bin/slate-sdr > "$T/cgi.out" 2>&1
check "cgi: IPv6 host" grep -q 'http://\[fd00::1\]:8080/' "$T/cgi.out"
HTTP_HOST='10.0.0.5:80' /www/cgi-bin/slate-sdr > "$T/cgi.out" 2>&1
check "cgi: links use the browser's host" grep -q 'remote=tcp://10.0.0.5:55132' "$T/cgi.out"
check "cgi: status is HTML-escaped" grep -q 'Jobs:' "$T/cgi.out"

echo "# SDR backend (slate-ui, was luci-app-slate-sdr)"
cp "$T/slate-sdr.default" /etc/config/slate-sdr
P=/usr/libexec/rpcd/luci.slate-sdr
check "sdr: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/luci-app-slate-sdr.json -e '@' -q
check "luci: plugin offers use and devices" [ "$("$P" list | jsonfilter -e '@.use.job') $("$P" list | jsonfilter -t '@.devices')" = "str object" ]

# use_job <name>: the rpcd call, with the init script's reload stubbed
use_job() { echo "{\"job\":\"$1\"}" | SLATE_INIT=true "$P" call use > "$T/use.out"; }
use_field() { jsonfilter -i "$T/use.out" -e "@.$1"; }
use_job ism
check "luci use: hands the RTL-SDR to ism, stopping adsb" [ "$(use_field switched) $(use_field 'stopped[0]')" = "true adsb" ]
check "luci use: config switched, HackRF job untouched" [ "$(uci get slate-sdr.ism.enabled)$(uci get slate-sdr.adsb.enabled)$(uci get slate-sdr.survey.enabled)" = 101 ]
use_job ism
check "luci use: nothing changes when the job holds the radio" [ "$(use_field switched)" = false ]
use_job 'x; reboot'
check "luci use: rejects a bad job name" [ "$(use_field error)" = "invalid job name" ]
use_job nosuch
check "luci use: rejects an unknown job" [ "$(use_field error)" = "no job 'nosuch' in /etc/config/slate-sdr" ]
cp "$T/slate-sdr.default" /etc/config/slate-sdr

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
SLATE_ISM_DIR="$I" /usr/libexec/luci-slate-sdr-devices > "$T/devices.out" 2>&1
dev() { jsonfilter -i "$T/devices.out" -e "@.$1"; }
check "luci devices: one row per device, broken lines skipped" [ "$(dev decoded) $(dev 'devices[*].model' | xargs)" = "3 Acurite-Tower Schrader" ]
check "luci devices: merged across days, latest readings" [ "$(dev 'devices[0].count') $(dev 'devices[0].readings.humidity') $(dev 'devices[0].first')" = "2 47 2026-10-23T22:00:00Z" ]
check "luci devices: the ISM job's bands" [ "$(dev 'frequencies[0]') $(dev hop_interval)" = "433.92M 600" ]

echo "# network recon (slate-ui, was luci-app-slate-recon)"
RP=/usr/libexec/rpcd/luci.slate-recon
check "recon: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/luci-app-slate-recon.json -e '@' -q
check "recon: plugin offers uplink, discover, hosts, ports" sh -c '"'"$RP"'" list | jsonfilter -e "@.ports.target" | grep -qx str && "'"$RP"'" list | jsonfilter -e "@.uplink" >/dev/null'
# A valid target with no nmap present still yields valid JSON and no ports.
slate-recon ports 203.0.113.1 > "$T/ports.out" 2>&1
check "recon: port scan output is valid JSON" jsonfilter -i "$T/ports.out" -e '@.target' -q
check "recon: port scan target echoed" [ "$(jsonfilter -i "$T/ports.out" -e '@.target')" = 203.0.113.1 ]
check "recon: rejects a shell-injection target" sh -c 'slate-recon ports "x; reboot" | jsonfilter -e "@.error" | grep -q "give one host"'
check "recon: rejects an empty target" sh -c 'slate-recon ports "" | jsonfilter -e "@.error" >/dev/null'
check "recon: hosts with no scan is valid JSON" sh -c 'SLATE_RECON_STORE=/nonexistent slate-recon hosts | jsonfilter -e "@.hosts" >/dev/null'
check "recon: unknown command fails" sh -c '! slate-recon wat 2>/dev/null'

echo "# Wi-Fi survey (slate-survey-merge database)"
M=/usr/libexec/slate-survey-merge
SV="$T/survey"
rm -rf "$SV"
check "recon: plugin offers the survey methods" sh -c '"'"$RP"'" list | jsonfilter -e "@.survey_scan" >/dev/null && "'"$RP"'" list | jsonfilter -e "@.survey_clear" >/dev/null'
# First scan: two access points, one hidden.
printf '%s\n%s\n' \
	'{"bssid":"aa:bb:cc:dd:ee:ff","ssid":"Home","freq":2412,"channel":1,"signal":-60,"security":"WPA2"}' \
	'{"bssid":"11:22:33:44:55:66","ssid":"","freq":5180,"channel":36,"signal":-70,"security":"WPA3"}' |
	SLATE_SURVEY_STORE="$SV" SLATE_SURVEY_TIME=2026-10-24T12:00:00Z SLATE_SURVEY_PHY=phy1 "$M" scan > "$T/sv1.out"
check "survey: first scan saved both" sh -c '[ "$(jsonfilter -i '"$T"'/sv1.out -e "@.found") $(jsonfilter -i '"$T"'/sv1.out -e "@.total") $(jsonfilter -i '"$T"'/sv1.out -e "@.saved")" = "2 2 true" ]'
check "survey: no GPS -> null position" sh -c '[ "$(jsonfilter -i '"$T"'/sv1.out -e "@.gps")" = "" ]'
# Second scan: Home again, stronger, plus a broken line that must be skipped.
printf '%s\n%s\n%s\n' \
	'{"bssid":"aa:bb:cc:dd:ee:ff","ssid":"Home","freq":2412,"channel":1,"signal":-45,"security":"WPA2"}' \
	'not json' \
	'{"bssid":"99:99:99:99:99:99","ssid":"Cafe","freq":2437,"channel":6,"signal":-80,"security":"Open"}' |
	SLATE_SURVEY_STORE="$SV" SLATE_SURVEY_TIME=2026-10-24T12:05:00Z SLATE_SURVEY_PHY=phy1 "$M" scan > "$T/sv2.out"
check "survey: broken line skipped, new AP added" sh -c '[ "$(jsonfilter -i '"$T"'/sv2.out -e "@.found") $(jsonfilter -i '"$T"'/sv2.out -e "@.total")" = "2 3" ]'
SLATE_SURVEY_STORE="$SV" "$M" networks > "$T/svn.out"
check "survey: three networks logged, newest first" sh -c '[ "$(jsonfilter -i '"$T"'/svn.out -e "@.total") $(jsonfilter -i '"$T"'/svn.out -e "@.networks[0].bssid")" = "3 aa:bb:cc:dd:ee:ff" ]'
check "survey: Home merged (count 2, strongest -45, first kept)" sh -c '[ "$(jsonfilter -i '"$T"'/svn.out -e "@.networks[0].count") $(jsonfilter -i '"$T"'/svn.out -e "@.networks[0].best_signal") $(jsonfilter -i '"$T"'/svn.out -e "@.networks[0].first")" = "2 -45 2026-10-24T12:00:00Z" ]'
check "survey: wardrive log has a line per sighting" sh -c '[ "$(wc -l < "$(ls '"$SV"'/survey-*.ndjson)")" = 4 ]'
check "survey: clear empties the database" sh -c 'SLATE_SURVEY_STORE="'"$SV"'" "'"$M"'" clear >/dev/null; [ "$(SLATE_SURVEY_STORE="'"$SV"'" "'"$M"'" networks | jsonfilter -e "@.total")" = 0 ]'
check "survey: unknown command fails" sh -c '! "'"$M"'" wat 2>/dev/null'

echo "# Wi-Fi survey GPS (slate-survey gps, gpspipe mocked)"
GM="$T/gpsmock"; mkdir -p "$GM"
# gpspipe is not installed in the test image, so a plain call reports that.
check "gps: reports not installed when gpspipe is missing" sh -c '[ "$(slate-survey gps | jsonfilter -e "@.installed")" = false ]'
# gpsd not reachable: gpspipe prints nothing.
printf '#!/bin/sh\nexit 0\n' > "$GM/gpspipe"; chmod +x "$GM/gpspipe"
check "gps: gpsd down -> running false" sh -c "[ \"\$(PATH=$GM:\$PATH slate-survey gps | jsonfilter -e '@.running')\" = false ]"
# gpsd up, no fix: VERSION/DEVICES/WATCH only.
printf '#!/bin/sh\nprintf "%%s\\n" %s %s %s\n' \
	"'{\"class\":\"VERSION\"}'" "'{\"class\":\"DEVICES\",\"devices\":[]}'" "'{\"class\":\"WATCH\"}'" > "$GM/gpspipe"
chmod +x "$GM/gpspipe"
check "gps: running, no fix" sh -c "[ \"\$(PATH=$GM:\$PATH slate-survey gps | jsonfilter -e '@.running') \$(PATH=$GM:\$PATH slate-survey gps | jsonfilter -e '@.fix')\" = 'true none' ]"
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
PATH="$GM:$PATH" slate-survey gps > "$T/gps.out"
check "gps: 3D fix with device and satellites" sh -c "[ \"\$(jsonfilter -i $T/gps.out -e '@.fix') \$(jsonfilter -i $T/gps.out -e '@.device') \$(jsonfilter -i $T/gps.out -e '@.sats_used')\" = '3D /dev/ttyACM0 7' ]"
check "gps: 3D fix reports the position" sh -c "[ \"\$(jsonfilter -i $T/gps.out -e '@.lat') \$(jsonfilter -i $T/gps.out -e '@.lon')\" = '37.421998 -122.084000' ]"
# A scan sighting with a GPS position tags the network.
printf '%s\n' '{"bssid":"de:ad:be:ef:00:01","ssid":"Mobile","freq":2412,"channel":1,"signal":-55,"security":"WPA2"}' |
	SLATE_SURVEY_STORE="$T/gpssurv" SLATE_SURVEY_TIME=2026-10-24T13:00:00Z SLATE_SURVEY_LAT=37.42 SLATE_SURVEY_LON=-122.08 "$M" scan > "$T/gpsm.out"
check "gps: a located sighting tags the network" sh -c "[ \"\$(jsonfilter -i $T/gpsm.out -e '@.gps.lat') \$(jsonfilter -i $T/gpsm.out -e '@.networks[0].lat')\" = '37.420 37.420' ]"

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
printf '%s\n' MyNet | SLATE_SURVEY_STORE="$TR" SLATE_SURVEY_TIME=2026-10-24T18:00:00Z "$M" threats > "$TR/out.json"
check "threats: evil-twin and impersonation both flagged" sh -c "[ \"\$(jsonfilter -i $TR/out.json -e '@.threats[*].type' | sort | tr '\n' ' ')\" = 'evil_twin impersonation ' ]"
check "threats: the flagged SSIDs are HomeNet and MyNet" sh -c "[ \"\$(jsonfilter -i $TR/out.json -e '@.threats[*].ssid' | sort | tr '\n' ' ')\" = 'HomeNet MyNet ' ]"
check "threats: a legitimate open network is not flagged" sh -c "! jsonfilter -i $TR/out.json -e '@.threats[*].ssid' | grep -qx Cafe"
check "threats: reports the protected SSID" sh -c "[ \"\$(jsonfilter -i $TR/out.json -e '@.protected[0]')\" = MyNet ]"
# Deauth parser: sample tcpdump -e frames on stdin (no monitor radio needed).
printf '%s\n' 'a SA:de:ad:be:ef:00:01 DeAuthentication x' 'a SA:de:ad:be:ef:00:01 DeAuthentication x' 'a SA:ca:fe:00:00:00:02 Disassociation x' |
	slate-threats deauth-report 15 6 mon0 > "$TR/d.json"
check "threats: deauth parser counts frames by type" sh -c "[ \"\$(jsonfilter -i $TR/d.json -e '@.total') \$(jsonfilter -i $TR/d.json -e '@.deauth') \$(jsonfilter -i $TR/d.json -e '@.disassoc')\" = '3 2 1' ]"
check "threats: deauth parser aggregates the top source" sh -c "[ \"\$(jsonfilter -i $TR/d.json -e '@.sources[0].mac') \$(jsonfilter -i $TR/d.json -e '@.sources[0].count')\" = 'de:ad:be:ef:00:01 2' ]"
check "threats: a deauth flood raises the alert" sh -c 'for i in $(seq 12); do echo "x SA:ba:ad:00:00:00:0f DeAuthentication y"; done | slate-threats deauth-report 20 6 mon0 | jsonfilter -e "@.alert" | grep -qx true'
check "threats: quiet air does not alert" sh -c 'printf "" | slate-threats deauth-report 15 6 mon0 | jsonfilter -e "@.alert" | grep -qx false'
check "threats: deauth rejects a bad window" sh -c 'slate-threats deauth abc | jsonfilter -e "@.error" >/dev/null'

echo "# recon dashboard (slate-dashboard)"
slate-dashboard > "$T/dash.json" 2>/dev/null
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
PATH="$DM:$PATH" slate-dashboard > "$T/dash2.json" 2>/dev/null
check "dashboard: radios take the Mode, not the HT Mode" sh -c "[ \"\$(jsonfilter -i $T/dash2.json -e '@.radios[*].mode' | tr '\n' ' ')\" = 'Monitor Master ' ]"
check "dashboard: radios keep the SSID and channel" sh -c "[ \"\$(jsonfilter -i $T/dash2.json -e '@.radios[1].ssid') \$(jsonfilter -i $T/dash2.json -e '@.radios[0].channel')\" = 'Pirate Radio 10' ]"

echo "# recon scan profiles (slate-recon scan, nmap mocked)"
check "scan: valid JSON without nmap" sh -c 'slate-recon scan quick 203.0.113.1 | jsonfilter -e "@.profile" -q'
check "scan: rejects a shell-injection target" sh -c 'slate-recon scan quick "x; reboot" | jsonfilter -e "@.error" | grep -q "give a host"'
check "scan: rejects an unknown profile" sh -c 'slate-recon scan bogus 203.0.113.1 | jsonfilter -e "@.error" | grep -q "unknown profile"'
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
PATH="$NM:$PATH" slate-recon scan quick 192.168.1.10 > "$T/scanq.out"
check "scan: parses hosts and ports" sh -c "[ \"\$(jsonfilter -i $T/scanq.out -e '@.hosts[0].ip') \$(jsonfilter -i $T/scanq.out -e '@.hosts[0].ports[*].service' | tr '\n' ' ')\" = '192.168.1.10 ssh http ' ]"
check "scan: service profile removed (nmap -sV OOMs on 128 MB)" sh -c 'slate-recon scan service 192.168.1.10 | jsonfilter -e "@.error" | grep -q "unknown profile"'
PATH="$NM:$PATH" slate-recon scan ping 192.168.1.0/24 > "$T/scanp.out"
check "scan: ping sweep lists hosts up" sh -c "[ \"\$(jsonfilter -i $T/scanp.out -e '@.hosts[*].ip' | tr '\n' ' ')\" = '192.168.1.10 192.168.1.23 ' ]"
RS="$T/reconstore"; mkdir -p "$RS"
PATH="$NM:$PATH" SLATE_RECON_STORE="$RS" slate-recon scan quick 192.168.1.10 >/dev/null
check "scan: saves a readable copy and a JSON log" sh -c "ls '$RS'/scan-quick-*.txt >/dev/null 2>&1 && [ -s '$RS/scans.ndjson' ]"

echo "# slate-ui: router basics (slate-router)"
RR=/usr/libexec/rpcd/luci.slate-router
check "router: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/luci-app-slate-router.json -e '@' -q
check "router: rpcd plugin offers status, clients, adblock" sh -c '"'"$RR"'" list | jsonfilter -e "@.status" >/dev/null && "'"$RR"'" list | jsonfilter -e "@.clients" >/dev/null && "'"$RR"'" list | jsonfilter -e "@.adblock" >/dev/null'
check "router: status has a positive memory total" sh -c '[ "$(slate-router status | jsonfilter -e "@.memory.total")" -gt 0 ]'
check "router: status online is a boolean" sh -c 'slate-router status | jsonfilter -e "@.online" | grep -qxE "true|false"'
printf '%s\n' '1700000000 b8:27:eb:aa:bb:cc 192.168.1.10 raspberrypi *' '1700000000 3c:22:fb:12:34:56 192.168.1.23 * *' > "$T/leases"
SLATE_LEASES="$T/leases" slate-router clients > "$T/clients.out"
check "router: clients parsed from the leases (unknown host -> -)" sh -c "[ \"\$(jsonfilter -i $T/clients.out -e '@.clients[0].host') \$(jsonfilter -i $T/clients.out -e '@.clients[0].ip') \$(jsonfilter -i $T/clients.out -e '@.clients[1].host')\" = 'raspberrypi 192.168.1.10 -' ]"
check "router: no leases file -> empty list" sh -c "[ \"\$(SLATE_LEASES=/nonexistent slate-router clients | jsonfilter -e '@.clients[*].ip' | wc -l)\" = 0 ]"
check "router: adblock reports installed false when absent" sh -c 'slate-router adblock | jsonfilter -e "@.installed" | grep -qx false'
check "router: unknown command yields an error" sh -c 'slate-router wat | jsonfilter -e "@.error" >/dev/null'
check "router: rpcd offers set_password, wifi_status/scan/join" sh -c '"'"$RR"'" list | jsonfilter -e "@.set_password.password" | grep -qx str && "'"$RR"'" list | jsonfilter -e "@.wifi_join.ssid" | grep -qx str'
check "router: wifi_status is valid JSON" sh -c 'slate-router wifi_status | jsonfilter -e "@" >/dev/null'
check "router: wifi_scan is valid JSON" sh -c 'slate-router wifi_scan | jsonfilter -e "@" >/dev/null'
check "router: wifi_join rejects a missing SSID" sh -c 'slate-router wifi_join "" psk2 </dev/null | jsonfilter -e "@.error" | grep -q "no SSID"'
check "router: wifi_join needs a password for a secured network" sh -c 'echo "" | slate-router wifi_join MyNet psk2 | jsonfilter -e "@.error" | grep -q "needs a password"'
check "router: set_password rejects an empty password" sh -c 'echo "" | slate-router set_password | jsonfilter -e "@.error" | grep -q "empty"'
check "router: set_password rejects a short password" sh -c 'printf abc | slate-router set_password | jsonfilter -e "@.error" | grep -q "at least 5"'

echo "# slate-ui: capture workbench (slate-capture)"
RC=/usr/libexec/rpcd/luci.slate-capture
check "capture: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/luci-app-slate-capture.json -e '@' -q
check "capture: rpcd plugin offers start and status" sh -c '"'"$RC"'" list | jsonfilter -e "@.start.iface" | grep -qx str && "'"$RC"'" list | jsonfilter -e "@.status" >/dev/null'
check "capture: interfaces is valid JSON" sh -c 'slate-capture interfaces | jsonfilter -e "@" >/dev/null'
check "capture: idle status" sh -c 'slate-capture status | jsonfilter -e "@.running" | grep -qx false'
check "capture: list is valid JSON" sh -c 'slate-capture list | jsonfilter -e "@" >/dev/null'
check "capture: start rejects an unknown interface" sh -c 'slate-capture start nosuchif0 "" "" | jsonfilter -e "@.error" | grep -q "no such interface"'
check "capture: start rejects a filter with metacharacters" sh -c 'slate-capture start lo "; reboot" "" | jsonfilter -e "@.error" | grep -q "disallowed"'

echo "# slate-ui: passive handshake capture (slate-handshake)"
RH=/usr/libexec/rpcd/luci.slate-handshake
check "handshake: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/luci-app-slate-handshake.json -e '@' -q
check "handshake: rpcd plugin offers start and radios" sh -c '"'"$RH"'" list | jsonfilter -e "@.start.channel" | grep -qx str && "'"$RH"'" list | jsonfilter -e "@.radios" >/dev/null'
check "handshake: radios is valid JSON" sh -c 'slate-handshake radios | jsonfilter -e "@" >/dev/null'
check "handshake: idle status" sh -c 'slate-handshake status | jsonfilter -e "@.running" | grep -qx false'
check "handshake: start rejects a non-numeric channel" sh -c 'slate-handshake start phy0 abc "" | jsonfilter -e "@.error" | grep -q "channel must be a number"'
check "handshake: start rejects a channel out of range" sh -c 'slate-handshake start phy0 999 "" | jsonfilter -e "@.error" | grep -q "out of range"'
check "handshake: start rejects an unknown radio" sh -c 'slate-handshake start nosuchphy 6 "" | jsonfilter -e "@.error" | grep -q "no such radio"'

echo "# slate-ui: firmware flasher (slate-firmware)"
RF=/usr/libexec/rpcd/luci.slate-firmware
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
export SLATE_FIRMWARE_IMG="$IMGF"
export SLATE_SYSUPGRADE="$FWM/sysupgrade"
export SLATE_FIRMWARE_BACKUPS="$T"
rm -f "$IMGF" "$IMGF.ok"
check "firmware: ACL is valid JSON" jsonfilter -i /usr/share/rpcd/acl.d/luci-app-slate-firmware.json -e '@' -q
check "firmware: rpcd plugin offers status, verify, apply, fetch" sh -c '"'"$RF"'" list | jsonfilter -e "@.status" >/dev/null && "'"$RF"'" list | jsonfilter -e "@.verify" >/dev/null && "'"$RF"'" list | jsonfilter -e "@.apply.mode" | grep -qx str && "'"$RF"'" list | jsonfilter -e "@.fetch.url" | grep -qx str'
check "firmware: status with nothing staged" sh -c 'slate-firmware status | jsonfilter -e "@.staged" | grep -qx false'
check "firmware: verify with no image errors" sh -c 'slate-firmware verify | jsonfilter -e "@.error" | grep -q "no image staged"'
check "firmware: apply with no image refuses" sh -c 'slate-firmware apply keep | jsonfilter -e "@.error" | grep -q "no image staged"'
check "firmware: fetch rejects a non-http URL" sh -c 'slate-firmware fetch ftp://x/y | jsonfilter -e "@.error" | grep -q "http"'
head -c 4096 /dev/zero > "$IMGF"
check "firmware: verify accepts a good image" sh -c 'slate-firmware verify | jsonfilter -e "@.ok" | grep -qx true'
check "firmware: status shows staged and verified" sh -c 'slate-firmware status | jsonfilter -e "@.verified" | grep -qx true'
check "firmware: apply reports flashing for a verified image" sh -c 'slate-firmware apply keep | jsonfilter -e "@.message" | grep -q "flashing now"'
check "firmware: verify rejects a bad image" sh -c 'MOCK_SYSUP_FAIL=1 slate-firmware verify | jsonfilter -e "@.ok" | grep -qx false'
check "firmware: apply refuses an unverifiable image" sh -c 'MOCK_SYSUP_FAIL=1 slate-firmware apply keep | jsonfilter -e "@.error" | grep -q "not flashing"'
check "firmware: backup writes an archive and reports its size" sh -c '[ "$(slate-firmware backup | jsonfilter -e "@.size")" -gt 0 ]'
check "firmware: clear discards the staged image" sh -c 'slate-firmware clear >/dev/null; slate-firmware status | jsonfilter -e "@.staged" | grep -qx false'
check "upload CGI: stages the posted body" sh -c 'printf hello | CONTENT_LENGTH=5 sh /www/cgi-bin/slate-upload | tail -1 | jsonfilter -e "@.ok" | grep -qx true && [ -s "$SLATE_FIRMWARE_IMG" ]'
check "upload CGI: rejects an empty body" sh -c 'CONTENT_LENGTH=0 sh /www/cgi-bin/slate-upload </dev/null | tail -1 | jsonfilter -e "@.error" | grep -q "no data"'
check "upload CGI: rejects an oversize body" sh -c 'CONTENT_LENGTH=100 SLATE_UPLOAD_MAX=10 sh /www/cgi-bin/slate-upload </dev/null | tail -1 | jsonfilter -e "@.error" | grep -q "too large"'

echo "# slate-ui: GPS plug and play (slate-gps)"
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
	echo "$*" >> "$SLATE_TEST_CALLS"
EOF
chmod +x "$T/fake-gpsd"
gsync() { : > "$T/gsync.log"; env SLATE_GPSD_INIT="$T/fake-gpsd" SLATE_DEV_ROOT="$GD" SLATE_TEST_CALLS="$T/gsync.log" slate-gps sync "$@" > /dev/null 2>&1; cat "$T/gsync.log"; }
check "gps pnp: no GPS plugged in -> gpsd stopped" [ "$(gsync)" = stop ]
: > "$GD/dev/ttyACM0"
check "gps pnp: GPS plugged in -> gpsd started" [ "$(gsync)" = start ]
check "gps pnp: the device being removed counts as gone" [ "$(gsync /dev/ttyACM0)" = stop ]
check "gps pnp: present reports a plugged-in GPS" env SLATE_DEV_ROOT="$GD" slate-gps present
# The tty hotplug hook (hotplug-call sources it; here it runs under sh).
GH=/etc/hotplug.d/tty/20-slate-gps
ghp() { : > "$T/gsync.log"; env SLATE_GPS_ACTIVE="$T/gps.active" SLATE_GPSD_INIT="$T/fake-gpsd" SLATE_DEV_ROOT="$GD" SLATE_TEST_CALLS="$T/gsync.log" "$@" sh "$GH" > /dev/null 2>&1; cat "$T/gsync.log"; }
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
check "status: notes a PortaPack in Mayhem mode" sh -c 'slate-sdr status | grep -q "^  note: PortaPack (1d50:6018) is in Mayhem mode"'
check "status: a PortaPack in Mayhem mode is not a radio" sh -c '. /usr/share/slate-sdr/lib.sh; ! slate_usb_radios | grep -q 1d50:6018'
rm -f "$T/gps.active"
check "gps hotplug: nothing while slate-gps is stopped" [ -z "$(ghp ACTION=add DEVNAME=ttyACM0)" ]

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
