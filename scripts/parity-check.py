#!/usr/bin/env python3
"""Cross-check the two implementations of this project's logic (GitHub #3).

The local/solo oracle is tools/logic/ValidateSeed.ts (TypeScript). The Archipelago
apworld reasons with apworld/rs2004scape/logic.py (Python). They read the same exported
bundle and must reach the SAME conclusions - same reachable regions, same completed
quests, same QP, same goals - or one of them is wrong.

Run it against a live seed:

    python3 scripts/parity-check.py                     # uses ../Server/engine
    python3 scripts/parity-check.py --server ../Server/engine
    python3 scripts/parity-check.py --write-fixture     # also refresh the unit-test fixture

It builds a SPATIAL-ONLY scratch config (entrances + gated areas + spawn, no placements
and no unlocks) so both sides start from the same, unambiguous state: uncapped skills,
no quest-gate items. That is exactly the config RandomizeEntrances grades candidate
tables against, so parity here is parity on the thing the reroll loop actually decides.

Exit 0 = the two agree. Exit 1 = they disagree (with a diff), exit 2 = setup problem.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APWORLD = os.path.join(REPO, "apworld")
FIXTURE_DIR = os.path.join(APWORLD, "rs2004scape", "test", "data")

SPATIAL_FILES = ("ap-entrances.json", "ap-gated-areas.json", "ap-spawn.json")


def load_logic_module():
    """Import apworld/rs2004scape/logic.py without dragging in Archipelago."""
    package = types.ModuleType("rs2004parity")
    package.__path__ = [os.path.join(APWORLD, "rs2004scape")]
    sys.modules["rs2004parity"] = package
    spec = importlib.util.spec_from_file_location(
        "rs2004parity.logic", os.path.join(APWORLD, "rs2004scape", "logic.py"))
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "rs2004parity"
    sys.modules["rs2004parity.logic"] = module
    spec.loader.exec_module(module)
    return module


def run_validate_seed(server: str, config_dir: str, out_path: str) -> dict:
    cmd = ["npx", "tsx", os.path.join("tools", "logic", "ValidateSeed.ts"),
           "--config-dir", config_dir, "--json", out_path]
    result = subprocess.run(cmd, cwd=server, capture_output=True, text=True)
    if not os.path.exists(out_path):
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit(2)
    # a BLOCKED seed exits 1; that is a perfectly good parity subject, so only the
    # missing report above is fatal.
    with open(out_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def compare(reference: dict, derived) -> list:
    """Returns a list of human-readable differences (empty = parity)."""
    problems = []

    ts_regions = reference["reachableRegionCount"]
    if len(derived.regions) != ts_regions:
        problems.append(f"reachable regions: python {len(derived.regions)} vs ts {ts_regions}")

    ts_quests = set(reference["completedQuests"])
    if derived.completed != ts_quests:
        only_ts = sorted(ts_quests - derived.completed)
        only_py = sorted(derived.completed - ts_quests)
        problems.append(f"completed quests differ - only in ts: {only_ts or '-'}; only in python: {only_py or '-'}")

    if derived.qp != reference["totalQp"]:
        problems.append(f"quest points: python {derived.qp} vs ts {reference['totalQp']}")

    ts_goals = {g["id"] for g in reference["goals"] if g["reachedAtSphere"] is not None}
    if derived.goals != ts_goals:
        problems.append(f"goals: python {sorted(derived.goals)} vs ts {sorted(ts_goals)}")

    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default=os.path.join(os.path.dirname(REPO), "Server", "engine"),
                        help="path to the LostCityRS engine checkout (default ../Server/engine)")
    parser.add_argument("--bundle", default=os.path.join(APWORLD, "rs2004scape", "data", "rs2004_logic.json"),
                        help="logic bundle to test (default: the one shipped in the apworld)")
    parser.add_argument("--write-fixture", action="store_true",
                        help="also refresh apworld/rs2004scape/test/data/parity_fixture.json")
    args = parser.parse_args()

    server = os.path.abspath(args.server)
    source_config = os.path.join(server, "data", "config")
    if not os.path.isdir(source_config):
        sys.stderr.write(f"no engine config dir at {source_config}\n")
        return 2
    if not os.path.exists(args.bundle):
        sys.stderr.write(f"no logic bundle at {args.bundle}\n"
                         f"generate one: cd {server} && npx tsx tools/ap/ExportLogicBundle.ts\n")
        return 2

    logic = load_logic_module()
    bundle = logic.load_bundle_file(args.bundle)

    with tempfile.TemporaryDirectory(prefix="rs2004-parity-") as scratch:
        copied = []
        for name in SPATIAL_FILES:
            source = os.path.join(source_config, name)
            if os.path.exists(source):
                shutil.copy(source, os.path.join(scratch, name))
                copied.append(name)
        print(f"spatial-only config: {', '.join(copied) or '(vanilla - nothing to copy)'}")

        report_path = os.path.join(scratch, "validate.json")
        reference = run_validate_seed(server, scratch, report_path)

        entrances_path = os.path.join(scratch, "ap-entrances.json")
        overrides = {}
        if os.path.exists(entrances_path):
            with open(entrances_path, "r", encoding="utf-8") as handle:
                overrides = json.load(handle).get("overrides", {})

        engine = logic.LogicEngine(bundle, overrides=overrides or None)
        derived = engine.derive(engine.uncapped())

        problems = compare(reference, derived)
        print(f"regions  python {len(derived.regions):>5}  ts {reference['reachableRegionCount']:>5}")
        print(f"quests   python {len(derived.completed):>5}  ts {len(reference['completedQuests']):>5}"
              f"   (qp {derived.qp} / {reference['totalQp']})")
        print(f"goals    python {sorted(derived.goals)}")

        if problems:
            print("\nPARITY FAILURE - the local oracle and the apworld disagree:")
            for problem in problems:
                print(f"  - {problem}")
            return 1
        print("\nPARITY OK - ValidateSeed.ts and logic.py agree on this seed.")

        if args.write_fixture:
            os.makedirs(FIXTURE_DIR, exist_ok=True)
            fixture = {
                "_comment": ("Frozen parity subject for test_parity.py: one entrance layout plus the "
                             "answers tools/logic/ValidateSeed.ts gives for it. Refresh with "
                             "scripts/parity-check.py --write-fixture whenever the logic model changes."),
                "overrides": overrides,
                "expected": {
                    "regionCount": reference["reachableRegionCount"],
                    "regions": sorted(derived.regions),
                    "completedQuests": sorted(reference["completedQuests"]),
                    "totalQp": reference["totalQp"],
                    "goals": sorted({g["id"] for g in reference["goals"] if g["reachedAtSphere"] is not None}),
                },
            }
            out = os.path.join(FIXTURE_DIR, "parity_fixture.json")
            with open(out, "w", encoding="utf-8") as handle:
                json.dump(fixture, handle, separators=(",", ":"))
                handle.write("\n")
            print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
