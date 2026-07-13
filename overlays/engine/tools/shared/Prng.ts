// Small seedable PRNG + shuffle helpers shared by the AP randomizer tools
// (Math.random() isn't seedable, so every seeded shuffle in this repo goes through
// this file - entrances, drip, and anything added later).

// mulberry32 - small, fast, seedable PRNG.
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// a permutation of [0..n) with no fixed points, so every entry actually moves.
// falls back to a manual neighbor-swap fixup if rejection sampling runs out of luck.
export function derangement(n: number, rand: () => number): number[] {
    const identity = Array.from({ length: n }, (_, i) => i);
    if (n < 2) {
        return identity;
    }

    let perm = identity;
    for (let attempt = 0; attempt < 200; attempt++) {
        perm = shuffle(identity, rand);
        if (perm.every((v, i) => v !== i)) {
            return perm;
        }
    }

    perm = perm.slice();
    for (let i = 0; i < n; i++) {
        if (perm[i] === i) {
            const swapWith = (i + 1) % n;
            [perm[i], perm[swapWith]] = [perm[swapWith], perm[i]];
        }
    }
    return perm;
}
