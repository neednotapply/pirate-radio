#!/bin/sh
# Dreamcast Now (dreamcast.online/now), as DreamPi does it. This router is
# listed there under an id, a hash of its MAC address, and a name set on the
# site's configure form (until then "Unnamed_" and the id's first 6 digits).
#
#   dcnow report      during a PPP call, every 15 s: a POST with a hash of the
#                     game server name the Dreamcast last looked up, which the
#                     site maps to the game being played (names several games
#                     share are sent once per call). Runs until killed: the
#                     call script starts and stops it.
#   dcnow id          the id
#   dcnow name        the name this router is listed under
#   dcnow name <new>  list it under <new> instead

API=${DREAMPI_DCNOW_API:-https://dcnow-2016.appspot.com/api/update}
SITE=${DREAMPI_DCNOW_SITE:-dreamcast.online}
LOG=${DREAMPI_RUN:-/var/run/dreampi}/dns.log
UA="Mozilla/4.0 (compatible; MSIE 5.5; Windows NT), Dreamcast Now"
SYSFS=${SLATE_SYSFS:-/sys}
INTERVAL=${DREAMPI_DCNOW_INTERVAL:-15}

sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

id() {
	local mac
	mac=$(cat "$SYSFS/class/net/br-lan/address" 2> /dev/null ||
		cat "$SYSFS/class/net/eth0/address" 2> /dev/null)
	[ -n "$mac" ] || return 1
	sha "$(echo "$mac" | tr a-f A-F)"
}

report() {
	local id data name key shared="" failing=""

	id=$(id) || { logger -t dreampi "Dreamcast Now: no MAC address"; exit 1; }
	# This call's lookups only
	: > "$LOG"
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
}

# The configure form is plain HTTP (the site sends https there back to http)
# and needs a cookie, so the exchange is by hand: http <file> < request
http() { nc "$SITE" 80 > "$1" 2> /dev/null && head -n 1 "$1" | grep -q '^HTTP/1\.[01] 200 '; }

# Every byte as %XX: valid form encoding for any name
urlenc() { printf '%s' "$1" | hexdump -v -e '/1 "%02X\n"' | sed 's/^/%/' | tr -d '\n'; }

# The username field of the form in <file>, its HTML entities decoded
form_name() {
	sed -n 's/.*name="username" value="\([^"]*\)".*/\1/p' "$1" | head -n 1 |
		sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&#x27;/'/g" -e "s/&#39;/'/g" -e 's/&amp;/\&/g'
}

name() {
	local id new="$1" tmp cookie token body err

	id=$(id) || { echo "no MAC address" >&2; return 1; }
	tmp=$(mktemp)
	err="couldn't reach $SITE"
	printf 'GET /now/configure/%s/ HTTP/1.0\r\nHost: %s\r\nUser-Agent: %s\r\nConnection: close\r\n\r\n' \
		"$id" "$SITE" "$UA" | http "$tmp" || { rm -f "$tmp"; echo "$err" >&2; return 1; }
	if [ -z "$new" ]; then
		form_name "$tmp"
		rm -f "$tmp"
		return 0
	fi
	cookie=$(sed -n 's/^[Ss]et-[Cc]ookie: csrftoken=\([^;]*\).*/\1/p' "$tmp" | head -n 1 | tr -d '\r')
	token=$(sed -n 's/.*name="csrfmiddlewaretoken" value="\([^"]*\)".*/\1/p' "$tmp" | head -n 1)
	[ -n "$cookie" ] && [ -n "$token" ] || { rm -f "$tmp"; echo "$SITE's form has changed" >&2; return 1; }
	body="csrfmiddlewaretoken=$token&username=$(urlenc "$new")&email_hash="
	printf 'POST /now/configure/%s/ HTTP/1.0\r\nHost: %s\r\nUser-Agent: %s\r\nCookie: csrftoken=%s\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
		"$id" "$SITE" "$UA" "$cookie" "${#body}" "$body" | http "$tmp" || { rm -f "$tmp"; echo "$SITE refused the name" >&2; return 1; }
	# The reply is the form again, with the name as saved
	if [ "$(form_name "$tmp")" != "$new" ]; then
		rm -f "$tmp"
		echo "$SITE didn't take the name" >&2
		return 1
	fi
	rm -f "$tmp"
	echo "$new"
}

case "$1" in
report) report ;;
id) id ;;
name) name "$2" ;;
*)
	echo "usage: dcnow report | id | name [new name]" >&2
	exit 1
	;;
esac
