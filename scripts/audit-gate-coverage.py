#!/usr/bin/env python3
"""Check gated-area boxes against the walkable regions they are supposed to guard.

`ApAreaGates` decides "is this arrival inside a gated area?" by testing the
destination TILE against that area's `boxes` rectangles, so a box edge that
falls in the middle of a room is wrong in one of two directions:

  * LEAK - part of the guarded room is outside the boxes, and an entrance
    arrival there walks straight in. This is the Legends' Guild bug (2026-07-29):
    its boxes ended three tiles short of the building, and the shuffled entrance
    that landed on the first floor was never gate-checked.
  * FALSE DENIAL - the box juts into a PUBLIC room, so an arrival there is
    refused for a requirement vanilla never asked for. Worse than it sounds:
    the logic model gates by region membership behind the door tiles, so it
    thinks the tile is free and can place progression behind that entrance.

Both are the same underlying rule: **a walkable region should be entirely
inside an area's boxes or entirely outside them** - a gate boundary belongs on
a wall or a door, never across open floor. Regions that straddle get reported,
split by which side the pool can actually reach.

"Which side is the area really guarding?" is answered by how much of the region
the boxes cover. A door box that clips a few tiles of the corridor in front of
it is normal (the derived boxes are bboxes around the pocket); a box that
covers half a room means the room is what the area is for. STRADDLE_FRACTION is
that dividing line - tuned against the known cases: the real Legends' Guild leak
sat at 46% covered, while every observed spill was under 20%.

Run from the repo root (reads the deployed Server checkout):
    python3 scripts/audit-gate-coverage.py [--server ../Server/engine] [--all]
Exit status is 1 if anything in the two hard sections is reported.
"""
import argparse
import json
import os
import sys

# Above this a "region" is an open-air plane or a whole dungeon level, where
# same-region no longer implies same-room.
MAX_REGION_TILES = 4000
# Fraction of a region's tiles inside the boxes, above which the area is judged
# to be guarding that region (so unboxed tiles are a leak) rather than merely
# clipping it (so boxed tiles are a spill).
STRADDLE_FRACTION = 0.25


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

    def tiles_of(self, level, region_id):
        box = self.regions[region_id]['bbox']
        return [(x, z) for x in range(box['minX'], box['maxX'] + 1)
                for z in range(box['minZ'], box['maxZ'] + 1)
                if self.region_at(level, x, z) == region_id]


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument('--server', default=os.path.join(os.path.dirname(repo), 'Server', 'engine'),
                        help='engine dir holding data/config + tools/logic/region-graph.json')
    parser.add_argument('--all', action='store_true',
                        help='also list straddling regions no pool entrance can reach')
    args = parser.parse_args()

    graph = Graph(load(args.server, os.path.join('tools', 'logic', 'region-graph.json')))
    areas = load(args.server, os.path.join('data', 'config', 'ap-gated-areas.json'))['areas']
    pool = load(args.server, os.path.join('data', 'config', 'ap-entrance-pool.json'))

    sides = []
    for gate in pool['gates']:
        sides.extend((gate['a'], gate['b']))
    sides.extend(gate.get('a', gate) for gate in pool.get('oneWays', []))
    pool_at = {}
    for side in sides:
        for key in ('trigger', 'arrival'):
            coord = side.get(key)
            if coord:
                pool_at.setdefault(decode(coord), []).append(
                    (coord, key, side.get('description', '')))

    leaks, denials, quiet = [], [], []
    for area in areas:
        def boxed(level, x, z):
            return any(b['level'] == level and b['x1'] <= x <= b['x2'] and b['z1'] <= z <= b['z2']
                       for b in area['boxes'])

        touched = set()
        for box in area['boxes']:
            for x in range(box['x1'], box['x2'] + 1):
                for z in range(box['z1'], box['z2'] + 1):
                    region_id = graph.region_at(box['level'], x, z)
                    if region_id and graph.regions[region_id]['tileCount'] <= MAX_REGION_TILES:
                        touched.add((box['level'], region_id))

        for level, region_id in sorted(touched):
            inside, outside = [], []
            for x, z in graph.tiles_of(level, region_id):
                (inside if boxed(level, x, z) else outside).append((x, z))
            if not outside:
                continue  # region wholly inside the boxes: the boundary is a wall
            fraction = len(inside) / (len(inside) + len(outside))
            guarded = fraction >= STRADDLE_FRACTION
            reachable = [(t, pool_at[(level,) + t]) for t in (outside if guarded else inside)
                         if (level,) + t in pool_at]
            row = (area['name'], level, region_id, len(inside), len(outside), fraction, reachable)
            if not reachable:
                quiet.append((guarded, row))
            elif guarded:
                leaks.append(row)
            else:
                denials.append(row)

    def dump(rows, verb):
        for name, level, region_id, ins, outs, fraction, reachable in sorted(
                rows, key=lambda r: -r[5]):
            print(f'  {name}  L{level} region {region_id}: {ins} boxed / {outs} unboxed'
                  f' ({fraction:.0%} covered)')
            for (x, z), hits in reachable:
                for coord, key, description in hits:
                    print(f'      {coord} ({x},{z}) {key} "{description}" -> {verb}')

    print(f'{len(areas)} gated area(s), {len(pool_at)} distinct entrance tile(s) in the pool\n')
    print(f'LEAKS - guarded room (>= {STRADDLE_FRACTION:.0%} boxed) with an ungated entrance tile: {len(leaks)}')
    dump(leaks, 'ungated arrival into a guarded area')
    print(f'\nFALSE DENIALS - box juts into a public room that an entrance lands in: {len(denials)}')
    dump(denials, 'arrival refused though vanilla asks nothing here')

    if args.all:
        print(f'\nADVISORY - straddling regions no pool entrance can reach: {len(quiet)}')
        for guarded, row in sorted(quiet, key=lambda r: -r[1][5]):
            name, level, region_id, ins, outs, fraction, _ = row
            print(f'  {"leak-shaped " if guarded else "spill-shaped"} {name}'
                  f'  L{level} r{region_id}: {ins}/{ins + outs} boxed ({fraction:.0%})')
    else:
        print(f'\n({len(quiet)} more straddling region(s) with no pool entrance on them; --all to list)')
    return 1 if leaks or denials else 0


if __name__ == '__main__':
    sys.exit(main())
