# The rest of the seed, rolled inside the apworld (GitHub #3, follow-up).
#
# Entrance randomization ships a finished TABLE to the game server (it is a runtime JSON
# read, so the server can just adopt it). The other four randomizers cannot all work that
# way - shopsanity mutates .npc config and needs a content pack rebuild - so they use the
# other half of the same trick: **Archipelago picks the seed, and the deterministic
# TypeScript tools reproduce the identical table server-side.**
#
# That only helps if the apworld knows what the tables WILL be, which is the point: with
# these rolled during generation, the fill reasons about the real world -
#
#   - gathersanity / processsanity re-key which action yields which item, so item
#     obtainability (and therefore every quest that needs a gathered/processed item)
#     changes with the roll;
#   - shopsanity moves shops between NPCs, so an item's "buy" source moves to wherever
#     its new shopkeeper stands;
#   - spawn randomization changes where you start, i.e. sphere 0 itself.
#
# Every roll here mirrors its TypeScript original exactly - same ordered candidate pool
# (exported by that tool's own `--export-pool`), same PRNG (prng.py is a byte-exact port
# of Prng.ts, pinned by test vectors), same pin rules, same mode semantics. new-run.sh
# feeds all of them one shared `$SEED`, which is why one number is enough.

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence

from .prng import derangement, hash_key, mulberry32, shuffle


@dataclass
class SkillSwapRoll:
    """One gathersanity / processsanity table."""

    swaps: Dict[str, str] = field(default_factory=dict)          # product name -> delivered name
    table: Dict[str, int] = field(default_factory=dict)          # obj id (string) -> obj id
    pinned: Dict[str, str] = field(default_factory=dict)         # product -> why it stayed vanilla
    mode: str = "off"


def roll_skill_swaps(pool: Mapping, seed: int, mode: str,
                     quest_pins: Optional[bool] = None) -> SkillSwapRoll:
    """Port of RandomizeGathering/RandomizeProcessing's main().

    `mode` is off | shuffle | tiered | chaos. Quest-critical pinning is mode-aware exactly
    as in the tools: off in shuffle and tiered (both are bijections, so everything stays
    obtainable and the item just moves), on in chaos (which genuinely can orphan a
    product).

    tiered runs shuffle's derangement once per PROGRESSION BAND instead of once over the
    whole pool, so a product only ever becomes another product of a similar skill level.
    The band boundaries are NOT re-derived here: the TS tool stamps each product with the
    band it landed in and exports the band order alongside, and this groups by those
    strings. That is deliberate - a band table duplicated on both sides is a table that
    can drift, and a drifted band means the apworld's logic describes swaps the server
    never made.
    """
    if mode not in ("shuffle", "tiered", "chaos"):
        return SkillSwapRoll(mode="off")

    products = [entry["item"] for entry in pool["products"]]
    obj_ids = {entry["item"]: entry["objId"] for entry in pool["products"]}
    band_of = {entry["item"]: entry.get("band") for entry in pool["products"]}

    pin_quest_items = (mode == "chaos") if quest_pins is None else quest_pins
    pinned: Dict[str, str] = {}
    for item, reason in pool.get("hardExcluded", {}).items():
        if item in obj_ids:
            pinned[item] = reason
    if pin_quest_items:
        for item in pool.get("questCritical", ()):
            if item in obj_ids:
                pinned.setdefault(item, "quest-critical (inv_total/inv_del gate in a quest script)")

    candidates = [item for item in products if item not in pinned]
    if len(candidates) < 2:
        return SkillSwapRoll(pinned=pinned, mode=mode)

    swaps: Dict[str, str] = {}
    if mode == "tiered":
        # one derangement per band, each on its own stream (salted by band NAME, so
        # widening one band later does not reshuffle the others). A band holding fewer
        # than 2 eligible products can't be deranged - its member stays vanilla.
        for band in pool.get("bands", ()):
            members = [item for item in candidates if band_of.get(item) == band]
            if len(members) < 2:
                continue
            rand = mulberry32(seed ^ hash_key(band))
            perm = derangement(len(members), rand)
            for index, item in enumerate(members):
                swaps[item] = members[perm[index]]
    elif mode == "shuffle":
        rand = mulberry32(seed)
        perm = derangement(len(candidates), rand)
        for index, item in enumerate(candidates):
            swaps[item] = candidates[perm[index]]
    else:
        # chaos: independent uniform resample per product, retried up to 50x so nothing
        # keeps its own value by accident (same loop shape as the TS original).
        rand = mulberry32(seed)
        for item in candidates:
            picked = item
            for _ in range(50):
                if picked != item:
                    break
                picked = candidates[int(rand() * len(candidates))]
            swaps[item] = picked

    table = {str(obj_ids[was]): obj_ids[now] for was, now in swaps.items()}
    return SkillSwapRoll(swaps=swaps, table=table, pinned=pinned, mode=mode)


@dataclass
class ShopRoll:
    """Where each shop ended up.

    Keyed by BUNDLE (the shopkeeper NPC that stocked it in vanilla), not by shop id:
    several NPCs can share one shop id (two barmaids, one pub inventory), so "who owns
    shop S now" is ambiguous while "who took over this particular shopkeeper's stock" is
    not - and only the latter reduces to the identity when shopsanity is off.
    """

    successor: Dict[str, str] = field(default_factory=dict)   # vanilla shopkeeper -> whoever stocks their goods now
    stocks_now: Dict[str, str] = field(default_factory=dict)  # shopkeeper -> the shop id they stock now
    moved: int = 0
    enabled: bool = False


def roll_shops(pool: Mapping, seed: int, enabled: bool) -> ShopRoll:
    """Port of RandomizeShops's derangement: eligible[i] takes eligible[perm[i]]'s shop.

    Shopsanity is a content mutation (it rewrites .npc params and needs a pack rebuild),
    so the apworld cannot hand the server a finished table - it hands over the seed and
    the server's own roll lands exactly here. Excluded bundles (shop ids hardcoded in
    scripts) always keep their own shop.
    """
    eligible = list(pool.get("eligible", ()))
    excluded = list(pool.get("excluded", ()))

    successor = {bundle["npc"]: bundle["npc"] for bundle in eligible + excluded}
    stocks_now = {bundle["npc"]: bundle["shop"] for bundle in eligible + excluded}
    if not enabled or len(eligible) < 2:
        return ShopRoll(successor=successor, stocks_now=stocks_now, enabled=False)

    rand = mulberry32(seed)
    perm = derangement(len(eligible), rand)
    for index, bundle in enumerate(eligible):
        source = eligible[perm[index]]
        stocks_now[bundle["npc"]] = source["shop"]
        # whatever `source` used to sell, you now buy from `bundle`
        successor[source["npc"]] = bundle["npc"]
    return ShopRoll(successor=successor, stocks_now=stocks_now, moved=len(eligible), enabled=True)


@dataclass
class SpawnRoll:
    coord: str
    label: str
    region: int


def roll_spawn(pool: Mapping, seed: int, mode: str) -> SpawnRoll:
    """Port of RandomizeSpawn's pick: one rand() into the mode's candidate list."""
    vanilla = pool["vanilla"]
    if mode not in ("city", "chunk"):
        return SpawnRoll(vanilla["coord"], vanilla["label"], vanilla["region"])
    candidates = list(pool.get(mode, ()))
    if not candidates:
        return SpawnRoll(vanilla["coord"], vanilla["label"], vanilla["region"])
    rand = mulberry32(seed)
    pick = candidates[int(rand() * len(candidates))]
    return SpawnRoll(pick["coord"], pick["label"], pick["region"])


def relocate_buy_sources(item_sources: Mapping[str, Sequence[dict]], shops: Mapping,
                         roll: ShopRoll) -> Dict[str, List[dict]]:
    """Re-point every `via: buy` source at whoever sells that item NOW.

    An item's vanilla shopkeepers each stocked it somewhere; after the shuffle their
    stock sits with a different NPC, standing somewhere else. Shopkeepers with no bundle
    at all (a stock list reached some other way) stay put - the model only ever moves
    what it can account for.

    With identity ownership this reproduces the exported vanilla regions exactly, which
    is why the shopsanity-off path can just skip it (and a test pins that).
    """
    buy_owners: Mapping[str, Sequence[str]] = shops.get("buyOwners", {})
    npc_regions: Mapping[str, int] = shops.get("npcRegions", {})

    out: Dict[str, List[dict]] = {item: list(sources) for item, sources in item_sources.items()}
    for item, vanilla_owners in buy_owners.items():
        regions = set()
        for npc in vanilla_owners:
            region = npc_regions.get(roll.successor.get(npc, npc))
            if region:
                regions.add(region)
        kept = [s for s in out.get(item, ()) if s.get("via") != "buy"]
        relocated = kept + [{"region": region, "via": "buy"} for region in sorted(regions)]
        if relocated:
            out[item] = relocated
        else:
            out.pop(item, None)
    return out


# ---------------------------------------------------------------------------
# drop randomization
# ---------------------------------------------------------------------------


def _pick_different(pool: Sequence[str], avoid: str, rand) -> Optional[str]:
    """RandomizeDrops.pickDifferent: resample up to 50x to avoid keeping the same item."""
    if not pool:
        return None
    candidate = avoid
    for _ in range(50):
        if candidate != avoid:
            break
        candidate = pool[int(rand() * len(pool))]
    return candidate


@dataclass
class DropRoll:
    """Which monster drops what, after the roll.

    `drops_now` is the SLOT-CORPUS view only: item -> the NPCs whose weighted loot
    tables (or, in mimic mode, whose death handler's borrowed table) now contain it.
    Guaranteed death_drop params ride along in the same map. Drops the corpus does not
    explain - bespoke handlers, hardcoded gives - are left alone by the relocation.
    """

    mode: str = "off"
    drops_was: Dict[str, List[str]] = field(default_factory=dict)
    drops_now: Dict[str, List[str]] = field(default_factory=dict)
    mimic_map: Dict[int, int] = field(default_factory=dict)   # slot index -> unit index
    new_item: Dict[int, str] = field(default_factory=dict)    # slot ref -> item it holds now
    death_drops: Dict[str, str] = field(default_factory=dict)  # npc -> guaranteed drop now
    slots_changed: int = 0
    enabled: bool = False


def _corpus_vanilla(pool: Mapping, include_death_drops: bool) -> Dict[str, set]:
    out: Dict[str, set] = {}
    for slot in pool["slots"]:
        out.setdefault(slot["item"], set()).add(slot["npc"])
    if include_death_drops:
        for entry in pool["deathDrops"]:
            out.setdefault(entry["item"], set()).add(entry["npc"])
    return out


def roll_drops(pool: Mapping, seed: int, mode: str) -> DropRoll:
    """Port of RandomizeDrops for the two designs that move items between monsters.

    tiered/chaos rewrite each weighted loot slot's item (plus a derangement of the
    guaranteed death_drop params); mimic leaves items alone and instead points each
    monster's death handler at another monster's ENTIRE table. Both change which monster
    - and therefore which region - an item can be killed for, which is exactly what the
    four-source obtainability model's `drop` sources encode.

    Everything the tools sort is pre-sorted in the exported pool (JS `localeCompare` is
    not reproducible here), so this only has to replay the sampling.
    """
    if mode not in ("tiered", "chaos", "mimic"):
        return DropRoll(mode="off", drops_was=_corpus_vanilla(pool, True),
                        drops_now=_corpus_vanilla(pool, True))

    slots = pool["slots"]

    if mode == "mimic":
        # mimic skips the death_drop pass - each extracted table inlines its own.
        was = _corpus_vanilla(pool, False)
        units = {unit["index"]: unit for unit in pool["mimic"]["units"]}
        candidates = list(pool["mimic"]["slots"])

        mimic_map: Dict[int, int] = {}
        rand = mulberry32((seed ^ hash_key("mimic")) & 0xFFFFFFFF)
        perm = None
        for _ in range(10000):
            candidate = shuffle(list(range(len(candidates))), rand)
            # a unit-level derangement: an index swap between two slots sharing one table
            # (all four goblin variants run goblin_drop_table) would change nothing.
            if all(candidates[candidate[i]]["unitKey"] != slot["unitKey"]
                   for i, slot in enumerate(candidates)):
                perm = candidate
                break
        if perm is None:
            return DropRoll(mode=mode, drops_was=was, drops_now=was)
        for i, slot in enumerate(candidates):
            mimic_map[slot["index"]] = candidates[perm[i]]["unitIndex"]

        now: Dict[str, set] = {}
        unit_of_slot = {slot["index"]: slot["unitIndex"] for slot in candidates}
        handlers = [(slot["handler"], mimic_map.get(slot["index"], unit_of_slot[slot["index"]]))
                    for slot in candidates]
        handlers += [(slot["handler"], slot["unitIndex"]) for slot in pool["mimic"]["pinned"]]
        for handler, unit_index in handlers:
            unit = units.get(unit_index)
            if unit is None:
                continue
            for item in unit["items"]:
                now.setdefault(item, set()).add(handler)
        return DropRoll(mode=mode, drops_was=was, drops_now=now, mimic_map=mimic_map,
                        slots_changed=len(mimic_map), enabled=True)

    # tiered / chaos: per-slot item replacement
    new_item: Dict[int, str] = {}
    if mode == "chaos":
        universe = pool["chaos"]["universe"]
        rand = mulberry32((seed ^ hash_key("chaos")) & 0xFFFFFFFF)
        for ref in pool["chaos"]["slots"]:
            candidate = _pick_different(universe, slots[ref]["item"], rand)
            if candidate is not None:
                new_item[ref] = candidate
    else:
        for bucket in pool["tiered"]["buckets"]:
            universe = bucket["universe"]
            if len(universe) < 2:
                continue  # left vanilla, and consumes no randomness (per-bucket streams)
            rand = mulberry32((seed ^ hash_key(bucket["name"])) & 0xFFFFFFFF)
            for ref in bucket["slots"]:
                candidate = _pick_different(universe, slots[ref]["item"], rand)
                if candidate is not None:
                    new_item[ref] = candidate

    # death_drop params are deranged in the same pass (tiered/chaos only)
    death = list(pool["deathDrops"])
    death_now = {entry["npc"]: entry["item"] for entry in death}
    if len(death) >= 2:
        rand = mulberry32((seed ^ hash_key("death_drop")) & 0xFFFFFFFF)
        perm = derangement(len(death), rand)
        for index, entry in enumerate(death):
            death_now[entry["npc"]] = death[perm[index]]["item"]

    now = {}
    for index, slot in enumerate(slots):
        now.setdefault(new_item.get(index, slot["item"]), set()).add(slot["npc"])
    for npc, item in death_now.items():
        now.setdefault(item, set()).add(npc)

    changed = sum(1 for index, item in new_item.items() if item != slots[index]["item"])
    return DropRoll(mode=mode, drops_was=_corpus_vanilla(pool, True), drops_now=now,
                    new_item=new_item, death_drops=death_now, slots_changed=changed, enabled=True)


def relocate_drop_sources(item_sources: Mapping[str, Sequence[dict]], drops: Mapping,
                          roll: DropRoll) -> Dict[str, List[dict]]:
    """Re-point every `via: drop` source at whatever drops that item NOW.

    Applied as a DELTA rather than a recomputation, because the two datasets involved do
    not coincide: `itemSources`' vanilla drop regions come from drop-sources.json, which
    is broader in places than the weighted-loot corpus this roll touches (bespoke
    handlers, scripted gives) and narrower in others. Recomputing from the corpus would
    silently invent regions for items whose vanilla entry never claimed them.

    So: per item, take the monsters the corpus says stopped dropping it and the ones that
    started, and move only those regions - keeping a region if some monster that still
    drops the item stands there. Everything the corpus cannot account for is left alone,
    in both directions, and an unrolled DropRoll is exactly the identity (which is why
    the drops-off path can skip this; a test pins it).
    """
    npc_regions: Mapping[str, int] = drops.get("npcRegions", {})

    def regions_of(npcs) -> set:
        return {npc_regions[npc] for npc in npcs if npc in npc_regions}

    out: Dict[str, List[dict]] = {item: list(sources) for item, sources in item_sources.items()}
    for item in set(roll.drops_was) | set(roll.drops_now):
        was = set(roll.drops_was.get(item, ()))
        now = set(roll.drops_now.get(item, ()))
        if was == now:
            continue
        vanilla = {s["region"] for s in out.get(item, ()) if s.get("via") == "drop"}
        # a region only leaves if nothing that still drops the item stands there
        gone = regions_of(was - now) - regions_of(now)
        regions = (vanilla - gone) | regions_of(now - was)
        if regions == vanilla:
            continue
        kept = [s for s in out.get(item, ()) if s.get("via") != "drop"]
        relocated = kept + [{"region": region, "via": "drop"} for region in sorted(regions)]
        if relocated:
            out[item] = relocated
        else:
            out.pop(item, None)
    return out


@dataclass
class SeedRoll:
    """Everything the apworld rolled for one slot, ready for logic AND for slot_data."""

    seed: int
    gather: SkillSwapRoll
    process: SkillSwapRoll
    shops: ShopRoll
    spawn: SpawnRoll
    drops: DropRoll

    def item_swaps(self) -> Dict[str, str]:
        """Combined gather+process product re-keying for LogicEngine(item_swaps=...)."""
        swaps = dict(self.gather.swaps)
        swaps.update(self.process.swaps)
        return swaps


def roll_all(bundle: Mapping, seed: int, *, gathering: str, processing: str,
             shops: bool, spawn: str, drops: str = "off") -> SeedRoll:
    pools = bundle["randomizerPools"]
    return SeedRoll(
        seed=seed,
        gather=roll_skill_swaps(pools["gather"], seed, gathering),
        process=roll_skill_swaps(pools["process"], seed, processing),
        shops=roll_shops(pools["shops"], seed, shops),
        spawn=roll_spawn(pools["spawn"], seed, spawn),
        drops=roll_drops(pools["drops"], seed, drops),
    )


def apply_rolls(item_sources: Mapping[str, Sequence[dict]], pools: Mapping,
                roll: SeedRoll) -> Dict[str, List[dict]]:
    """The whole region-gated half of the item graph, re-pointed for one rolled world."""
    sources = item_sources
    if roll.shops.enabled:
        sources = relocate_buy_sources(sources, pools["shops"], roll.shops)
    if roll.drops.enabled:
        sources = relocate_drop_sources(sources, pools["drops"], roll.drops)
    return {item: list(srcs) for item, srcs in sources.items()}
