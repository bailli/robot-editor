# Free event entries: research notes

Done 2026-11-08 (started 2026-11-07; see "Free event entries" in
[STATUS.md](../../STATUS.md)). The
result is `freeEventEntries` in `packages/formats/src/events.ts`, whose table of code
uses (`CODE_EVENT_USES`) these scripts produce. Code read throughout; the kits' events
in their new entries are checked in the game by `pnpm test:game` (native wrapper).

## Reproduce

From the repository root (needs `reference/GameOfRobot.exe`; `out/` is git-ignored,
it holds the disassembly):

    mkdir -p research/event-entries/out
    objdump -d -M intel reference/GameOfRobot.exe > research/event-entries/out/dis.txt
    node research/event-entries/dump.ts research/event-entries/out/dump.json
    python3 research/event-entries/trace.py table > research/event-entries/out/table.txt
    python3 research/event-entries/trace.py uses > research/event-entries/out/uses.json
    python3 research/event-entries/candidates.py
    python3 research/event-entries/joins.py                   # calls a jump enters
    python3 research/event-entries/trace.py 42bef0            # every call with its owners
    python3 research/event-entries/trace.py owners 40f660     # who reaches a function
    python3 research/event-entries/disrange.py 42bef0 42c000  # a range of the disassembly

- `dump.ts`: per episode the tile types' class objects and ids, the event table, and
  every script `Enigma` call with the instructions before it.
- `trace.py`: parses the objdump text; function starts are call targets, code
  addresses in `.rdata`/`.data` and immediates, and instructions after nop/int3
  padding. For each call of a function it finds the argument (the nth last push before
  the call, on the fall-through path only: see `joins.py`) and walks callers, jumps,
  immediates and data references up to roots: a class vtable (0x60 bytes) or touch
  table (12 entries, from the touch method's `call [reg*4+table]`) of an episode's
  class table, an episode vtable, or an object vtable (followed to the functions that
  construct the object). `table` prints one row per call of 0x42bef0 (award, argument
  1) and 0x43a780 (sound, argument 3) with an event id or a computed one: id, site,
  function, the episodes whose class tables hold a root class, the classes, and
  unresolved roots (`deep:` = depth limit, `data:` = an unclassified data reference,
  `WIDE` = more than 40 roots, i.e. engine code). `uses` merges the rows per id into
  class vtables, episode methods or engine code, with the hand resolutions below
  (`MANUAL`, `JOINED`, the oracle); its JSON is what `CODE_EVENT_USES` holds (episode
  methods as the episode's vtable).
- `candidates.py`: per episode, its entries from 128 on, grouped: no code uses the id;
  only code of classes the episode lacks (or unresolved, marked `?`); used by its own
  classes or engine code. Script Enigma calls are not in it.
- `joins.py`: calls a jump enters between the argument's push and the call (another
  path may push another id).

## Findings

**The award, 0x42bef0(id)** (cdecl, one argument): the once-only key is bit `id` of
0x4fe324; the entry is 0x43a710(id) = `0x4c70e0[id]` when id < 0x188, the value is
nonzero and below the entry count, else **entry 0**. So an id nothing maps shares entry
0's sound/points/text; the bit is still its own. 0x4c70e0 holds class → tile type below
256 (0x43b46a) and event id → entry from the constructor's loop over entries 128..count
(0x43b4b1; ids of 0 skipped). Text 1800 + `0x4c70e0[id]` (vtable +0x38), no bounds check.

**Enigma takes an entry.** The script's `Enigma(n)` (0x407aa0): 0x43a750(n) gives entry n
(entry 0 if n ≥ count), then 0x42bef0(**entry n's id**). The **console's `ENIGMA n`**
(0x43ca95) instead passes n straight to 0x42bef0: an **id**.

**Every event id raised is in the tables.** At 115 of the 117 calls the id is an
immediate or one of: the script Enigma (entry → id), the oracle 0x412c14 (0x106 +
(state & 0xf): 262–277), first takes in 0x42c010 (`class & 0xff`, below 256) and the
console. Two calls are entered by a jump with another push (`joins.py`): 0x40f511
pushes **315** for the slot machine (class 70, its jump table at 0x40f5d8), and the
take function's 0x42c1a1 pushes **0x141 + state** for class 239, **III's gems** (states
0–3: ids 321–324, entries 128–131 with the gems' texts); the third (0x4152e0) only
another class key. Ids below 256 are class keys (first takes) and never collide with
event ids. No logic record awards events; the only other accesses to the bitset are a
query by id (0x42bed5), save and load, and the console's CLRENIGMA.

**Sounds by id**: 0x43a780 plays an event's sound without awarding it (7 calls, the id
in argument 3): 298 (I's method 0x4095e0, the ending's FINALE), 304 (class 129, II),
317 (the exits' class 33 and the take function: every episode), 318 (the window code,
I's method 0x4096c0, the base episode method 0x43b660: every episode). An entry whose
sound is played this way is used too.

**Savegames** keep the raised events by entry (0x438ca0: bit n set when entry n's id
is raised; loading, 0x438bc5, sets the bit of entry n's id). An event without an entry
of its own loses its once-only state on loading; a mod that changes entry ids reads old
savegames by entry number.

**Script Enigma calls** (only II and IV have any; sources and compiled scripts agree): II
rooms 53 → 181, 683 → 112; IV: 180–185, 188, 191–196. IV's 186, 187, 189, 190 have texts
("Dieses Terminal hier solltest Du Dir merken", the punch, a machine starting) but no
room awards them: cut content, like IV's 348 (the little train), 358 (the recorder) and
the banks' 296, 297 (Junior, I, II), which no code raises either.

**Owners resolved by hand**:
- 287 (0x410050): a magic-word handler (word table 0x481acc, handler 0x42c820 checks
  the letters, class 78's type); needs `Wizzard` (0x4fe370) and the registration check
  (0x42f3a0, 0x42f910), raises 287, places class 80 (the wizard's door): class 78.
- 290, 310–313, 317 (0x4514a0, 0x44f690, 0x44f150): the computer's programs (records
  at 0x4834e0… filled by the static initializer 0x4519e0, CRT init list at 0x474520;
  the dialog of STATUS's "Computer" kit, 0x4524e0, runs them): class 53.
- 331, 335, 337 (0x447370, 0x447230, 0x4475e0): hero state objects 11 (hammer), 10
  (axe), 12 (bridle), set only by classes 180, 179, 166 (`CLASS_HERO_STATES`).
- 276 (0x42e6e0, 0x42ec30, the rucksack window's key handlers): the item menu
  (0x51bb60, vtable 0x46cba8, entries {text 8400 + k, 0, kind} copied from 0x482100)
  offers kind 3 (text 8403) when the hero carries class 73, the **joker** (I's text 63
  "Dies ist ein JOKER"); chosen, the joker goes (0x42c220(0x49)), the item is added
  again (0x42c2e0; type 0xea with a random state) and 276 is raised. Kind 2 (8402) needs
  class 36, the exclamation mark. Every episode has the joker: class 73.
- The oracle's 262–277: wherever the oracle class (vtable 0x467d90) is, whatever its
  rooms' oracles' states; so oracle events stay reserved once the kit is in, before
  any oracle is placed.
- 291 (0x425ae0; a static initializer also reaches it), 328, 342 (III; function starts
  not found), 285, 286 (0x44da70) and 292 (0x4251e0, hundreds of callers): engine.

**Free entries in the originals** (`freeEventEntries` with the episodes' own rooms):

| Ep  | Free | Nothing uses             | The rest: events only classes the episode lacks use       |
| --- | ---: | ------------------------ | --------------------------------------------------------- |
| 0   |   37 | 168, 169, 181, 188, 190  | the oracle's 134–143, the computer's, the slot machine's… |
| 1   |   22 | 168, 169, 181, 188, 190  | the oracle's 134–143, III's and II's classes'             |
| 2   |    4 | 168, 169, 188            | 170 (298: I's ending, Junior's goal)                      |
| 3   |    1 | 186                      |                                                           |
| 4   |   16 | 131, 134, 147, 169, 174, 186, 187, 189, 190, 197–200 | 154 (282), 170 (298), 171 (299)   |

Without rooms (a mod replacing them all), the entries only their scripts award are
free too: II's 181, IV's 180–185, 188, 191–196.

**Choosing among free entries** (kit planner, editor): an entry keeps its own text and
sound line unless the new event brings them (a mod cannot clear a sound line). So
entries without a text or sound come first; the planner removes an old text where the
event has none (`KitPlan.cleared`) and gives an event without a sound only an entry
without one; the editor refuses such a copy instead.

## Caveats

- **Branches are not told apart**: code shared by all episodes may raise an id only in
  one episode (e.g. 363, 366, 367 in the exits' 0x44b180 are probably IV-only). This
  only makes entries look used, never free.
- **Ownership by vtable**: a root class counts for an episode when the episode's class
  table holds that vtable; copied classes (kits) bring their uses along, and the
  planner counts a kit's classes before they are copied.
- **Class presence, not placement**: a class in the table counts even if no room has
  it (the joker's 276 stays used everywhere).
