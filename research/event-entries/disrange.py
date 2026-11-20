import re,sys,os
lo,hi=int(sys.argv[1],16),int(sys.argv[2],16)
for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'dis.txt')):
    m=re.match(r'^\s+([0-9a-f]+):\t[0-9a-f ]+\t(.*)$',l.rstrip())
    if m and lo<=int(m.group(1),16)<hi and m.group(2)!='nop': print(m.group(1),m.group(2))
