/**
 * What the game's code knows of classes besides their own methods: the classes whose
 * tile type it looks up by number, and the classes that need others (STATUS, "Classes
 * that need other classes"). Used where an episode gives up one of its own types for a
 * copy of another episode's (Editor.replaceableTypes).
 */
import { ACTOR_KIND_CLASSES } from "./actors.ts";
import { DOOR_IN_CLASS, DOOR_OUT_CLASS, STAIRS_CLASS } from "./exits.ts";
import { BACKDROP_CLASS } from "./render.ts";

/** The class → tile type table (0x43b46a fills it, 4 bytes per class id). */
export const TYPE_OF_CLASS_TABLE = 0x4c70e0;

/**
 * Classes whose tile type the code reads at a fixed entry of TYPE_OF_CLASS_TABLE (scan of
 * the exe for those addresses, 2026-11-06), with where: it draws, places or compares
 * that type, e.g. the dealer's pointing hand (84, 0x448759), the red border of a box
 * (132), the hero-state icons (135), the robots (2, 189) and the hero (1).
 */
export const CODE_LOOKUP_CLASSES: ReadonlyMap<number, readonly number[]> = new Map([
  [1, [0x435cdb]],
  [2, [0x44dd63]],
  [8, [0x40661f, 0x406727]],
  [10, [0x435e23]],
  [31, [0x435f93]],
  [40, [0x43608a]],
  [50, [0x41d2c3]],
  [51, [0x4361ac]],
  [59, [0x44fd9c]],
  [78, [0x40ff83, 0x42c823]],
  [79, [0x435f8b]],
  [84, [0x448759]],
  [94, [0x41273d]],
  [100, [0x433bbd]],
  [102, [0x447ca3]],
  [103, [0x447d83]],
  [104, [0x412c62]],
  [112, [0x412ff0]],
  [114, [0x4114ae, 0x4114d6]],
  [132, [0x43ec93, 0x44005d]],
  [135, [0x435cb4]],
  [137, [0x422674]],
  [153, [0x40aa2c]],
  [158, [0x435eb3]],
  [167, [0x4144f3]],
  [176, [0x412a36]],
  [181, [0x427d70]],
  [188, [0x4160c3]],
  [189, [0x44dd88]],
  [191, [0x4066a9]],
  [239, [0x40aaea, 0x413127, 0x427a24, 0x447f58]],
]);

/**
 * Classes the engine creates or places by number, besides CODE_LOOKUP_CLASSES: the
 * actor kinds (0x47ec98), stairs (a lit circuit node places them), doors in and out, the
 * backdrop cell, the wizard's door (class 80), the beam, class 13. Classes no room of any episode
 * has (the hero's doubles, the fireman, the game's pictures) are left to the caller.
 */
export const ENGINE_CLASSES: ReadonlyMap<number, string> = new Map([
  ...ACTOR_KIND_CLASSES.map((id) => [id, "an actor the game creates"] as const),
  [STAIRS_CLASS, "stairs: a lit circuit node places them"],
  [DOOR_IN_CLASS, "a door in: room changes"],
  [DOOR_OUT_CLASS, "a door out: room changes"],
  [BACKDROP_CLASS, "the backdrop cell"],
  [80, "the wizard's door"],
  [35, "the beam: the code places it"],
  [13, "out of order: the code sets it (0x434212, 0x446c59)"],
]);

/** A class that needs another: what it does with it. */
export interface ClassNeed {
  needs: number;
  by: number;
  how: string;
}

const need = (by: number, needs: number, how: string): ClassNeed => ({ by, needs, how });

/**
 * The classes that need others (scan of the code, 2026-11-06, STATUS "Classes that need
 * other classes"; class ids, not types): items the hero must carry, classes placed or
 * looked for, sets within an episode, types named by a text or description.
 */
export const CLASS_NEEDS: readonly ClassNeed[] = [
  need(91, 134, "the woods let the hero through with the boots"),
  ...[55, 82].flatMap((water) => [
    need(water, 111, "the fins: swimming"),
    need(water, 118, "the bucket: filled from it"),
    need(water, 181, "III's oxygen bottle"),
    need(water, 239, "III's red gem"),
  ]),
  need(59, 72, "the letters: the wand"),
  need(62, 63, "the seed: the sickle"),
  need(15, 8, "the notes: the solution book"),
  need(15, 191, "the notes: IV's mini recorder"),
  need(107, 108, "the skateboard"),
  need(201, 202, "IV's skates"),
  need(110, 113, "the telephone: the phone card"),
  need(110, 104, "the telephone: money"),
  need(116, 113, "the postman: the phone card"),
  need(116, 114, "the postman names the credit card"),
  need(127, 112, "the bus: the ticket"),
  need(129, 112, "the ship: the ticket"),
  need(115, 112, "the travel agency hands out the ticket"),
  need(56, 117, "the lamp puts flames"),
  need(56, 157, "the lamp looks for III's pipes"),
  need(56, 186, "the lamp looks for III's torch"),
  need(118, 117, "the bucket puts out fire"),
  need(118, 238, "the bucket: III's tap"),
  need(118, 136, "the bucket makes ash"),
  need(121, 119, "the machete cuts the bones"),
  need(119, 121, "the bones: the machete"),
  need(119, 112, "the bones: the ticket"),
  ...[
    [35, 57],
    [35, 60],
    [57, 35],
    [57, 60],
    [60, 35],
    [60, 57],
  ].map(([by = 0, needs = 0]) => need(by, needs, "beam, electrodes and cable ends work together")),
  need(101, 103, "the food names the toilet"),
  need(102, 103, "the food names the toilet"),
  need(119, 103, "the bones name the toilet"),
  need(25, 137, "the false wall names the magic jumping boots"),
  need(92, 94, "the stones: the amulet"),
  need(96, 176, "names III's tangram"),
  need(159, 188, "III's natives name it"),
  need(159, 239, "III's natives: the red gem"),
  need(174, 239, "the red gem"),
  need(151, 169, "III's researcher"),
  need(151, 238, "III's tap"),
  need(160, 162, "III's stool"),
  need(239, 152, "the red gem's socket"),
  need(235, 57, "IV's cylinders: the electrodes"),
  need(235, 228, "IV's cylinders: the punch"),
  need(235, 231, "IV's cylinders: the sliding doors"),
  need(234, 194, "IV's revolving door"),
  need(207, 210, "IV's 0x37 with 0x3c"),
];
