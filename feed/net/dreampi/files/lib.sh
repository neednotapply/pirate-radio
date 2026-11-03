# Shared by the dreampi init script, its hotplug hook and the Pirate Radio UI (and
# pirate-gps, which leaves modems alone): which plugged-in serial devices are
# USB modems dreampi can answer with.

# Overridable for tests.
DREAMPI_SYSFS=${PIRATE_SYSFS:-/sys}
DREAMPI_MODEMS=${DREAMPI_MODEMS:-/usr/share/dreampi/modems}

# dreampi_usb_id <tty>: the vid:pid of the USB device a tty (ttyACM0) is on
dreampi_usb_id() {
	local d="$DREAMPI_SYSFS/class/tty/$1/device"
	[ -e "$d" ] || return 1
	d=$(readlink -f "$d") || return 1
	while [ -n "$d" ] && [ ! -r "$d/idVendor" ]; do d=${d%/*}; done
	[ -n "$d" ] && echo "$(cat "$d/idVendor"):$(cat "$d/idProduct")"
}

# dreampi_modem_name <vid:pid>: the modem's name, if it's a known modem
dreampi_modem_name() {
	local id name
	while read -r id name; do
		case "$id" in "" | "#"*) continue ;; esac
		# shellcheck disable=SC2254
		case "$1" in $id) echo "$name"; return 0 ;; esac
	done < "$DREAMPI_MODEMS"
	return 1
}

# dreampi_modems: "<device> <vid:pid> <name>", a line per modem plugged in
dreampi_modems() {
	local t n id name
	for t in "$DREAMPI_SYSFS"/class/tty/ttyACM* "$DREAMPI_SYSFS"/class/tty/ttyUSB*; do
		[ -e "$t" ] || continue
		n=${t##*/}
		id=$(dreampi_usb_id "$n") || continue
		name=$(dreampi_modem_name "$id") || continue
		echo "/dev/$n $id $name"
	done
}
