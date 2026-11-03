#!/bin/sh
# pirate-radio status page: http://<router>/cgi-bin/pirate-radio

html() { sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

# The address the browser used, for the links below; only a plain host name
# or address (letters, digits, . : - [ ]) is echoed back.
host=$HTTP_HOST
case "$host" in
\[*) host="${host%%]*}]" ;;
*) host=${host%%:*} ;;
esac
if [ "$(printf '%s' "$host" | sed -n '/^[][A-Za-z0-9.:-]\{1,253\}$/p')" != "$host" ] || [ -z "$host" ]; then
	host=$(uci -q get network.lan.ipaddr)
	host=${host%%/*}
	[ -n "$host" ] || host=192.168.1.1
fi

cat <<EOT
Content-Type: text/html; charset=utf-8

<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>pirate-radio</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 1rem auto; padding: 0 1rem; color: #222; background: #fff; }
pre { background: #f3f3f3; padding: 1rem; overflow-x: auto; }
code { background: #f3f3f3; padding: 0 .2rem; }
@media (prefers-color-scheme: dark) { body { color: #ddd; background: #181818; } pre, code { background: #262626; } a { color: #8cf; } }
</style>
</head>
<body>
<h1>pirate-radio</h1>
<p>
<a href="http://$host:8080/">Aircraft map</a> &middot;
<a href="http://$host:8433/">ISM sensors (live)</a> &middot;
<a href="http://$host:8081/pirate-radio/">Recorded data</a> &middot;
<a href="/">Pirate Radio UI</a>
</p>
<pre>
EOT
pirate-radio status 2>&1 | html
cat <<EOT
</pre>
<h2>Connect from a computer</h2>
<ul>
<li>SoapySDR clients (SDR++, GQRX, CubicSDR, SDRangel, GNU Radio):
<code>driver=remote,remote=tcp://$host:55132</code></li>
<li>rtl_tcp clients (SDR#, SDR++, GQRX), when job <code>rtltcp</code> is on: <code>$host:1234</code></li>
<li>ADS-B: SBS <code>$host:30003</code>, Beast <code>$host:30005</code></li>
<li>AIS (OpenCPN), when job <code>ais</code> is on: TCP <code>$host:10110</code></li>
</ul>
<p>Jobs are set in <code>/etc/config/pirate-radio</code>; <code>pirate-radio enable|disable &lt;job&gt;</code> over SSH.</p>
</body>
</html>
EOT
