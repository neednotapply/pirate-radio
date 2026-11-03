#!/bin/sh
# The Dreamcast's packet fixes, as DreamPi makes them with iptables, in an
# nftables table of their own (ip dreampi) for what comes in from the call's
# PPP link (dc0):
#   - game servers' fixed addresses go where those servers live now (DreamPi's
#     dcnatrules list, fetched from nat_rules_url; a copy ships as fallback)
#   - forwarded packets get a TTL of 64 (the Dreamcast sends 30)
#   - a second SYN within 1 s from ports 3200-3205 is dropped (PowerSmash)
#
#   nat apply    load the table from the newest list at hand
#   nat update   fetch the list (at most every 6 hours), then apply
#   nat clear    remove the table

. /lib/functions.sh

RUN=${DREAMPI_RUN:-/var/run/dreampi}
SHIPPED=${DREAMPI_SHARE:-/usr/share/dreampi}/dnat.txt
LIST="$RUN/dnat.txt"
IFACE=dc0

# ip4 <address>: a plain dotted quad
ip4() {
	local IFS=. x
	case "$1" in "" | *[!0-9.]*) return 1 ;; esac
	# shellcheck disable=SC2086
	set -- $1
	[ $# -eq 4 ] || return 1
	for x; do
		case "$x" in "" | 0?*) return 1 ;; esac
		[ "$x" -le 255 ] || return 1
	done
}

# The list is someone else's, so each line is checked before it reaches nft;
# lines that aren't <from> <to> [port [tcp|udp]] are skipped.
rules() {
	local from to port proto rest
	while read -r from to port proto rest; do
		case "$from" in "" | "#"*) continue ;; esac
		ip4 "$from" && ip4 "$to" && [ -z "$rest" ] || continue
		case "$proto" in "") proto=tcp ;; tcp | udp) ;; *) continue ;; esac
		if [ -n "$port" ]; then
			case "$port" in *[!0-9]* | 0*) continue ;; esac
			[ "$port" -le 65535 ] || continue
			echo "		iifname \"$IFACE\" ip daddr $from $proto dport $port dnat to $to:$port"
		else
			[ "$proto" = tcp ] || continue
			echo "		iifname \"$IFACE\" ip daddr $from meta l4proto tcp dnat to $to"
		fi
	done < "$1"
}

apply() {
	local list="$SHIPPED"
	[ -s "$LIST" ] && list="$LIST"
	{
		echo "table ip dreampi"
		echo "delete table ip dreampi"
		echo "table ip dreampi {"
		echo "	set syn_seen { type ipv4_addr . ipv4_addr; flags dynamic, timeout; }"
		echo "	chain prerouting {"
		echo "		type nat hook prerouting priority dstnat - 5; policy accept;"
		rules "$list"
		echo "	}"
		echo "	chain forward {"
		echo "		type filter hook forward priority mangle; policy accept;"
		echo "		iifname \"$IFACE\" ip ttl set 64"
		echo "		iifname \"$IFACE\" tcp flags & (fin | syn | rst | ack) == syn tcp sport 3200-3205 ip saddr . ip daddr @syn_seen drop"
		echo "		iifname \"$IFACE\" tcp flags & (fin | syn | rst | ack) == syn tcp sport 3200-3205 add @syn_seen { ip saddr . ip daddr timeout 1s }"
		echo "	}"
		echo "}"
	} | nft -f -
}

update() {
	local url
	config_load dreampi
	config_get url main nat_rules_url
	[ -n "$url" ] || return 0
	mkdir -p "$RUN"
	# Fresh enough: fetched in the last 6 hours
	[ -n "$(find "$LIST" -mmin -360 2>/dev/null)" ] && return 0
	if uclient-fetch -q -T 15 -O "$LIST.new" "$url" 2> /dev/null && [ -s "$LIST.new" ]; then
		mv "$LIST.new" "$LIST"
		apply
	else
		rm -f "$LIST.new"
		logger -t dreampi "couldn't fetch the NAT rules from $url; using the last copy"
	fi
}

case "$1" in
apply) apply ;;
update) update ;;
clear) nft delete table ip dreampi 2> /dev/null; true ;;
*)
	echo "usage: nat apply|update|clear" >&2
	exit 1
	;;
esac
