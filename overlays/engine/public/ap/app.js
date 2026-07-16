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
        layer: 'surface'
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

    function parseEntranceKey(key) {
        var idx = key.lastIndexOf(':');
        if (idx === -1) {
            return { coord: parseCoord(key), op: null };
        }
        return { coord: parseCoord(key.slice(0, idx)), op: key.slice(idx + 1) };
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

    // ---- render: map ----

    var mapDrag = { active: false, startX: 0, startY: 0, tx: 0, ty: 0, scale: 1 };

    function initMapControls() {
        var viewport = document.getElementById('map-viewport');
        var world = document.getElementById('map-world');

        function applyTransform() {
            world.style.transform = 'translate(' + mapDrag.tx + 'px,' + mapDrag.ty + 'px) scale(' + mapDrag.scale + ')';
        }

        viewport.addEventListener('pointerdown', function (e) {
            mapDrag.active = true;
            mapDrag.startX = e.clientX - mapDrag.tx;
            mapDrag.startY = e.clientY - mapDrag.ty;
            viewport.classList.add('dragging');
            viewport.setPointerCapture(e.pointerId);
        });

        viewport.addEventListener('pointermove', function (e) {
            if (!mapDrag.active) {
                return;
            }
            mapDrag.tx = e.clientX - mapDrag.startX;
            mapDrag.ty = e.clientY - mapDrag.startY;
            applyTransform();
        });

        function endDrag(e) {
            mapDrag.active = false;
            viewport.classList.remove('dragging');
            if (e && e.pointerId !== undefined) {
                try { viewport.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            }
        }

        viewport.addEventListener('pointerup', endDrag);
        viewport.addEventListener('pointercancel', endDrag);

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
        overlay.innerHTML = '';

        if (!data) {
            return;
        }

        var entrances = (data.discoveries && data.discoveries.entrances) || {};
        var teleports = (data.discoveries && data.discoveries.teleports) || {};

        var markerCount = 0;

        Object.keys(entrances).forEach(function (key) {
            var parsedKey = parseEntranceKey(key);
            var srcCoord = parsedKey.coord;
            var dstCoord = parseCoord(entrances[key]);
            if (!srcCoord || !dstCoord) {
                return;
            }

            var srcOnLayer = srcCoord.layer === state.layer;
            var dstOnLayer = dstCoord.layer === state.layer;
            if (!srcOnLayer && !dstOnLayer) {
                return;
            }

            if (srcOnLayer && dstOnLayer) {
                var p1 = coordToPixel(srcCoord, bounds, pxPerTile);
                var p2 = coordToPixel(dstCoord, bounds, pxPerTile);
                overlay.appendChild(svgEl('line', { class: 'marker-line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }));
                overlay.appendChild(svgEl('circle', { class: 'marker', cx: p1.x, cy: p1.y, r: 4 }));
                overlay.appendChild(svgEl('circle', { class: 'marker dest', cx: p2.x, cy: p2.y, r: 4 }));
                markerCount += 2;
            } else if (srcOnLayer) {
                var ps = coordToPixel(srcCoord, bounds, pxPerTile);
                overlay.appendChild(svgEl('circle', { class: 'marker cross', cx: ps.x, cy: ps.y, r: 5 }));
                var lbl = svgEl('text', { class: 'marker-label', x: ps.x + 7, y: ps.y + 4 });
                lbl.textContent = '→ ' + dstCoord.layer;
                overlay.appendChild(lbl);
                markerCount += 1;
            } else if (dstOnLayer) {
                var pd = coordToPixel(dstCoord, bounds, pxPerTile);
                overlay.appendChild(svgEl('circle', { class: 'marker cross', cx: pd.x, cy: pd.y, r: 5 }));
                var lbl2 = svgEl('text', { class: 'marker-label', x: pd.x + 7, y: pd.y + 4 });
                lbl2.textContent = '← ' + srcCoord.layer;
                overlay.appendChild(lbl2);
                markerCount += 1;
            }
        });

        Object.keys(teleports).forEach(function (spell) {
            var coord = parseCoord(teleports[spell]);
            if (!coord || coord.layer !== state.layer) {
                return;
            }
            var p = coordToPixel(coord, bounds, pxPerTile);
            overlay.appendChild(svgEl('circle', { class: 'marker dest', cx: p.x, cy: p.y, r: 5 }));
            var lbl = svgEl('text', { class: 'marker-label', x: p.x + 7, y: p.y + 4 });
            lbl.textContent = spell;
            overlay.appendChild(lbl);
            markerCount += 1;
        });

        emptyEl.hidden = markerCount > 0;

        var counters = document.getElementById('map-counters');
        var entranceTotal = (data.totals && data.totals.entrances) || 0;
        var teleportTotal = (data.totals && data.totals.teleports) || 0;
        counters.innerHTML =
            '<span>Entrances: <b>' + Object.keys(entrances).length + ' / ' + entranceTotal + '</b></span>' +
            '<span>Teleports: <b>' + Object.keys(teleports).length + ' / ' + teleportTotal + '</b></span>';
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

        document.querySelectorAll('.tab-btn').forEach(function (b) {
            b.classList.toggle('active', b.dataset.tab === 'map');
        });
        document.querySelectorAll('.tab-panel').forEach(function (p) {
            p.classList.toggle('active', p.id === 'tab-map');
        });

        var viewport = document.getElementById('map-viewport');
        var world = document.getElementById('map-world');
        var bounds = meta[coord.layer];
        var pxPerTile = meta.pxPerTile || 2;
        var p = coordToPixel(coord, bounds, pxPerTile);

        mapDrag.scale = Math.max(mapDrag.scale, 2);
        mapDrag.tx = viewport.clientWidth / 2 - p.x * mapDrag.scale;
        mapDrag.ty = viewport.clientHeight / 2 - p.y * mapDrag.scale;
        world.style.transform = 'translate(' + mapDrag.tx + 'px,' + mapDrag.ty + 'px) scale(' + mapDrag.scale + ')';

        renderMap();
        showPanPulse(viewport);
    }

    // ---- render all ----

    function renderAll() {
        renderItemSwapTab('gather', 'gathering-table', 'gathering-empty', 'gathering-counter');
        renderItemSwapTab('process', 'recipes-table', 'recipes-empty', 'recipes-counter');
        renderBestiaryTab();
        renderTeleportsTab();
        renderEntrancesTab();
        renderMap();
    }

    // ---- init ----

    document.addEventListener('DOMContentLoaded', function () {
        initTabs();
        initSpoilerToggle();
        initMapControls();
        initEntranceSearch();
        fetchMeta();
        fetchTracker();
        setInterval(fetchTracker, POLL_MS);
    });
})();
