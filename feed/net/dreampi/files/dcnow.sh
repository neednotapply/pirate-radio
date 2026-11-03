#!/bin/sh
# Dreamcast Now (dreamcast.online/now) during a PPP call, as DreamPi's dcnow.py
# does it: every 15 s, a POST keyed by a hash of this router's MAC address,
# with a hash of the game server name the Dreamcast last looked up (which the
# site maps to the game being played). Names several games share are sent
# once per call. Runs until killed (the call script kills it at hang-up).

API=${DREAMPI_DCNOW_API:-https://dcnow-2016.appspot.com/api/update}
LOG=${DREAMPI_RUN:-/var/run/dreampi}/dns.log
UA="Mozilla/4.0 (compatible; MSIE 5.5; Windows NT), Dreamcast Now"
SYSFS=${SLATE_SYSFS:-/sys}
INTERVAL=${DREAMPI_DCNOW_INTERVAL:-15}

sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

mac=$(cat "$SYSFS/class/net/br-lan/address" 2> /dev/null ||
	cat "$SYSFS/class/net/eth0/address" 2> /dev/null)
[ -n "$mac" ] || { logger -t dreampi "Dreamcast Now: no MAC address"; exit 1; }
id=$(sha "$(echo "$mac" | tr a-f A-F)")

# This call's lookups only
: > "$LOG"
shared=
failing=
while :; do
	data=
	name=$(tail -n 15 "$LOG" 2> /dev/null |
		sed -n 's/.*query\[A\] \([^ ]*\) from .*/\1/p' | grep -v appspot | tail -n 1)
	case "$name" in
	*gameloft* | *onsen0.overworks.isao.net*)
		case "$name" in *gameloft*) key=gameloft ;; *) key=onsen0 ;; esac
		case " $shared " in
		*" $key "*) name= ;;
		*) shared="$shared $key" ;;
		esac
		;;
	esac
	[ -n "$name" ] && data="dns_query=$(sha "$name")"
	if uclient-fetch -q -T 15 -U "$UA" --post-data="$data" -O /dev/null "$API/$id/" 2> /dev/null; then
		[ -n "$failing" ] && logger -t dreampi "Dreamcast Now: updating again"
		failing=
	else
		[ -z "$failing" ] && logger -t dreampi "Dreamcast Now: update failed"
		failing=1
	fi
	sleep "$INTERVAL"
done
