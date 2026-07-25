# A byte-exact Python port of tools/shared/Prng.ts.
#
# Every seeded shuffle in this project goes through mulberry32 + derangement, and the
# apworld has to reproduce the game server's tables EXACTLY: Archipelago picks the seed,
# ships it in slot_data, and the TypeScript tools roll the same permutation server-side
# (some of those randomizers mutate content and need a pack rebuild, so shipping a
# finished table the way entrance randomization does is not an option for them).
#
# If this file drifts from Prng.ts, the apworld's logic describes a world the player is
# not in - test_randomizers.py pins both against vectors taken from the TS implementation.

from __future__ import annotations

from typing import Callable, List, Sequence, TypeVar

T = TypeVar("T")

_U32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    """JavaScript Math.imul: 32-bit signed integer multiply."""
    product = (a * b) & _U32
    return product - 0x100000000 if product >= 0x80000000 else product


def _to_int32(value: int) -> int:
    value &= _U32
    return value - 0x100000000 if value >= 0x80000000 else value


def mulberry32(seed: int) -> Callable[[], float]:
    """mulberry32 - small, fast, seedable PRNG. Same stream as the TS original."""
    state = seed & _U32

    def rand() -> float:
        nonlocal state
        state = _to_int32(state)
        state = _to_int32(state + 0x6D2B79F5)
        a = state & _U32
        t = _imul(a ^ (a >> 15), 1 | state)
        t = _to_int32(_to_int32(t + _imul(t ^ ((t & _U32) >> 7), 61 | t)) ^ t)
        t &= _U32
        return ((t ^ (t >> 14)) & _U32) / 4294967296

    return rand


def shuffle(arr: Sequence[T], rand: Callable[[], float]) -> List[T]:
    out = list(arr)
    for i in range(len(out) - 1, 0, -1):
        j = int(rand() * (i + 1))
        out[i], out[j] = out[j], out[i]
    return out


def derangement(n: int, rand: Callable[[], float]) -> List[int]:
    """A permutation of [0..n) with no fixed points, so every entry actually moves.

    Falls back to a manual neighbour-swap fixup if rejection sampling runs out of luck -
    same 200 attempts, same fixup, same order as the TS version.
    """
    identity = list(range(n))
    if n < 2:
        return identity

    perm = identity
    for _ in range(200):
        perm = shuffle(identity, rand)
        if all(value != index for index, value in enumerate(perm)):
            return perm

    perm = list(perm)
    for i in range(n):
        if perm[i] == i:
            swap_with = (i + 1) % n
            perm[i], perm[swap_with] = perm[swap_with], perm[i]
    return perm
