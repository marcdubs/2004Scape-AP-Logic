#!/usr/bin/env bash
# One-shot GitHub repo hardening. Run ONCE, right after making the repo public
# (rulesets and secret scanning are unavailable on private free-plan repos):
#
#   bash scripts/setup-repo-rules.sh
#
# Needs the gh CLI authenticated as the repo owner.
set -euo pipefail
REPO="marcdubs/2004Scape-AP-Logic"

echo "==> ruleset: protect main (no force pushes, no deletion; admin can bypass)"
gh api -X POST "repos/$REPO/rulesets" --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ],
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ]
}
JSON

echo "==> secret scanning + push protection"
gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON

echo "==> done. Current rulesets:"
gh api "repos/$REPO/rulesets" --jq '.[] | "\(.name) [\(.enforcement)]"'
