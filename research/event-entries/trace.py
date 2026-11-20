"""Research script (event entries): trace every call of the award function 0x42bef0 to
its id and owners. See README.md here."""
import json, os, re, struct, sys
from collections import defaultdict

T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
EXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../reference/GameOfRobot.exe")
data = open(EXE, "rb").read()
pe = struct.unpack_from("<I", data, 0x3C)[0]
nsec = struct.unpack_from("<H", data, pe + 6)[0]
optsz = struct.unpack_from("<H", data, pe + 20)[0]
base = struct.unpack_from("<I", data, pe + 52)[0]
secs = []
for i in range(nsec):
    o = pe + 24 + optsz + 40 * i
    name = data[o:o + 8].rstrip(b"\0").decode()
    vsize, va, rsize, raw = struct.unpack_from("<IIII", data, o + 8)
    secs.append((name, base + va, vsize, raw, rsize))


def u32(va):
    for name, sva, vs, raw, rs in secs:
        if sva <= va < sva + rs:
            return struct.unpack_from("<I", data, raw + va - sva)[0]
    return None


ins = []
for l in open(T + "/dis.txt"):
    m = re.match(r"^\s+([0-9a-f]+):\t([0-9a-f ]+)\t(.*)$", l.rstrip("\n"))
    if m:
        ins.append((int(m.group(1), 16), m.group(3).strip()))
addrs = [a for a, _ in ins]
index = {a: i for i, a in enumerate(addrs)}
text = [s for s in secs if s[0] == ".text"][0]
tlo, thi = text[1], text[1] + text[2]

# references to code addresses: calls, jumps, immediates, data dwords
calls = defaultdict(list)  # target -> call sites
jumps = defaultdict(list)
imms = defaultdict(list)
jtargets = set()
for a, t in ins:
    m = re.match(r"call\s+0x([0-9a-f]+)$", t)
    if m:
        calls[int(m.group(1), 16)].append(a)
        continue
    m = re.match(r"j\w+\s+0x([0-9a-f]+)$", t)
    if m:
        jumps[int(m.group(1), 16)].append(a)
        jtargets.add(int(m.group(1), 16))
        continue
    for v in re.findall(r"0x([0-9a-f]{6})\b", t):
        v = int(v, 16)
        if tlo <= v < thi and v in index:
            imms[v].append(a)
dataref = defaultdict(list)
for name, sva, vs, raw, rs in secs:
    if name in (".text", ".rsrc"):
        continue
    for off in range(0, rs - 3, 4):
        v = struct.unpack_from("<I", data, raw + off)[0]
        if tlo <= v < thi and v in index:
            dataref[v].append(sva + off)

const_refs = defaultdict(list)
for a, t in ins:
    for v in re.findall(r"0x([0-9a-f]{6})\b", t):
        v = int(v, 16)
        if not (tlo <= v < thi):
            const_refs[v].append(a)
const_keys = sorted(const_refs)
starts = set(calls) | set(dataref) | set(imms)
# after padding
for i in range(1, len(ins)):
    if ins[i - 1][1] in ("nop", "int3"):
        if ins[i][1] not in ("nop", "int3") and ins[i][0] not in jtargets:
            if ins[i][1].startswith("push   ebp") or ins[i][1].startswith("sub    esp") or ins[i][1].startswith("push"):
                starts.add(ins[i][0])
starts = sorted(s for s in starts if s in index)
import bisect


def func_of(a):
    i = bisect.bisect_right(starts, a) - 1
    return starts[i]


# class vtables: mov dword [obj], vt   (C7 05 obj vt)
vt_of_obj = {}
tx = text[3]
for i in range(tx, tx + text[4] - 10):
    if data[i] == 0xC7 and data[i + 1] == 0x05:
        obj, vt = struct.unpack_from("<II", data, i + 2)
        if 0x4C0000 <= obj < 0x520000 and 0x466000 <= vt < 0x474000 and obj not in vt_of_obj:
            vt_of_obj[obj] = vt
dump = json.load(open(T + "/dump.json"))
vt_info = defaultdict(set)  # vtable -> {(episode, type, classid)}
touch_tables = {}  # table -> vtable
for ep in dump:
    for t in ep["types"]:
        vt = vt_of_obj.get(t["object"])
        if vt is None:
            continue
        vt_info[vt].add((ep["episode"], t["type"], t["id"]))
for vt in list(vt_info):
    touch = u32(vt + 0x0C)
    i = index.get(touch)
    if i is None:
        continue
    for k in range(i, i + 10):
        if re.match(r"call   DWORD PTR \[e[a-d]x\*4\+0x", ins[k][1]):
            tab = int(re.search(r"0x([0-9a-f]+)\]", ins[k][1]).group(1), 16)
            touch_tables[tab] = vt
            break
# every vtable-like immediate stored into an object
other_vt = {}
ctor_sites = {}
for a, t in ins:
    m = re.match(r"mov    DWORD PTR \[(e[a-z]{2}(?:\+0x[0-9a-f]+)?|ds:0x[0-9a-f]+)\],0x(4[67][0-9a-f]{4})$", t)
    if m:
        v = int(m.group(2), 16)
        if v not in vt_info:
            other_vt.setdefault(v, a)
            ctor_sites.setdefault(v, []).append(a)
EPVT = {0x466CD8: "ep0", 0x466458: "ep1", 0x4665A8: "ep2", 0x466B08: "ep3", 0x466C38: "ep4", 0x46CDF0: "epbase"}


def classify_data(addr):
    for vt in vt_info:
        if vt <= addr < vt + 0x60:
            return ("class", vt, (addr - vt))
    for tab, vt in touch_tables.items():
        if tab <= addr < tab + 12 * 4:
            return ("touch", vt, (addr - tab) // 4)
    for vt, n in EPVT.items():
        if vt <= addr < vt + 0x70:
            return ("episode", n, addr - vt)
    best = max((v for v in other_vt if v <= addr < v + 0x80), default=None)
    if best is not None:
        return ("objvt", best, addr - best)
    return ("data", addr, 0)


def owners(f, depth=0, seen=None):
    """Roots reaching function f: class vtables, touch tables, episode vtables, other."""
    seen = seen or set()
    if f in seen or depth > 6:
        return {("deep", f)}
    seen = seen | {f}
    out = set()
    for d in dataref.get(f, []):
        k = classify_data(d)
        if k[0] == "objvt":
            for site in ctor_sites.get(k[1], []):
                g = func_of(site)
                if g != f:
                    out |= {("via", k[1])} | owners(g, depth + 1, seen)
        elif k[0] == "data":
            i = bisect.bisect_right(const_keys, d) - 1
            c = const_keys[i] if i >= 0 else None
            if c is not None and d - c < 0x60:
                for site in const_refs[c]:
                    g = func_of(site)
                    if g != f:
                        out |= {("tab", c)} | owners(g, depth + 1, seen)
            else:
                out.add(("data", d))
        else:
            out.add(k[:2])
    for site in calls.get(f, []) + jumps.get(f, []) + imms.get(f, []):
        g = func_of(site)
        if g == f:
            continue
        out |= owners(g, depth + 1, seen)
    if not out:
        out.add(("noref", f))
    return out


def arg_of(i):
    """The last push before the call at ins[i], within its block."""
    for j in range(i - 1, max(0, i - 25), -1):
        a, t = ins[j]
        if t.startswith("call"):
            return "?call"
        if t.startswith("push"):
            v = t.split(None, 1)[1]
            return v
        if ins[j + 1][0] in jtargets and j + 1 != i:
            pass
    return "?"


def describe(target):
    rows = []
    for i, (a, t) in enumerate(ins):
        if t == f"call   0x{target:x}":
            f = func_of(a)
            rows.append({"site": a, "func": f, "arg": arg_of(i), "owners": sorted(map(str, owners(f)))})
    return rows


def fmt_owner(o):
    return o


def print_table():
    rows = site_table()
    def key(r):
        try:
            return (0, int(r["arg"], 16))
        except ValueError:
            return (1, 0)
    for r in sorted(rows, key=key):
        k = key(r)
        if k[0] == 0 and k[1] < 0x100:
            continue  # class keys: first takes, never an event id
        print(f"{r['arg']:>6} {k[1] if k[0] == 0 else '':>4} {r['site']:#x} f={r['func']:#x} eps={''.join(map(str, r['eps'])) or '-'} classes={r['classes'][:10]} {r['unknown'][:4]}")


def site_table(target=0x42bef0):
    rows = []
    for i, (a, t) in enumerate(ins):
        if t == f"call   0x{target:x}":
            f = func_of(a)
            own = owners(f)
            eps = set()
            unknown = []
            for o in own:
                if o[0] in ("class", "touch"):
                    eps |= {e for e, _, _ in vt_info[o[1]]}
                elif o[0] == "episode":
                    eps.add(o[1])
                elif o[0] in ("via", "tab"):
                    pass
                else:
                    unknown.append(f"{o[0]}:{o[1]:#x}" if isinstance(o[1], int) else str(o))
            classes = sorted({c for o in own if o[0] in ("class", "touch") for _, _, c in vt_info[o[1]]}, key=str)
            rows.append(dict(site=a, func=f, arg=arg_of(i), eps=sorted(eps, key=str), classes=classes, unknown=unknown if len(own) < 40 else ["WIDE"]))
    return rows


if __name__ == "__main__" and sys.argv[1] == "table":
    print_table()
elif __name__ == "__main__":
    target = int(sys.argv[1], 16)
    rows = describe(target)
    vtnames = {}
    for vt, s in vt_info.items():
        eps = sorted({e for e, _, _ in s})
        ids = sorted({str(c) for _, _, c in s})
        types = sorted({f"{e}:{t:#x}" for e, t, _ in s})
        vtnames[vt] = f"vt{vt:#x}[class {','.join(ids)} eps {''.join(map(str, eps))}]"
    for r in rows:
        own = []
        for o in owners(r["func"]):
            if o[0] in ("class", "touch"):
                own.append(o[0] + ":" + vtnames[o[1]])
            elif o[0] in ("via", "tab"):
                continue
            elif o[0] == "objvt":
                own.append(f"objvt:{o[1]:#x}(ctor {other_vt[o[1]]:#x})")
            elif o[0] == "episode":
                own.append("episode:" + o[1])
            else:
                own.append(f"{o[0]}:{o[1]:#x}")
        print(f"{r['site']:#x} f={r['func']:#x} arg={r['arg']:<10} " + " | ".join(sorted(own)))
