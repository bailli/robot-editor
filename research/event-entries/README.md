# Free event entries: research notes (in progress)

Started 2026-11-07 (see "Free event entries" in [STATUS.md](../../STATUS.md) and step 1
of the plan there). Code only so far, nothing tried in the game.
Written to survive an interruption: the findings, how to reproduce them, and what is
left are all here.

## Reproduce

From the repository root (needs `reference/GameOfRobot.exe`; `out/` is git-ignored,
it holds the disassembly):

    mkdir -p research/event-entries/out
    objdump -d -M intel reference/GameOfRobot.exe > research/event-entries/out/dis.txt
    node research/event-entries/dump.ts research/event-entries/out/dump.json
    python3 research/event-entries/trace.py table > research/event-entries/out/table.txt
    python3 research/event-entries/candidates.py
    python3 research/event-entries/trace.py 42bef0           # every call with its owners
    python3 research/event-entries/disrange.py 42bef0 42c000  # a range of the disassembly

- `dump.ts`: per episode the tile types' class objects and ids, the event table, and
  every script `Enigma` call with the instructions before it.
- `trace.py`: parses the objdump text; function starts are call targets, code
  addresses in `.rdata`/`.data` and immediates, and instructions after nop/int3
  padding. For each call of a function (default 0x42bef0) it finds the argument (the
  last push before the call; correct for one-argument functions only) and walks
  callers, jumps, immediates and data references up to roots: a class vtable (0x60
  bytes) or touch table (12 entries, from the touch method's `call [reg*4+table]`) of
  an episode's class table, an episode vtable, or an object vtable (followed to the
  functions that construct the object). `table` prints one row per call with an
  event id or a computed one: id, site, function, the episodes whose class tables hold
  a root class, the classes, and unresolved roots (`deep:` = depth limit, `data:` = an
  unclassified data reference, `WIDE` = more than 40 roots, i.e. engine code).
- `candidates.py`: per episode, its entries from 128 on, grouped: no code raises the
  id; only code of classes the episode lacks (or unresolved, marked `?`); raised by its
  own classes or engine code. Script Enigma calls are not in it (see below).

## Findings

**The award, 0x42bef0(id)** (cdecl, one argument): the once-only key is bit `id` of
0x4fe324; the entry is 0x43a710(id) = `0x4c70e0[id]` when id < 0x188, the value is
nonzero and below the entry count, else **entry 0**. So an id nothing maps shares entry
0's sound/points/text; the bit is still its own. 0x4c70e0 holds class → tile type below
256 (0x43b46a) and event id → entry from the constructor's loop over entries 128..count
(0x43b4b1; ids of 0 skipped). Text 1800 + `0x4c70e0[id]` (vtable +0x38), no bounds check.

**Enigma takes an entry (resolved).** The script's `Enigma(n)` (0x407aa0): 0x43a750(n)
gives entry n (entry 0 if n ≥ count), then 0x42bef0(**entry n's id**). So the docs are
right: an entry number, and the key is that entry's id (II's `Enigma(112)` raises the
id of tile-type entry 112). The **console's `ENIGMA n`** (0x43ca95) instead passes n
straight to 0x42bef0: an **id**, not an entry (help-dialog and STATUS say "event n").

**All 117 calls of 0x42bef0 are accounted for.** The id is an immediate everywhere
except: the script Enigma (entry → id), the oracle 0x412c14 (0x106 + (state & 0xf):
ids 262–277; the oracles' 3500-point entries are 262–271), first takes in 0x42c010
(`class & 0xff`, below 256) and the console. Ids below 256 are class keys (first takes,
also 0x0a, 0x30, 0x6e, 0x9e, 0xa4, 0xe4, 0xe8 as immediates) and never collide with
event ids. **So no event id is raised that the table does not show**; what is left is
which code runs in which episode (ownership).

**Script Enigma calls** (only II and IV have any): II rooms 53 → 181, 683 → 112;
IV: 180, 181, 182, 183, 184, 185, 188, 191, 192, 193, 194, 195, 196. IV's 186, 187, 189,
190 are **not** awarded by any script (events.ts says "IV's scripts award 180–196").

**Owners resolved by hand** (the tracer's unresolved rows):
- 287 (0x410050): a magic-word handler (word table 0x481acc, handler 0x42c820 checks
  the letters, class 78's type); needs `Wizzard` (0x4fe370) and the registration check
  (0x42f3a0, 0x42f910), raises 287, places class 80 (the wizard's door). Episode I only
  in practice (letters and Wizzard).
- 290, 310, 311, 312, 313, 317 (0x4514a0, 0x44f690, 0x44f150): the computer's
  programs. Records at 0x4834e0… are filled by the static initializer 0x4519e0 (CRT
  init list at 0x474520, walked by 0x45c8b2) with handler pointers (0x4519c0 →
  0x44f400 → object vtable 0x46d968; 0x4519d0 → 0x450040 → vtable 0x46d990;
  0x451570 → 0x4514a0). Raised only through the computer (class 53, I and II; the
  Computer kit). To confirm: that only the computer starts these programs.
- 331, 335, 337 (0x447370, 0x447230, 0x4475e0): hero state objects 11 (hammer), 10
  (axe), 12 (bridle), built by static initializers (list at 0x4744c0). Those states are
  set only by classes 180, 179, 166 (III; `CLASS_HERO_STATES`), so the ids come with
  the Axe & bridges kit.
- 276 (0x42e6e0 and 0x42ec30, both methods of object vtable 0x46cb80): the **rucksack
  window** (keys Enter/Esc/arrows); made by 0x42dda0 / 0x42ef20 from 0x43bc90 (window
  code), so engine code in every episode. The branch: Enter on an item while the object
  at 0x51bb60 (set at 0x42e055 / 0x42e3f8) is open and its last entry's kind
  (`[obj + (count*3 + 0x42)*4]`, count at +0x104) is 3: raise 276, 0x42c220(0x49),
  0x42c2e0(item). Looks like handing an item to someone (a trade); **open**: what
  0x51bb60 is and which episodes can reach kind 3. Until then treat 276 as used.
- 291 (0x425ae0): classes 35, 57, 60 (I, II, IV) and a static initializer (0x4743c8);
  treat as used where those classes are.
- 328 (0x4155d0), 342 (0x416674): III ids, function starts not found (0x416674 matched
  import-name strings at 0x473114); irrelevant outside III.
- 285, 286 (0x44da70) and 292 (0x4251e0): reached from hundreds of places (actors,
  engine): used in every episode.

**Per episode, entries from 128 on** (`candidates.py`; code raisers only; script Enigma
added in the last column):

| Ep  | No code raiser (entry:id)                                                                     | Only other episodes' classes                                                                                                   | Scripts award |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 0   | 134–143 (262–271, oracles), 168:296, 169:297, 176:304, 181:309, 187:315, 188:316, 190:0, 191:318 | 131:259, 146:274, 147:275, 149:277, 150:278, 151:279, 159:287, 161:289, 162:290, 163:291, 165–167:293–295, 174:302, 178:306, 180:308, 182–185:310–313, 186:314, 189:317 (276 open) | none          |
| 1   | as Junior                                                                                     | 131:259, 147:275, 149:277, 150:278, 151:279, 170:298, 180:308 (+ 287, 290, 310–313, 317 are I's own: wizard, computer)          | none          |
| 2   | 134–143, 168:296, 169:297, 176:304, 181:309, 187:315, 188:316, 191:318                          | 170:298 (+ 290, 310–313, 317 if II has the computer: it does, class 53)                                                        | 112, 181      |
| 3   | 128:321, 129:322, 130:323, 131:324, 154–163 (oracles), 184:318, 186:316                          | 185:317 (computer)                                                                                                             | none          |
| 4   | 131:348, 134:349, 147:358, 169:297, 174:316, 177:318, 186:377, 187:378, 189:380, 190:381, 197–200 | 154:282, 170:298, 171:299 (276 open)                                                                                           | 180–185, 188, 191–196 |

The oracle entries (262–271) are free when no oracle of the episode's rooms has that
state (a mod replacing all rooms decides this itself). "Only other episodes' classes"
entries are free as long as no kit brings that class (or hero state, or the computer).

**For Junior with all its rooms replaced:** without kits, Junior has 8 entries
no code raises (168, 169, 176, 181, 187, 188, 190, 191), the oracle entries its new
rooms leave unused, and about 20 entries raised only by classes Junior lacks. The kits
need seven ids (331, 335 Axe & bridges; 350–353, 370 Punch cards); that fits easily,
so the fallback (a larger table) should not be needed. Note that the kits' own classes
then raise ids Junior's other entries hold only if those classes are among the
"other episodes' classes" above: check per kit (e.g. Swimming brings class 55/82's
0x427450, which raises 274 and 329; Computer brings 289, 290, 310–313, 317).

## Caveats and open items

- **Branches are not told apart**: code shared by all episodes may raise an id only in
  one episode (e.g. 363, 366, 367 in the exits' 0x44b180 are probably IV-only). This
  only makes entries look used, never free, so it is safe.
- **Ownership by vtable**: a root class counts for an episode when the episode's class
  table holds that vtable. Copied classes (kits) bring their raisers along.
- **276**: identify 0x51bb60 and the kind-3 entry (see above).
- **0x43a780** (play an event's sound by id, 7 calls; id is the third argument, so the
  tracer's "last push" column is wrong for it): list its ids; a repurposed entry
  changes the sound those calls play.
- **Entry 0 fallback**: an id with no entry plays entry 0's sound and shows text 1800.
  If a kit's id is raised in an episode without its entry, that is what happens.
- Not yet checked whether logic records or tasks raise events by other routes than
  0x42bef0 (none seen: all writes to the bitset 0x4fe324 besides 0x42bef0 are
  0x42bed5 (a test), 0x438bfa/0x438ccb (save/load?) and 0x43cabb (console CLRENIGMA)).
- Next: confirm the computer programs' reach and 276; then `freeEventEntries(episode,
  rooms, kits)` in `events.ts`, replacing `SPARE_ENTRIES` (kit planner, editor);
  update STATUS.md ("Free event entries", the event-table text under "The mod format",
  the console's ENIGMA as an id) and events.ts' doc comment (IV's scripts).
