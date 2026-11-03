#!/bin/sh
# An answered Dreamcast call (dreampi -c): call <ppp|dcnet> <number>, with the
# modem in $DREAMPI_TTY at $DREAMPI_BAUD. The call lasts as long as this does.
#   ppp    pppd on the modem, as DreamPi runs it: the Dreamcast logs in with
#          PAP (any name and password) and gets dreamcast_ip, with this
#          router (dnsmasq, DreamPi's DNS servers) for DNS. The link is dc0,
#          in the "dreamcast" firewall zone, with DreamPi's packet fixes.
#   dcnet  the DCNet client: the modem goes straight to a DCNet access point,
#          which runs PPP itself.

. /lib/functions.sh

service=$1 number=$2
LIBEXEC=${DREAMPI_LIBEXEC:-/usr/libexec/dreampi}

# run <command...>: in the background, so a TERM from dreampi reaches it
run() {
	"$@" &
	child=$!
	trap 'kill "$child" 2> /dev/null' TERM INT
	wait "$child"
	# wait returns early when a trap fires; wait for the end
	wait "$child"
}

config_load dreampi
logger -t dreampi "call to $number: $service"

case "$service" in
ppp)
	config_get local_ip main local_ip 192.168.169.1
	config_get dc_ip main dreamcast_ip 192.168.169.2
	config_get_bool dcnow main dcnow 1
	config_get_bool debug main debug 0

	reporter=
	if [ "$dcnow" = 1 ]; then
		"$LIBEXEC/dcnow" &
		reporter=$!
	fi
	set -- "$DREAMPI_TTY" "$DREAMPI_BAUD" "$local_ip:$dc_ip" nodetach auth \
		ms-dns "$local_ip" ktune noccp noipv6 ifname dc0
	[ "$debug" = 1 ] && set -- "$@" debug
	run "${DREAMPI_PPPD:-pppd}" "$@"
	[ -n "$reporter" ] && kill "$reporter" 2> /dev/null
	;;
dcnet)
	# These numbers (from DreamPi's Netlink) are for DCNet's second port
	port=7654
	case "$number" in
	0053600100*)
		case "${number#0053600100}" in 0[1-9] | 1[0345] | 16) port=7656 ;; esac
		;;
	esac
	run "${DREAMPI_DCNET:-dcnet}" -t "$DREAMPI_TTY" -b "$DREAMPI_BAUD" -p "$port"
	;;
*)
	logger -t dreampi "unknown service: $service"
	exit 1
	;;
esac
