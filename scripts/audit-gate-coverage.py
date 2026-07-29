#!/usr/bin/env python3
"""Find gated areas whose boxes don't cover the whole area they're guarding.

`ApAreaGates` decides "is this arrival inside a gated area?" by testing the
destination tile against that area's `boxes` rectangles. The LOGIC side
(BuildRegionGraph/ValidateSeed) gates by region membership behind the area's
door tiles instead. When a box is smaller than the region it protects, the two
disagree and the entrance shuffle can drop you *past* the lock: the reported
case was a shuffled entrance landing on the Legends' Guild first floor at
(2732, 3380), three tiles north of the level-1 box's z2 of 3377.

The check: in the gated region graph, any region holding at least one boxed
tile is "protected". Every other walkable tile of that region is reachable from
the boxed part without passing a door, so an arrival there bypasses the gate.
Small regions only (<= MAX_REGION_TILES) - the open-air planes are connected
enough that "same region" stops meaning "same room".

Reports two things:
  * entrance sides (trigger/arrival tiles, from ap-entrance-pool.json) sitting
    in a protected region but outside every box of that area - a leak the
    CURRENT pool can realise, and the only part that is a hard finding,
  * ADVISORY: room-sized regions (<= ADVISORY_REGION_TILES) only partly boxed,
    so a gap is visible even when no entrance lands in it this seed. A door
    whose box deliberately covers only the pocket behind it inside a much
    larger dungeon is normal and is filtered out by the size cut, not a bug.

Run from the repo root (reads the deployed Server checkout):
    python3 scripts/audit-gate-coverage.py [--server ../Server/engine]
"""
import argparse
import json
import os
import sys

# Above this a "region" is an open-air plane or a whole dungeon level, where
# same-region no longer implies same-room; box coverage isn't the right model
# for those and every one of them would report as a false leak.
MAX_REGION_TILES = 4000
# The advisory pass only makes sense for room-sized pockets: past this a region
# is a dungeon wing, where a door box covering just its own antechamber is the
# intended shape rather than a gap.
ADVISORY_REGION_TILES = 400


def load(server, name):
    with open(os.path.join(server, name), encoding='utf8') as fh:
        return json.load(fh)


def decode(coord):
    """'1_42_52_44_52' -> (level, absoluteX, absoluteZ)."""
    level, mx, mz, lx, lz = (int(part) for part in coord.split('_'))
    return level, mx * 64 + lx, mz * 64 + lz


class Graph:
    def __init__(self, raw):
        self.squares = raw['squares']
        self.regions = {r['id']: r for r in raw['regions']}

    def region_at(self, level, x, z):
        runs = self.squares.get(f'{x >> 6}_{z >> 6}', {}).get(str(level))
        if not runs:
            return 0
        index = (z & 63) * 64 + (x & 63)
        seen = 0
        for region_id, length in runs:
            if index < seen + length:
                return region_id
            seen += length
        return 0

    def small(self, region_id):
        return bool(region_id) and self.regions[region_id]['tileCount'] <= MAX_REGION_TILES


def covered_by(area, level, x, z):
    return any(b['level'] == level and b['x1'] <= x <= b['x2'] and b['z1'] <= z <= b['z2']
               for b in area['boxes'])


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument('--server', default=os.path.join(os.path.dirname(repo), 'Server', 'engine'),
                        help='engine dir holding data/config + tools/logic/region-graph.json')
    args = parser.parse_args()

    graph = Graph(load(args.server, os.path.join('tools', 'logic', 'region-graph.json')))
    areas = load(args.server, os.path.join('data', 'config', 'ap-gated-areas.json'))['areas']
    pool = load(args.server, os.path.join('data', 'config', 'ap-entrance-pool.json'))

    # protected region -> the areas that box part of it
    protected = {}
    for area in areas:
        for box in area['boxes']:
            for x in range(box['x1'], box['x2'] + 1):
                for z in range(box['z1'], box['z2'] + 1):
                    region_id = graph.region_at(box['level'], x, z)
                    if graph.small(region_id):
                        protected.setdefault((box['level'], region_id), set()).add(area['name'])

    by_name = {area['name']: area for area in areas}
    sides = []
    for gate in pool['gates']:
        sides.extend((gate['a'], gate['b']))
    sides.extend(gate.get('a', gate) for gate in pool.get('oneWays', []))

    leaks = []
    for side in sides:
        for key in ('trigger', 'arrival'):
            coord = side.get(key)
            if not coord:
                continue
            level, x, z = decode(coord)
            names = protected.get((level, graph.region_at(level, x, z)))
            if names and not any(covered_by(by_name[n], level, x, z) for n in names):
                leaks.append((coord, level, x, z, sorted(names), side.get('description', '')))

    print(f'{len(areas)} gated area(s), {len(protected)} protected region(s), '
          f'{len(sides)} entrance side(s) in the pool\n')
    print(f'entrance sides inside a protected region but outside its boxes: {len(leaks)}')
    for coord, level, x, z, names, description in leaks:
        print(f'  {coord}  L{level} ({x},{z})  {"/".join(names)}  "{description}"')

    print(f'\nADVISORY - room-sized regions (<= {ADVISORY_REGION_TILES} tiles) only partly boxed:')
    partial = 0
    for (level, region_id), names in sorted(protected.items()):
        region = graph.regions[region_id]
        if region['tileCount'] > ADVISORY_REGION_TILES:
            continue
        box = region['bbox']
        inside = outside = 0
        for x in range(box['minX'], box['maxX'] + 1):
            for z in range(box['minZ'], box['maxZ'] + 1):
                if graph.region_at(level, x, z) != region_id:
                    continue
                if any(covered_by(by_name[n], level, x, z) for n in names):
                    inside += 1
                else:
                    outside += 1
        if outside:
            partial += 1
            print(f'  L{level} region {region_id}: {outside}/{inside + outside} tile(s) uncovered'
                  f'  x{box["minX"]}-{box["maxX"]} z{box["minZ"]}-{box["maxZ"]}  {"/".join(sorted(names))}')
    print(f'\n{partial} partially-covered region(s)')
    return 1 if leaks else 0


if __name__ == '__main__':
    sys.exit(main())
