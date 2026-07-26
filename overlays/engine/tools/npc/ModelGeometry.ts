import fs from 'fs';
import path from 'path';

// Reads the vertex bounding box out of a .ob2 model file.
//
// The drip randomizer's exclusion list was hand-curated one user report at a time
// ("Betty is invisible", "the Monks have no legs", "everyone has demon hands"). Every
// one of those turned out to be a model that is not a general-purpose substitute for
// its category - and most of them are visible in the geometry itself, if something
// actually reads it. This does: enough of the RS model format to walk the vertex list
// and report the box, which is all any of those questions need ("does this legs model
// reach the ankles?", "does this torso model include a head?").
//
// Format notes (mirrors webclient/src/dash3d/Model.ts unpackType1, which is the
// authority): the last 18 bytes are the trailer - counts and per-section byte lengths;
// everything before it is section data laid out in a fixed order. Vertices are
// delta-encoded from the previous vertex, each axis present only if its bit is set in
// the per-vertex order byte, using the CLIENT's `gsmarts` (1 byte biased by 0x40, or 2
// bytes biased by 0xc000) - note the engine's Packet.gsmarts is a DIFFERENT encoding,
// so this reader carries its own.
//
// Y grows DOWNWARD in model space, so "top" (height above the ground plane) is -minY.

export type ModelBounds = {
    numPoints: number;
    numFaces: number;
    // heights above the ground plane: top is the highest vertex, bottom the lowest.
    top: number;
    bottom: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
};

class ByteReader {
    private readonly buf: Buffer;
    pos = 0;

    constructor(buf: Buffer, pos = 0) {
        this.buf = buf;
        this.pos = pos;
    }

    g1(): number {
        return this.buf[this.pos++];
    }

    g2(): number {
        const value = (this.buf[this.pos] << 8) | this.buf[this.pos + 1];
        this.pos += 2;
        return value;
    }

    // the client's signed "smart": < 0x80 is one byte biased by 0x40, otherwise two
    // bytes biased by 0xc000.
    gsmarts(): number {
        return this.buf[this.pos] < 0x80 ? this.g1() - 0x40 : this.g2() - 0xc000;
    }
}

export function readModelBounds(filePath: string): ModelBounds | null {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 18) {
        return null;
    }

    const trailer = new ByteReader(buf, buf.length - 18);
    const numPoints = trailer.g2();
    const numFaces = trailer.g2();
    const numTextured = trailer.g1();
    const hasRenderType = trailer.g1();
    const priority = trailer.g1();
    const hasAlpha = trailer.g1();
    const hasFaceLabels = trailer.g1();
    const hasVertexLabels = trailer.g1();
    const lengthX = trailer.g2();
    const lengthY = trailer.g2();
    const lengthZ = trailer.g2();
    const lengthFaceIndex = trailer.g2();

    let pos = 0;
    const vertexOrderOffset = pos;
    pos += numPoints; // vertex order flags
    pos += numFaces; // face index order
    if (priority === 255) {
        pos += numFaces; // per-face priority
    }
    if (hasFaceLabels === 1) {
        pos += numFaces;
    }
    if (hasRenderType === 1) {
        pos += numFaces;
    }
    if (hasVertexLabels === 1) {
        pos += numPoints;
    }
    if (hasAlpha === 1) {
        pos += numFaces;
    }
    pos += lengthFaceIndex;
    pos += numFaces * 2; // face colours
    pos += numTextured * 6; // texture axes
    const vertexXOffset = pos;
    pos += lengthX;
    const vertexYOffset = pos;
    pos += lengthY;
    const vertexZOffset = pos;
    pos += lengthZ;
    if (pos > buf.length - 18) {
        return null;
    }

    const order = new ByteReader(buf, vertexOrderOffset);
    const xs = new ByteReader(buf, vertexXOffset);
    const ys = new ByteReader(buf, vertexYOffset);
    const zs = new ByteReader(buf, vertexZOffset);

    let x = 0;
    let y = 0;
    let z = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let v = 0; v < numPoints; v++) {
        const flags = order.g1();
        x += (flags & 0x1) !== 0 ? xs.gsmarts() : 0;
        y += (flags & 0x2) !== 0 ? ys.gsmarts() : 0;
        z += (flags & 0x4) !== 0 ? zs.gsmarts() : 0;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
    }

    if (!Number.isFinite(minY)) {
        return null;
    }

    return { numPoints, numFaces, top: -minY, bottom: -maxY, minX, maxX, minZ, maxZ };
}

// name -> .ob2 path, over the whole models tree (names are unique - the pack build
// resolves a model.pack name to exactly one file).
let modelPaths: Map<string, string> | null = null;

function indexModelFiles(modelsRoot: string): Map<string, string> {
    if (modelPaths) {
        return modelPaths;
    }
    modelPaths = new Map();
    const stack = [modelsRoot];
    while (stack.length) {
        const dir = stack.pop()!;
        if (!fs.existsSync(dir)) {
            continue;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.name.endsWith('.ob2')) {
                modelPaths.set(entry.name.slice(0, -'.ob2'.length), full);
            }
        }
    }
    return modelPaths;
}

const boundsCache = new Map<string, ModelBounds | null>();

export function boundsFor(modelsRoot: string, name: string): ModelBounds | null {
    if (boundsCache.has(name)) {
        return boundsCache.get(name)!;
    }
    const file = indexModelFiles(modelsRoot).get(name);
    let bounds: ModelBounds | null = null;
    if (file) {
        try {
            bounds = readModelBounds(file);
        } catch {
            bounds = null;
        }
    }
    boundsCache.set(name, bounds);
    return bounds;
}

export function median(values: number[]): number {
    if (!values.length) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}
