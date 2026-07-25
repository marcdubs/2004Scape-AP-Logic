# Construct-valid entrance randomization for the 2004Scape apworld (GitHub #3).
#
# The LOCAL randomizer (tools/map/RandomizeEntrances.ts) shuffles the pool with a
# derangement and then rerolls until tools/logic/ValidateSeed.ts says the result is
# beatable - generate-and-test. That stays: it is how solo seeds are made, and
# --require-perfect is its acceptance criterion.
#
# Archipelago cannot reroll: its fill runs once, over a layout that must already be
# sound. So AP mode builds the layout the way Archipelago's own
# worlds/generic/randomize_entrances does - a reachability-preserving frontier:
#
#   while unpaired exits remain:
#     pick a RANDOM unpaired exit whose trigger region is already reachable
#     pair it with a partner that opens new ground (falling back to any partner)
#     re-derive reachability and repeat
#
# Because every exit is only ever consumed once it is reachable, the layout is connected
# by construction and there is nothing to reroll.
#
# The pool's structure (see RandomizeEntrances.ts): each physical gate has two sides, A
# and B, and side A's "arrival" tile sits next to side B's trigger. Pairing gate i's A
# side with gate j's B side therefore means:
#
#   overrides[i.a.trigger] = j.a.arrival   (enter at i.a, come out next to j.b)
#   overrides[j.b.trigger] = i.b.arrival   (go back through j.b, come out next to i.a)
#
# which is exactly the reciprocity the local tool guarantees - walk back the way you came
# and you end up where you started. The vanilla layout is the identity pairing i.a <-> i.b.

from __future__ import annotations

import random
from typing import Dict, List, Optional, Sequence, Set, Tuple

from .logic import LogicEngine


class EntranceShuffler:
    """Builds a reachability-preserving entrance assignment over the exported pool."""

    def __init__(self, engine: LogicEngine, rng: random.Random,
                 pools: Optional[Sequence[str]] = None, mixed: bool = False):
        self.engine = engine
        self.rng = rng
        self.gates = engine.pool.gates
        self.one_ways = engine.pool.one_ways
        # the local tool keeps 'connector' (dungeon/area) and 'floor-shift' (building
        # stairs) in separate pools so buildings lead to buildings; --mixed merges them.
        if mixed:
            self.groups: Dict[str, List[int]] = {"mixed": list(range(len(self.gates)))}
        else:
            self.groups = {}
            for index, gate in enumerate(self.gates):
                self.groups.setdefault(gate["pool"], []).append(index)
        if pools is not None:
            self.groups = {name: members for name, members in self.groups.items() if name in pools}

        self._all_triggers = {side["trigger"] for side in engine.pool.sides()}
        self._all_triggers |= {one_way["trigger"] for one_way in self.one_ways}

    # -- helpers ------------------------------------------------------------

    def _overrides_for(self, pairing: Dict[int, int]) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for i, j in pairing.items():
            gate_i, gate_j = self.gates[i], self.gates[j]
            out[LogicEngine.pool_side_key(gate_i["a"])] = gate_j["a"]["arrival"]
            out[LogicEngine.pool_side_key(gate_j["b"])] = gate_i["b"]["arrival"]
        return out

    def _reachable(self, pairing: Dict[int, int]) -> Set[int]:
        """Regions reachable under a PARTIAL layout, at maximal player state.

        Maximal state (uncapped skills, every quest gate held) is the right oracle for
        laying out a map: the question here is purely spatial - can the player ever walk
        there - while whether the ITEMS are placed reachably is Archipelago's fill's job,
        answered against the same engine once the layout is fixed.
        """
        self.engine.set_overrides(self._overrides_for(pairing), reserved_triggers=self._all_triggers)
        return set(self.engine.derive(self.engine.uncapped(),
                                      unlocked_quests=self.engine.quest_gates).regions)

    # -- the frontier -------------------------------------------------------

    def shuffle(self) -> Dict[str, str]:
        pairing: Dict[int, int] = {}
        for members in self.groups.values():
            self._shuffle_group(members, pairing)
        overrides = self._overrides_for(pairing)
        overrides.update(self._shuffle_one_ways())
        self.engine.set_overrides(overrides)
        return overrides

    def _shuffle_group(self, members: Sequence[int], pairing: Dict[int, int]) -> None:
        if len(members) < 2:
            return
        free_a: Set[int] = set(members)   # gates whose A side has no partner yet
        free_b: Set[int] = set(members)   # gates whose B side is unclaimed
        reachable = self._reachable(pairing)

        while free_a:
            # every unpaired exit currently standing on reachable ground; an A side and a
            # B side are both exits, they just get consumed from opposite ends.
            open_a = [i for i in free_a if self.gates[i]["a"]["triggerRegion"] in reachable]
            open_b = [j for j in free_b if self.gates[j]["b"]["triggerRegion"] in reachable]
            if not open_a and not open_b:
                # Nothing left standing on reachable ground: the remainder can only form a
                # closed loop off the map. Pair it up vanilla-style so the table is still
                # total and reciprocal (this is the same residue the local tool leaves
                # behind as "unpairable"; it strands nothing that was reachable).
                self._pair_remainder(free_a, free_b, pairing)
                return

            if open_a and (not open_b or self.rng.random() < 0.5):
                source = self.rng.choice(open_a)
                partner = self._pick_partner(free_b, reachable, key="b", exclude=source,
                                             last=len(free_a) == 1)
                pairing[source] = partner
            else:
                partner = self.rng.choice(open_b)
                source = self._pick_partner(free_a, reachable, key="a", exclude=partner,
                                            last=len(free_a) == 1)
                pairing[source] = partner
            free_a.discard(source)
            free_b.discard(partner)
            reachable = self._reachable(pairing)

    def _pick_partner(self, free: Set[int], reachable: Set[int], key: str,
                      exclude: int, last: bool) -> int:
        """Prefer a partner that opens NEW ground; never self-pair unless forced."""
        candidates = [g for g in free if g != exclude] or list(free)
        fresh = [g for g in candidates if self.gates[g][key]["triggerRegion"] not in reachable]
        if fresh and not last:
            return self.rng.choice(fresh)
        return self.rng.choice(candidates)

    def _pair_remainder(self, free_a: Set[int], free_b: Set[int], pairing: Dict[int, int]) -> None:
        left = sorted(free_a)
        right = sorted(free_b)
        self.rng.shuffle(right)
        for source, partner in zip(left, right):
            pairing[source] = partner
        free_a.clear()
        free_b.clear()

    def _shuffle_one_ways(self) -> Dict[str, str]:
        """One-ways have no far side to come back through, so reciprocity does not apply -
        a plain derangement of arrivals is safe as long as every trigger stays reachable,
        which the two-way frontier above has already established."""
        if len(self.one_ways) < 2:
            return {}
        order = list(range(len(self.one_ways)))
        for _ in range(16):
            shuffled = order[:]
            self.rng.shuffle(shuffled)
            if all(a != b for a, b in zip(order, shuffled)):
                break
        else:
            shuffled = order[1:] + order[:1]
        return {
            LogicEngine.pool_side_key(self.one_ways[i]): self.one_ways[j]["arrival"]
            for i, j in zip(order, shuffled)
        }


def randomize_entrances(engine: LogicEngine, rng: random.Random, mixed: bool = False) -> Dict[str, str]:
    """Convenience wrapper: returns the override table and installs it on `engine`."""
    return EntranceShuffler(engine, rng, mixed=mixed).shuffle()


def vanilla_entrances(engine: LogicEngine) -> Dict[str, str]:
    overrides = engine.pool.vanilla_overrides()
    engine.set_overrides(overrides)
    return overrides


def coverage(engine: LogicEngine, overrides: Dict[str, str]) -> Tuple[int, int]:
    """(reachable pool sides, total pool sides) under the given layout at maximal state -
    the layout-quality number the shuffle is built to keep at 100%."""
    engine.set_overrides(overrides)
    reachable = engine.derive(engine.uncapped(), unlocked_quests=engine.quest_gates).regions
    sides = engine.pool.sides() + engine.pool.one_ways
    return sum(1 for s in sides if s["triggerRegion"] in reachable), len(sides)
