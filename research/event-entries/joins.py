"""Research script (event entries): calls of 0x42bef0 / 0x43a780 that a jump enters between
the argument's push and the call, so another path may push another id (trace.py's
argument is only the fall-through path's). Prints each with the jumps into it."""
import re, sys, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
ins = []
for l in open(os.path.join(OUT, "dis.txt")):
    m = re.match(r"^\s+([0-9a-f]+):\t[0-9a-f ]+\t(.*)$", l.rstrip("\n"))
    if m:
        ins.append((int(m.group(1), 16), m.group(2).strip()))
jumps = {}
for a, t in ins:
    m = re.match(r"j\w+\s+0x([0-9a-f]+)$", t)
    if m:
        jumps.setdefault(int(m.group(1), 16), []).append(a)
for target, nth in ((0x42BEF0, 1), (0x43A780, 3)):
    for i, (a, t) in enumerate(ins):
        if t != f"call   0x{target:x}":
            continue
        pushes, j = 0, i - 1
        while j > 0 and pushes < nth:
            if ins[j][1].startswith("push"):
                pushes += 1
            j -= 1
        entered = [(b, jumps[b]) for b, _ in ins[j + 2 : i + 1] if b in jumps]
        if entered:
            print(f"{target:#x} call {a:#x}:", ", ".join(f"{b:#x} <- {[hex(x) for x in s]}" for b, s in entered))
