#!/usr/bin/env python3
"""Makes feed/utils/pirate-radio-ui/files/bt/names.js, the Bluetooth page's
table of assigned numbers (who a company number is, what a service number
means, what an appearance value says a device is), from Nordic
Semiconductor's bluetooth-numbers-database:

    https://github.com/NordicSemiconductor/bluetooth-numbers-database

    python3 scripts/bt-names.py <a checkout of that database> <its date>

It reads v1/company_ids.json, v1/service_uuids.json, v1/gap_appearance.json
and LICENSE there (the licence goes into the file made, as it asks), and
writes the file in this tree. <its date> is said in the file: the day the
database was fetched. Run it again when a maker is missing from the page.
"""
import io
import json
import os
import sys

# Services whose 16-bit numbers belong to a company (the Bluetooth SIG gives
# its members such numbers), which say who made a thing and little else. The
# few that matter to the page; the database has only some of them.
MEMBERS = {
    "FEED": "Tile", "FEEC": "Tile", "FD84": "Tile",
    "FD5A": "Samsung", "FD59": "Samsung", "FD69": "Samsung",
    "FE2C": "Google", "FEAA": "Google", "FE9F": "Google", "FEA0": "Google", "FEF3": "Google",
    "FE26": "Google", "FCF1": "Google",
    "FD6F": "Apple", "FCB2": "Apple", "FE25": "Apple",
    "FE95": "Xiaomi", "FDAB": "Xiaomi", "FEE0": "Huami (Xiaomi's bands)", "FEE7": "Tencent",
    "FE07": "Sonos", "FEBE": "Bose", "FE03": "Amazon", "FE61": "Logitech",
    "FE33": "Chipolo", "FE65": "Chipolo", "FE78": "HP", "FDF7": "HP",
    "FEB8": "Meta", "FE0F": "Signify (Philips Hue)", "FE59": "Nordic Semiconductor",
}


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, date = sys.argv[1], sys.argv[2]
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "..", "feed", "utils", "pirate-radio-ui", "files", "bt", "names.js")

    def load(name):
        with io.open(os.path.join(src, name), encoding="utf-8") as f:
            return json.load(f)

    def plain(s):
        s = " ".join(s.split())
        for bad in ("`", "${", "\\", "�"):
            s = s.replace(bad, "")
        return s

    companies = {c["code"]: plain(c["name"]) for c in load("v1/company_ids.json") if c["code"] < 0xffff}
    lines = [companies.get(i, "") for i in range(max(companies) + 1)]

    short, long_ = [], []
    for s in load("v1/service_uuids.json"):
        (short if len(s["uuid"]) == 4 else long_).append("%s %s" % (s["uuid"].upper(), plain(s["name"])))
    short.sort()
    long_.sort()

    looks = []
    for a in load("v1/gap_appearance.json"):
        looks.append("%d %s" % (a["category"], plain(a["name"])))
        for sub in a.get("subcategory", []):
            looks.append("%d.%d %s" % (a["category"], sub["value"], plain(sub["name"])))

    with io.open(os.path.join(src, "LICENSE"), encoding="utf-8") as f:
        licence = [" ".join(l.split()) for l in f.read().replace("*/", "").splitlines()]

    js = []
    js.append("/* Pirate Radio: Bluetooth's assigned numbers, for the Bluetooth page.")
    js.append("")
    js.append("   Who a company number is (the number that leads an advertisement's")
    js.append("   manufacturer data), what a service's number means, and what an")
    js.append("   appearance value says a device is. Made by scripts/bt-names.py, not by")
    js.append("   hand, from Nordic Semiconductor's bluetooth-numbers-database")
    js.append("   (https://github.com/NordicSemiconductor/bluetooth-numbers-database) as")
    js.append("   it was on %s: %d companies, %d services, %d appearances. The few" %
              (date, len(companies), len(short) + len(long_), len(looks)))
    js.append("   services listed under MEMBERS are added there by hand. The database's")
    js.append("   licence:")
    js.append("")
    for l in licence:
        js.append(("   " + l).rstrip())
    js.append("*/")
    js.append("(function (root) {")
    js.append('\t"use strict";')
    js.append("")
    js.append("\t// A company's name, on the line of its number (the first line: number 0)")
    js.append("\tvar COMPANIES = `" + "\n".join(lines) + "`.split(/\\r?\\n/);")
    js.append("")
    js.append("\t// What a service is: its 16-bit number, or its whole UUID, and its name")
    js.append("\tvar SERVICES = `" + "\n".join(short + long_) + "`;")
    js.append("")
    js.append("\t// 16-bit service numbers that are a company's own: whose")
    js.append("\tvar MEMBERS = `" + "\n".join("%s %s" % (k, MEMBERS[k]) for k in sorted(MEMBERS)) + "`;")
    js.append("")
    js.append("\t// What a device says it is: a category (the value's upper ten bits), or")
    js.append("\t// category.kind within it (the lower six), and its name")
    js.append("\tvar LOOKS = `" + "\n".join(looks) + "`;")
    js.append("")
    js.append("\tfunction table(text) {")
    js.append("\t\tvar t = {};")
    js.append("\t\ttext.split(/\\r?\\n/).forEach(function (l) {")
    js.append('\t\t\tvar i = l.indexOf(" ");')
    js.append("\t\t\tif (i > 0) t[l.slice(0, i)] = l.slice(i + 1);")
    js.append("\t\t});")
    js.append("\t\treturn t;")
    js.append("\t}")
    js.append("\tvar services = table(SERVICES), members = table(MEMBERS), looks = table(LOOKS);")
    js.append("\tfunction hex4(n) { return (\"000\" + n.toString(16)).slice(-4).toUpperCase(); }")
    js.append("")
    js.append("\tvar api = {")
    js.append("\t\t// The company with this number, or null")
    js.append("\t\tcompany: function (code) { return COMPANIES[code] || null; },")
    js.append("\t\t// The service with this 16-bit number, or this UUID (as text), or null")
    js.append("\t\tservice: function (uuid) {")
    js.append('\t\t\treturn services[typeof uuid === "number" ? hex4(uuid) : String(uuid).toUpperCase()] || null;')
    js.append("\t\t},")
    js.append("\t\t// Whose a 16-bit service number is, when it is a company's own, or null")
    js.append("\t\tmember: function (uuid16) { return members[hex4(uuid16)] || null; },")
    js.append("\t\t// An appearance value: { category, name }, name the kind within the")
    js.append("\t\t// category where the value says one; or null")
    js.append("\t\tappearance: function (value) {")
    js.append("\t\t\tvar cat = looks[value >> 6], kind = looks[(value >> 6) + \".\" + (value & 63)];")
    js.append("\t\t\treturn cat ? { category: cat, name: kind || cat } : null;")
    js.append("\t\t}")
    js.append("\t};")
    js.append("")
    js.append('\tif (typeof module !== "undefined" && module.exports) module.exports = api;')
    js.append("\telse root.PirateBTNames = api;")
    js.append('})(typeof window !== "undefined" ? window : this);')
    with io.open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(js) + "\n")
    sys.stdout.write("%s: %d companies, %d services, %d appearances, %d bytes\n" %
                     (os.path.normpath(out), len(companies), len(short) + len(long_), len(looks),
                      os.path.getsize(out)))


main()
