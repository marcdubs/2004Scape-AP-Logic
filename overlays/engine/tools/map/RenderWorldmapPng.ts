import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';
import { printInfo, printWarning } from '#/util/Logger.js';

// Renders the whole world into two flat PNGs (surface + underground) for the browser
// discovery tracker map (2004Scape-AP-Logic docs/tracker-map.md, "the map itself").
// One-time/regenerate-on-content-rebuild tool - it never needs to run per-seed
// (terrain doesn't change between randomizer seeds), only when map data changes.
//
// Rendering source (2026-07 rewrite): this now bakes the AUTHENTIC 2004 world map by
// reusing the webclient's own renderer. `engine/data/pack/mapview/worldmap.jag` (built
// by tools/pack/map/Worldmap.ts) is the exact data the in-client world map applet
// reads: per-tile underlay ids (for the directional ground blend), overlay colours +
// shapes (coastlines / paths / water edges), and loc walls (building/wall outlines).
// `webclient/src/mapview/MapView.ts` turns that data into pixels via a handful of pure
// routines - getBlendedGroundColour + getRgb (the HSL ground shading), renderWorldMap
// (the per-tile fill + wall pass) and drawOverlayShape (the diagonal overlay tiles).
// Those routines are ported verbatim below and run headless into a raw pixel buffer,
// so the output is the real world-map look (shaded terrain, coastlines, wall outlines)
// WITHOUT dragging in MapView's interactive applet (GameShell, input, pan/zoom UI).
//
// Place-name labels (labels.dat) are NOT baked into the PNG (that would need the jag's
// bitmap fonts); instead they're emitted into worldmap-meta.json as {text, x, z, size}
// in absolute tile coords, and the tracker SPA draws them as crisp SVG text that scales
// with the map - see docs/tracker-map.md.
//
// The "underground" layer is not a separate Z/plane of the SAME mapsquare - it's a
// disjoint set of mapsquares at mapZ+100 (see lessons-learned.md "the +100-mapsquare
// convention"). worldmap.jag's data streams carry every mapsquare keyed by its own
// mx/mz (the applet just windows the surface ones out), so splitting surface vs
// underground here is only a matter of bucketing whole mapsquares by mapZ >= 100.

const PX_PER_TILE = 2;
const SQUARE = 64;
// tile padding around each layer's tight bounds, so the ground-blend's +-5/+-10 tile
// neighbour reads at the map edge don't fall off the array (they just read void/id 0,
// exactly as the applet's ocean padding does).
const PAD = 16;
// background for tiles with no map data (ocean gaps, unregistered squares). The applet
// renders those as black; a near-black navy reads a touch nicer under the SVG markers.
const VOID_RGB = 0x0a0a0e;

const OUT_DIR = 'public/ap';
const JAG_PATH = 'data/pack/mapview/worldmap.jag';

// ---- parsed worldmap.jag data ----

interface Square {
    mapX: number;
    mapZ: number;
    // all indexed [localX * 64 + localZ]
    underlay: Uint8Array; // underlay flo id (0 = none) -> blended via floorcol1
    overlayRgb: Int32Array; // resolved overlay RGB (0 = none)
    overlayShapeRot: Uint8Array; // (shape << 2) | rotation
    wall: Uint8Array; // 1..28 wall/door code (0 = none)
}

interface WorldmapData {
    floorcol1: number[]; // packed HSL per underlay id, for the ground blend
    floorcol2: number[]; // RGB per overlay opcode
    squares: Map<string, Square>;
    labels: { text: string; x: number; z: number; size: number }[];
}

function getSquare(map: Map<string, Square>, mx: number, mz: number): Square {
    const key = mx + '_' + mz;
    let sq = map.get(key);
    if (!sq) {
        sq = {
            mapX: mx,
            mapZ: mz,
            underlay: new Uint8Array(SQUARE * SQUARE),
            overlayRgb: new Int32Array(SQUARE * SQUARE),
            overlayShapeRot: new Uint8Array(SQUARE * SQUARE),
            wall: new Uint8Array(SQUARE * SQUARE)
        };
        map.set(key, sq);
    }
    return sq;
}

function parseWorldmap(jag: Jagfile): WorldmapData {
    const squares = new Map<string, Square>();

    // floorcol.dat: floorcol1 = packed HSL (underlay), floorcol2 = RGB (overlay).
    const floorcol1: number[] = [0];
    const floorcol2: number[] = [0];
    const floorcol = jag.read('floorcol.dat');
    if (floorcol) {
        const count = floorcol.g2();
        for (let i = 0; i < count; i++) {
            floorcol1[i + 1] = floorcol.g4();
            floorcol2[i + 1] = floorcol.g4();
        }
    }

    // underlay.dat: per square (mx, mz) then 64*64 underlay ids in Worldmap.ts's write
    // order - localX outer (0..63), localZ inner (0..63, ascending). The north-up image
    // flip is applied later in renderLayer, so tiles are stored at their true local z.
    const underlay = jag.read('underlay.dat');
    if (underlay) {
        while (underlay.available > 0) {
            const mx = underlay.g1();
            const mz = underlay.g1();
            const sq = getSquare(squares, mx, mz);
            for (let lx = 0; lx < SQUARE; lx++) {
                for (let k = 0; k < SQUARE; k++) {
                    const lz = k; // stream byte order is local z ascending; north-up flip happens at render time
                    sq.underlay[lx * SQUARE + lz] = underlay.g1();
                }
            }
        }
    }

    // overlay.dat: opcode 0 = no overlay; else a shape/rotation byte follows and the
    // opcode indexes floorcol2 for the overlay RGB (MapView.loadOverlay).
    const overlay = jag.read('overlay.dat');
    if (overlay) {
        while (overlay.available > 0) {
            const mx = overlay.g1();
            const mz = overlay.g1();
            const sq = getSquare(squares, mx, mz);
            for (let lx = 0; lx < SQUARE; lx++) {
                for (let k = 0; k < SQUARE; k++) {
                    const lz = k; // stream byte order is local z ascending; north-up flip happens at render time
                    const opcode = overlay.g1();
                    if (opcode !== 0) {
                        sq.overlayShapeRot[lx * SQUARE + lz] = overlay.g1();
                        sq.overlayRgb[lx * SQUARE + lz] = floorcol2[opcode];
                    }
                }
            }
        }
    }

    // loc.dat: per tile a run of opcodes terminated by 0. <29 = wall/door code,
    // 29..159 = mapscene sprite, >=160 = mapfunction icon (MapView.loadLoc). We only
    // bake walls into the PNG; scenes/functions are left for a later sprite pass.
    const loc = jag.read('loc.dat');
    if (loc) {
        while (loc.available > 0) {
            const mx = loc.g1();
            const mz = loc.g1();
            const sq = getSquare(squares, mx, mz);
            for (let lx = 0; lx < SQUARE; lx++) {
                for (let k = 0; k < SQUARE; k++) {
                    const lz = k; // stream byte order is local z ascending; north-up flip happens at render time
                    for (;;) {
                        const opcode = loc.g1();
                        if (opcode === 0) {
                            break;
                        }
                        if (opcode < 29) {
                            sq.wall[lx * SQUARE + lz] = opcode;
                        }
                        // 29..159 mapscene, >=160 mapfunction: consumed to keep the
                        // stream aligned, not rendered here.
                    }
                }
            }
        }
    }

    // labels.dat: count, then per label a newline-terminated string, x, z (absolute
    // tile coords) and a size tier (0 small POI / 1 town / 2 region).
    const labels: { text: string; x: number; z: number; size: number }[] = [];
    const labelPacket = jag.read('labels.dat');
    if (labelPacket) {
        const count = labelPacket.g2();
        for (let i = 0; i < count; i++) {
            const text = labelPacket.gjstr();
            const x = labelPacket.g2();
            const z = labelPacket.g2();
            const size = labelPacket.g1();
            labels.push({ text, x, z, size });
        }
    }

    return { floorcol1, floorcol2, squares, labels };
}

// ---- MapView render routines (ported verbatim from webclient/src/mapview/MapView.ts) ----

// MapView.getRgb: HSL -> packed RGB. Kept byte-for-byte so the ground shading matches
// the in-client world map exactly (including its out-of-range-hue tolerance).
function getRgb(hue: number, saturation: number, lightness: number): number {
    let r = lightness;
    let g = lightness;
    let b = lightness;

    if (saturation !== 0.0) {
        let q: number;
        if (lightness < 0.5) {
            q = lightness * (saturation + 1.0);
        } else {
            q = lightness + saturation - lightness * saturation;
        }

        const p = lightness * 2.0 - q;
        let t = hue + 0.3333333333333333;
        if (t > 1.0) {
            t--;
        }

        let d11 = hue - 0.3333333333333333;
        if (d11 < 0.0) {
            d11++;
        }

        if (t * 6.0 < 1.0) {
            r = p + (q - p) * 6.0 * t;
        } else if (t * 2.0 < 1.0) {
            r = q;
        } else if (t * 3.0 < 2.0) {
            r = p + (q - p) * (0.6666666666666666 - t) * 6.0;
        } else {
            r = p;
        }

        if (hue * 6.0 < 1.0) {
            g = p + (q - p) * 6.0 * hue;
        } else if (hue * 2.0 < 1.0) {
            g = q;
        } else if (hue * 3.0 < 2.0) {
            g = p + (q - p) * (0.6666666666666666 - hue) * 6.0;
        } else {
            g = p;
        }

        if (d11 * 6.0 < 1.0) {
            b = p + (q - p) * 6.0 * d11;
        } else if (d11 * 2.0 < 1.0) {
            b = q;
        } else if (d11 * 3.0 < 2.0) {
            b = p + (q - p) * (0.6666666666666666 - d11) * 6.0;
        } else {
            b = p;
        }
    }

    const intR = (r * 256.0) | 0;
    const intG = (g * 256.0) | 0;
    const intB = (b * 256.0) | 0;
    return (intR << 16) + (intG << 8) + intB;
}

// MapView.drawOverlayShape: paints one overlay tile as a diagonal/edge split between
// the underlay colour and the overlay colour (coastlines, path edges, ...). `stride`
// is the destination row width in pixels; `off` the top-left pixel index.
function drawOverlayShape(data: Int32Array, off: number, stride: number, underlay: number, overlay: number, width: number, height: number, shape: number, rotation: number): void {
    const step = stride - width;
    if (shape == 9) {
        shape = 1;
        rotation = (rotation + 1) & 0x3;
    } else if (shape == 10) {
        shape = 1;
        rotation = (rotation + 3) & 0x3;
    } else if (shape == 11) {
        shape = 8;
        rotation = (rotation + 3) & 0x3;
    }

    if (shape == 1) {
        if (rotation == 0) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x <= y ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x <= y ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x >= y ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x >= y ? overlay : underlay;
                }
                off += step;
            }
        }
    } else if (shape == 2) {
        if (rotation == 0) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x <= y >> 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x >= y << 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y = 0; y < height; y++) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x <= y >> 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x >= y << 1 ? overlay : underlay;
                }
                off += step;
            }
        }
    } else if (shape == 3) {
        if (rotation == 0) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x <= y >> 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x >= y << 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x <= y >> 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y = 0; y < height; y++) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x >= y << 1 ? overlay : underlay;
                }
                off += step;
            }
        }
    } else if (shape == 4) {
        if (rotation == 0) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x >= y >> 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x <= y << 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y = 0; y < height; y++) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x >= y >> 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x <= y << 1 ? overlay : underlay;
                }
                off += step;
            }
        }
    } else if (shape == 5) {
        if (rotation == 0) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x >= y >> 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x <= y << 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x >= y >> 1 ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y = 0; y < height; y++) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x <= y << 1 ? overlay : underlay;
                }
                off += step;
            }
        }
    } else if (shape == 6) {
        if (rotation == 0) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x <= ((width / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = y <= ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x >= ((width / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = y >= ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        }
    } else if (shape == 7) {
        if (rotation == 0) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x <= y - ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x <= y - ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x <= y - ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y = 0; y < height; y++) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x <= y - ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        }
    } else if (shape == 8) {
        if (rotation == 0) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x >= y - ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = 0; x < width; x++) {
                    data[off++] = x >= y - ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y = height - 1; y >= 0; y--) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x >= y - ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y = 0; y < height; y++) {
                for (let x = width - 1; x >= 0; x--) {
                    data[off++] = x >= y - ((height / 2) | 0) ? overlay : underlay;
                }
                off += step;
            }
        }
    }
}

// ---- layer assembly ----

interface LayerBounds {
    minMapX: number;
    maxMapX: number;
    minMapZ: number;
    maxMapZ: number;
    minAbsX: number;
    maxAbsX: number;
    minAbsZ: number;
    maxAbsZ: number;
    widthPx: number;
    heightPx: number;
}

function computeBounds(squares: Square[]): LayerBounds {
    let minMapX = Infinity;
    let maxMapX = -Infinity;
    let minMapZ = Infinity;
    let maxMapZ = -Infinity;
    for (const sq of squares) {
        minMapX = Math.min(minMapX, sq.mapX);
        maxMapX = Math.max(maxMapX, sq.mapX);
        minMapZ = Math.min(minMapZ, sq.mapZ);
        maxMapZ = Math.max(maxMapZ, sq.mapZ);
    }

    const minAbsX = minMapX * SQUARE;
    const maxAbsX = (maxMapX + 1) * SQUARE - 1;
    const minAbsZ = minMapZ * SQUARE;
    const maxAbsZ = (maxMapZ + 1) * SQUARE - 1;

    return {
        minMapX,
        maxMapX,
        minMapZ,
        maxMapZ,
        minAbsX,
        maxAbsX,
        minAbsZ,
        maxAbsZ,
        widthPx: (maxAbsX - minAbsX + 1) * PX_PER_TILE,
        heightPx: (maxAbsZ - minAbsZ + 1) * PX_PER_TILE
    };
}

function hline(pix: Int32Array, pw: number, ph: number, x: number, y: number, len: number, rgb: number): void {
    if (y < 0 || y >= ph) {
        return;
    }
    let x0 = x;
    let n = len;
    if (x0 < 0) {
        n += x0;
        x0 = 0;
    }
    if (x0 + n > pw) {
        n = pw - x0;
    }
    let off = y * pw + x0;
    for (let i = 0; i < n; i++) {
        pix[off++] = rgb;
    }
}

function vline(pix: Int32Array, pw: number, ph: number, x: number, y: number, len: number, rgb: number): void {
    if (x < 0 || x >= pw) {
        return;
    }
    let y0 = y;
    let n = len;
    if (y0 < 0) {
        n += y0;
        y0 = 0;
    }
    if (y0 + n > ph) {
        n = ph - y0;
    }
    let off = y0 * pw + x;
    for (let i = 0; i < n; i++) {
        pix[off] = rgb;
        off += pw;
    }
}

// pixelX = (absX - minAbsX) * PX_PER_TILE
// pixelY = (maxAbsZ - absZ) * PX_PER_TILE   -- flipped so north (high Z) renders at the top
function renderLayer(squares: Square[], bounds: LayerBounds, wm: WorldmapData): Buffer {
    const wTiles = bounds.maxAbsX - bounds.minAbsX + 1;
    const hTiles = bounds.maxAbsZ - bounds.minAbsZ + 1;

    // padded working arrays (array coords: ax = absX - minAbsX + PAD, az flips Z north-up)
    const aw = wTiles + 2 * PAD;
    const ah = hTiles + 2 * PAD;
    const floort1 = new Uint8Array(aw * ah); // underlay id
    const floort2 = new Int32Array(aw * ah); // overlay RGB (0 = none)
    const floorsr = new Uint8Array(aw * ah); // overlay (shape<<2)|rotation
    const locWall = new Uint8Array(aw * ah); // wall/door code

    for (const sq of squares) {
        const baseX = sq.mapX * SQUARE;
        const baseZ = sq.mapZ * SQUARE;
        for (let lx = 0; lx < SQUARE; lx++) {
            const ax = baseX + lx - bounds.minAbsX + PAD;
            for (let lz = 0; lz < SQUARE; lz++) {
                const az = bounds.maxAbsZ - (baseZ + lz) + PAD;
                const li = lx * SQUARE + lz;
                const ai = ax * ah + az;
                floort1[ai] = sq.underlay[li];
                floort2[ai] = sq.overlayRgb[li];
                floorsr[ai] = sq.overlayShapeRot[li];
                locWall[ai] = sq.wall[li];
            }
        }
    }

    // MapView.getBlendedGroundColour: a directional HSL blend of the underlay colours
    // that gives the terrain its characteristic soft relief shading. `>>` coerces to
    // int32 exactly as the original, so the output matches the client.
    const blended = new Int32Array(aw * ah);
    const average = new Array<number>(ah).fill(0);
    const { floorcol1 } = wm;
    for (let x = 5; x < aw - 5; x++) {
        const eastCol = (x + 5) * ah;
        const westCol = (x - 5) * ah;
        for (let z = 0; z < ah; z++) {
            average[z] += floorcol1[floort1[eastCol + z]] - floorcol1[floort1[westCol + z]];
        }

        if (x > 10 && x < aw - 10) {
            let r = 0;
            let g = 0;
            let b = 0;
            for (let z = 5; z < ah - 5; z++) {
                const north = average[z + 5];
                const south = average[z - 5];
                r += (north >> 20) - (south >> 20);
                g += ((north >> 10) & 0x3ff) - ((south >> 10) & 0x3ff);
                b += (north & 0x3ff) - (south & 0x3ff);
                if (b > 0) {
                    blended[x * ah + z] = getRgb(r / 8533.0, g / 8533.0, b / 8533.0);
                }
            }
        }
    }

    // ---- rasterize into a packed-RGB pixel buffer at 2px/tile ----
    const pw = wTiles * PX_PER_TILE;
    const ph = hTiles * PX_PER_TILE;
    const pix = new Int32Array(pw * ph).fill(VOID_RGB);

    // ground + overlay pass (MapView.renderWorldMap, the widthRatio=2 case)
    for (let tx = 0; tx < wTiles; tx++) {
        const ax = tx + PAD;
        const px0 = tx * PX_PER_TILE;
        for (let tz = 0; tz < hTiles; tz++) {
            const az = tz + PAD;
            const ai = ax * ah + az;
            const off = tz * PX_PER_TILE * pw + px0;

            const overlayVal = floort2[ai];
            if (overlayVal !== 0) {
                const info = floorsr[ai];
                const shape = info & 0xfc;
                if (shape === 0) {
                    pix[off] = overlayVal;
                    pix[off + 1] = overlayVal;
                    pix[off + pw] = overlayVal;
                    pix[off + pw + 1] = overlayVal;
                } else {
                    drawOverlayShape(pix, off, pw, blended[ai], overlayVal, PX_PER_TILE, PX_PER_TILE, shape >> 2, info & 0x3);
                }
            } else {
                const c = blended[ai];
                if (c !== 0) {
                    pix[off] = c;
                    pix[off + 1] = c;
                    pix[off + pw] = c;
                    pix[off + pw + 1] = c;
                }
            }
        }
    }

    // wall pass (MapView.renderWorldMap wall block, lengthX=lengthY=2)
    for (let tx = 0; tx < wTiles; tx++) {
        const ax = tx + PAD;
        const startX = tx * PX_PER_TILE;
        const edgeX = startX + 1;
        for (let tz = 0; tz < hTiles; tz++) {
            const az = tz + PAD;
            let wall = locWall[ax * ah + az] & 0xff;
            if (wall === 0) {
                continue;
            }
            const startY = tz * PX_PER_TILE;
            const edgeY = startY + 1;

            let rgb = 0xcccccc;
            if ((wall >= 5 && wall <= 8) || (wall >= 13 && wall <= 16) || (wall >= 21 && wall <= 24)) {
                rgb = 0xcc0000;
                wall -= 4;
            }
            if (wall === 27 || wall === 28) {
                rgb = 0xcc0000;
                wall -= 2;
            }

            if (wall === 1) {
                vline(pix, pw, ph, startX, startY, PX_PER_TILE, rgb);
            } else if (wall === 2) {
                hline(pix, pw, ph, startX, startY, PX_PER_TILE, rgb);
            } else if (wall === 3) {
                vline(pix, pw, ph, edgeX, startY, PX_PER_TILE, rgb);
            } else if (wall === 4) {
                hline(pix, pw, ph, startX, edgeY, PX_PER_TILE, rgb);
            } else if (wall === 9) {
                vline(pix, pw, ph, startX, startY, PX_PER_TILE, 0xffffff);
                hline(pix, pw, ph, startX, startY, PX_PER_TILE, rgb);
            } else if (wall === 10) {
                vline(pix, pw, ph, edgeX, startY, PX_PER_TILE, 0xffffff);
                hline(pix, pw, ph, startX, startY, PX_PER_TILE, rgb);
            } else if (wall === 11) {
                vline(pix, pw, ph, edgeX, startY, PX_PER_TILE, 0xffffff);
                hline(pix, pw, ph, startX, edgeY, PX_PER_TILE, rgb);
            } else if (wall === 12) {
                vline(pix, pw, ph, startX, startY, PX_PER_TILE, 0xffffff);
                hline(pix, pw, ph, startX, edgeY, PX_PER_TILE, rgb);
            } else if (wall === 17) {
                hline(pix, pw, ph, startX, startY, 1, rgb);
            } else if (wall === 18) {
                hline(pix, pw, ph, edgeX, startY, 1, rgb);
            } else if (wall === 19) {
                hline(pix, pw, ph, edgeX, edgeY, 1, rgb);
            } else if (wall === 20) {
                hline(pix, pw, ph, startX, edgeY, 1, rgb);
            } else if (wall === 25) {
                for (let i = 0; i < PX_PER_TILE; i++) {
                    hline(pix, pw, ph, startX + i, edgeY - i, 1, rgb);
                }
            } else if (wall === 26) {
                for (let i = 0; i < PX_PER_TILE; i++) {
                    hline(pix, pw, ph, startX + i, startY + i, 1, rgb);
                }
            }
        }
    }

    // ---- pack into PNG scanlines (filter byte 0 per row, then RGB) ----
    const stride = 1 + pw * 3;
    const raw = Buffer.alloc(stride * ph);
    for (let y = 0; y < ph; y++) {
        const rowStart = y * stride;
        const rowPix = y * pw;
        for (let x = 0; x < pw; x++) {
            const c = pix[rowPix + x];
            const off = rowStart + 1 + x * 3;
            raw[off] = (c >> 16) & 0xff;
            raw[off + 1] = (c >> 8) & 0xff;
            raw[off + 2] = c & 0xff;
        }
    }
    return raw;
}

// ---- hand-rolled PNG encoding (no new npm dependency; node:zlib does the deflate) ----

let crcTable: Int32Array | null = null;
function getCrcTable(): Int32Array {
    if (crcTable !== null) {
        return crcTable;
    }
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    crcTable = table;
    return table;
}

function crc32(buf: Buffer): number {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// scanlines must already be filter-byte-prefixed (1 + width*3 bytes per row, filter
// type 0/None throughout - simplest correct encoding).
function encodePng(width: number, height: number, scanlines: Buffer): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 2; // color type: truecolor (RGB)
    ihdrData[10] = 0;
    ihdrData[11] = 0;
    ihdrData[12] = 0;
    const ihdr = pngChunk('IHDR', ihdrData);

    const idatData = zlib.deflateSync(scanlines, { level: 6 });
    const idat = pngChunk('IDAT', idatData);

    const iend = pngChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdr, idat, iend]);
}

// ---- main ----

async function main(): Promise<void> {
    if (!fs.existsSync(JAG_PATH)) {
        printWarning(`RenderWorldmapPng: ${JAG_PATH} is missing - run tools/pack/Build.ts (which packs the worldmap) first`);
        process.exitCode = 1;
        return;
    }

    const jag = Jagfile.load(JAG_PATH);
    const wm = parseWorldmap(jag);

    const surface: Square[] = [];
    const underground: Square[] = [];
    for (const sq of wm.squares.values()) {
        // +100-mapsquare convention: mapZ >= 100 is the underground layer.
        (sq.mapZ >= 100 ? underground : surface).push(sq);
    }

    printInfo(`RenderWorldmapPng: parsed ${surface.length} surface square(s), ${underground.length} underground square(s), ${wm.labels.length} label(s)`);

    if (surface.length === 0 && underground.length === 0) {
        printWarning('RenderWorldmapPng: worldmap.jag carried no mapsquares - nothing to render');
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const meta: Record<string, unknown> = { pxPerTile: PX_PER_TILE };

    if (surface.length > 0) {
        const bounds = computeBounds(surface);
        const raw = renderLayer(surface, bounds, wm);
        const png = encodePng(bounds.widthPx, bounds.heightPx, raw);
        fs.writeFileSync(path.join(OUT_DIR, 'worldmap-surface.png'), png);
        meta.surface = bounds;
        printInfo(`RenderWorldmapPng: wrote worldmap-surface.png (${bounds.widthPx}x${bounds.heightPx}, ${png.length} bytes)`);
    }

    if (underground.length > 0) {
        const bounds = computeBounds(underground);
        const raw = renderLayer(underground, bounds, wm);
        const png = encodePng(bounds.widthPx, bounds.heightPx, raw);
        fs.writeFileSync(path.join(OUT_DIR, 'worldmap-underground.png'), png);
        meta.underground = bounds;
        printInfo(`RenderWorldmapPng: wrote worldmap-underground.png (${bounds.widthPx}x${bounds.heightPx}, ${png.length} bytes)`);
    }

    // Place-name labels are drawn by the SPA as SVG text (scales with the map), so they
    // ship as data, not baked pixels. Coords are absolute tiles; size 0/1/2 = POI/town/
    // region. `/` in text is a line break (rendered as multi-line by the SPA).
    meta.labels = wm.labels;

    fs.writeFileSync(path.join(OUT_DIR, 'worldmap-meta.json'), JSON.stringify(meta, null, 2));
    printInfo(`RenderWorldmapPng: wrote ${path.join(OUT_DIR, 'worldmap-meta.json')}`);
}

main().catch(err => {
    printWarning(`RenderWorldmapPng: fatal error (${err instanceof Error ? err.stack ?? err.message : err})`);
    process.exitCode = 1;
});
