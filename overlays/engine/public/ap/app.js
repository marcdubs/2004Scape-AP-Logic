// Archipelago discovery tracker SPA (2004Scape-AP-Logic docs/tracker-map.md).
// Plain HTML/CSS/JS, no build step, no frameworks. Polls /ap/tracker.json every 5s
// and renders whatever's been discovered so far - a discovery journal, not a
// spoiler dump (unless ?spoiler=1 is on the URL, see the toggle link in the header).

(function () {
    'use strict';

    var POLL_MS = 5000;

    var params = new URLSearchParams(window.location.search);
    var spoilerMode = params.get('spoiler') === '1';

    var state = {
        data: null,
        meta: null,
        layer: 'surface',
        selectedSite: null
    };

    // ---- coord string parsing ----
    // entrance keys: "level_mapX_mapZ_localX_localZ:op"
    // entrance/teleport values: "level_mapX_mapZ_localX_localZ"
    // (see ApEntranceOverrides.ts stringFromPacked / teleport.rs2's ap_track call -
    // both use this exact format so the map can parse both categories the same way.)

    function parseCoord(raw) {
        var parts = raw.split('_');
        if (parts.length !== 5) {
            return null;
        }
        var level = parseInt(parts[0], 10);
        var mapX = parseInt(parts[1], 10);
        var mapZ = parseInt(parts[2], 10);
        var localX = parseInt(parts[3], 10);
        var localZ = parseInt(parts[4], 10);
        if ([level, mapX, mapZ, localX, localZ].some(function (n) { return Number.isNaN(n); })) {
            return null;
        }
        var absX = mapX * 64 + localX;
        var absZ = mapZ * 64 + localZ;
        return {
            level: level,
            mapX: mapX,
            mapZ: mapZ,
            absX: absX,
            absZ: absZ,
            layer: mapZ >= 100 ? 'underground' : 'surface'
        };
    }

    function coordToPixel(coord, bounds, pxPerTile) {
        return {
            x: (coord.absX - bounds.minAbsX) * pxPerTile,
            y: (bounds.maxAbsZ - coord.absZ) * pxPerTile
        };
    }

    // ---- fetching ----

    function fetchTracker() {
        var url = '/ap/tracker.json' + (spoilerMode ? '?spoiler=1' : '');
        fetch(url, { cache: 'no-store' })
            .then(function (res) {
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }
                return res.json();
            })
            .then(function (data) {
                state.data = data;
                setStatus(true);
                renderAll();
            })
            .catch(function (err) {
                setStatus(false, err);
            });
    }

    function fetchMeta() {
        fetch('worldmap-meta.json', { cache: 'no-store' })
            .then(function (res) {
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }
                return res.json();
            })
            .then(function (meta) {
                state.meta = meta;
                renderMap();
            })
            .catch(function () {
                document.getElementById('map-loading').textContent = 'Map images unavailable (run RenderWorldmapPng.ts on the server).';
            });
    }

    function setStatus(ok, err) {
        var el = document.getElementById('status');
        if (ok) {
            el.textContent = 'live' + (spoilerMode ? ' · spoiler mode' : '');
            el.className = 'status ok';
        } else {
            el.textContent = 'offline (' + (err ? err.message : 'error') + ')';
            el.className = 'status err';
        }
    }

    // ---- tabs ----

    function initTabs() {
        var buttons = document.querySelectorAll('.tab-btn');
        buttons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                buttons.forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
                document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
            });
        });
    }

    function initSpoilerToggle() {
        var link = document.getElementById('spoiler-toggle');
        if (spoilerMode) {
            link.textContent = 'exit spoiler mode';
            link.classList.add('on');
            link.href = '?';
        } else {
            link.textContent = 'spoiler mode';
            link.href = '?spoiler=1';
        }
    }

    // ---- render: shared table helper ----

    function renderTable(tableId, emptyId, discovered, spoilerFull, rowBuilder) {
        var table = document.getElementById(tableId);
        var tbody = table.querySelector('tbody');
        var emptyEl = document.getElementById(emptyId);
        tbody.innerHTML = '';

        var discoveredKeys = Object.keys(discovered || {});

        if (discoveredKeys.length === 0 && (!spoilerFull || Object.keys(spoilerFull).length === 0)) {
            table.style.display = 'none';
            emptyEl.hidden = false;
            return;
        }

        table.style.display = '';
        emptyEl.hidden = true;

        discoveredKeys.forEach(function (key) {
            var tr = rowBuilder(key, discovered[key], false);
            if (tr) {
                tbody.appendChild(tr);
            }
        });

        if (spoilerFull) {
            Object.keys(spoilerFull).forEach(function (key) {
                if (Object.prototype.hasOwnProperty.call(discovered || {}, key)) {
                    return;
                }
                var tr = rowBuilder(key, spoilerFull[key], true);
                if (tr) {
                    tr.classList.add('spoiler-row');
                    tbody.appendChild(tr);
                }
            });
        }
    }

    function makeRow(a, arrow, b) {
        var tr = document.createElement('tr');
        var tdA = document.createElement('td');
        tdA.textContent = a;
        var tdArrow = document.createElement('td');
        tdArrow.className = 'arrow';
        tdArrow.textContent = arrow;
        var tdB = document.createElement('td');
        tdB.textContent = b;
        tr.appendChild(tdA);
        tr.appendChild(tdArrow);
        tr.appendChild(tdB);
        return tr;
    }

    // ---- render: gathering / recipes (obj id -> obj id, via names.items) ----

    function renderItemSwapTab(category, tableId, emptyId, counterId) {
        var data = state.data;
        if (!data) {
            return;
        }
        var discovered = (data.discoveries && data.discoveries[category]) || {};
        var spoilerFull = data.spoiler ? data.spoiler[category] : null;
        var names = (data.names && data.names.items) || {};
        var total = (data.totals && data.totals[category]) || 0;

        document.getElementById(counterId).textContent = '(' + Object.keys(discovered).length + ' / ' + total + ' discovered)';

        renderTable(tableId, emptyId, discovered, spoilerFull, function (key, value) {
            var fromName = names[key] || ('item_' + key);
            var toName = names[value] || ('item_' + value);
            return makeRow(fromName, '→', toName);
        });
    }

    // ---- render: bestiary (drop slot -> unit, via names.dropSlots/dropUnits) ----

    function renderBestiaryTab() {
        var data = state.data;
        if (!data) {
            return;
        }
        var discovered = (data.discoveries && data.discoveries.drops) || {};
        var spoilerFull = data.spoiler ? data.spoiler.drops : null;
        var slots = (data.names && data.names.dropSlots) || {};
        var units = (data.names && data.names.dropUnits) || {};
        var total = (data.totals && data.totals.drops) || 0;

        document.getElementById('bestiary-counter').textContent = '(' + Object.keys(discovered).length + ' / ' + total + ' discovered)';

        renderTable('bestiary-table', 'bestiary-empty', discovered, spoilerFull, function (slot, unit) {
            var monster = slots[slot] || ('slot_' + slot);
            var table = units[unit] || ('unit_' + unit);
            return makeRow(monster, '→ smells like', table);
        });
    }

    // ---- render: teleports (spell name -> coord string, no spoiler source) ----

    function renderTeleportsTab() {
        var data = state.data;
        if (!data) {
            return;
        }
        var discovered = (data.discoveries && data.discoveries.teleports) || {};
        var total = (data.totals && data.totals.teleports) || 0;

        document.getElementById('teleports-counter').textContent = '(' + Object.keys(discovered).length + ' / ' + total + ' discovered)';

        renderTable('teleports-table', 'teleports-empty', discovered, null, function (spell, coordStr) {
            var coord = parseCoord(coordStr);
            var label = coord
                ? (coord.layer === 'underground' ? 'underground, ' : '') + 'tile (' + coord.absX + ', ' + coord.absZ + ') level ' + coord.level
                : coordStr;
            return makeRow(spell, '→', label);
        });
    }

    // ---- render: entrances list (docs/tracker-map.md "the map can be hard to read")
    // ----
    // Same discovered-entrances data the map draws as pins/lines, as a readable,
    // sortable, filterable list. Discovery gating comes for free: this only ever
    // reads data.discoveries.entrances, which the server already scopes to what's
    // actually been used (see buildApTrackerResponse in web.ts).

    function labelForRaw(raw) {
        var data = state.data;
        var places = (data && data.names && data.names.places) || {};
        if (places[raw]) {
            return places[raw];
        }
        var coord = parseCoord(raw);
        if (coord) {
            return (coord.layer === 'underground' ? 'underground, ' : '') + 'tile (' + coord.absX + ', ' + coord.absZ + ') level ' + coord.level;
        }
        return raw;
    }

    // Collapses a discovered "A leads to B" record and its discovered reverse (if
    // any) into one row - one-way connections keep a single "->" arrow, entrances
    // that have been used from both ends render once as a "<->" pair instead of two
    // near-duplicate rows.
    function buildConnectionRows(discovered) {
        var bySrcDst = {};
        var parsed = [];

        Object.keys(discovered).forEach(function (key) {
            var idx = key.lastIndexOf(':');
            var src = idx === -1 ? key : key.slice(0, idx);
            var dst = discovered[key];
            bySrcDst[src + '|' + dst] = true;
            parsed.push({ src: src, dst: dst });
        });

        var seenPairs = {};
        var rows = [];

        parsed.forEach(function (entry) {
            var pairKey = [entry.src, entry.dst].sort().join('|');
            if (seenPairs[pairKey]) {
                return;
            }
            seenPairs[pairKey] = true;

            var twoWay = !!bySrcDst[entry.dst + '|' + entry.src];
            var srcCoord = parseCoord(entry.src);
            var dstCoord = parseCoord(entry.dst);
            var group = 'Cross-layer';
            if (srcCoord && dstCoord && srcCoord.layer === dstCoord.layer) {
                group = srcCoord.layer === 'underground' ? 'Underground' : 'Surface';
            }

            rows.push({
                srcRaw: entry.src,
                dstRaw: entry.dst,
                srcLabel: labelForRaw(entry.src),
                dstLabel: labelForRaw(entry.dst),
                twoWay: twoWay,
                group: group
            });
        });

        return rows;
    }

    var ENTRANCE_GROUP_ORDER = ['Surface', 'Underground', 'Cross-layer'];

    function renderEntrancesTab() {
        var data = state.data;
        var container = document.getElementById('entrances-groups');
        var emptyEl = document.getElementById('entrances-empty');
        var counterEl = document.getElementById('entrances-counter');
        if (!data) {
            return;
        }

        var discovered = (data.discoveries && data.discoveries.entrances) || {};
        var total = (data.totals && data.totals.entrances) || 0;
        counterEl.textContent = '(' + Object.keys(discovered).length + ' / ' + total + ' discovered)';

        var rows = buildConnectionRows(discovered);
        container.innerHTML = '';

        if (rows.length === 0) {
            emptyEl.hidden = false;
            return;
        }
        emptyEl.hidden = true;

        var searchInput = document.getElementById('entrances-search');
        var filterTerm = ((searchInput && searchInput.value) || '').trim().toLowerCase();

        var byGroup = {};
        rows.forEach(function (row) {
            if (!byGroup[row.group]) {
                byGroup[row.group] = [];
            }
            byGroup[row.group].push(row);
        });

        var anyRendered = false;

        ENTRANCE_GROUP_ORDER.forEach(function (groupName) {
            var groupRows = byGroup[groupName];
            if (!groupRows || groupRows.length === 0) {
                return;
            }

            groupRows.sort(function (a, b) {
                return a.srcLabel.localeCompare(b.srcLabel) || a.dstLabel.localeCompare(b.dstLabel);
            });

            if (filterTerm) {
                groupRows = groupRows.filter(function (row) {
                    return row.srcLabel.toLowerCase().indexOf(filterTerm) !== -1 || row.dstLabel.toLowerCase().indexOf(filterTerm) !== -1;
                });
            }

            if (groupRows.length === 0) {
                return;
            }

            anyRendered = true;

            var section = document.createElement('div');
            section.className = 'connection-group';

            var heading = document.createElement('h3');
            heading.textContent = groupName + ' (' + groupRows.length + ')';
            section.appendChild(heading);

            var table = document.createElement('table');
            table.className = 'discovery-table';
            var thead = document.createElement('thead');
            thead.innerHTML = '<tr><th>Location</th><th></th><th>Leads to</th></tr>';
            table.appendChild(thead);

            var tbody = document.createElement('tbody');
            groupRows.forEach(function (row) {
                var tr = makeRow(row.srcLabel, row.twoWay ? '⇄' : '→', row.dstLabel);
                tr.classList.add('clickable');
                tr.title = 'Click to view on the map';
                tr.addEventListener('click', function () {
                    panToRaw(row.srcRaw);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);

            section.appendChild(table);
            container.appendChild(section);
        });

        if (!anyRendered && filterTerm) {
            var noMatch = document.createElement('p');
            noMatch.className = 'tab-desc';
            noMatch.textContent = 'No connections match "' + filterTerm + '".';
            container.appendChild(noMatch);
        }
    }

    function initEntranceSearch() {
        var input = document.getElementById('entrances-search');
        input.addEventListener('input', renderEntrancesTab);
    }

    function initShowLockedToggle() {
        var box = document.getElementById('unlocks-show-locked');
        if (box) {
            box.addEventListener('change', renderUnlocksTab);
        }
    }

    // ---- render: map ----

    var mapDrag = { active: false, moved: false, downX: 0, downY: 0, startX: 0, startY: 0, tx: 0, ty: 0, scale: 1 };

    // sites drawn on the CURRENT layer, with their pixel positions, so a pointer
    // "click" (a pointerup that didn't drag) can hit-test against them without
    // fighting the viewport's pointer capture - see handleMapClick.
    var currentPins = [];

    // Applies the current pan/zoom to the world, and rescales the SVG markers so they
    // stay roughly a fixed SIZE on screen (and shrink a little once zoomed in) instead
    // of ballooning with the map - that's what lets a cluster of nearby ladders stay
    // legible at high zoom. Done via CSS custom properties on the overlay so one write
    // restyles every pin, rather than touching hundreds of elements per wheel tick.
    function applyMapTransform() {
        var world = document.getElementById('map-world');
        if (world) {
            world.style.transform = 'translate(' + mapDrag.tx + 'px,' + mapDrag.ty + 'px) scale(' + mapDrag.scale + ')';
        }
        var overlay = document.getElementById('map-overlay');
        if (!overlay) {
            return;
        }
        var scale = mapDrag.scale || 1;
        var screenR = scale >= 3 ? 2.5 : 4;         // px on screen; a touch smaller zoomed in
        overlay.style.setProperty('--pin-r', (screenR / scale).toFixed(3));
        overlay.style.setProperty('--pin-sw', (1.1 / scale).toFixed(3));
        overlay.style.setProperty('--pin-badge', (7 / scale).toFixed(3) + 'px');
        overlay.style.setProperty('--ring-r', ((screenR + 4) / scale).toFixed(3));
        overlay.style.setProperty('--sel-sw', (1.6 / scale).toFixed(3));
    }

    function initMapControls() {
        var viewport = document.getElementById('map-viewport');

        var applyTransform = applyMapTransform;

        viewport.addEventListener('pointerdown', function (e) {
            mapDrag.active = true;
            mapDrag.moved = false;
            mapDrag.downX = e.clientX;
            mapDrag.downY = e.clientY;
            mapDrag.startX = e.clientX - mapDrag.tx;
            mapDrag.startY = e.clientY - mapDrag.ty;
            viewport.classList.add('dragging');
            viewport.setPointerCapture(e.pointerId);
        });

        viewport.addEventListener('pointermove', function (e) {
            if (!mapDrag.active) {
                return;
            }
            if (Math.abs(e.clientX - mapDrag.downX) > 4 || Math.abs(e.clientY - mapDrag.downY) > 4) {
                mapDrag.moved = true;
            }
            mapDrag.tx = e.clientX - mapDrag.startX;
            mapDrag.ty = e.clientY - mapDrag.startY;
            applyTransform();
        });

        function endDrag(e) {
            var wasActive = mapDrag.active;
            mapDrag.active = false;
            viewport.classList.remove('dragging');
            if (e && e.pointerId !== undefined) {
                try { viewport.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            }
            // a press that never moved is a click - hit-test it against the pins
            if (wasActive && !mapDrag.moved && e && e.type === 'pointerup') {
                handleMapClick(e);
            }
        }

        viewport.addEventListener('pointerup', endDrag);
        viewport.addEventListener('pointercancel', endDrag);

        var closeBtn = document.getElementById('map-info-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', function () {
                selectSite(null);
            });
        }

        viewport.addEventListener('wheel', function (e) {
            e.preventDefault();
            var rect = viewport.getBoundingClientRect();
            var cx = e.clientX - rect.left;
            var cy = e.clientY - rect.top;

            var prevScale = mapDrag.scale;
            var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            var nextScale = Math.min(8, Math.max(0.15, prevScale * factor));

            // keep the point under the cursor stationary while zooming
            mapDrag.tx = cx - ((cx - mapDrag.tx) / prevScale) * nextScale;
            mapDrag.ty = cy - ((cy - mapDrag.ty) / prevScale) * nextScale;
            mapDrag.scale = nextScale;
            applyTransform();
        }, { passive: false });

        document.querySelectorAll('.layer-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('.layer-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                state.layer = btn.dataset.layer;
                // a selection on the other layer would be invisible - drop it
                state.selectedSite = null;
                // reset the view for the new layer's image
                mapDrag.tx = 0;
                mapDrag.ty = 0;
                mapDrag.scale = 1;
                applyTransform();
                renderMap();
            });
        });
    }

    function svgEl(tag, attrs) {
        var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (var k in attrs) {
            if (Object.prototype.hasOwnProperty.call(attrs, k)) {
                el.setAttribute(k, attrs[k]);
            }
        }
        return el;
    }

    // Group every shuffled entrance (and teleport landing) by its map pixel, keyed by
    // "absX_absZ". A single map spot can stack several plane levels and several ops
    // (spiral-staircase up + down, trapdoors on different floors) - they all land on
    // the same pixel, so grouping here is what lets a click "separate out the multiple
    // levels available" instead of piling identical pins on top of each other.
    var sitesCache = { sig: null, sites: null };

    function trackerSignature(data) {
        var entrances = (data.discoveries && data.discoveries.entrances) || {};
        var teleports = (data.discoveries && data.discoveries.teleports) || {};
        var sources = data.entranceSources || [];
        return sources.length + '|' + Object.keys(entrances).length + '|' + Object.keys(teleports).length;
    }

    function buildSites(data) {
        var sig = trackerSignature(data);
        if (sitesCache.sig === sig && sitesCache.sites) {
            return sitesCache.sites;
        }

        var sites = {};
        function siteFor(coord) {
            var k = coord.absX + '_' + coord.absZ;
            if (!sites[k]) {
                sites[k] = { key: k, absX: coord.absX, absZ: coord.absZ, layer: coord.layer, entrances: [], teleports: [] };
            }
            return sites[k];
        }

        var discovered = (data.discoveries && data.discoveries.entrances) || {};
        var sources = data.entranceSources || [];

        // fall back to just the discovered set if the server predates entranceSources
        var sourceKeys = sources.length ? sources : Object.keys(discovered);

        sourceKeys.forEach(function (rawKey) {
            var idx = rawKey.lastIndexOf(':');
            var srcRaw = idx === -1 ? rawKey : rawKey.slice(0, idx);
            var op = idx === -1 ? '' : rawKey.slice(idx + 1);
            var coord = parseCoord(srcRaw);
            if (!coord) {
                return;
            }
            var destRaw = discovered[rawKey] || null;
            siteFor(coord).entrances.push({
                srcRaw: srcRaw,
                op: op,
                level: coord.level,
                coord: coord,
                destRaw: destRaw,
                dest: destRaw ? parseCoord(destRaw) : null
            });
        });

        var teleports = (data.discoveries && data.discoveries.teleports) || {};
        Object.keys(teleports).forEach(function (spell) {
            var coord = parseCoord(teleports[spell]);
            if (!coord) {
                return;
            }
            siteFor(coord).teleports.push({ spell: spell, coord: coord });
        });

        // keep each site's entrance list in a stable, readable order (by level, then op)
        Object.keys(sites).forEach(function (k) {
            sites[k].entrances.sort(function (a, b) {
                return (a.level - b.level) || a.op.localeCompare(b.op);
            });
        });

        sitesCache = { sig: sig, sites: sites };
        return sites;
    }

    function siteIsExplored(site) {
        return site.teleports.length > 0 || site.entrances.some(function (e) { return !!e.destRaw; });
    }

    var SEL_PALETTE = ['#ff981f', '#5ad0d0', '#d05ad0', '#7fd63c', '#ffe14d', '#ff6f5a'];

    // the pin layer only needs rebuilding when the layer or the discovered data
    // changes - not on every 5s poll. Selection is drawn as a separate, cheap group,
    // so clicking a pin never re-touches the (potentially hundreds of) base pins.
    var lastPinKey = null;

    function renderMap() {
        var data = state.data;
        var meta = state.meta;
        var img = document.getElementById('map-image');
        var overlay = document.getElementById('map-overlay');
        var loadingEl = document.getElementById('map-loading');
        var emptyEl = document.getElementById('map-empty');

        if (!meta || !meta[state.layer]) {
            return;
        }

        loadingEl.hidden = true;

        var bounds = meta[state.layer];
        var pxPerTile = meta.pxPerTile || 2;
        var src = 'worldmap-' + state.layer + '.png';

        if (img.getAttribute('data-src') !== src) {
            img.src = src;
            img.setAttribute('data-src', src);
            img.width = bounds.widthPx;
            img.height = bounds.heightPx;
        }

        overlay.setAttribute('width', bounds.widthPx);
        overlay.setAttribute('height', bounds.heightPx);
        overlay.setAttribute('viewBox', '0 0 ' + bounds.widthPx + ' ' + bounds.heightPx);

        var pinGroup = document.getElementById('map-pins');
        var selGroup = document.getElementById('map-sel');
        if (!pinGroup) {
            pinGroup = svgEl('g', { id: 'map-pins' });
            selGroup = svgEl('g', { id: 'map-sel' });
            overlay.appendChild(pinGroup);
            overlay.appendChild(selGroup);
        }

        if (!data) {
            return;
        }

        var sites = buildSites(data);
        var pinKey = state.layer + '::' + trackerSignature(data);

        if (pinKey !== lastPinKey) {
            lastPinKey = pinKey;
            rebuildPins(pinGroup, sites, bounds, pxPerTile);
            var counters = document.getElementById('map-counters');
            var discoveredEntrances = (data.discoveries && data.discoveries.entrances) || {};
            var discoveredTeleports = (data.discoveries && data.discoveries.teleports) || {};
            var entranceTotal = (data.totals && data.totals.entrances) || 0;
            var teleportTotal = (data.totals && data.totals.teleports) || 0;
            counters.innerHTML =
                '<span>Entrances: <b>' + Object.keys(discoveredEntrances).length + ' / ' + entranceTotal + '</b></span>' +
                '<span>Teleports: <b>' + Object.keys(discoveredTeleports).length + ' / ' + teleportTotal + '</b></span>';
            emptyEl.hidden = currentPins.length > 0;
        }

        selGroup.innerHTML = '';
        renderSelectionOverlay(selGroup, sites, bounds, pxPerTile);
        renderSitePanel(sites);
        applyMapTransform(); // set the initial --pin-r etc. for the current zoom
    }

    // ---- base layer: one pin per site, no connecting lines (those are drawn only for
    // the selected site, keeping the default view legible at any zoom) ----
    function rebuildPins(pinGroup, sites, bounds, pxPerTile) {
        pinGroup.innerHTML = '';
        currentPins = [];
        Object.keys(sites).forEach(function (k) {
            var site = sites[k];
            if (site.layer !== state.layer) {
                return;
            }
            var p = coordToPixel(site, bounds, pxPerTile);
            var teleOnly = site.entrances.length === 0 && site.teleports.length > 0;
            var cls = 'site-pin ' + (teleOnly ? 'teleport' : (siteIsExplored(site) ? 'known' : 'unexplored'));
            pinGroup.appendChild(svgEl('circle', { class: cls, cx: p.x, cy: p.y, r: 4 }));

            var count = site.entrances.length + site.teleports.length;
            if (count > 1) {
                // y offset comes from CSS dominant-baseline so it stays centered as the
                // font-size var changes with zoom
                var badge = svgEl('text', { class: 'site-badge', x: p.x, y: p.y });
                badge.textContent = String(count);
                pinGroup.appendChild(badge);
            }

            currentPins.push({ key: k, x: p.x, y: p.y });
        });
    }

    // Lines + destination dots for the selected site only. Cross-layer destinations
    // can't be drawn on this image, so they're left to the info panel's jump links.
    function renderSelectionOverlay(group, sites, bounds, pxPerTile) {
        var key = state.selectedSite;
        if (!key || !sites[key] || sites[key].layer !== state.layer) {
            return;
        }
        var site = sites[key];
        var origin = coordToPixel(site, bounds, pxPerTile);
        group.appendChild(svgEl('circle', { class: 'site-ring', cx: origin.x, cy: origin.y, r: 8 }));

        site.entrances.forEach(function (e, i) {
            if (!e.dest || e.dest.layer !== state.layer) {
                return;
            }
            var color = SEL_PALETTE[i % SEL_PALETTE.length];
            var pd = coordToPixel(e.dest, bounds, pxPerTile);
            group.appendChild(svgEl('line', { class: 'sel-line', x1: origin.x, y1: origin.y, x2: pd.x, y2: pd.y, stroke: color }));
            group.appendChild(svgEl('circle', { class: 'sel-dest', cx: pd.x, cy: pd.y, r: 4, fill: color, stroke: '#000' }));
        });
    }

    // ---- map: pin selection (click a pin -> list its stacked entrances/levels) ----

    // Physical up/down of an entrance, inferred from the plane stack at its site - NOT
    // from the op number (op 1 is used for both up and down ladders) and NOT from the
    // destination (it's been shuffled to somewhere unrelated). At a shared building
    // tile the lowest floor can only go up and the highest can only go down; a middle
    // floor with ladders both above and below is genuinely ambiguous, so we say so
    // rather than guess. A lone entrance (a door/cave with nothing stacked) gets no
    // direction claim at all.
    function directionFor(site, entrance) {
        var hasAbove = false;
        var hasBelow = false;
        site.entrances.forEach(function (other) {
            if (other.level > entrance.level) { hasAbove = true; }
            if (other.level < entrance.level) { hasBelow = true; }
        });
        if (hasAbove && !hasBelow) { return { arrow: '▲', text: 'up' }; }
        if (hasBelow && !hasAbove) { return { arrow: '▼', text: 'down' }; }
        if (hasAbove && hasBelow) { return { arrow: '↕', text: 'up/down' }; }
        return null;
    }

    function siteTitle(site) {
        for (var i = 0; i < site.entrances.length; i++) {
            var name = (state.data && state.data.names && state.data.names.places) || {};
            if (name[site.entrances[i].srcRaw]) {
                return name[site.entrances[i].srcRaw];
            }
        }
        var lbl = site.layer === 'underground' ? 'Underground ' : '';
        return lbl + 'tile (' + site.absX + ', ' + site.absZ + ')';
    }

    function renderSitePanel(sites) {
        var panel = document.getElementById('map-info');
        var key = state.selectedSite;
        if (!key || !sites || !sites[key]) {
            panel.hidden = true;
            return;
        }
        var site = sites[key];
        panel.hidden = false;
        document.getElementById('map-info-title').textContent = siteTitle(site);

        var body = document.getElementById('map-info-body');
        body.innerHTML = '';

        site.entrances.forEach(function (e, i) {
            var row = document.createElement('div');
            row.className = 'info-row';

            var lvl = document.createElement('span');
            lvl.className = 'info-lvl';
            lvl.textContent = 'floor ' + e.level;
            row.appendChild(lvl);

            var dir = directionFor(site, e);
            if (dir) {
                var verb = document.createElement('span');
                verb.className = 'info-verb dir-' + dir.text.replace('/', '');
                verb.textContent = dir.arrow + ' ' + dir.text;
                row.appendChild(verb);
            }

            var arrow = document.createElement('span');
            arrow.className = 'info-arrow';
            arrow.textContent = '→';
            row.appendChild(arrow);

            var dest = document.createElement('span');
            if (e.dest) {
                dest.className = 'info-dest';
                var swatch = document.createElement('span');
                swatch.className = 'info-swatch';
                swatch.style.background = (e.dest.layer === state.layer) ? SEL_PALETTE[i % SEL_PALETTE.length] : '#7a6a4a';
                dest.appendChild(swatch);
                dest.appendChild(document.createTextNode(labelForRaw(e.destRaw)));
                if (e.dest.layer !== state.layer) {
                    dest.appendChild(document.createTextNode('  '));
                    var jump = document.createElement('a');
                    jump.className = 'info-jump';
                    jump.href = '#';
                    jump.textContent = '(jump)';
                    jump.addEventListener('click', function (ev) {
                        ev.preventDefault();
                        panToRaw(e.destRaw);
                    });
                    dest.appendChild(jump);
                }
            } else {
                dest.className = 'info-dest unexplored';
                dest.textContent = 'not yet explored';
            }
            row.appendChild(dest);
            body.appendChild(row);
        });

        site.teleports.forEach(function (t) {
            var row = document.createElement('div');
            row.className = 'info-row';
            var tag = document.createElement('span');
            tag.className = 'info-lvl tele';
            tag.textContent = 'teleport';
            row.appendChild(tag);
            var name = document.createElement('span');
            name.className = 'info-dest';
            name.textContent = t.spell + ' lands here';
            row.appendChild(name);
            body.appendChild(row);
        });
    }

    // Translate a pointerup into a site selection by hit-testing the pins in world
    // space (the viewport captures the pointer, so native SVG clicks never fire).
    function handleMapClick(e) {
        if (!currentPins.length) {
            selectSite(null);
            return;
        }
        var viewport = document.getElementById('map-viewport');
        var rect = viewport.getBoundingClientRect();
        var worldX = (e.clientX - rect.left - mapDrag.tx) / mapDrag.scale;
        var worldY = (e.clientY - rect.top - mapDrag.ty) / mapDrag.scale;
        var radius = 9 / mapDrag.scale; // ~9 screen px, generous for small pins

        var best = null;
        var bestDist = radius * radius;
        currentPins.forEach(function (pin) {
            var dx = pin.x - worldX;
            var dy = pin.y - worldY;
            var d = dx * dx + dy * dy;
            if (d <= bestDist) {
                bestDist = d;
                best = pin.key;
            }
        });
        selectSite(best);
    }

    function selectSite(key) {
        state.selectedSite = key;
        renderMap();
    }

    // ---- map: pan-to-connection (entrances list -> map click-through) ----

    function showPanPulse(viewport) {
        var existing = viewport.querySelector('.pan-pulse');
        if (existing) {
            existing.remove();
        }
        var pulse = document.createElement('div');
        pulse.className = 'pan-pulse';
        viewport.appendChild(pulse);
        setTimeout(function () {
            pulse.remove();
        }, 1500);
    }

    // Switches to the map tab (and the coord's layer if needed), centers the
    // viewport on it, and drops a brief pulse there - the entrances list's "jump to
    // it on the map" affordance. Since panning always centers the target in the
    // viewport, the pulse itself needs no coordinate math: it's just a fixed dot at
    // the viewport's center.
    function panToRaw(raw) {
        var coord = parseCoord(raw);
        var meta = state.meta;
        if (!coord || !meta || !meta[coord.layer]) {
            return;
        }

        if (state.layer !== coord.layer) {
            state.layer = coord.layer;
            document.querySelectorAll('.layer-btn').forEach(function (b) {
                b.classList.toggle('active', b.dataset.layer === coord.layer);
            });
        }

        // select the site at that spot so its stacked entrances (and their lines) show
        state.selectedSite = coord.absX + '_' + coord.absZ;

        document.querySelectorAll('.tab-btn').forEach(function (b) {
            b.classList.toggle('active', b.dataset.tab === 'map');
        });
        document.querySelectorAll('.tab-panel').forEach(function (p) {
            p.classList.toggle('active', p.id === 'tab-map');
        });

        var viewport = document.getElementById('map-viewport');
        var bounds = meta[coord.layer];
        var pxPerTile = meta.pxPerTile || 2;
        var p = coordToPixel(coord, bounds, pxPerTile);

        mapDrag.scale = Math.max(mapDrag.scale, 2);
        mapDrag.tx = viewport.clientWidth / 2 - p.x * mapDrag.scale;
        mapDrag.ty = viewport.clientHeight / 2 - p.y * mapDrag.scale;
        applyMapTransform();

        renderMap();
        showPanPulse(viewport);
    }

    // ---- render: unlocks (current received-item state from ap-unlocks.json - never
    // reveals where unplaced items are hidden, see buildUnlocksPanel in web.ts) ----

    // skill name -> [sheet, index] into the vanilla stats-tab sprite sheets
    // (staticons.png / staticons2.png, 6x3 grid of 25x25 cells, copied from
    // content/sprites with the magenta key made transparent). Index order verified
    // against stats.if's component layout: tab column 1 = icons 0-5, column 2 =
    // 6-11, column 3 = 12-17; runecraft is staticons2 index 0.
    var STAT_ICONS = {
        attack: [0, 0], strength: [0, 1], defence: [0, 2], ranged: [0, 3], prayer: [0, 4], magic: [0, 5],
        hitpoints: [0, 6], agility: [0, 7], herblore: [0, 8], thieving: [0, 9], crafting: [0, 10], fletching: [0, 11],
        mining: [0, 12], smithing: [0, 13], fishing: [0, 14], cooking: [0, 15], firemaking: [0, 16], woodcutting: [0, 17],
        runecraft: [1, 0]
    };

    function statIcon(skill) {
        var def = STAT_ICONS[skill];
        var span = document.createElement('span');
        span.className = 'stat-icon' + (def && def[0] === 1 ? ' sheet2' : '');
        if (def) {
            var i = def[1];
            span.style.backgroundPosition = (-(i % 6) * 25) + 'px ' + (-Math.floor(i / 6) * 25) + 'px';
        }
        span.title = skill;
        return span;
    }

    // first table cell with a stat icon in front of the text
    function iconCell(skill, text) {
        var td = document.createElement('td');
        td.className = 'icon-cell';
        if (skill) {
            td.appendChild(statIcon(skill));
        }
        td.appendChild(document.createTextNode(text));
        return td;
    }

    function makeIconRow(skill, a, arrow, b) {
        var tr = document.createElement('tr');
        tr.appendChild(iconCell(skill, a));
        var tdArrow = document.createElement('td');
        tdArrow.className = 'arrow';
        tdArrow.textContent = arrow;
        var tdB = document.createElement('td');
        tdB.textContent = b;
        tr.appendChild(tdArrow);
        tr.appendChild(tdB);
        return tr;
    }

    // gear/tool rows reuse the closest stat's icon
    var GEAR_FAMILY_ICONS = { Melee: 'attack', Armour: 'defence', Ranged: 'ranged', Magic: 'magic' };
    var TOOL_ICONS = { Pickaxe: 'mining', Axe: 'woodcutting' };

    function fillUnlockTable(tableId, rows, rowBuilder) {
        var tbody = document.getElementById(tableId).querySelector('tbody');
        tbody.textContent = '';
        for (var i = 0; i < rows.length; i++) {
            tbody.appendChild(rowBuilder(rows[i]));
        }
    }

    function renderUnlocksTab() {
        var data = state.data;
        if (!data) {
            return;
        }
        var unlocks = data.unlocks || { present: false };
        var grid = document.querySelector('#tab-unlocks .unlocks-grid');
        document.getElementById('unlocks-empty').hidden = !!unlocks.present;
        if (grid) {
            grid.hidden = !unlocks.present;
        }
        if (!unlocks.present) {
            document.getElementById('unlocks-counter').textContent = '';
            return;
        }

        fillUnlockTable('unlocks-gear-table', unlocks.gear || [], function (g) {
            return makeIconRow(GEAR_FAMILY_ICONS[g.label], g.label, g.count + ' / ' + g.max, g.detail);
        });
        fillUnlockTable('unlocks-tools-table', unlocks.tools || [], function (t) {
            return makeIconRow(TOOL_ICONS[t.label], t.label, t.count + ' / ' + t.max, t.detail);
        });
        fillUnlockTable('unlocks-caps-table', unlocks.caps || [], function (c) {
            var name = c.skill.charAt(0).toUpperCase() + c.skill.slice(1);
            var tr = makeIconRow(c.skill, name, '', String(c.cap));
            if (c.cap >= 99) {
                tr.className = 'unlock-maxed';
            }
            return tr;
        });

        var quests = unlocks.quests || [];
        var unlockedQuests = quests.filter(function (q) {
            return q.unlocked;
        }).length;
        document.getElementById('unlocks-quests-counter').textContent = quests.length ? '(' + unlockedQuests + ' / ' + quests.length + ' unlocked)' : '';
        document.getElementById('unlocks-quests-empty').hidden = quests.length > 0;

        // Locked quests are hidden by default (the list is long and mostly noise
        // early on) - the "Show locked" checkbox opts back in to the full list.
        var showLockedBox = document.getElementById('unlocks-show-locked');
        var showLocked = !!(showLockedBox && showLockedBox.checked);
        var visibleQuests = showLocked ? quests : quests.filter(function (q) { return q.unlocked; });
        document.getElementById('unlocks-quests-alllocked').hidden = !(quests.length > 0 && visibleQuests.length === 0);
        document.getElementById('unlocks-quests-table').style.display = quests.length > 0 && visibleQuests.length === 0 ? 'none' : '';
        fillUnlockTable('unlocks-quests-table', visibleQuests, function (q) {
            var tr = makeRow(q.label, '', q.unlocked ? 'open' : 'LOCKED');
            tr.className = q.unlocked ? 'unlock-open' : 'unlock-locked';
            return tr;
        });
    }

    // ---- Archipelago connection setup tab ----
    // GET /ap/archipelago.json = stored credentials + live client status;
    // PUT same path saves + hot-applies; POST /ap/archipelago/test probes a
    // host/port for the AP RoomInfo greeting. The form is only filled from the
    // server ONCE (and after an explicit save) so polling never clobbers edits.

    var apFormFilled = false;

    function apMsg(id, text, kind) {
        var el = document.getElementById(id);
        el.hidden = !text;
        el.textContent = text || '';
        el.className = 'ap-msg' + (kind ? ' ' + kind : '');
    }

    function fillApForm(config) {
        document.getElementById('ap-enabled').checked = !!config.enabled;
        document.getElementById('ap-host').value = config.host || '';
        document.getElementById('ap-port').value = config.port || 38281;
        document.getElementById('ap-slot').value = config.slot || '';
        document.getElementById('ap-password').value = config.password || '';
        apFormFilled = true;
    }

    function renderApStatus(status) {
        var tbody = document.getElementById('ap-status-table').querySelector('tbody');
        tbody.textContent = '';
        function row(label, value, cls) {
            var tr = document.createElement('tr');
            var tdA = document.createElement('td');
            tdA.textContent = label;
            var tdB = document.createElement('td');
            tdB.textContent = value;
            if (cls) {
                tdB.className = cls;
            }
            tr.appendChild(tdA);
            tr.appendChild(tdB);
            tbody.appendChild(tr);
        }
        if (!status || !status.active) {
            row('State', 'disabled', 'ap-state-off');
            if (status && status.lastError) {
                row('Last error', status.lastError, 'ap-state-err');
            }
            return;
        }
        row('State', status.connected ? 'connected' : 'retrying…', status.connected ? 'ap-state-ok' : 'ap-state-warn');
        row('Server', (status.host || '?') + ':' + (status.port || '?'));
        row('Slot', status.slot || '?');
        row('Goal', status.goal || '?');
        row('Checks sent', String(status.sentChecks));
        row('Items received', String(status.receivedItems));
        if (status.pendingDeliveries > 0) {
            row('Awaiting delivery', status.pendingDeliveries + ' (log in to receive)');
        }
        if (status.goalSent) {
            row('Victory', 'reported!', 'ap-state-ok');
        }
        if (status.lastError && !status.connected) {
            row('Last error', status.lastError, 'ap-state-err');
        }
    }

    function fetchApStatus() {
        fetch('/ap/archipelago.json', { cache: 'no-store' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!apFormFilled) {
                    fillApForm(data.config || {});
                }
                renderApStatus(data.status);
            })
            .catch(function () { /* offline - main status pill already shows it */ });
    }

    function apFormValues() {
        return {
            enabled: document.getElementById('ap-enabled').checked,
            host: document.getElementById('ap-host').value.trim(),
            port: parseInt(document.getElementById('ap-port').value, 10) || 38281,
            slot: document.getElementById('ap-slot').value.trim(),
            password: document.getElementById('ap-password').value
        };
    }

    function initArchipelagoTab() {
        document.getElementById('ap-test').addEventListener('click', function () {
            var values = apFormValues();
            if (!values.host) {
                apMsg('ap-test-result', 'Enter a host to test.', 'err');
                return;
            }
            apMsg('ap-test-result', 'Testing ' + values.host + ':' + values.port + '…');
            fetch('/ap/archipelago/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host: values.host, port: values.port })
            })
                .then(function (res) { return res.json(); })
                .then(function (result) {
                    if (result.ok) {
                        var bits = ['Archipelago ' + (result.version || '?') + ' is up'];
                        if (result.seedName) {
                            bits.push('seed ' + result.seedName);
                        }
                        bits.push(result.hasOurGame ? '2004Scape slot hosted ✓' : 'WARNING: no 2004Scape game in this room');
                        if (result.passwordRequired) {
                            bits.push('password required');
                        }
                        apMsg('ap-test-result', bits.join(' · '), result.hasOurGame ? 'ok' : 'warn');
                    } else {
                        apMsg('ap-test-result', 'Unreachable: ' + (result.error || 'unknown error'), 'err');
                    }
                })
                .catch(function (err) { apMsg('ap-test-result', 'Test failed: ' + err.message, 'err'); });
        });

        document.getElementById('ap-save').addEventListener('click', function () {
            var values = apFormValues();
            apMsg('ap-form-msg', 'Saving…');
            fetch('/ap/archipelago.json', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(values)
            })
                .then(function (res) { return res.json(); })
                .then(function (result) {
                    if (result.ok) {
                        apMsg('ap-form-msg', values.enabled ? 'Saved - connecting…' : 'Saved (disabled).', 'ok');
                        fillApForm(result.config || values);
                        renderApStatus(result.status);
                    } else {
                        apMsg('ap-form-msg', 'Not saved: ' + (result.error || 'unknown error'), 'err');
                    }
                })
                .catch(function (err) { apMsg('ap-form-msg', 'Save failed: ' + err.message, 'err'); });
        });

        fetchApStatus();
        setInterval(fetchApStatus, POLL_MS);
    }

    // ---- render all ----

    function renderAll() {
        renderItemSwapTab('gather', 'gathering-table', 'gathering-empty', 'gathering-counter');
        renderItemSwapTab('process', 'recipes-table', 'recipes-empty', 'recipes-counter');
        renderBestiaryTab();
        renderTeleportsTab();
        renderEntrancesTab();
        renderUnlocksTab();
        renderMap();
    }

    // ---- init ----

    document.addEventListener('DOMContentLoaded', function () {
        initTabs();
        initSpoilerToggle();
        initMapControls();
        initEntranceSearch();
        initShowLockedToggle();
        initArchipelagoTab();
        fetchMeta();
        fetchTracker();
        setInterval(fetchTracker, POLL_MS);
    });
})();
