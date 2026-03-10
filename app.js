/**
 * Hugo Navigation App — app.js
 * Full PWA navigation app with Leaflet, Nominatim search, OSRM routing,
 * animated UI, turn-by-turn directions, and geolocation tracking.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════════ */
const Config = {
  defaultCenter:   [51.505, -0.09],
  defaultZoom:     14,
  navZoom:         17,
  tileLayers: {
    dark:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  },
  tileAttr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://CARTO.com/attributions">CARTO</a>',
  nominatimBase: 'https://nominatim.openstreetmap.org',
  osrmBase:      'https://router.project-osrm.org/route/v1/driving',
  searchDelay:   420,
  splashMs:      4200,
};

/* ═══════════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════════ */
const State = {
  map:            null,
  tileLayer:      null,
  userMarker:     null,
  destMarker:     null,
  routeGroup:     null,
  userLocation:   null,   // { lat, lon, accuracy, speed, heading }
  destination:    null,   // { lat, lon, name, displayName }
  route:          null,   // OSRM route object
  steps:          [],     // parsed step array
  stepIndex:      0,
  isNavigating:   false,
  watchId:        null,
  theme:          localStorage.getItem('hugo-theme')   || 'dark',
  units:          localStorage.getItem('hugo-units')   || 'km',
  activeTab:      'map',
  totalDuration:     0,      // total route duration in seconds (for avg-speed calc)
  totalDistance:     0,      // total route distance in metres
  _navStatsInterval: null,   // setInterval id for ETA ticker
  recents:        JSON.parse(localStorage.getItem('hugo-recents') || '[]'),
};

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════ */
const Utils = {
  fmtDist(m) {
    if (State.units === 'mi') {
      const mi = m / 1609.34;
      return mi < 0.5 ? `${Math.round(m * 3.281)} ft` : `${mi.toFixed(1)} mi`;
    }
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  },
  fmtTime(s) {
    if (s < 60)   return `${Math.round(s)} sec`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return `${h}h ${m}m`;
  },
  // Returns { value, unit } for use in the stats bar (value and label separately)
  fmtDistParts(m) {
    if (State.units === 'mi') {
      const mi = m / 1609.34;
      if (mi < 0.5) return { value: String(Math.round(m * 3.281)), unit: 'ft away' };
      return { value: mi.toFixed(1), unit: 'mi away' };
    }
    if (m < 1000) return { value: String(Math.round(m)), unit: 'm away' };
    return { value: (m / 1000).toFixed(1), unit: 'km away' };
  },
  debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },
  async fetchJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
    return r.json();
  },
  haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, d2r = Math.PI / 180;
    const dLat = (lat2 - lat1) * d2r, dLon = (lon2 - lon1) * d2r;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },
  saveRecent(result) {
    State.recents = State.recents.filter(r => r.place_id !== result.place_id);
    State.recents.unshift(result);
    if (State.recents.length > 6) State.recents.pop();
    localStorage.setItem('hugo-recents', JSON.stringify(State.recents));
  },
  placeIcon(type, cls) {
    const t = { restaurant:'🍽️',cafe:'☕',bar:'🍸',fast_food:'🍔',hotel:'🏨',
      hospital:'🏥',pharmacy:'💊',bank:'🏦',atm:'💳',parking:'🅿️',fuel:'⛽',
      school:'🏫',university:'🎓',airport:'✈️',station:'🚉',bus_stop:'🚌',
      subway:'🚇',museum:'🏛️',park:'🌳',cinema:'🎬',theatre:'🎭',
      supermarket:'🛒',gym:'💪',beach:'🏖️',convenience:'🏪',
    };
    const c = { amenity:'📍',highway:'🛣️',building:'🏢',natural:'🌿',
      tourism:'🎯',leisure:'⛹️',shop:'🛍️' };
    return t[type] || c[cls] || '📍';
  },
  turnIcon(maneuver) {
    const mod = maneuver?.modifier || '';
    const typ = maneuver?.type || '';
    if (typ === 'arrive')  return '🏁';
    if (typ === 'depart')  return '🚦';
    if (typ === 'roundabout' || typ === 'rotary') return '🔄';
    if (mod.includes('sharp left'))  return '↰';
    if (mod.includes('sharp right')) return '↱';
    if (mod.includes('slight left')) return '↖';
    if (mod.includes('slight right')) return '↗';
    if (mod.includes('left'))        return '←';
    if (mod.includes('right'))       return '→';
    if (mod.includes('uturn'))       return '↩';
    return '↑';
  },
  buildInstruction(step) {
    const typ = step.maneuver?.type || '';
    const mod = step.maneuver?.modifier || '';
    const road = step.name ? ` onto <strong>${step.name}</strong>` : '';
    if (typ === 'arrive')  return `Arrive at destination`;
    if (typ === 'depart')  return `Head <strong>${mod || 'forward'}</strong>${road}`;
    if (typ === 'turn')    return `Turn <strong>${mod}</strong>${road}`;
    if (typ === 'fork')    return `Keep <strong>${mod}</strong>${road}`;
    if (typ === 'merge')   return `Merge <strong>${mod}</strong>${road}`;
    if (typ === 'roundabout' || typ === 'rotary') return `Enter roundabout${road}`;
    if (typ === 'exit roundabout') return `Exit roundabout${road}`;
    if (typ === 'continue' || typ === 'new name') return `Continue${road || ' straight'}`;
    return `Continue${road || ''}`;
  },
};

/* ═══════════════════════════════════════════════════════════════
   TRAFFIC CONTROLLER
   Simulates live traffic segments that colour the route polyline.
   Levels: 'clear' (blue) | 'moderate' (amber) | 'heavy' (red)
═══════════════════════════════════════════════════════════════ */
const Traffic = {
  _levels:         null,
  _updateInterval: null,

  // Call once per route calculation to seed segment traffic levels.
  generate(coordCount) {
    const segCount = Math.min(8, Math.max(4, Math.floor(coordCount / 20)));
    this._levels = Array.from({ length: segCount }, (_, i) => {
      // First / last segment always clear (origin & destination areas)
      if (i === 0 || i === segCount - 1) return 'clear';
      const r = Math.random();
      return r < 0.48 ? 'clear' : r < 0.76 ? 'moderate' : 'heavy';
    });
  },

  // Randomly mutate one mid-route segment (called by live update interval).
  _mutate() {
    if (!this._levels?.length) return;
    const idx = Math.floor(Math.random() * this._levels.length);
    const r   = Math.random();
    this._levels[idx] = r < 0.5 ? 'clear' : r < 0.78 ? 'moderate' : 'heavy';
  },

  getColor(level) {
    return { clear: '#4F8EF7', moderate: '#F59E0B', heavy: '#EF4444' }[level] ?? '#4F8EF7';
  },

  getHaloColor(level) {
    return {
      clear:    'rgba(79,142,247,0.18)',
      moderate: 'rgba(245,158,11,0.15)',
      heavy:    'rgba(239,68,68,0.15)',
    }[level] ?? 'rgba(79,142,247,0.18)';
  },

  // Split a latLng array into traffic-coloured segment objects.
  getSegments(latLngs) {
    if (!this._levels?.length) return [{ coords: latLngs, level: 'clear' }];
    const segSize = Math.floor(latLngs.length / this._levels.length);
    if (segSize < 2)             return [{ coords: latLngs, level: 'clear' }];
    return this._levels.map((level, i) => {
      const start = i * segSize;
      const end   = i === this._levels.length - 1 ? latLngs.length : (i + 1) * segSize + 1;
      return { coords: latLngs.slice(start, end), level };
    }).filter(s => s.coords.length > 1);
  },

  // Returns the worst overall traffic level for the badge.
  getDominantLevel() {
    if (!this._levels?.length) return 'clear';
    const counts = { clear: 0, moderate: 0, heavy: 0 };
    this._levels.forEach(l => counts[l]++);
    if (counts.heavy   >= 2)            return 'heavy';
    if (counts.moderate > counts.clear) return 'moderate';
    return 'clear';
  },

  // Sync the traffic badge in the route card.
  _syncBadge() {
    const level  = this.getDominantLevel();
    const labels = { clear: 'Light Traffic', moderate: 'Moderate Traffic', heavy: 'Heavy Traffic' };
    const sep    = document.getElementById('trafficSep');
    const badge  = document.getElementById('trafficBadge');
    if (sep)   sep.style.display = '';
    if (badge) {
      badge.textContent  = labels[level];
      badge.className    = `traffic-badge traffic-${level}`;
      badge.style.display = '';
    }
  },

  // Begin live 45-second refresh cycle.
  startUpdates() {
    this.stopUpdates();
    this._updateInterval = setInterval(() => {
      if (!State.route) { this.stopUpdates(); return; }
      this._mutate();
      this._syncBadge();
      Map_.redrawRoute();
    }, 45_000);
  },

  stopUpdates() {
    if (this._updateInterval) { clearInterval(this._updateInterval); this._updateInterval = null; }
  },
};

/* ═══════════════════════════════════════════════════════════════
   MAP CONTROLLER
═══════════════════════════════════════════════════════════════ */
const Map_ = {
  init() {
    State.map = L.map('map', {
      zoomControl:        false,
      attributionControl: true,
      preferCanvas:       false,
    }).setView(Config.defaultCenter, Config.defaultZoom);

    this.applyTheme(State.theme);

    // Style attribution
    requestAnimationFrame(() => {
      const att = document.querySelector('.leaflet-control-attribution');
      if (att) {
        Object.assign(att.style, {
          background: 'rgba(0,0,0,0.45)',
          color: 'rgba(255,255,255,0.45)',
          fontSize: '10px',
          borderRadius: '8px 0 0 0',
          padding: '2px 6px',
        });
      }
    });
  },

  applyTheme(theme) {
    if (State.tileLayer) State.map.removeLayer(State.tileLayer);
    State.tileLayer = L.tileLayer(Config.tileLayers[theme], {
      attribution: Config.tileAttr,
      subdomains: 'abcd',
      maxZoom: 20,
    });
    State.tileLayer.addTo(State.map);
    State.theme = theme;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('hugo-theme', theme);
    document.getElementById('metaTheme').content = theme === 'dark' ? '#0A0B12' : '#EEF0F8';
    const tv = document.getElementById('themeValue');
    if (tv) tv.textContent = theme === 'dark' ? 'Dark' : 'Light';
    const ti = document.querySelector('.toggle-icon');
    if (ti) ti.textContent = theme === 'dark' ? '☀️' : '🌙';
  },

  flyTo(lat, lon, zoom) {
    State.map.flyTo([lat, lon], zoom || Config.defaultZoom, { duration: 1.4 });
  },
  setView(lat, lon, zoom) {
    State.map.setView([lat, lon], zoom || State.map.getZoom(), { animate: true, duration: 0.5 });
  },

  placeUser(lat, lon) {
    const icon = L.divIcon({
      html: `<div class="user-marker">
               <div class="user-pulse-outer"></div>
               <div class="user-pulse-inner"></div>
               <div class="user-dot"></div>
             </div>`,
      iconSize:   [60, 60],
      iconAnchor: [30, 30],
      className:  'user-marker-wrapper',
    });
    if (State.userMarker) {
      State.userMarker.setLatLng([lat, lon]);
    } else {
      State.userMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(State.map);
    }
  },

  placeDestination(lat, lon) {
    const icon = L.divIcon({
      html: `<div class="dest-marker">
               <div class="dest-pin-body">
                 <svg viewBox="0 0 24 24" width="22" height="22">
                   <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="currentColor"/>
                 </svg>
               </div>
               <div class="dest-shadow"></div>
             </div>`,
      iconSize:   [44, 56],
      iconAnchor: [22, 54],
      className:  'dest-marker-wrapper',
    });
    if (State.destMarker) State.map.removeLayer(State.destMarker);
    State.destMarker = L.marker([lat, lon], { icon, zIndexOffset: 900 }).addTo(State.map);
  },

  clearDestination() {
    if (State.destMarker) { State.map.removeLayer(State.destMarker); State.destMarker = null; }
  },

  drawRoute(coords) {
    this.clearRoute();
    // coords = [[lon, lat], ...]
    const latLngs  = coords.map(([ln, lt]) => [lt, ln]);
    const segments = Traffic.getSegments(latLngs);
    const layers   = [];

    segments.forEach((seg, idx) => {
      if (seg.coords.length < 2) return;

      // Outer glow halo (traffic-tinted)
      const halo = L.polyline(seg.coords, {
        color:    Traffic.getHaloColor(seg.level),
        weight:   20,
        lineCap:  'round',
        lineJoin: 'round',
        opacity:  1,
      });
      halo.addTo(State.map);

      // Main coloured route line
      const line = L.polyline(seg.coords, {
        color:    Traffic.getColor(seg.level),
        weight:   6,
        lineCap:  'round',
        lineJoin: 'round',
      });
      line.addTo(State.map);

      // Staggered draw animation per segment
      line.on('add', () => {
        const path = line._path;
        if (!path) return;
        const len = path.getTotalLength();
        path.style.strokeDasharray  = len;
        path.style.strokeDashoffset = len;
        path.style.transition = 'none';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          path.style.transition      = `stroke-dashoffset ${1.4 + idx * 0.08}s cubic-bezier(0.4,0,0.2,1) ${idx * 0.12}s`;
          path.style.strokeDashoffset = '0';
        }));
      });

      layers.push(halo, line);
    });

    State.routeGroup = L.layerGroup(layers);

    // Fit map to complete route
    const allLine = L.polyline(latLngs);
    State.map.fitBounds(allLine.getBounds().pad(0.18), { animate: true, duration: 1.4 });
  },

  // Re-draw route in place with updated traffic colours (called by Traffic.startUpdates).
  redrawRoute() {
    if (!State.route) return;
    this.drawRoute(State.route.geometry.coordinates);
  },

  clearRoute() {
    if (State.routeGroup) {
      State.routeGroup.eachLayer(l => State.map.removeLayer(l));
      State.routeGroup = null;
    }
  },
};

/* ═══════════════════════════════════════════════════════════════
   GEOLOCATION
═══════════════════════════════════════════════════════════════ */
const Geo = {
  startWatching() {
    if (!navigator.geolocation) {
      UI.toast('Geolocation not supported by your browser', 'error');
      Map_.setView(...Config.defaultCenter, Config.defaultZoom);
      return;
    }
    UI.setLocBtnState('loading');
    State.watchId = navigator.geolocation.watchPosition(
      pos => this._onPos(pos),
      err => this._onErr(err),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }
    );
  },
  stopWatching() {
    if (State.watchId != null) {
      navigator.geolocation.clearWatch(State.watchId);
      State.watchId = null;
    }
  },
  _onPos(pos) {
    const { latitude: lat, longitude: lon, accuracy, speed, heading } = pos.coords;
    const first = !State.userLocation;
    State.userLocation = { lat, lon, accuracy, speed, heading };
    Map_.placeUser(lat, lon);
    UI.setLocBtnState('active');

    if (first) {
      Map_.flyTo(lat, lon, Config.defaultZoom);
    } else if (State.isNavigating) {
      Map_.setView(lat, lon, Config.navZoom);
      Nav._trackProgress(lat, lon, speed);
    }

    // Update speed display
    const spd = speed != null ? Math.round(speed * 3.6) : 0;
    const el = document.getElementById('speedNum');
    if (el) el.textContent = spd;
  },
  _onErr(err) {
    UI.setLocBtnState('idle');
    if (!State.userLocation) Map_.setView(...Config.defaultCenter, Config.defaultZoom);
    if (err.code === 1) UI.toast('Allow location access to use Hugo navigation', 'warning');
  },
  centerOnUser() {
    if (State.userLocation) {
      Map_.flyTo(State.userLocation.lat, State.userLocation.lon, Config.defaultZoom + 1);
    } else {
      this.startWatching();
    }
  },
};

/* ═══════════════════════════════════════════════════════════════
   SEARCH CONTROLLER
═══════════════════════════════════════════════════════════════ */
const Search = {
  async query(q) {
    if (!q || q.trim().length < 2) { UI.renderRecents(); return; }
    UI.setSearchLoading(true);
    try {
      const params = new URLSearchParams({
        q, format: 'json', limit: '8', addressdetails: '1',
        'accept-language': navigator.language,
      });
      if (State.userLocation) {
        const { lat, lon } = State.userLocation;
        params.set('viewbox', `${lon - 1},${lat - 1},${lon + 1},${lat + 1}`);
        params.set('bounded', '0');
      }
      const results = await Utils.fetchJSON(`${Config.nominatimBase}/search?${params}`);
      UI.renderSearchResults(results);
    } catch {
      UI.toast('Search failed — check your connection', 'error');
      UI.renderSearchResults([]);
    } finally {
      UI.setSearchLoading(false);
    }
  },

  async select(result) {
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);
    const name = result.name || result.display_name.split(',')[0].trim();
    State.destination = { lat, lon, name, displayName: result.display_name };
    Utils.saveRecent(result);
    UI.closeSearch();
    Map_.placeDestination(lat, lon);
    UI.openRouteCard();
    UI.setRouteLoading(true);
    await Router.calculate();
  },
};

/* ═══════════════════════════════════════════════════════════════
   ROUTER
═══════════════════════════════════════════════════════════════ */
const Router = {
  async calculate() {
    if (!State.destination) return;
    const origin = State.userLocation ?? { lat: Config.defaultCenter[0], lon: Config.defaultCenter[1] };
    const { lat: dLat, lon: dLon } = State.destination;
    const url = `${Config.osrmBase}/${origin.lon},${origin.lat};${dLon},${dLat}?overview=full&geometries=geojson&steps=true&annotations=false`;
    try {
      const data = await Utils.fetchJSON(url);
      if (data.code !== 'Ok' || !data.routes.length) throw new Error('No route');
      const route = data.routes[0];
      State.route = route;
      State.steps  = this._parseSteps(route.legs[0].steps);
      Traffic.generate(route.geometry.coordinates.length);
      Map_.drawRoute(route.geometry.coordinates);
      UI.updateRouteCard(route);
      UI.renderDirections(State.steps);
      Traffic.startUpdates();
      document.getElementById('routeError').classList.add('hidden');
    } catch (err) {
      console.error('Routing error:', err);
      document.getElementById('routeError').classList.remove('hidden');
      UI.toast('Could not find a route to that location', 'error');
    } finally {
      UI.setRouteLoading(false);
    }
  },

  _parseSteps(rawSteps) {
    return rawSteps.map(s => ({
      icon:        Utils.turnIcon(s.maneuver),
      instruction: Utils.buildInstruction(s),
      distance:    Utils.fmtDist(s.distance),
      duration:    Utils.fmtTime(s.duration),
      name:        s.name || '',
    }));
  },
};

/* ═══════════════════════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════════════════════ */
const Nav = {
  start() {
    if (!State.route || !State.destination) return;
    State.isNavigating  = true;
    State.stepIndex     = 0;
    State.totalDuration = State.route.duration;
    State.totalDistance = State.route.distance;
    document.getElementById('app').classList.add('is-navigating');
    UI.showNavHud();
    UI.hideBottomNav();
    UI.closeRouteCard();
    const spd = document.getElementById('speedDisplay');
    if (spd) spd.classList.add('visible');

    // Show stats bar with initial estimate
    const d0 = State.userLocation
      ? Utils.haversine(State.userLocation.lat, State.userLocation.lon,
                        State.destination.lat,  State.destination.lon)
      : State.totalDistance;
    UI.showNavStats();
    UI.updateNavStats(d0);

    // Tick ETA every 30 s even when GPS is quiet
    State._navStatsInterval = setInterval(() => {
      if (!State.isNavigating || !State.destination || !State.userLocation) return;
      const d = Utils.haversine(State.userLocation.lat, State.userLocation.lon,
                                State.destination.lat,  State.destination.lon);
      UI.updateNavStats(d);
    }, 30_000);

    this._showStep(State.steps[0]);
    if (State.userLocation) Map_.flyTo(State.userLocation.lat, State.userLocation.lon, Config.navZoom);
    UI.toast('Navigation started — drive safe!', 'success');
  },
  stop() {
    State.isNavigating = false;
    if (State._navStatsInterval) { clearInterval(State._navStatsInterval); State._navStatsInterval = null; }
    Traffic.stopUpdates();
    document.getElementById('app').classList.remove('is-navigating');
    UI.hideNavHud();
    UI.hideNavStats();
    UI.showBottomNav();
    const spd = document.getElementById('speedDisplay');
    if (spd) spd.classList.remove('visible');
    if (State.destination) UI.openRouteCard();
    if (State.userLocation) Map_.flyTo(State.userLocation.lat, State.userLocation.lon, Config.defaultZoom);
  },
  _showStep(step) {
    if (!step) return;
    const icon   = document.getElementById('navTurnIcon');
    const dist   = document.getElementById('navTurnDist');
    const street = document.getElementById('navTurnStreet');
    if (icon)   icon.textContent   = step.icon;
    if (dist)   dist.textContent   = step.distance;
    if (street) street.innerHTML   = step.instruction;
  },
  _trackProgress(lat, lon, speed) {
    if (!State.destination) return;
    const d = Utils.haversine(lat, lon, State.destination.lat, State.destination.lon);
    if (d < 40) { this._arrive(); return; }
    UI.updateNavStats(d);
    // Advance step hint based on proximity to current step waypoint
    const nextStep = State.steps[State.stepIndex + 1];
    if (nextStep && d < 100) {
      State.stepIndex = Math.min(State.stepIndex + 1, State.steps.length - 1);
      this._showStep(State.steps[State.stepIndex]);
    }
  },
  _arrive() {
    State.isNavigating = false;
    if (State._navStatsInterval) { clearInterval(State._navStatsInterval); State._navStatsInterval = null; }
    Traffic.stopUpdates();
    document.getElementById('app').classList.remove('is-navigating');
    UI.hideNavHud();
    UI.hideNavStats();
    UI.showBottomNav();
    const spd = document.getElementById('speedDisplay');
    if (spd) spd.classList.remove('visible');
    UI.showArrival(State.destination.name);
    Map_.clearRoute();
    Map_.clearDestination();
    State.destination = null;
    State.route = null;
    State.steps = [];
  },
};

/* ═══════════════════════════════════════════════════════════════
   UI CONTROLLER
═══════════════════════════════════════════════════════════════ */
const UI = {
  // ── bootstrap ─────────────────────────────────
  bind() {
    // Search open/close
    document.getElementById('searchTrigger').addEventListener('click', () => this.openSearch());
    document.getElementById('searchBack').addEventListener('click',    () => this.closeSearch());
    document.getElementById('clearSearch').addEventListener('click',   () => this._clearSearch());

    // Keyboard shortcut
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); this.openSearch(); }
      if (e.key === 'Escape') { this.closeSearch(); }
    });

    // Search input
    const input = document.getElementById('searchInput');
    const debouncedQuery = Utils.debounce(q => Search.query(q), Config.searchDelay);
    input.addEventListener('input', e => {
      const q = e.target.value.trim();
      document.getElementById('clearSearch').style.display = q ? 'flex' : 'none';
      if (q.length < 2) this.renderRecents();
      else debouncedQuery(q);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const q = input.value.trim();
        if (q) Search.query(q);
      }
    });

    // FABs
    document.getElementById('locationBtn').addEventListener('click', () => Geo.centerOnUser());

    // Route card
    document.getElementById('startNavBtn').addEventListener('click',  () => Nav.start());
    document.getElementById('closeRouteBtn').addEventListener('click', () => this.dismissRoute());
    document.getElementById('stopNavBtn').addEventListener('click',   () => Nav.stop());

    // Bottom nav
    document.querySelectorAll('.nav-tab').forEach(btn =>
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab))
    );

    // Theme toggles
    [document.getElementById('themeToggle'), document.getElementById('themeToggleMenu')]
      .filter(Boolean)
      .forEach(btn => btn.addEventListener('click', () => {
        Map_.applyTheme(State.theme === 'dark' ? 'light' : 'dark');
        this._updateThemeUI();
      }));

    // Units toggle
    document.getElementById('unitsToggle')?.addEventListener('click', () => {
      State.units = State.units === 'km' ? 'mi' : 'km';
      localStorage.setItem('hugo-units', State.units);
      const uv = document.getElementById('unitsValue');
      if (uv) uv.textContent = State.units;
    });

    // Map click (dismiss panels)
    State.map.on('click', () => {
      if (State.activeTab !== 'map') this.switchTab('map');
    });

    // Ripple
    document.addEventListener('click', e => {
      const btn = e.target.closest('.ripple-btn');
      if (btn) this._ripple(e, btn);
    });

    // Bottom sheet drag
    this._initSheetDrag();

    this._updateThemeUI();
  },

  // ── search ────────────────────────────────────
  openSearch() {
    document.getElementById('searchPanel').classList.add('open');
    setTimeout(() => document.getElementById('searchInput')?.focus(), 320);
    this.renderRecents();
  },
  closeSearch() {
    const panel = document.getElementById('searchPanel');
    panel.classList.add('closing');
    setTimeout(() => panel.classList.remove('open', 'closing'), 350);
    document.getElementById('searchInput').blur();
  },
  _clearSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('clearSearch').style.display = 'none';
    this.renderRecents();
    document.getElementById('searchInput').focus();
  },
  setSearchLoading(on) {
    document.getElementById('searchSpinner').classList.toggle('active', on);
  },

  renderRecents() {
    const box = document.getElementById('searchResults');
    if (!State.recents.length) {
      box.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🗺️</div>
        <div class="empty-text">Search for a destination</div>
      </div>`;
      return;
    }
    box.innerHTML = `<div class="section-label">Recent</div>
      <div class="results-list">
        ${State.recents.map((r, i) => this._resultHtml(r, i, true)).join('')}
      </div>`;
    this._bindResultClicks(box);
  },

  renderSearchResults(results) {
    const box = document.getElementById('searchResults');
    if (!results.length) {
      box.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-text">No results found</div>
      </div>`;
      return;
    }
    box.innerHTML = results.map((r, i) => this._resultHtml(r, i, false)).join('');
    this._bindResultClicks(box);
  },

  _resultHtml(r, i, isRecent) {
    const name = (r.name || r.display_name.split(',')[0]).trim();
    const addr = r.display_name;
    const icon = isRecent ? '🕐' : Utils.placeIcon(r.type, r.class);
    const escaped = JSON.stringify(r).replace(/"/g, '&quot;');
    return `<div class="result-item ripple-btn"
                 data-result="${escaped}"
                 style="--delay:${i * 0.05}s"
                 role="option" tabindex="0"
                 aria-label="${name}">
      <div class="result-emoji">${icon}</div>
      <div class="result-info">
        <div class="result-name">${this._hl(name, document.getElementById('searchInput')?.value || '')}</div>
        <div class="result-addr">${addr}</div>
      </div>
      <div class="result-chevron">›</div>
    </div>`;
  },

  _hl(text, query) {
    if (!query) return text;
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(re, '<mark style="background:rgba(79,142,247,0.25);color:inherit;border-radius:2px">$1</mark>');
  },

  _bindResultClicks(container) {
    container.querySelectorAll('.result-item').forEach(el => {
      const act = () => {
        const r = JSON.parse(el.dataset.result.replace(/&quot;/g, '"'));
        Search.select(r);
      };
      el.addEventListener('click', act);
      el.addEventListener('keydown', e => e.key === 'Enter' && act());
    });
  },

  // ── route card ────────────────────────────────
  openRouteCard() {
    document.getElementById('routeCard').classList.add('open');
    document.getElementById('routeDest').textContent = State.destination?.name || 'Destination';
  },
  closeRouteCard() {
    document.getElementById('routeCard').classList.remove('open');
  },
  setRouteLoading(on) {
    const btn  = document.getElementById('startNavBtn');
    const time = document.getElementById('routeTime');
    const dist = document.getElementById('routeDist');
    btn.disabled = on;
    if (on) {
      time.innerHTML = '<span class="shimmer">— — —</span>';
      dist.innerHTML = '<span class="shimmer">— — —</span>';
    }
  },
  updateRouteCard(route) {
    document.getElementById('routeTime').textContent = Utils.fmtTime(route.duration);
    document.getElementById('routeDist').textContent = Utils.fmtDist(route.distance);
    document.getElementById('startNavBtn').disabled = false;
    Traffic._syncBadge();
  },
  renderDirections(steps) {
    const list = document.getElementById('directionsList');
    list.innerHTML = steps.map((s, i) => `
      <div class="direction-step" style="--delay:${i * 0.04}s">
        <div class="step-arrow">${s.icon}</div>
        <div class="step-body">
          <div class="step-instruction">${s.instruction}</div>
          <div class="step-dist">${s.distance}${s.name ? ' · ' + s.name : ''}</div>
        </div>
        <div class="step-time">${s.duration}</div>
      </div>`).join('');
  },
  dismissRoute() {
    this.closeRouteCard();
    Traffic.stopUpdates();
    // Reset traffic badge
    const sep   = document.getElementById('trafficSep');
    const badge = document.getElementById('trafficBadge');
    if (sep)   sep.style.display   = 'none';
    if (badge) badge.style.display = 'none';
    Map_.clearRoute();
    Map_.clearDestination();
    State.destination = null;
    State.route = null;
    State.steps = [];
  },

  // ── navigation HUD ────────────────────────────
  showNavHud() {
    document.getElementById('navHud').classList.add('visible');
  },
  hideNavHud() {
    document.getElementById('navHud').classList.remove('visible');
  },

  // ── navigation stats bar ──────────────────────
  showNavStats() {
    document.getElementById('navStatsBar').classList.add('visible');
  },
  hideNavStats() {
    document.getElementById('navStatsBar').classList.remove('visible');
  },
  updateNavStats(distM) {
    // Use route's own average speed; fall back to ~50 km/h.
    const avgSpeedMps  = State.totalDistance && State.totalDuration
      ? State.totalDistance / State.totalDuration
      : 13.89;
    const secRemaining = Math.max(0, distM / avgSpeedMps);
    const minRemaining = Math.round(secRemaining / 60);
    const eta          = new Date(Date.now() + secRemaining * 1000);
    const etaStr       = eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const { value: distVal, unit: distUnit } = Utils.fmtDistParts(distM);

    const minsEl     = document.getElementById('navStatMinutes');
    const etaEl      = document.getElementById('navStatETA');
    const distEl     = document.getElementById('navStatDist');
    const distUnitEl = document.getElementById('navStatDistUnit');
    if (minsEl)     minsEl.textContent     = minRemaining < 1 ? '<1' : String(minRemaining);
    if (etaEl)      etaEl.textContent      = etaStr;
    if (distEl)     distEl.textContent     = distVal;
    if (distUnitEl) distUnitEl.textContent = distUnit;
  },

  // ── bottom nav ────────────────────────────────
  showBottomNav() {
    document.getElementById('bottomNav').classList.remove('hidden-nav');
  },
  hideBottomNav() {
    document.getElementById('bottomNav').classList.add('hidden-nav');
  },

  // ── tab switching ─────────────────────────────
  switchTab(tab) {
    State.activeTab = tab;
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
      btn.setAttribute('aria-current', btn.dataset.tab === tab ? 'page' : 'false');
    });

    // Close all side panels
    ['explorePanel', 'routesPanel', 'profilePanel'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });

    if (tab === 'explore') {
      this._renderExplore();
      document.getElementById('explorePanel').hidden = false;
    } else if (tab === 'routes') {
      this._renderRoutes();
      document.getElementById('routesPanel').hidden = false;
    } else if (tab === 'profile') {
      document.getElementById('profilePanel').hidden = false;
    }
  },

  _renderExplore() {
    const cats = [
      { icon:'🍽️', name:'Restaurants', q:'restaurant' },
      { icon:'☕', name:'Coffee',      q:'cafe'       },
      { icon:'⛽', name:'Gas',         q:'fuel'       },
      { icon:'🅿️', name:'Parking',    q:'parking'    },
      { icon:'🛍️', name:'Shopping',   q:'mall'       },
      { icon:'🏨', name:'Hotels',      q:'hotel'      },
      { icon:'🏥', name:'Hospital',    q:'hospital'   },
      { icon:'🏧', name:'ATM',         q:'atm'        },
    ];
    const panel = document.getElementById('explorePanel');
    panel.innerHTML = `
      <div class="panel-header"><h2>Explore Nearby</h2></div>
      <div class="category-grid">
        ${cats.map((c, i) => `<button class="category-item ripple-btn"
            data-q="${c.q}" style="--delay:${i*0.05}s"
            aria-label="${c.name}">
          <div class="cat-icon">${c.icon}</div>
          <div class="cat-name">${c.name}</div>
        </button>`).join('')}
      </div>`;

    panel.querySelectorAll('.category-item').forEach(btn =>
      btn.addEventListener('click', () => {
        this.switchTab('map');
        this.openSearch();
        setTimeout(() => {
          const inp = document.getElementById('searchInput');
          inp.value = btn.dataset.q;
          inp.dispatchEvent(new Event('input'));
        }, 100);
      })
    );
  },

  _renderRoutes() {
    const panel = document.getElementById('routesPanel');
    const items = State.recents.length
      ? State.recents.map(r => {
          const name = (r.name || r.display_name.split(',')[0]).trim();
          const addr = r.display_name;
          const escaped = JSON.stringify(r).replace(/"/g, '&quot;');
          return `<div class="route-history-item" data-result="${escaped}">
            <div class="route-history-icon">🕐</div>
            <div>
              <div class="route-history-name">${name}</div>
              <div class="route-history-addr">${addr}</div>
            </div>
          </div>`;
        }).join('')
      : `<div class="empty-state"><div class="empty-icon">🛣️</div><div class="empty-text">No recent routes</div></div>`;

    panel.innerHTML = `<div class="panel-header"><h2>Recent Routes</h2></div>
                       <div class="routes-list">${items}</div>`;

    panel.querySelectorAll('.route-history-item').forEach(el => {
      el.addEventListener('click', () => {
        const r = JSON.parse(el.dataset.result.replace(/&quot;/g, '"'));
        this.switchTab('map');
        Search.select(r);
      });
    });
  },

  // ── arrival animation ─────────────────────────
  showArrival(name) {
    const overlay = document.createElement('div');
    overlay.className = 'arrival-overlay';
    overlay.innerHTML = `
      <div class="arrival-rings-wrap">
        <div class="arrival-ring" style="animation-delay:0s"></div>
        <div class="arrival-ring" style="animation-delay:0.35s"></div>
        <div class="arrival-ring" style="animation-delay:0.7s"></div>
      </div>
      <div class="arrival-icon">🏁</div>
      <div class="arrival-title">You've arrived!</div>
      <div class="arrival-sub">${name}</div>`;
    document.getElementById('app').appendChild(overlay);
    setTimeout(() => {
      overlay.style.transition = 'opacity 0.5s';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 500);
    }, 2800);
  },

  // ── toast ─────────────────────────────────────
  toast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', 'alert');
    el.textContent = msg;
    container.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
    }, 3800);
  },

  // ── location btn state ────────────────────────
  setLocBtnState(state) {
    const btn = document.getElementById('locationBtn');
    if (!btn) return;
    btn.classList.remove('active', 'loading');
    if (state !== 'idle') btn.classList.add(state);
  },

  // ── ripple effect ─────────────────────────────
  _ripple(e, el) {
    const rp = document.createElement('div');
    rp.className = 'ripple-effect';
    const r = el.getBoundingClientRect();
    const sz = Math.max(r.width, r.height) * 2;
    rp.style.cssText = `width:${sz}px;height:${sz}px;left:${e.clientX - r.left - sz/2}px;top:${e.clientY - r.top - sz/2}px`;
    el.appendChild(rp);
    setTimeout(() => rp.remove(), 700);
  },

  // ── bottom sheet drag ─────────────────────────
  _initSheetDrag() {
    const sheet = document.getElementById('routeCard');
    const handle = sheet.querySelector('.sheet-handle-bar');
    if (!handle) return;
    let startY = 0, isDragging = false;

    handle.addEventListener('touchstart', e => {
      startY = e.touches[0].clientY;
      isDragging = true;
      sheet.style.transition = 'none';
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!isDragging) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0) sheet.style.transform = `translateY(${Math.min(dy, sheet.offsetHeight * 0.75)}px)`;
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      sheet.style.transition = '';
      const m = new DOMMatrix(window.getComputedStyle(sheet).transform);
      if (m.m42 > 90) this.dismissRoute();
      else sheet.style.transform = '';
    });
  },

  // ── theme UI sync ─────────────────────────────
  _updateThemeUI() {
    const icon = document.querySelector('.toggle-icon');
    const val  = document.getElementById('themeValue');
    if (icon) icon.textContent = State.theme === 'dark' ? '☀️' : '🌙';
    if (val)  val.textContent  = State.theme === 'dark' ? 'Dark' : 'Light';
  },
};

/* ═══════════════════════════════════════════════════════════════
   SPLASH CONTROLLER
═══════════════════════════════════════════════════════════════ */
const Splash = {
  init() {
    // Add particle dots
    const pc = document.getElementById('splashParticles');
    if (pc) {
      for (let i = 0; i < 28; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        p.style.cssText = `
          left:${Math.random() * 100}%;
          top:${Math.random() * 100}%;
          --dur:${2.5 + Math.random() * 3}s;
          --delay:${Math.random() * 2}s;
          opacity:${0.2 + Math.random() * 0.6};
          width:${1 + Math.random() * 2.5}px;
          height:${1 + Math.random() * 2.5}px;`;
        pc.appendChild(p);
      }
    }

    setTimeout(() => {
      const splash = document.getElementById('splash');
      const app    = document.getElementById('app');
      splash.classList.add('fade-out');
      setTimeout(() => {
        splash.style.display = 'none';
        app.classList.remove('app-hidden');
        app.classList.add('app-visible');
        App.postSplash();
      }, 650);
    }, Config.splashMs);
  },
};

/* ═══════════════════════════════════════════════════════════════
   SERVICE WORKER REGISTRATION
═══════════════════════════════════════════════════════════════ */
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('SW registered', reg.scope))
      .catch(err => console.warn('SW failed:', err));
  }
}

/* ═══════════════════════════════════════════════════════════════
   APP BOOTSTRAP
═══════════════════════════════════════════════════════════════ */
const App = {
  init() {
    Splash.init();
    registerSW();
  },
  postSplash() {
    Map_.init();
    UI.bind();
    Geo.startWatching();
    // Apply saved theme
    Map_.applyTheme(State.theme);
    UI._updateThemeUI();
    const uv = document.getElementById('unitsValue');
    if (uv) uv.textContent = State.units;
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
