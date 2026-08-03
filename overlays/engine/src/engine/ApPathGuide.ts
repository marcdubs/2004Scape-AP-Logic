// Archipelago path helper - the in-game guide (docs/tracker-map.md "Pathfinding helper").
// Holds each player's active route and drives the Tutorial Island hint arrow along it,
// advancing one waypoint at a time as they actually get there.
//
// ---- Why the arrow, and why chaining ----
// The 2004 client has no waypoint-path rendering: no polyline, no multi-marker minimap.
// What it does have is `hint_coord` (content/scripts/general/configs/hint.constant's
// ^hint_center = 2, the same arrow Tutorial Island points at doors), which marks exactly
// one tile. So a multi-leg route is delivered the only way the client can express it -
// one arrow at a time, re-pointed at the next entrance the moment you reach the current
// one. The chat list gives the whole plan; the arrow answers "where now".
//
// ---- Waypoints, not legs ----
// A route's legs alternate walk/entrance, but a player only ever needs to be TOLD about
// the tiles they must interact with: each entrance's trigger tile, then the destination.
// Walking between them is self-evident once the arrow is up, so the waypoint list skips
// walk legs entirely.
//
// ---- State ----
// A WeakMap keyed by Player, deliberately not fields on Player: a route is transient
// convenience state that should never be saved, synced, or survive a logout, and letting
// the map drop it on GC is exactly that lifecycle. Nothing here is persisted.

import { CoordGrid } from '#/engine/CoordGrid.js';
import { PathLeg, PathResult, PathTile, findPath, listPlaces } from '#/engine/ApPathfinder.js';
import type Player from '#/engine/entity/Player.js';

/** ^hint_center - the centered coord arrow (HintArrowEncoder type 2). */
const HINT_CENTER = 2;

/** Hint arrow height offset, matching what the content scripts pass for ground tiles. */
const HINT_HEIGHT = 0;

/** How close (chebyshev tiles) counts as having reached a waypoint. */
const ARRIVE_RADIUS = 3;

/**
 * Range within which the arrow is worth arming. The client only renders a coord arrow for
 * a tile inside its loaded scene, so pointing at something across the world does nothing;
 * the arrow is armed lazily once the waypoint is actually close enough to draw, and
 * disarmed if the player wanders back out of range.
 */
const ARM_RANGE = 90;

interface Waypoint {
    tile: PathTile;
    /** what the player does here. */
    label: string;
    kind: 'entrance' | 'destination';
    requirement?: string;
    undiscovered?: boolean;
}

interface GuideState {
    destination: string;
    legs: PathLeg[];
    /** display lines, one per leg, prebuilt so the script command just prints them. */
    lines: string[];
    waypoints: Waypoint[];
    index: number;
    /**
     * Which waypoint the arrow currently on the player's client points at, or -1 for none.
     * NOT a boolean: the client keeps drawing the last HintArrow packet until something
     * writes another, so "is an arrow showing" and "is it showing the RIGHT waypoint" are
     * different questions and only the second one can drive a re-point. A bool conflated
     * them and stranded the arrow on the first ladder of every route (see tickRoute).
     */
    armedIndex: number;
    totalSteps: number;
}

const routes = new WeakMap<Player, GuideState>();

/** Last failure reason per player, so the script command can report it. */
const failures = new WeakMap<Player, string>();

function describeWhere(leg: PathLeg): string {
    if (!leg.near) {
        return '';
    }
    return leg.nearVia ? ` (via ${leg.near})` : ` (near ${leg.near})`;
}

/** "walk 126 steps to the laddertop (near Falador)" / "climb the ladder - needs a dramen staff". */
function describeLeg(leg: PathLeg, index: number): string {
    const where = describeWhere(leg);
    if (leg.kind === 'walk') {
        return `${index + 1}. Walk ${leg.steps} steps to ${leg.name}${where}`;
    }
    const notes: string[] = [];
    if (leg.requirement) {
        notes.push(`needs ${leg.requirement}`);
    }
    if (leg.undiscovered) {
        notes.push('you have not used this one yet');
    }
    return `${index + 1}. Use ${leg.name}${where}${notes.length > 0 ? ` - ${notes.join(', ')}` : ''}`;
}

function buildWaypoints(result: PathResult): Waypoint[] {
    const waypoints: Waypoint[] = [];
    for (const leg of result.legs) {
        if (leg.kind === 'entrance') {
            waypoints.push({
                tile: leg.from,
                label: leg.name,
                kind: 'entrance',
                requirement: leg.requirement,
                undiscovered: leg.undiscovered
            });
        }
    }
    const last = result.legs[result.legs.length - 1];
    if (last) {
        waypoints.push({ tile: last.to, label: result.destination, kind: 'destination' });
    }
    return waypoints;
}

function chebyshev(a: PathTile, b: PathTile): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function currentWaypoint(state: GuideState): Waypoint | null {
    return state.index < state.waypoints.length ? state.waypoints[state.index] : null;
}

function armArrow(player: Player, waypoint: Waypoint): void {
    player.hintTile(HINT_CENTER, waypoint.tile.x, waypoint.tile.z, HINT_HEIGHT);
}

function announce(player: Player, state: GuideState): void {
    const waypoint = currentWaypoint(state);
    if (!waypoint) {
        return;
    }
    if (waypoint.kind === 'destination') {
        player.messageGame(`Path: head for ${waypoint.label} - you are on the last stretch.`);
        return;
    }
    const notes: string[] = [];
    if (waypoint.requirement) {
        notes.push(`needs ${waypoint.requirement}`);
    }
    player.messageGame(`Path: next, use ${waypoint.label}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}.`);
}

/**
 * Computes a route from the player's current tile and makes it their active guide.
 * Returns the leg count, or -1 on failure (reason retrievable via routeText(-1)).
 */
export function startRoute(player: Player, destination: string, revealAll: boolean): number {
    clearRoute(player);

    const result = findPath({ level: player.level, x: player.x, z: player.z }, destination, { discoveredOnly: !revealAll });
    if (!result.ok) {
        failures.set(player, result.reason);
        return -1;
    }

    if (result.legs.length === 0) {
        failures.set(player, `you are already at ${result.destination}`);
        return 0;
    }

    const state: GuideState = {
        destination: result.destination,
        legs: result.legs,
        lines: result.legs.map((leg, i) => describeLeg(leg, i)),
        waypoints: buildWaypoints(result),
        index: 0,
        armedIndex: -1,
        totalSteps: result.totalSteps
    };
    routes.set(player, state);

    // Arm immediately if the first waypoint is already on screen; otherwise the per-tick
    // check picks it up as the player closes in.
    tickRoute(player);
    return result.legs.length;
}

/**
 * Text for the script command. index -1 returns the summary line (or the failure reason
 * when the last attempt failed); 0..legs-1 returns that leg's description.
 */
export function routeText(player: Player, index: number): string {
    if (index < 0) {
        const state = routes.get(player);
        if (!state) {
            return failures.get(player) ?? 'no active path';
        }
        const runTicks = Math.ceil(state.totalSteps / 2);
        const hops = state.legs.filter(l => l.kind === 'entrance').length;
        return `Path to ${state.destination}: ${state.totalSteps} steps, ${hops} entrance${hops === 1 ? '' : 's'}, about ${Math.max(1, Math.round(runTicks * 0.6))}s running.`;
    }

    const state = routes.get(player);
    if (!state || index >= state.lines.length) {
        return '';
    }
    return state.lines[index];
}

/** Packed coord of a leg's actionable tile (an entrance's trigger, a walk's endpoint). */
export function routeCoord(player: Player, index: number): number {
    const state = routes.get(player);
    if (!state || index < 0 || index >= state.legs.length) {
        return -1;
    }
    const leg = state.legs[index];
    const tile = leg.kind === 'entrance' ? leg.from : leg.to;
    return CoordGrid.packCoord(tile.level, tile.x, tile.z);
}

/** Forgets the active route and takes the arrow down. */
export function clearRoute(player: Player): void {
    const state = routes.get(player);
    routes.delete(player);
    failures.delete(player);
    if (state !== undefined && state.armedIndex !== -1) {
        player.stopHint();
    }
}

export function hasRoute(player: Player): boolean {
    return routes.has(player);
}

/** Characters of place names to put on one chat line before starting a new page. */
const PLACES_PAGE_WIDTH = 90;

/**
 * One chat-line-sized page of routable place names, '' once past the end. Paging lives here
 * rather than in rs2 because the name list is engine-side data; the script just prints
 * pages until it gets an empty one.
 */
export function placesPage(page: number): string {
    if (page < 0) {
        return '';
    }

    const names = listPlaces().map(p => p.name);
    const pages: string[] = [];
    let current = '';
    for (const name of names) {
        const next = current.length === 0 ? name : `${current}, ${name}`;
        if (next.length > PLACES_PAGE_WIDTH) {
            pages.push(current);
            current = name;
        } else {
            current = next;
        }
    }
    if (current.length > 0) {
        pages.push(current);
    }

    return page < pages.length ? pages[page] : '';
}

/**
 * Per-tick advance. Called from Player.updateMovement, so it runs for every player every
 * tick and must stay to a couple of comparisons in the common case (no active route).
 */
export function tickRoute(player: Player): void {
    const state = routes.get(player);
    if (!state) {
        return;
    }

    const here: PathTile = { level: player.level, x: player.x, z: player.z };

    // Reached the current waypoint? Advance - possibly several at once, since an entrance
    // can drop the player right on top of the next one.
    let advanced = false;
    for (;;) {
        const waypoint = currentWaypoint(state);
        if (!waypoint) {
            break;
        }
        if (waypoint.tile.level !== here.level || chebyshev(waypoint.tile, here) > ARRIVE_RADIUS) {
            break;
        }
        state.index++;
        advanced = true;
    }

    if (state.index >= state.waypoints.length) {
        // Route complete.
        if (state.armedIndex !== -1) {
            player.stopHint();
        }
        routes.delete(player);
        player.messageGame(`Path: you have arrived at ${state.destination}.`);
        return;
    }

    if (advanced) {
        announce(player, state);
    }

    const waypoint = currentWaypoint(state);
    if (!waypoint) {
        return;
    }

    // Arm, re-point, or disarm the arrow depending on whether the client could actually
    // draw the CURRENT waypoint. Comparing armedIndex against index (rather than a bool)
    // is what makes the middle case exist: advancing onto a waypoint the client cannot
    // draw - which is every ladder and staircase, since the next waypoint is by definition
    // on another level - has to take the old arrow DOWN. The bool version cleared its
    // "armed" flag on advance and so could never reach its own stopHint branch, leaving
    // the first ladder's arrow burned onto the screen for the rest of the route.
    const drawable = waypoint.tile.level === here.level && chebyshev(waypoint.tile, here) <= ARM_RANGE;
    if (drawable && state.armedIndex !== state.index) {
        armArrow(player, waypoint);
        state.armedIndex = state.index;
    } else if (!drawable && state.armedIndex !== -1) {
        player.stopHint();
        state.armedIndex = -1;
    }
}
