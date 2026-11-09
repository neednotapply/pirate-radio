#!/bin/sh
# pirate-radio job runner: runs the job section named $1 of /etc/config/pirate-radio.
# procd starts one runner per enabled job and restarts it if it exits.

. /lib/functions.sh
. /usr/share/pirate-radio/lib.sh

JOB="$1"
CHILD=
WATCH=
MAP=

log() { echo "$JOB: $*" >&2; }

stop_children() {
	[ -n "$WATCH" ] && kill "$WATCH" 2>/dev/null
	[ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null
	[ -n "$MAP" ] && kill "$MAP" 2>/dev/null
	wait
	rm -f "$PIRATE_STATE/$JOB".sweep-*
}
trap 'stop_children; exit 0' TERM INT

# nap <seconds>: a sleep that a stop request interrupts
nap() {
	sleep "$1" &
	WATCH=$!
	wait "$WATCH"
	WATCH=
}

# A configuration the runner cannot use: say so, and do not respawn often.
config_error() {
	log "$*"
	nap 3600
	exit 1
}

# Block until a radio of this kind is on USB.
wait_radio() {
	local said=
	while ! pirate_radio_present "$1"; do
		[ -n "$said" ] || log "waiting for a $1 on USB"
		said=1
		nap 5
	done
}

# Block until the card is mounted and has room, then set OUTDIR.
wait_storage() {
	local state said=
	while state=$(pirate_storage_state) && [ "$state" != ok ]; do
		if [ "$said" != "$state" ]; then
			case "$state" in
			nocard) log "waiting for the microSD card at $STORE_MOUNT" ;;
			full) log "microSD card has less than $STORE_MIN_FREE_MB MiB free; waiting" ;;
			esac
		fi
		said=$state
		nap 30
	done
	OUTDIR="$STORE_ROOT/$JOB"
	mkdir -p "$OUTDIR" || config_error "cannot create $OUTDIR"
}

# Like wait_storage, but returns 1 at once when the card is not usable.
have_storage() {
	OUTDIR=
	[ "$(pirate_storage_state)" = ok ] || return 1
	OUTDIR="$STORE_ROOT/$JOB"
	mkdir -p "$OUTDIR"
}

# Today's directory under OUTDIR.
day_dir() {
	local d
	d="$OUTDIR/$(date +%Y-%m-%d)"
	mkdir -p "$d" && echo "$d"
}

# segment_stamp <hour|day|seconds>: the time part of a rotated file's name
segment_stamp() {
	case "$1" in
	day) date +%Y%m%d ;;
	hour) date +%Y%m%d-%H00 ;;
	*) date +%Y%m%dT%H%M%S ;;
	esac
}

compress() {
	[ -f "$1" ] && nice gzip -f "$1" &
}

# sleep_rest <start> <interval>: sleep out the rest of an interval
sleep_rest() {
	local left=$(($2 - ($(date +%s) - $1)))
	[ "$left" -gt 0 ] && nap "$left"
	return 0
}

# watchdog <seconds> <pid>: stop <pid> after <seconds>, or sooner when the
# card becomes unusable (removed, full) or usable again, so the next
# segment writes to the right place. Exits 2 when it stopped <pid>.
watchdog() {
	local left="$1" step was now
	# 2>/dev/null: run_for stops the watchdog as soon as the receiver exits,
	# maybe mid-check; the check's output then meets a closed pipe and, with
	# SIGPIPE ignored as under procd, the shell would log a write error.
	was=$(pirate_storage_state 2>/dev/null)
	while [ "$left" -gt 0 ]; do
		step=$((left < 30 ? left : 30))
		sleep "$step"
		left=$((left - step))
		kill -0 "$2" 2>/dev/null || exit 0
		now=$(pirate_storage_state 2>/dev/null)
		if [ "$was" = ok ] && [ "$now" != ok ]; then
			log "microSD card removed or full: closing this segment"
			break
		fi
		if [ "$was" != ok ] && [ "$now" = ok ]; then
			log "microSD card ready: logging to it"
			break
		fi
	done
	kill -TERM "$2" 2>/dev/null
	exit 2
}

# run_for <seconds> <function> [args]: run a function that execs the
# receiver, for at most <seconds>. A receiver that exits by itself within
# 10 s (radio busy, bad option) is followed by a 10 s pause, so failures do
# not spin; with QUICK_OK set (one-shot sweeps), only a failed one is.
run_for() {
	local secs="$1" rc wrc start
	shift
	start=$(date +%s)
	"$@" &
	CHILD=$!
	watchdog "$secs" "$CHILD" &
	WATCH=$!
	wait "$CHILD"
	rc=$?
	kill "$WATCH" 2>/dev/null
	wait "$WATCH" 2>/dev/null
	wrc=$?
	CHILD='' WATCH=''
	if [ "$wrc" != 2 ] && [ $(($(date +%s) - start)) -lt 10 ] &&
		{ [ "$rc" != 0 ] || [ -z "$QUICK_OK" ]; }; then
		nap 10
	fi
	return $rc
}

# --- network servers ---------------------------------------------------------

job_soapy_server() {
	local bind
	config_get bind "$JOB" bind
	[ -n "$bind" ] && exec SoapySDRServer --bind="$bind"
	exec SoapySDRServer --bind
}

job_rtl_tcp() {
	local addr port dev gain ppm
	config_get addr "$JOB" address 0.0.0.0
	config_get port "$JOB" port 1234
	config_get dev "$JOB" device 0
	config_get gain "$JOB" gain
	config_get ppm "$JOB" ppm
	wait_radio rtlsdr
	set -- rtl_tcp -a "$addr" -p "$port" -d "$dev"
	[ -n "$gain" ] && set -- "$@" -g "$gain"
	[ -n "$ppm" ] && set -- "$@" -P "$ppm"
	# shellcheck disable=SC2086
	exec "$@" $EXTRA
}

# --- decoders ----------------------------------------------------------------

# ADS-B: dump1090 (RTL-SDR) or readsb (HackRF, through SoapySDR) serves the
# SBS/Beast feeds and writes the aircraft table; the map on port 8080 (a uhttpd
# of its own) runs only while this job does. readsb writes the same
# aircraft.json, so the map is the same either way. Every log_every seconds
# (0: never) the aircraft table is appended to the card.
job_adsb() {
	local radio dev gain ppm lat lon every last f day
	config_get radio "$JOB" radio rtlsdr
	config_get dev "$JOB" device 0
	config_get gain "$JOB" gain
	config_get ppm "$JOB" ppm
	config_get lat "$JOB" lat
	config_get lon "$JOB" lon
	config_get every "$JOB" log_every 60
	wait_radio "$radio"
	mkdir -p /var/run/dump1090
	uhttpd -f -h /usr/share/dump1090 -n 3 -N 20 -R -p 0.0.0.0:8080 -p '[::]:8080' &
	MAP=$!
	if [ "$radio" = hackrf ]; then
		# A HackRF at 1090 MHz is far less sensitive than an RTL-SDR, so expect
		# fewer aircraft; readsb drives it through SoapySDR.
		set -- readsb-soapy --device-type soapysdr --soapy-device driver=hackrf \
			--net --net-bo-port 30005 --net-sbs-port 30003 \
			--write-json /var/run/dump1090 --write-json-every 1 --quiet
		[ -n "$gain" ] && set -- "$@" --soapy-gain-element "$gain"
		[ -n "$lat" ] && [ -n "$lon" ] && set -- "$@" --lat "$lat" --lon "$lon"
	else
		set -- dump1090 --quiet --net --device-index "$dev" --write-json /var/run/dump1090
		[ -n "$gain" ] && set -- "$@" --gain "$gain"
		[ -n "$ppm" ] && set -- "$@" --ppm "$ppm"
		[ -n "$lat" ] && [ -n "$lon" ] && set -- "$@" --lat "$lat" --lon "$lon"
	fi

	# shellcheck disable=SC2086
	"$@" $EXTRA &
	CHILD=$!
	while [ "$every" -gt 0 ] 2>/dev/null && kill -0 "$CHILD" 2>/dev/null; do
		nap "$every"
		have_storage || continue
		[ -s /var/run/dump1090/aircraft.json ] || continue
		day=$(day_dir) || continue
		f="$day/aircraft-$(date +%Y%m%d).json"
		[ -n "$last" ] && [ "$last" != "$f" ] && compress "$last"
		last=$f
		cat /var/run/dump1090/aircraft.json >> "$f"
	done
	wait "$CHILD"
	kill "$MAP" 2>/dev/null
	MAP=
}

add_freq() {
	ISM_FREQS="$ISM_FREQS -f $1"
	ISM_NFREQ=$((ISM_NFREQ + 1))
}

ism_exec() {
	set -- "$ISM_BIN" -d "$ISM_DEV"
	[ -n "$ISM_RATE" ] && set -- "$@" -s "$ISM_RATE"
	set -- "$@" -M time:iso:utc -M level -M protocol -F "json:$1"
	[ -n "$ISM_HTTP" ] && set -- "$@" -F "http:0.0.0.0:$ISM_HTTP"
	[ -n "$ISM_GAIN" ] && set -- "$@" -g "$ISM_GAIN"
	[ -n "$ISM_PPM" ] && set -- "$@" -p "$ISM_PPM"
	# shellcheck disable=SC2086
	exec "$@" $ISM_FREQS $EXTRA
}

# ISM-band sensors with rtl_433: one JSON object per line, one file a day, and
# a live view on http://<router>:<http_port>/. On the HackRF (radio 'hackrf')
# rtl_433 tunes through SoapySDR (-d driver=hackrf) at a 2.4 Msps sample rate;
# on the RTL-SDR it uses the device index and its native lower rate.
job_ism() {
	local radio hop out
	config_get radio "$JOB" radio rtlsdr
	config_get ISM_GAIN "$JOB" gain
	config_get ISM_PPM "$JOB" ppm
	config_get ISM_HTTP "$JOB" http_port 8433
	config_get hop "$JOB" hop_interval 600
	if [ "$radio" = hackrf ]; then
		ISM_BIN=rtl_433-soapy
		config_get ISM_DEV "$JOB" device driver=hackrf
		config_get ISM_RATE "$JOB" rate 2400000
	else
		ISM_BIN=rtl_433
		config_get ISM_DEV "$JOB" device 0
		ISM_RATE=
	fi
	ISM_FREQS='' ISM_NFREQ=0
	config_list_foreach "$JOB" frequency add_freq
	[ "$ISM_NFREQ" -gt 0 ] || add_freq 433.92M
	[ "$ISM_NFREQ" -gt 1 ] && ISM_FREQS="$ISM_FREQS -H $hop"
	while :; do
		wait_radio "$radio"
		out=/dev/null
		have_storage && out="$(day_dir)/ism-$(date +%Y%m%d).json"
		run_for "$(pirate_secs_to_boundary day)" ism_exec "$out"
	done
}

ais_exec() {
	local log="$1"
	if [ "$AIS_RADIO" = hackrf ]; then
		# AIS-catcher on the HackRF: NMEA to the card (stdout) and to the TCP
		# server on AIS_PORT. The device is pinned by the HackRF's serial.
		set -- AIS-catcher
		[ -n "$AIS_DEV" ] && [ "$AIS_DEV" != - ] && set -- "$@" -d "$AIS_DEV"
		# shellcheck disable=SC2153  # AIS_RATE is set in job_ais, not ISM_RATE
		set -- "$@" -s "$AIS_RATE" -gf lna "$AIS_LNA" vga "$AIS_VGA" preamp "$AIS_AMP" -S "$AIS_PORT" -o 1
		# shellcheck disable=SC2086
		exec "$@" $EXTRA >> "$log"
	fi
	set -- rtl_ais -d "$AIS_DEV" -T -P "$AIS_PORT" -n
	[ -n "$AIS_GAIN" ] && set -- "$@" -g "$AIS_GAIN"
	[ -n "$AIS_PPM" ] && set -- "$@" -p "$AIS_PPM"
	# shellcheck disable=SC2086
	exec "$@" $EXTRA 2>>"$log"
}

# Ships (AIS) with rtl_ais on the RTL-SDR, or AIS-catcher on the HackRF
# (radio 'hackrf'): NMEA on a TCP server (OpenCPN etc.) and the sentences
# logged to the card, one file a day.
job_ais() {
	local out amp
	config_get AIS_RADIO "$JOB" radio rtlsdr
	config_get AIS_PORT "$JOB" port 10110
	config_get AIS_GAIN "$JOB" gain
	config_get AIS_PPM "$JOB" ppm
	config_get AIS_DEV "$JOB" device 0
	# HackRF-only tunables (AIS-catcher); harmless defaults on the RTL-SDR path.
	config_get AIS_RATE "$JOB" rate 2304000
	config_get AIS_LNA "$JOB" lna 16
	config_get AIS_VGA "$JOB" vga 20
	config_get_bool amp "$JOB" amp 0
	AIS_AMP=off
	[ "$amp" = 1 ] && AIS_AMP=on
	while :; do
		wait_radio "$AIS_RADIO"
		# On the HackRF, pin AIS-catcher to its serial (an RTL-SDR may share the bus).
		[ "$AIS_RADIO" = hackrf ] &&
			AIS_DEV=$(pirate_usb_radios | awk '$1 == "hackrf" { print $3; exit }')
		out=/dev/null
		have_storage && out="$(day_dir)/ais-$(date +%Y%m%d).nmea"
		run_for "$(pirate_secs_to_boundary day)" ais_exec "$out"
	done
}

# --- spectrum sweeps ---------------------------------------------------------

# sweep_exec <radio> <once|continuous> <file> [errfile]: hackrf_sweep or
# rtl_power, CSV appended to <file>, messages to [errfile] when given
sweep_exec() {
	local radio="$1" mode="$2" file="$3" err="$4" range bin integ gain lna vga amp dev
	local fifo="$PIRATE_STATE/$JOB.sweep-fifo"
	if [ "$radio" = hackrf ]; then
		config_get range "$JOB" range 1:6000
		config_get bin "$JOB" bin_width 1000000
		config_get lna "$JOB" lna 16
		config_get vga "$JOB" vga 20
		config_get_bool amp "$JOB" amp 0
		config_get dev "$JOB" device
		# -P estimate: hackrf_sweep's default FFTW plan ("measure") times FFT
		# algorithms first, which on this FPU-less CPU took minutes per sweep
		# (and every one-shot sweep plans again); a sweep itself takes ~1 s.
		set -- hackrf_sweep -f "$range" -w "$bin" -l "$lna" -g "$vga" -a "$amp" -P estimate
		[ -n "$dev" ] && set -- "$@" -d "$dev"
	else
		config_get range "$JOB" range 24M:1766M:250k
		config_get integ "$JOB" integration 10
		config_get gain "$JOB" gain
		config_get dev "$JOB" device 0
		set -- rtl_power -d "$dev" -f "$range" -i "$integ"
		[ -n "$gain" ] && set -- "$@" -g "$gain"
	fi
	[ "$mode" = once ] && set -- "$@" -1
	# shellcheck disable=SC2086
	set -- "$@" $EXTRA
	[ "$radio" = rtlsdr ] && set -- "$@" -
	# At one sweep a minute, every sweep's start-up and exit messages would
	# crowd everything else out of the log: a one-shot sweep's go to [errfile]
	# for job_sweep to log if it fails. Sweeping without pause, all but
	# hackrf_sweep's once-a-second progress line are logged.
	[ -n "$err" ] && exec "$@" >> "$file" 2> "$err"
	if [ "$radio" = hackrf ] && rm -f "$fifo" && mkfifo "$fifo"; then
		awk '!/ total sweeps completed, / { print; fflush() }' < "$fifo" >&2 &
		exec "$@" >> "$file" 2> "$fifo"
	fi
	exec "$@" >> "$file"
}

# Spectrum survey: one sweep every <interval> seconds (0: sweep without
# pause), CSV rotated every hour or day and compressed when closed.
job_sweep() {
	local radio interval rotate out last start err="$PIRATE_STATE/$JOB.sweep-err"
	config_get radio "$JOB" radio rtlsdr
	config_get interval "$JOB" interval 60
	config_get rotate "$JOB" rotate hour
	mkdir -p "$PIRATE_STATE"
	while :; do
		wait_radio "$radio"
		wait_storage
		out="$(day_dir)/sweep-$radio-$(segment_stamp "$rotate").csv"
		[ -n "$last" ] && [ "$last" != "$out" ] && compress "$last"
		last=$out
		if [ "$interval" -gt 0 ]; then
			start=$(date +%s)
			QUICK_OK=1
			run_for 900 sweep_exec "$radio" once "$out" "$err" || {
				log "sweep failed (exit $?):"
				tail -n 20 "$err" >&2
			}
			QUICK_OK=''
			rm -f "$err"
			sleep_rest "$start" "$interval"
		else
			run_for "$(pirate_secs_to_boundary "$rotate")" sweep_exec "$radio" continuous "$out"
		fi
	done
}

# --- raw IQ ------------------------------------------------------------------

# iq_exec <radio> <file>
iq_exec() {
	local radio="$1" file="$2" gain ppm lna vga amp bw dev
	if [ "$radio" = hackrf ]; then
		config_get lna "$JOB" lna 16
		config_get vga "$JOB" vga 20
		config_get_bool amp "$JOB" amp 0
		config_get bw "$JOB" bandwidth
		config_get dev "$JOB" device
		set -- hackrf_transfer -r "$file" -f "$IQ_HZ" -s "$IQ_SPS" -l "$lna" -g "$vga" -a "$amp"
		[ -n "$bw" ] && set -- "$@" -b "$(pirate_to_hz "$bw")"
		[ -n "$dev" ] && set -- "$@" -d "$dev"
	else
		config_get gain "$JOB" gain
		config_get ppm "$JOB" ppm
		config_get dev "$JOB" device 0
		set -- rtl_sdr -d "$dev" -f "$IQ_HZ" -s "$IQ_SPS"
		[ -n "$gain" ] && set -- "$@" -g "$gain"
		[ -n "$ppm" ] && set -- "$@" -p "$ppm"
	fi
	# shellcheck disable=SC2086
	set -- "$@" $EXTRA
	[ "$radio" = rtlsdr ] && set -- "$@" "$file"
	exec "$@"
}

# Continuous raw IQ to the card in <segment>-second SigMF recordings.
job_iq() {
	local radio freq rate segment base
	config_get radio "$JOB" radio hackrf
	config_get freq "$JOB" frequency
	config_get rate "$JOB" rate 2M
	config_get segment "$JOB" segment 600
	IQ_HZ=$(pirate_to_hz "$freq") || config_error "set a frequency, e.g. option frequency '433.92M'"
	IQ_SPS=$(pirate_to_hz "$rate") || config_error "set a sample rate, e.g. option rate '2M'"
	while :; do
		wait_radio "$radio"
		wait_storage
		base="$(day_dir)/iq-$radio-${IQ_HZ}Hz-${IQ_SPS}sps-$(date +%Y%m%dT%H%M%S)"
		pirate_sigmf_meta "$base.sigmf-meta" "$radio" "$IQ_SPS" "$IQ_HZ" "pirate-radio job $JOB"
		run_for "$segment" iq_exec "$radio" "$base.sigmf-data"
		[ -s "$base.sigmf-data" ] || rm -f "$base.sigmf-data" "$base.sigmf-meta"
	done
}

# --- Wi-Fi spectral scan -------------------------------------------------------

job_wifi_spectral() {
	local interval bands country start
	config_get interval "$JOB" interval 60
	config_get bands "$JOB" bands "2g 5g"
	config_get country "$JOB" country
	[ -n "$(pirate_spectral_dirs)" ] ||
		config_error "no Wi-Fi radio with spectral scan: this firmware was built without it (use the full build)"
	[ -n "$country" ] && iw reg set "$country"
	while :; do
		wait_storage
		start=$(date +%s)
		pirate_spectral_sweep "$(day_dir)" "$bands"
		sleep_rest "$start" "$interval"
	done
}

config_load pirate-radio
config_get TYPE "$JOB" type
config_get EXTRA "$JOB" extra_args
pirate_storage_load
OUTDIR=

case "$TYPE" in
soapy_server|rtl_tcp|adsb|ism|ais|sweep|iq|wifi_spectral) "job_$TYPE" ;;
'') config_error "no job '$JOB' with a type in /etc/config/pirate-radio" ;;
*) config_error "job '$JOB': unknown type '$TYPE'" ;;
esac
