# The 2004Scape logic engine, in Python.
#
# This is a faithful port of tools/logic/ValidateSeed.ts's sphere-expansion fixpoint
# (GitHub #3). ValidateSeed is the LOCAL mode's beatability oracle - it stays exactly
# where it is, and RandomizeEntrances keeps rerolling against it for solo seeds. This
# module is the same reasoning made available to Archipelago, so AP's fill can guarantee
# beatability by construction instead of by generate-and-test.
#
# Both sides consume ONE artifact: data/rs2004_logic.json, produced by
# tools/ap/ExportLogicBundle.ts from the same tools/logic/LogicModel.ts that ValidateSeed
# imports. If the two ever disagree, test/test_parity.py fails - see docs/parity.
#
# The fixpoint, sphere by sphere (order matters; it mirrors ValidateSeed exactly):
#   0. recompute item obtainability from the current skill caps + reachable regions
#   1. entrance edges (the seed's shuffled trigger -> arrival table), gated ones only
#      when their requirement is satisfied
#   2. curated alwaysConnected edges (Karamja boat etc), bidirectional
#   2b. script-teleport / world edges, carrying a gated interior's requirement when they
#       enter one
#   2c. curated open areas (member regions are mutually connected)
#   3. gated areas: any adjacent region reachable AND requirement satisfied -> interior
#   4. quests: skills + QP + prereq chain + gathered/processed items + quest-gate item +
#      curated anchors + extracted region groups
# ...repeat until nothing changes.
#
# The KEY non-obvious rule, ported verbatim: a quest-progress varp gate is satisfiable
# when its quest is DOABLE, not COMPLETE. See LogicModel.ts for why (it breaks the
# circular deadlock where a quest's own interior door requires that quest), and note
# SPLIT_VARPS, which keeps post-quest guild gates completion-safe on the same varp.

from __future__ import annotations

import json
import pkgutil
from dataclasses import dataclass
from typing import Dict, FrozenSet, Iterable, List, Mapping, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# bundle
# ---------------------------------------------------------------------------

_UNCAPPED = 99


def load_bundle(package: str = __package__, resource: str = "data/rs2004_logic.json") -> dict:
    raw = pkgutil.get_data(package, resource)
    if raw is None:
        raise FileNotFoundError(f"logic bundle {resource} missing from {package}")
    return json.loads(raw.decode("utf-8"))


def load_bundle_file(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


# ---------------------------------------------------------------------------
# requirement evaluation (port of GatedAreas.ts requireSatisfied)
# ---------------------------------------------------------------------------


class RequireContext:
    """Varp / item / skill-cap state a gate requirement is evaluated against."""

    __slots__ = ("varps", "obtainable", "item_sources", "stat_caps")

    def __init__(self, varps: Mapping[str, int], obtainable: FrozenSet[str],
                 item_sources: Mapping[str, Sequence[dict]], stat_caps: Mapping[str, int]):
        self.varps = varps
        self.obtainable = obtainable
        self.item_sources = item_sources
        self.stat_caps = stat_caps

    def has_item(self, item: str) -> bool:
        # ItemGraph.itemAvailable: unmodelled items are assumed obtainable (never
        # invent a gate we cannot prove).
        return item not in self.item_sources or item in self.obtainable


def require_satisfied(req: Optional[dict], ctx: RequireContext) -> bool:
    if req is None:
        return True
    if "allOf" in req:
        return all(require_satisfied(r, ctx) for r in req["allOf"])
    if "varp" in req:
        value = ctx.varps.get(req["varp"], 0)
        if "bit" in req:
            return (value >> req["bit"]) & 1 == 1
        if "bitClear" in req:
            return (value >> req["bitClear"]) & 1 == 0
        return value >= req["gte"]
    if "stat" in req:
        return ctx.stat_caps.get(req["stat"].lower(), _UNCAPPED) >= req["gte"]
    return ctx.has_item(req["item"])


def describe_require(req: Optional[dict]) -> str:
    if req is None:
        return "(none)"
    if "allOf" in req:
        return "(" + " AND ".join(describe_require(r) for r in req["allOf"]) + ")"
    if "varp" in req:
        if "bit" in req:
            return f"%{req['varp']} bit {req['bit']} set"
        if "bitClear" in req:
            return f"%{req['varp']} bit {req['bitClear']} clear"
        return f"%{req['varp']} >= {req['gte']}"
    if "stat" in req:
        return f"{req['stat']} (base) >= {req['gte']}"
    return f"holds {req['item']}"


# ---------------------------------------------------------------------------
# entrance assignment
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EntranceEdge:
    """One directed trigger -> arrival transition, as the runtime override table sees it."""

    key: str            # "level_mapX_mapZ_localX_localZ:op" - the override table key
    arrival: str        # raw arrival coord the override points at
    from_region: int
    to_region: int
    require_index: int  # -1, or an index into LogicEngine.requires


class EntrancePool:
    """The unshuffled candidate set exported by RandomizeEntrances --export-pool.

    A *seed* is an assignment of pool sides to arrivals. `vanilla()` reproduces the
    unshuffled world; `shuffle()` (entrances.py) produces a reachability-preserving one.
    """

    def __init__(self, bundle: dict):
        pool = bundle["entrancePool"]
        self.gates: List[dict] = pool["gates"]
        self.one_ways: List[dict] = pool["oneWays"]
        self.requires: Dict[str, dict] = {k: v["require"] for k, v in pool["requires"].items()}
        self.require_names: Dict[str, str] = {k: v.get("name", "") for k, v in pool["requires"].items()}

    @staticmethod
    def side_key(side: dict) -> str:
        return f"{side['trigger']}:{side['op']}"

    def sides(self) -> List[dict]:
        out: List[dict] = []
        for gate in self.gates:
            out.append(gate["a"])
            out.append(gate["b"])
        return out

    def vanilla_overrides(self) -> Dict[str, str]:
        """trigger:op -> its own vanilla arrival (the identity assignment)."""
        out: Dict[str, str] = {}
        for side in self.sides():
            out[self.side_key(side)] = side["arrival"]
        for one_way in self.one_ways:
            out[self.side_key(one_way)] = one_way["arrival"]
        return out


# ---------------------------------------------------------------------------
# derived state
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Derived:
    regions: FrozenSet[int]
    completed: FrozenSet[str]
    qp: int
    obtainable: FrozenSet[str]
    goals: FrozenSet[str]


# ---------------------------------------------------------------------------
# the engine
# ---------------------------------------------------------------------------


class LogicEngine:
    """Sphere-expansion fixpoint over one fixed world layout (one entrance assignment).

    `derive(caps, unlocked_quests)` is memoized: Archipelago evaluates access rules many
    times per collection state, but the fixpoint only depends on the skill caps and the
    set of quest-gate unlocks the player holds.
    """

    def __init__(self, bundle: dict, overrides: Optional[Mapping[str, str]] = None,
                 spawn_region: Optional[int] = None, quest_gates: Iterable[str] = (),
                 item_swaps: Optional[Mapping[str, str]] = None):
        self.bundle = bundle
        meta = bundle["meta"]
        self.mainland = meta["mainlandRegionId"]
        self.cappable_skills: List[str] = list(meta["cappableSkills"])
        self.spawn_region = spawn_region if spawn_region is not None else meta["vanillaSpawnRegion"]

        self.quests: List[dict] = bundle["quests"]
        self.quests_by_id: Dict[str, dict] = {q["id"]: q for q in self.quests}
        self.goal_defs: List[dict] = bundle["goals"]
        # quests whose completion additionally needs a `quest_<id>` unlock item held
        self.quest_gates: FrozenSet[str] = frozenset(quest_gates)

        varp_model = bundle["varpModel"]
        self.gate_varp_all: int = varp_model["gateVarpAll"]
        self.varp_to_quest: Dict[str, str] = varp_model["varpToQuest"]
        self.split_varps: Dict[str, dict] = varp_model["splitVarps"]
        self.completion_only: Dict[str, str] = varp_model["completionOnly"]
        self.stat_varps: Dict[str, dict] = varp_model["statVarps"]

        self.anchors: Dict[str, int] = {k: int(v) for k, v in bundle["anchors"].items()}
        self.quest_anchors: Dict[str, List[str]] = bundle["questAnchors"]
        self.goal_anchors: Dict[str, List[str]] = bundle["goalAnchors"]
        self.requirement_groups: Dict[str, List[dict]] = bundle["requirementGroups"]

        self.always_connected = [(e["from"], e["to"]) for e in bundle["alwaysConnected"]]
        self.open_areas = [(frozenset(a["connectTo"]), frozenset(a["members"])) for a in bundle["openAreas"]]
        self.gated_areas = [
            (a["require"], frozenset(a["gated"]), frozenset(a["outside"]), a["name"])
            for a in bundle["gatedAreas"]
        ]
        # region id -> the require of the gated area whose interior it is, so an extracted
        # edge INTO a gated interior carries the gate instead of bypassing or being
        # dropped (GitHub #16 - dropping it severs multi-floor quest interiors).
        self.gated_region_require: Dict[int, dict] = {}
        for require, gated, _outside, _name in self.gated_areas:
            for region in gated:
                self.gated_region_require.setdefault(region, require)

        self.item_sources: Dict[str, List[dict]] = self._apply_swaps(bundle["itemSources"], item_swaps)
        self.quest_items: Dict[str, List[dict]] = bundle["questItems"]

        self.pool = EntrancePool(bundle)
        self.set_overrides(overrides if overrides is not None else self.pool.vanilla_overrides())

        self._memo: Dict[Tuple, Derived] = {}

    # -- layout -------------------------------------------------------------

    @staticmethod
    def pool_side_key(side: Mapping[str, object]) -> str:
        """The override-table key for one pool side: "<trigger raw coord>:<op>"."""
        return f"{side['trigger']}:{side['op']}"

    @staticmethod
    def _apply_swaps(sources: Mapping[str, Sequence[dict]],
                     swaps: Optional[Mapping[str, str]]) -> Dict[str, List[dict]]:
        """ItemGraph.applySwaps: gathersanity/processsanity re-key each source under the
        product the shuffled action now delivers."""
        if not swaps:
            return {item: list(srcs) for item, srcs in sources.items()}
        out: Dict[str, List[dict]] = {}
        for product, srcs in sources.items():
            out.setdefault(swaps.get(product, product), []).extend(srcs)
        return out

    def set_overrides(self, overrides: Mapping[str, str],
                      reserved_triggers: Iterable[str] = ()) -> None:
        """Install one entrance assignment (trigger:op -> arrival raw coord).

        `reserved_triggers` are pool trigger coords that are not (yet) assigned but must
        still be treated as replaced - the construct-valid shuffle in entrances.py uses
        this so a partial layout never credits the player with a vanilla transition it is
        about to overwrite.
        """
        region_of_arrival: Dict[str, int] = {}
        for side in self.pool.sides():
            region_of_arrival[side["arrival"]] = side["arrivalRegion"]
        for one_way in self.pool.one_ways:
            region_of_arrival[one_way["arrival"]] = one_way["arrivalRegion"]
        region_of_trigger: Dict[str, int] = {}
        for side in self.pool.sides() + self.pool.one_ways:
            region_of_trigger[self.pool.side_key(side)] = side["triggerRegion"]

        self.requires: List[dict] = []
        require_index: Dict[str, int] = {}
        for key, require in self.pool.requires.items():
            require_index[key] = len(self.requires)
            self.requires.append(require)

        edges: List[EntranceEdge] = []
        for key, arrival in overrides.items():
            from_region = region_of_trigger.get(key, 0)
            to_region = region_of_arrival.get(arrival, 0)
            edges.append(EntranceEdge(key, arrival, from_region, to_region, require_index.get(key, -1)))
        self.entrance_edges = edges
        self.overrides = dict(overrides)

        # world edges whose vanilla trigger this assignment replaced are dead: the runtime
        # override preamble preempts the case body (GeneratedQuestRegions.usableWorldEdges).
        overridden = {key.split(":")[0] for key in overrides} | set(reserved_triggers)
        script_edges: List[Tuple[Tuple[int, ...], int, Optional[dict]]] = []
        for edge in self.bundle["questScriptEdges"]:
            script_edges.append((tuple(edge["from"]), edge["to"], self.gated_region_require.get(edge["to"])))
        for edge in self.bundle["worldEdges"]:
            sources = edge["from"]
            if edge["viaCase"]:
                sources = [t for t in sources if t["raw"] not in overridden]
            regions = tuple({t["region"] for t in sources if t["region"] != 0})
            if not regions or edge["to"] == 0:
                continue
            script_edges.append((regions, edge["to"], self.gated_region_require.get(edge["to"])))
        self.script_edges = script_edges
        self._memo = {}

    # -- caps ---------------------------------------------------------------

    def caps_from_counts(self, counts: Mapping[str, int]) -> Dict[str, int]:
        """ConfigLoader.getSkillCap: cap = min(99, 20 + 10*progressive_<stat>); hitpoints
        is never capped (the engine's combat-safety guarantee)."""
        caps: Dict[str, int] = {}
        for skill in self.cappable_skills:
            caps[skill] = min(_UNCAPPED, 20 + 10 * counts.get(f"progressive_{skill}", 0))
        caps["hitpoints"] = _UNCAPPED
        return caps

    def uncapped(self) -> Dict[str, int]:
        caps = {skill: _UNCAPPED for skill in self.cappable_skills}
        caps["hitpoints"] = _UNCAPPED
        return caps

    # -- requirement helpers (ports of LogicModel.ts) -----------------------

    @staticmethod
    def _skills_satisfied(skills: Optional[Mapping[str, int]], caps: Mapping[str, int]) -> bool:
        if not skills:
            return True
        return all(caps.get(stat, _UNCAPPED) >= level for stat, level in skills.items())

    @staticmethod
    def _chain_satisfied(quests: Optional[Sequence[str]], quests_any: Optional[Sequence[Sequence[str]]],
                         completed: FrozenSet[str]) -> bool:
        if quests and not all(q in completed for q in quests):
            return False
        if quests_any and not all(any(q in completed for q in group) for group in quests_any):
            return False
        return True

    def _quest_doable(self, quest_id: str, qp: int, completed: FrozenSet[str],
                      caps: Mapping[str, int]) -> bool:
        quest = self.quests_by_id.get(quest_id)
        if quest is None:
            return False  # varp maps to a quest the model doesn't know -> fail-closed
        return (self._skills_satisfied(quest.get("skills"), caps)
                and qp >= quest.get("requiredQp", 0)
                and self._chain_satisfied(quest.get("quests"), quest.get("questsAny"), completed))

    def _resolve_varp(self, name: str, qp: int, completed: FrozenSet[str],
                      caps: Mapping[str, int]) -> Optional[int]:
        if name == "qp":
            return qp
        stat_varp = self.stat_varps.get(name)
        if stat_varp is not None:
            return 1 if caps.get(stat_varp["stat"], _UNCAPPED) >= stat_varp["gte"] else 0
        split = self.split_varps.get(name)
        if split is not None:
            if split["quest"] in completed:
                return self.gate_varp_all
            return split["mid"] if self._quest_doable(split["quest"], qp, completed, caps) else 0
        completion = self.completion_only.get(name)
        if completion is not None:
            return self.gate_varp_all if completion in completed else 0
        quest_id = self.varp_to_quest.get(name)
        if quest_id is not None:
            return self.gate_varp_all if self._quest_doable(quest_id, qp, completed, caps) else 0
        return None  # unknown varp -> 0 (fail-closed)

    def _varp_map(self, qp: int, completed: FrozenSet[str], caps: Mapping[str, int]) -> Dict[str, int]:
        out: Dict[str, int] = {}
        for name in self._needed_varps:
            value = self._resolve_varp(name, qp, completed, caps)
            if value is not None:
                out[name] = value
        return out

    # -- item obtainability (ItemGraph.computeObtainable) -------------------

    def _compute_obtainable(self, caps: Mapping[str, int], regions: FrozenSet[int]) -> FrozenSet[str]:
        obtainable: set = set()
        sources = self.item_sources

        def satisfiable(source: dict) -> bool:
            region = source.get("region")
            if region is not None:
                return region in regions  # buy/drop: shop owner / monster region reachable
            if caps.get(source.get("skill", ""), _UNCAPPED) < source.get("level", 0):
                return False
            for item in source.get("inputs", ()):
                if item in sources and item not in obtainable:
                    return False
            return True

        changed = True
        while changed:
            changed = False
            for item, srcs in sources.items():
                if item in obtainable:
                    continue
                if any(satisfiable(s) for s in srcs):
                    obtainable.add(item)
                    changed = True
        return frozenset(obtainable)

    # -- the fixpoint -------------------------------------------------------

    _needed_varps: FrozenSet[str] = frozenset()

    def _collect_needed_varps(self) -> FrozenSet[str]:
        names = {"qp"} | set(self.stat_varps)

        def walk(req: Optional[dict]) -> None:
            if req is None:
                return
            if "allOf" in req:
                for sub in req["allOf"]:
                    walk(sub)
            elif "varp" in req:
                names.add(req["varp"])

        for require, _gated, _outside, _name in self.gated_areas:
            walk(require)
        for require in self.pool.requires.values():
            walk(require)
        return frozenset(names)

    def derive(self, caps: Mapping[str, int], unlocked_quests: Iterable[str] = ()) -> Derived:
        if not self._needed_varps:
            self._needed_varps = self._collect_needed_varps()
        unlocked = frozenset(unlocked_quests)
        key = (tuple(sorted(caps.items())), unlocked)
        cached = self._memo.get(key)
        if cached is None:
            cached = self._run(caps, unlocked)
            self._memo[key] = cached
        return cached

    def derive_from_counts(self, counts: Mapping[str, int], unlocked_quests: Iterable[str] = ()) -> Derived:
        return self.derive(self.caps_from_counts(counts), unlocked_quests)

    def _run(self, caps: Mapping[str, int], unlocked: FrozenSet[str]) -> Derived:
        regions: set = set()
        if self.spawn_region != 0:
            regions.add(self.spawn_region)
        completed: set = set()
        qp = 0
        obtainable: FrozenSet[str] = frozenset()

        while True:
            changed = False
            frozen_regions = frozenset(regions)
            obtainable = self._compute_obtainable(caps, frozen_regions)
            frozen_completed = frozenset(completed)
            ctx = RequireContext(self._varp_map(qp, frozen_completed, caps), obtainable, self.item_sources, caps)

            # 1. entrance edges
            for edge in self.entrance_edges:
                if edge.from_region == 0 or edge.to_region == 0:
                    continue
                if edge.from_region not in regions or edge.to_region in regions:
                    continue
                if edge.require_index >= 0 and not require_satisfied(self.requires[edge.require_index], ctx):
                    continue
                regions.add(edge.to_region)
                changed = True

            # 2. curated always-connected edges (bidirectional)
            for a, b in self.always_connected:
                if a in regions and b not in regions:
                    regions.add(b)
                    changed = True
                if b in regions and a not in regions:
                    regions.add(a)
                    changed = True

            # 2b. script-teleport / world edges
            for from_regions, to_region, require in self.script_edges:
                if to_region in regions:
                    continue
                if not any(r in regions for r in from_regions):
                    continue
                if require is not None and not require_satisfied(require, ctx):
                    continue
                regions.add(to_region)
                changed = True

            # 2c. curated open areas
            for connect_to, members in self.open_areas:
                if not (connect_to & regions) and not (members & regions):
                    continue
                if not members <= regions:
                    regions |= members
                    changed = True

            # 3. gated areas
            for require, gated, outside, _name in self.gated_areas:
                if not (outside & regions):
                    continue
                if not require_satisfied(require, ctx):
                    continue
                if not gated <= regions:
                    regions |= gated
                    changed = True

            # 4. quests
            newly: List[dict] = []
            for quest in self.quests:
                quest_id = quest["id"]
                if quest_id in completed:
                    continue
                if quest_id in self.quest_gates and quest_id not in unlocked:
                    continue
                if not self._skills_satisfied(quest.get("skills"), caps):
                    continue
                if qp < quest.get("requiredQp", 0):
                    continue
                if not self._chain_satisfied(quest.get("quests"), quest.get("questsAny"), frozenset(completed)):
                    continue
                if not self._quest_items_satisfied(quest_id, obtainable):
                    continue
                if not self._anchors_reachable(self.quest_anchors.get(quest_id), regions):
                    continue
                if self.unsatisfied_groups(quest_id, regions):
                    continue
                newly.append(quest)
            if newly:
                changed = True
                for quest in newly:
                    completed.add(quest["id"])
                    qp += quest.get("qp", 0)

            if not changed:
                break

        frozen_regions = frozenset(regions)
        frozen_completed = frozenset(completed)
        goals = frozenset(
            goal["id"] for goal in self.goal_defs
            if self._goal_reached(goal, caps, qp, frozen_completed, frozen_regions)
        )
        return Derived(frozen_regions, frozen_completed, qp, obtainable, goals)

    # -- predicates ---------------------------------------------------------

    def _quest_items_satisfied(self, quest_id: str, obtainable: FrozenSet[str]) -> bool:
        for need in self.quest_items.get(quest_id, ()):
            item = need["item"]
            if item in self.item_sources and item not in obtainable:
                return False
        return True

    def _anchors_reachable(self, names: Optional[Sequence[str]], regions) -> bool:
        if not names:
            return True
        for name in names:
            region = self.anchors.get(name)
            if region is None or region == 0 or region not in regions:
                return False
        return True

    def unsatisfied_groups(self, ident: str, regions) -> List[dict]:
        """Extracted requirement groups with no reachable region (empty = satisfied)."""
        return [g for g in self.requirement_groups.get(ident, ()) if not any(r in regions for r in g["regions"])]

    def _goal_reached(self, goal: dict, caps: Mapping[str, int], qp: int,
                      completed: FrozenSet[str], regions: FrozenSet[int]) -> bool:
        return (self._skills_satisfied(goal.get("skills"), caps)
                and qp >= goal.get("requiredQp", 0)
                and self._chain_satisfied(goal.get("quests"), None, completed)
                and self._anchors_reachable(self.goal_anchors.get(goal["id"]), regions)
                and not self.unsatisfied_groups(goal["id"], regions))
