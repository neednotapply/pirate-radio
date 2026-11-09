# Shared helpers for pirate-radio (sourced; busybox ash).
# Callers source /lib/functions.sh first and run config_load pirate-radio.

PIRATE_STATE=${PIRATE_STATE:-/var/run/pirate-radio}

# The SDRs pirate-radio supports. pirate_radio_kind <vid> <pid> (4-digit lowercase
# hex, as in sysfs) prints rtlsdr, hackrf, or nothing for any other device.
pirate_radio_kind() {
	case "$1:$2" in
	0bda:2832|0bda:2838) echo rtlsdr ;;
	1d50:6089|1d50:604b|1d50:cc15) echo hackrf ;;
	esac
}

# Print one line per SDR on the USB bus: "<kind> <vid>:<pid> <serial> <product>"
pirate_usb_radios() {
	local d vid pid kind serial product
	for d in "${PIRATE_SYSFS:-/sys}"/bus/usb/devices/*; do
		[ -r "$d/idVendor" ] && [ -r "$d/idProduct" ] || continue
		read -r vid < "$d/idVendor"
		read -r pid < "$d/idProduct"
		kind=$(pirate_radio_kind "$vid" "$pid")
		[ -n "$kind" ] || continue
		serial=-
		product='?'
		[ -r "$d/serial" ] && read -r serial < "$d/serial"
		[ -r "$d/product" ] && read -r product < "$d/product"
		echo "$kind $vid:$pid $serial $product"
	done
}

# Notes on SDRs plugged in but in a mode pirate-radio can't use, one per line. A
# PortaPack on Mayhem firmware is only a USB serial console (1d50:6018) until
# it's switched to HackRF mode.
pirate_usb_notes() {
	local d vid pid
	for d in "${PIRATE_SYSFS:-/sys}"/bus/usb/devices/*; do
		[ -r "$d/idVendor" ] && [ -r "$d/idProduct" ] || continue
		read -r vid < "$d/idVendor"
		read -r pid < "$d/idProduct"
		case "$vid:$pid" in
		1d50:6018) echo "PortaPack ($vid:$pid) is in Mayhem mode: drive it on the PortaPack tab, or switch it to HackRF mode to use it as a radio here" ;;
		esac
	done
}

# pirate_radio_present <rtlsdr|hackrf>
pirate_radio_present() {
	pirate_usb_radios | grep -q "^$1 "
}

# The radio a job type holds while it runs; empty for jobs that hold none.
# pirate_job_radio <section> <type>
pirate_job_radio() {
	local radio
	case "$2" in
	rtl_tcp) radio=rtlsdr ;;
	adsb|ism|ais|sweep|iq) config_get radio "$1" radio rtlsdr ;;
	*) radio= ;;
	esac
	echo "$radio"
}

# What a job type needs on USB before it runs: rtlsdr, hackrf, any (an SDR of
# either kind; the SoapySDR server holds none of its own) or nothing.
# pirate_job_needs <section> <type>
pirate_job_needs() {
	case "$2" in
	soapy_server) echo any ;;
	*) pirate_job_radio "$1" "$2" ;;
	esac
}

# pirate_need_met <rtlsdr|hackrf|any|''>: is what a job needs on USB now?
pirate_need_met() {
	case "$1" in
	'') return 0 ;;
	any) [ -n "$(pirate_usb_radios)" ] ;;
	*) pirate_radio_present "$1" ;;
	esac
}

# Loads STORE_MOUNT, STORE_ROOT, STORE_MIN_FREE_MB, STORE_REQUIRE_MOUNT.
pirate_storage_load() {
	local dir
	config_get STORE_MOUNT storage mountpoint /mnt/sdcard
	config_get dir storage dir pirate-radio
	config_get STORE_MIN_FREE_MB storage min_free_mb 256
	config_get_bool STORE_REQUIRE_MOUNT storage require_mount 1
	STORE_ROOT="$STORE_MOUNT/$dir"
	# Cards written before the project was renamed keep their files in
	# slate-sdr/: they move over the first time the card is used
	if [ "$dir" = pirate-radio ] && [ ! -e "$STORE_ROOT" ] && [ -d "$STORE_MOUNT/slate-sdr" ] &&
		pirate_is_mounted "$STORE_MOUNT"; then
		mv "$STORE_MOUNT/slate-sdr" "$STORE_ROOT" 2> /dev/null
	fi
}

# pirate_is_mounted <path>: is a filesystem mounted exactly at <path>?
pirate_is_mounted() {
	awk -v m="$1" '$2 == m { found = 1 } END { exit !found }' "${PIRATE_PROC:-/proc}/mounts"
}

# pirate_free_mb <path>: free space in MiB (empty if df fails)
pirate_free_mb() {
	df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024) }'
}

# pirate_storage_state: prints ok, nocard or full (needs pirate_storage_load)
pirate_storage_state() {
	local free
	if [ "$STORE_REQUIRE_MOUNT" = 1 ] && ! pirate_is_mounted "$STORE_MOUNT"; then
		echo nocard
		return
	fi
	free=$(pirate_free_mb "$STORE_MOUNT")
	if [ -n "$free" ] && [ "$free" -lt "$STORE_MIN_FREE_MB" ]; then
		echo full
		return
	fi
	echo ok
}

# pirate_to_hz <value>: 433.92M, 2.4G, 100k or 1000000 -> integer Hz
pirate_to_hz() {
	echo "$1" | awk '
		/^[0-9]+(\.[0-9]+)?[kKmMgG]?$/ {
			v = $0; m = 1; u = substr(v, length(v))
			if (u ~ /[kK]/) m = 1e3; else if (u ~ /[mM]/) m = 1e6; else if (u ~ /[gG]/) m = 1e9
			if (m > 1) v = substr(v, 1, length(v) - 1)
			printf "%.0f\n", v * m; ok = 1
		}
		END { exit !ok }'
}

# pirate_secs_to_boundary <hour|day|seconds>: seconds until the next file rotation
pirate_secs_to_boundary() {
	local h m s now
	# shellcheck disable=SC2046
	set -- "$1" $(date '+%H %M %S')
	h=${2#0}; m=${3#0}; s=${4#0}
	now=$((h * 3600 + m * 60 + s))
	case "$1" in
	hour) echo $((3600 - now % 3600)) ;;
	day) echo $((86400 - now)) ;;
	*[!0-9]*|'') echo 3600 ;;
	*) echo $(( $1 - now % $1 )) ;;
	esac
}

# pirate_json_str <text>: <text> escaped for a JSON string
pirate_json_str() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# pirate_sigmf_meta <file.sigmf-meta> <rtlsdr|hackrf> <rate> <freq_hz> <description>
# rtl_sdr writes unsigned 8-bit I/Q (cu8), hackrf_transfer signed (ci8).
pirate_sigmf_meta() {
	local dtype hw
	case "$2" in
	hackrf) dtype=ci8 hw="HackRF One" ;;
	*) dtype=cu8 hw="RTL-SDR (RTL2832U)" ;;
	esac
	cat > "$1" <<-META
	{
	  "global": {
	    "core:datatype": "$dtype",
	    "core:sample_rate": $3,
	    "core:version": "1.0.0",
	    "core:hw": "$hw",
	    "core:recorder": "pirate-radio on GL-AR750S",
	    "core:description": "$(pirate_json_str "$5")"
	  },
	  "captures": [
	    {
	      "core:sample_start": 0,
	      "core:frequency": $4,
	      "core:datetime": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	    }
	  ],
	  "annotations": []
	}
	META
}

# pirate_spectral_dirs: debugfs directories of Wi-Fi radios with spectral scan
# (ath9k: the 2.4 GHz radio in the QCA9563; ath10k: the 5 GHz QCA9887)
pirate_spectral_dirs() {
	local d
	for d in "${PIRATE_DEBUGFS:-/sys/kernel/debug}"/ieee80211/phy*/ath9k \
		"${PIRATE_DEBUGFS:-/sys/kernel/debug}"/ieee80211/phy*/ath10k; do
		[ -e "$d/spectral_scan_ctl" ] && echo "$d"
	done
}

# pirate_spectral_sweep <outdir> [bands]: one spectral scan across every
# channel of each capable radio, raw samples to <outdir>/<band>-<time>.bin
# (decode with FFT_eval). The radio must not be in use as an access point.
pirate_spectral_sweep() {
	local d phy drv band iface out bands="${2:-2g 5g}"
	for d in $(pirate_spectral_dirs); do
		phy=${d%/*}
		phy=${phy##*/}
		drv=${d##*/}
		band=5g
		[ "$drv" = ath9k ] && band=2g
		case " $bands " in *" $band "*) ;; *) continue ;; esac
		iface="sdr$phy"
		iw phy "$phy" interface add "$iface" type managed 2>/dev/null
		if ! ip link set "$iface" up 2>/dev/null; then
			echo "spectral: cannot use $phy ($band); is it running an access point?" >&2
			iw dev "$iface" del 2>/dev/null
			continue
		fi
		if [ "$drv" = ath9k ]; then
			echo chanscan > "$d/spectral_scan_ctl"
		else
			echo background > "$d/spectral_scan_ctl"
			echo trigger > "$d/spectral_scan_ctl"
		fi
		iw dev "$iface" scan > /dev/null 2>&1
		echo disable > "$d/spectral_scan_ctl"
		out="$1/$band-$(date +%Y%m%dT%H%M%S).bin"
		cat "$d/spectral_scan0" > "$out"
		[ -s "$out" ] || rm -f "$out"
		ip link set "$iface" down 2>/dev/null
		iw dev "$iface" del 2>/dev/null
	done
}
