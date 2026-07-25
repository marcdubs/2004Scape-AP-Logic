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

from .prng import derangement, mulberry32


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

    `mode` is off | shuffle | chaos. Quest-critical pinning is mode-aware exactly as in
    the tools: off in shuffle (a bijection keeps everything obtainable, the item just
    moves), on in chaos (which genuinely can orphan a product).
    """
    if mode not in ("shuffle", "chaos"):
        return SkillSwapRoll(mode="off")

    products = [entry["item"] for entry in pool["products"]]
    obj_ids = {entry["item"]: entry["objId"] for entry in pool["products"]}

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

    rand = mulberry32(seed)
    swaps: Dict[str, str] = {}
    if mode == "shuffle":
        perm = derangement(len(candidates), rand)
        for index, item in enumerate(candidates):
            swaps[item] = candidates[perm[index]]
    else:
        # chaos: independent uniform resample per product, retried up to 50x so nothing
        # keeps its own value by accident (same loop shape as the TS original).
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


@dataclass
class SeedRoll:
    """Everything the apworld rolled for one slot, ready for logic AND for slot_data."""

    seed: int
    gather: SkillSwapRoll
    process: SkillSwapRoll
    shops: ShopRoll
    spawn: SpawnRoll

    def item_swaps(self) -> Dict[str, str]:
        """Combined gather+process product re-keying for LogicEngine(item_swaps=...)."""
        swaps = dict(self.gather.swaps)
        swaps.update(self.process.swaps)
        return swaps


def roll_all(bundle: Mapping, seed: int, *, gathering: str, processing: str,
             shops: bool, spawn: str) -> SeedRoll:
    pools = bundle["randomizerPools"]
    return SeedRoll(
        seed=seed,
        gather=roll_skill_swaps(pools["gather"], seed, gathering),
        process=roll_skill_swaps(pools["process"], seed, processing),
        shops=roll_shops(pools["shops"], seed, shops),
        spawn=roll_spawn(pools["spawn"], seed, spawn),
    )
