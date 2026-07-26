import { classify, constantOffsets, type CoordLiteral, type Entrance, offsetCoord } from './EntranceParser.js';
import { scanPlacements } from './LocPlacementScanner.js';

// Turns an angle-keyed handler into one concrete entrance per physical placement.
//
// A handful of stair/ladder handlers describe their destination as an offset chosen by
// the loc's map rotation rather than by its coordinate (GitHub #4 - the Tree Gnome
// Stronghold wooden spiral stairs are the visible symptom):
//
//   [oploc1,spiralstairs_wooden]
//   switch_int (loc_angle) {
//       case 0 : p_telejump(movecoord(loc_coord, 2, 1, 0));
//       ...
//
// EntranceParser emits those as `source: {type:'angle'}` with a relative destination,
// which every downstream stage (pairing, override table, logic graph) ignores because it
// needs literal source AND destination coords - so these staircases silently fell out of
// the shuffle. Everything needed to make them concrete is in the map data: each .jm2 LOC
// line carries the placement's coord and its angle, the angle picks the case, and
// `loc_coord` IS the placement coord (LOC_COORD pushes activeLoc's own tile), so
// placement + offset is an exact literal landing - no geometry inference at all.
//
// A `movecoord(coord, ...)` destination (the angled ship ladders) depends on where the
// PLAYER is parked instead, so those are expanded to a literal SOURCE only and left
// relative; ApproachResolver picks them up from there under its own reciprocal-validation
// gate, exactly as it does for literal-source ladders. Placements whose angle matches no
// case (they hit `case default`) are skipped and stay vanilla.

type AngleCase = Entrance & { source: { type: 'angle'; angle: number } };

// `consumed` holds the angle-case records that produced at least one placement, so the
// caller can drop them: they've been replaced, and leaving them in would report them a
// second time as "non-literal source" in the excluded diagnostics. An angle case with no
// placement at that rotation is NOT consumed - it stays and is correctly reported.
export type AngleExpansion = { entrances: Entrance[]; consumed: Set<Entrance>; handlers: number; skippedPlacements: number };

function isAngleCase(e: Entrance): e is AngleCase {
    // gated transitions stay vanilla for the same reason they do everywhere else - an
    // override table entry runs before nothing and would bypass the guard.
    return e.source.type === 'angle' && e.destination?.type === 'relative' && !e.gated && (e.method === 'p_telejump' || e.method === 'p_teleport');
}

export function expandAngleKeyedEntrances(entrances: Entrance[]): AngleExpansion {
    const targets = entrances.filter(isAngleCase);
    if (!targets.length) {
        return { entrances: [], consumed: new Set(), handlers: 0, skippedPlacements: 0 };
    }

    // key by loc name + op: two handlers on the same loc (a climb-up oploc1 and a
    // climb-down oploc2) each get their own set of angle cases.
    const byHandler = new Map<string, AngleCase[]>();
    for (const t of targets) {
        const key = `${t.category}:${t.op}`;
        (byHandler.get(key) ?? byHandler.set(key, []).get(key)!).push(t);
    }

    const out: Entrance[] = [];
    const consumed = new Set<Entrance>();
    let skippedPlacements = 0;

    for (const placement of scanPlacements([...new Set(targets.map(t => t.category))])) {
        for (const [key, cases] of byHandler) {
            if (key.slice(0, key.indexOf(':')) !== placement.locName) {
                continue;
            }
            const match = cases.find(c => c.source.angle === placement.angle);
            if (!match) {
                skippedPlacements++;
                continue;
            }
            out.push(concretize(match, placement.coord));
            consumed.add(match);
        }
    }

    return { entrances: out, consumed, handlers: byHandler.size, skippedPlacements };
}

function concretize(match: AngleCase, coord: CoordLiteral): Entrance {
    const source: Entrance['source'] = { type: 'literal', coord };
    // these handlers carry no per-case comment to name them by, and every placement of
    // one shares the same handler - fall back to the same "<loc> at <coord>" label the
    // map-scanned gates use so the spoiler/tracker can still tell them apart.
    const description = match.description ?? `${match.category} at ${coord.raw}`;
    const relative = match.destination!;
    if (relative.type !== 'relative') {
        return { ...match, source, description };
    }

    const locOffsets = constantOffsets(relative, ['loc_coord', 'loc_coord()']);
    const destination = locOffsets ? offsetCoord(coord, locOffsets.dx, locOffsets.dy, locOffsets.dz) : relative;
    return { ...match, source, description, destination, kind: classify(source, destination) };
}
