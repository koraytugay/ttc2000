// TTC 2000 — Route 103 Mount Pleasant North
// Real-Time GPS Tracking, Stop Approximation, Layover Detection, Predictions & Timetables

import { fallbackSchedules } from './fallbackSchedules.js';
import { ROUTE_INFO, TRACKED_STOPS, ROUTE_PATHS, ALL_STOPS, ROUTE_DIRECTIONS } from './routeData.js';

// API Endpoints
const UMOIQ_BASE_URL = "https://retro.umoiq.com/service/publicJSONFeed";
const TTC_BASE_URL = "https://www.ttc.ca/ttcapi/routedetail";

// Caches and state
const scheduleMemoryCache = new Map();
let currentVehicles = [];
let multiStopPredictions = {};
const ttcNextBusesByStopCode = new Map();

// Map and layer references
let map = null;
const busMarkers = new Map();
const stopMarkers = new Map();
let routePolylineGroup = null;
let currentFilter = "all";
let lastBounds = null;

// Build stop lookup maps for fast sequential distance calculations
const allStopsByTag = new Map();
ALL_STOPS.forEach(s => allStopsByTag.set(s.tag, s));

const nbStopSeq = ROUTE_DIRECTIONS['103_1_103']?.stops || [];
const sbStopSeq = ROUTE_DIRECTIONS['103_0_103']?.stops || [];

// Helpers
const $ = (id) => document.getElementById(id);

function getCurrentTime() {
  const now = new Date();
  return now.toTimeString().split(' ')[0]; // HH:MM:SS
}

function getCurrentDay() {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
}

function compareTimes(t1, t2) {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  if (h1 !== h2) return h1 - h2;
  return m1 - m2;
}

// Haversine Distance (in meters)
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function formatDistance(meters) {
  if (meters == null || isNaN(meters)) return "--";
  if (meters < 100) return "At Stop";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/* ==========================================================================
   Leaflet Map Setup
   ========================================================================== */
function initMap() {
  const mapElement = $('map');
  if (!mapElement) return;

  map = L.map('map', {
    zoomControl: false,
    attributionControl: true
  }).setView([43.720, -79.395], 14);

  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
  }).addTo(map);

  routePolylineGroup = L.featureGroup().addTo(map);

  // Draw full Route 103 geometry
  if (ROUTE_PATHS && ROUTE_PATHS.length > 0) {
    ROUTE_PATHS.forEach(pathCoords => {
      L.polyline(pathCoords, {
        color: '#d32f2f',
        weight: 4,
        opacity: 0.82,
        lineJoin: 'round',
        lineCap: 'round'
      }).addTo(routePolylineGroup);
    });

    lastBounds = routePolylineGroup.getBounds();
    map.fitBounds(lastBounds.pad(0.08));
  }

  // Draw intermediate stops as subtle dots
  if (ALL_STOPS && Array.isArray(ALL_STOPS)) {
    const trackedStopTags = new Set([
      ...TRACKED_STOPS.northbound.map(s => s.tag),
      ...TRACKED_STOPS.southbound.map(s => s.tag)
    ]);

    ALL_STOPS.forEach(stop => {
      if (trackedStopTags.has(stop.tag)) return;

      const dot = L.circleMarker([stop.lat, stop.lon], {
        radius: 3.5,
        color: '#ffffff',
        weight: 1,
        fillColor: '#94a3b8',
        fillOpacity: 0.7
      }).addTo(map);

      dot.bindTooltip(`<b>${stop.title}</b><br><span style="font-size:11px;color:#64748b">Stop #${stop.stopId || stop.tag}</span>`, {
        direction: 'top',
        className: 'stop-tooltip'
      });
    });
  }

  setupTrackedStopMarkers();
}

function setupTrackedStopMarkers() {
  const allTracked = [
    ...TRACKED_STOPS.northbound.map(s => ({ ...s, dirLabel: 'Northbound' })),
    ...TRACKED_STOPS.southbound.map(s => ({ ...s, dirLabel: 'Southbound' }))
  ];

    allTracked.forEach(stop => {
    let pinClass = 'stop-pin';
    let iconSvg = '';
    let iconSize = [24, 24];
    let iconAnchor = [12, 12];
    let popupTitlePrefix = '🚏 ';

    if (stop.isHome) {
      pinClass += ' home-stop-pin';
      iconSize = [26, 26];
      iconAnchor = [13, 13];
      popupTitlePrefix = '🏠 ';
      iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
      </svg>`;
    } else if (stop.id === 'nb-eglinton') {
      pinClass += ' station-subway-pin';
      iconSize = [28, 28];
      iconAnchor = [14, 14];
      popupTitlePrefix = '🚇 ';
      iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2c-4 0-8 .5-8 4v9.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm2.5-6H5V7h14v4z"/>
      </svg>`;
    } else if (stop.id === 'sb-doncliffe') {
      pinClass += ' loop-terminal-pin';
      iconSize = [26, 26];
      iconAnchor = [13, 13];
      popupTitlePrefix = '🔄 ';
      iconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
      </svg>`;
    } else {
      // Major transfer stops: Mt Pleasant & Eglinton East (NB) and Mt Pleasant & Lawrence Ave East (SB)
      const dirClass = stop.dirLabel === 'Northbound' ? 'transfer-nb' : 'transfer-sb';
      pinClass += ` transfer-pin ${dirClass}`;
      iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/>
      </svg>`;
    }

    const iconHtml = `<div class="custom-pin ${pinClass}" title="${stop.title}">${iconSvg}</div>`;
    const markerIcon = L.divIcon({
      html: iconHtml,
      className: '',
      iconSize: iconSize,
      iconAnchor: iconAnchor
    });

    const marker = L.marker([stop.lat, stop.lon], { icon: markerIcon, zIndexOffset: 500 }).addTo(map);

    const popupHtml = `
      <div class="popup-card">
        <div class="popup-title">${popupTitlePrefix}${stop.title}</div>
        <div class="popup-row">
          <span>Direction:</span>
          <span class="popup-val">${stop.dirLabel}</span>
        </div>
        <div class="popup-row">
          <span>Stop Code:</span>
          <span class="popup-val">#${stop.stopCode}</span>
        </div>
        <div class="popup-row">
          <span>Status:</span>
          <span class="popup-val" id="popup-status-${stop.id}">Calculating…</span>
        </div>
      </div>
    `;
    marker.bindPopup(popupHtml);

    marker.on('click', () => {
      const cardId = `card-${stop.id}`;
      const cardEl = $(cardId);
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        cardEl.style.transition = 'all 0.3s ease';
        cardEl.style.borderColor = 'var(--accent-gold)';
        setTimeout(() => {
          cardEl.style.borderColor = '';
        }, 1500);
      }
    });

    stopMarkers.set(stop.id, marker);
  });
}

/* ==========================================================================
   Vehicle Status Analysis & Stop Proximity Matcher
   ========================================================================== */
function analyzeVehicleProgress(vehicle) {
  const isNorthbound = vehicle.dirTag && vehicle.dirTag.includes('_1_');
  const seq = isNorthbound ? nbStopSeq : sbStopSeq;
  const vlat = parseFloat(vehicle.lat);
  const vlon = parseFloat(vehicle.lon);

  if (isNaN(vlat) || isNaN(vlon) || !seq || seq.length === 0) return null;

  let closestTag = null;
  let minDistance = Infinity;
  let closestIndex = -1;

  for (let idx = 0; idx < seq.length; idx++) {
    const tag = seq[idx];
    const stopObj = allStopsByTag.get(tag);
    if (!stopObj) continue;
    const dist = distanceMeters(vlat, vlon, stopObj.lat, stopObj.lon);
    if (dist < minDistance) {
      minDistance = dist;
      closestTag = tag;
      closestIndex = idx;
    }
  }

  const closestStop = allStopsByTag.get(closestTag);
  const speed = parseInt(vehicle.speedKmHr || "0", 10);
  const isAtTerminal = (closestIndex === 0 || closestIndex === seq.length - 1) && minDistance < 300;

  return {
    vehicleId: vehicle.id,
    isNorthbound,
    closestStop,
    closestIndex,
    totalStops: seq.length,
    distanceToClosest: minDistance,
    isAtStop: minDistance < 180,
    isAtTerminal,
    speed,
    heading: parseInt(vehicle.heading || "0", 10)
  };
}

/* ==========================================================================
   Vehicle GPS Tracking & Bus Markers
   ========================================================================== */
async function fetchVehicleLocations() {
  try {
    const url = `${UMOIQ_BASE_URL}?command=vehicleLocations&a=ttc&r=103&t=0&_t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Vehicle HTTP error ${res.status}`);

    const data = await res.json();
    let vehicles = data.vehicle || [];
    if (!Array.isArray(vehicles)) vehicles = [vehicles];

    currentVehicles = vehicles;
    renderVehiclesOnMap(vehicles);
    updateProximityApproximations(vehicles);

    const badge = $('active-buses-badge');
    if (badge) {
      badge.innerText = `${vehicles.length} ${vehicles.length === 1 ? 'Bus' : 'Buses'} Active`;
      badge.style.color = vehicles.length > 0 ? 'var(--brand-nb)' : 'var(--text-muted)';
    }

    const overlay = $('map-status-overlay');
    if (overlay) {
      if (vehicles.length === 0) {
        overlay.removeAttribute('hidden');
        $('map-status-msg').innerText = 'No active buses currently reported on line 103.';
      } else {
        overlay.setAttribute('hidden', '');
      }
    }
  } catch (err) {
    console.warn("Could not fetch live vehicle locations:", err);
    const badge = $('active-buses-badge');
    if (badge) badge.innerText = "GPS Offline";
  }
}

function renderVehiclesOnMap(vehicles) {
  if (!map) return;

  const currentIds = new Set(vehicles.map(v => v.id));

  // Remove stale markers
  for (const [id, marker] of busMarkers.entries()) {
    if (!currentIds.has(id)) {
      map.removeLayer(marker);
      busMarkers.delete(id);
    }
  }

  vehicles.forEach(vehicle => {
    const isNorthbound = vehicle.dirTag && vehicle.dirTag.includes('_1_');
    const dirClass = isNorthbound ? 'dir-nb' : 'dir-sb';
    const dirSymbol = isNorthbound ? '▲ NB' : '▼ SB';
    const dirLabel = isNorthbound ? 'Northbound (to Doncliffe)' : 'Southbound (to Eglinton)';
    const heading = parseInt(vehicle.heading || "0", 10);
    const speed = parseInt(vehicle.speedKmHr || "0", 10);
    const secsAgo = vehicle.secsSinceReport || "0";

    const isVisible = (currentFilter === 'all') ||
                      (currentFilter === 'northbound' && isNorthbound) ||
                      (currentFilter === 'southbound' && !isNorthbound);

    const lat = parseFloat(vehicle.lat);
    const lon = parseFloat(vehicle.lon);
    if (isNaN(lat) || isNaN(lon)) return;

    // Analyze progress relative to stops
    const progress = analyzeVehicleProgress(vehicle);
    let statusLabel = `${dirSymbol}`;
    let popupStatusDesc = '';

    if (progress) {
      if (progress.isAtTerminal && speed === 0) {
        statusLabel = `At Station (${dirSymbol})`;
        popupStatusDesc = `Waiting at platform / terminal layover`;
      } else if (progress.isAtStop) {
        statusLabel = `At Stop (${dirSymbol})`;
        popupStatusDesc = `At Stop: ${progress.closestStop?.title || 'Serving stop'}`;
      } else if (speed > 0) {
        statusLabel = `${speed} km/h (${dirSymbol})`;
        popupStatusDesc = `In transit near ${progress.closestStop?.title || 'en route'}`;
      } else {
        statusLabel = `Stopped (${dirSymbol})`;
        popupStatusDesc = `Temporarily stopped near ${progress.closestStop?.title || 'traffic'}`;
      }
    }

    const iconHtml = `
      <div class="bus-marker-wrap">
        <div class="bus-pin ${dirClass}" title="Bus #${vehicle.id}">
          <div class="bus-heading-pointer" style="transform: rotate(${heading}deg);">
            <span class="heading-cone"></span>
          </div>
          <svg class="bus-vehicle-svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/>
          </svg>
        </div>
        <div class="bus-badge-label">
          <span>#${vehicle.id}</span>
          <span>•</span>
          <span>${statusLabel}</span>
        </div>
      </div>
    `;

    const customIcon = L.divIcon({
      html: iconHtml,
      className: '',
      iconSize: [70, 56],
      iconAnchor: [35, 17]
    });

    const popupContent = `
      <div class="popup-card">
        <div class="popup-title">🚌 Bus #${vehicle.id}</div>
        <div class="popup-row">
          <span>Direction:</span>
          <span class="popup-val">${dirLabel}</span>
        </div>
        <div class="popup-row">
          <span>Location:</span>
          <span class="popup-val">${popupStatusDesc}</span>
        </div>
        <div class="popup-row">
          <span>Speed:</span>
          <span class="popup-val">${speed > 0 ? `${speed} km/h` : 'Stopped / 0 km/h'}</span>
        </div>
        <div class="popup-row">
          <span>Heading:</span>
          <span class="popup-val">${heading}°</span>
        </div>
        <div class="popup-row">
          <span>GPS Ping:</span>
          <span class="popup-val">${secsAgo}s ago</span>
        </div>
      </div>
    `;

    if (busMarkers.has(vehicle.id)) {
      const marker = busMarkers.get(vehicle.id);
      marker.setLatLng([lat, lon]);
      marker.setIcon(customIcon);
      marker.setPopupContent(popupContent);
      if (isVisible) {
        if (!map.hasLayer(marker)) marker.addTo(map);
      } else {
        if (map.hasLayer(marker)) map.removeLayer(marker);
      }
    } else {
      const marker = L.marker([lat, lon], { icon: customIcon, zIndexOffset: 1000 });
      marker.bindPopup(popupContent);
      if (isVisible) marker.addTo(map);
      busMarkers.set(vehicle.id, marker);
    }
  });
}

/* ==========================================================================
   Comprehensive Stop Proximity & Layover Evaluation
   ========================================================================== */
function evaluateStopBusStatus(stop, candidateBuses, isNorthbound) {
  const seq = isNorthbound ? nbStopSeq : sbStopSeq;
  const targetStopIndex = seq.indexOf(stop.tag);

  let busAtStop = null;
  let busJustDeparted = null;
  let approachingBus = null;
  let approachingDist = Infinity;
  let terminalLayoverBus = null;

  candidateBuses.forEach(bus => {
    const busLat = parseFloat(bus.lat);
    const busLon = parseFloat(bus.lon);
    if (isNaN(busLat) || isNaN(busLon)) return;

    const straightDist = distanceMeters(busLat, busLon, stop.lat, stop.lon);
    const progress = analyzeVehicleProgress(bus);
    const speed = parseInt(bus.speedKmHr || "0", 10);

    // 1. Is this bus physically AT this stop (< 180 meters)?
    if (straightDist < 180) {
      busAtStop = { bus, distance: straightDist, speed };
    }

    // 2. Is this a terminal stop (Eglinton or Doncliffe) with a bus on layover?
    const isTerminalStop = (targetStopIndex === 0);
    if (isTerminalStop && straightDist < 300 && speed === 0) {
      terminalLayoverBus = { bus, distance: straightDist };
    }

    // 3. Sequential Progress Check
    if (progress && targetStopIndex !== -1) {
      const busStopIndex = progress.closestIndex;

      // Has the bus JUST DEPARTED this stop (within 1 stop ahead, and < 350m)?
      if (busStopIndex === targetStopIndex + 1 && straightDist < 350) {
        busJustDeparted = { bus, distance: straightDist };
      }

      // Is the bus approaching this stop from behind?
      if (busStopIndex <= targetStopIndex) {
        if (straightDist < approachingDist) {
          approachingDist = straightDist;
          approachingBus = { bus, distance: straightDist, speed };
        }
      }
    } else {
      // Fallback if stop index not in sequence
      if (straightDist < approachingDist) {
        approachingDist = straightDist;
        approachingBus = { bus, distance: straightDist, speed };
      }
    }
  });

  return {
    busAtStop,
    busJustDeparted,
    approachingBus,
    terminalLayoverBus
  };
}

function updateProximityApproximations(vehicles) {
  const nbBuses = vehicles.filter(v => v.dirTag && v.dirTag.includes('_1_'));
  const sbBuses = vehicles.filter(v => v.dirTag && !v.dirTag.includes('_1_'));

  TRACKED_STOPS.northbound.forEach(stop => {
    updateStopProximityBanner(stop, nbBuses, true);
  });

  TRACKED_STOPS.southbound.forEach(stop => {
    updateStopProximityBanner(stop, sbBuses, false);
  });

  updateHeaderHomePills(nbBuses, sbBuses);
}

function updateStopProximityBanner(stop, candidateBuses, isNorthbound) {
  let bannerId = '';
  if (stop.id === 'nb-eglinton') bannerId = 'nb-eglinton-proximity';
  else if (stop.id === 'nb-eglintonEast') bannerId = 'nb-eglintonEast-proximity';
  else if (stop.id === 'nb-home') bannerId = 'nb-home-proximity';
  else if (stop.id === 'sb-doncliffe') bannerId = 'sb-doncliffe-proximity';
  else if (stop.id === 'sb-lawrence') bannerId = 'sb-lawrence-proximity';
  else if (stop.id === 'sb-home') bannerId = 'sb-home-proximity';

  const bannerEl = $(bannerId);
  if (!bannerEl) return;

  const textSpan = bannerEl.querySelector('.proximity-text');
  if (!textSpan) return;

  const status = evaluateStopBusStatus(stop, candidateBuses, isNorthbound);

  if (status.busAtStop) {
    const { bus, distance, speed } = status.busAtStop;
    textSpan.innerHTML = `<span class="badge-live-status badge-at-stop">AT STOP NOW</span> Bus <b>#${bus.id}</b> is arriving / at platform (${speed > 0 ? `${speed} km/h` : 'serving stop'})`;
  } else if (status.terminalLayoverBus) {
    const { bus } = status.terminalLayoverBus;
    textSpan.innerHTML = `<span class="badge-live-status badge-layover">AT STATION</span> Bus <b>#${bus.id}</b> waiting at platform (terminal layover)`;
  } else if (status.busJustDeparted) {
    const { bus, distance } = status.busJustDeparted;
    const formattedDist = formatDistance(distance);
    textSpan.innerHTML = `<span class="badge-live-status badge-just-left">JUST LEFT</span> Bus <b>#${bus.id}</b> departed stop (~${formattedDist} past)`;
  } else if (status.approachingBus) {
    const { bus, distance, speed } = status.approachingBus;
    const formattedDist = formatDistance(distance);
    const progress = analyzeVehicleProgress(bus);
    let speedText = speed > 0 ? `moving at ${speed} km/h` : 'in slow traffic / stop';
    if (progress && progress.isAtTerminal && speed === 0) {
      speedText = 'at terminal, departing shortly';
    }
    textSpan.innerHTML = `<span class="badge-live-status badge-en-route">EN ROUTE</span> Bus <b>#${bus.id}</b> is <b>${formattedDist}</b> away (${speedText})`;
  } else {
    textSpan.innerHTML = `No upcoming bus currently en route in this direction.`;
  }

  // Update popup if open
  const popupStatusEl = $(`popup-status-${stop.id}`);
  if (popupStatusEl) {
    if (status.busAtStop) popupStatusEl.innerText = `Bus #${status.busAtStop.bus.id} At Stop`;
    else if (status.terminalLayoverBus) popupStatusEl.innerText = `Bus #${status.terminalLayoverBus.bus.id} at Terminal`;
    else if (status.approachingBus) {
      const progress = analyzeVehicleProgress(status.approachingBus.bus);
      if (progress && progress.isAtTerminal && status.approachingBus.speed === 0) {
        popupStatusEl.innerText = `Bus #${status.approachingBus.bus.id} at Terminal (departs soon)`;
      } else {
        popupStatusEl.innerText = `${formatDistance(status.approachingBus.distance)} away`;
      }
    }
    else popupStatusEl.innerText = `No bus en route`;
  }
}

function updateHeaderHomePills(nbBuses, sbBuses) {
  const homeNbStop = TRACKED_STOPS.northbound.find(s => s.isHome);
  const homeSbStop = TRACKED_STOPS.southbound.find(s => s.isHome);

  // 1. Home Northbound (Blythwood Rd)
  if (homeNbStop) {
    const status = evaluateStopBusStatus(homeNbStop, nbBuses, true);
    const distEl = $('pill-nb-dist');
    const timeEl = $('pill-nb-time');

    if (distEl && timeEl) {
      if (status.busAtStop) {
        distEl.innerHTML = `<b style="color:var(--brand-nb)">#${status.busAtStop.bus.id} AT STOP</b>`;
        timeEl.innerText = 'Now';
        timeEl.style.display = 'inline-block';
      } else if (status.busJustDeparted) {
        distEl.innerText = `#${status.busJustDeparted.bus.id} just left`;
        if (status.approachingBus) {
          const estMin = Math.max(1, Math.round((status.approachingBus.distance / 1000) / 20 * 60));
          timeEl.innerText = `Next: #${status.approachingBus.bus.id} ~${estMin}m`;
        } else {
          timeEl.style.display = 'none';
        }
      } else if (status.approachingBus) {
        distEl.innerText = `#${status.approachingBus.bus.id} • ${formatDistance(status.approachingBus.distance)}`;
        const ttcData = ttcNextBusesByStopCode.get(homeNbStop.stopCode);
        const nextMin = ttcData && ttcData[0] ? ttcData[0].nextBusMinutes : null;
        const estMin = Math.max(1, Math.round((status.approachingBus.distance / 1000) / 20 * 60));
        timeEl.innerText = nextMin ? `${nextMin} min` : `~${estMin} min`;
        timeEl.style.display = 'inline-block';
      } else {
        distEl.innerText = 'No bus en route';
        timeEl.style.display = 'none';
      }
    }
  }

  // 2. Home Southbound (Stibbard Ave)
  if (homeSbStop) {
    const status = evaluateStopBusStatus(homeSbStop, sbBuses, false);
    const distEl = $('pill-sb-dist');
    const timeEl = $('pill-sb-time');

    if (distEl && timeEl) {
      if (status.busAtStop) {
        distEl.innerHTML = `<b style="color:var(--brand-sb)">#${status.busAtStop.bus.id} AT STOP</b>`;
        timeEl.innerText = 'Now';
        timeEl.style.display = 'inline-block';
      } else if (status.busJustDeparted) {
        distEl.innerText = `#${status.busJustDeparted.bus.id} just left`;
        if (status.approachingBus) {
          const estMin = Math.max(1, Math.round((status.approachingBus.distance / 1000) / 20 * 60));
          timeEl.innerText = `Next: #${status.approachingBus.bus.id} ~${estMin}m`;
        } else {
          timeEl.style.display = 'none';
        }
      } else if (status.approachingBus) {
        distEl.innerText = `#${status.approachingBus.bus.id} • ${formatDistance(status.approachingBus.distance)}`;
        const ttcData = ttcNextBusesByStopCode.get(homeSbStop.stopCode);
        const nextMin = ttcData && ttcData[0] ? ttcData[0].nextBusMinutes : null;
        const estMin = Math.max(1, Math.round((status.approachingBus.distance / 1000) / 20 * 60));
        timeEl.innerText = nextMin ? `${nextMin} min` : `~${estMin} min`;
        timeEl.style.display = 'inline-block';
      } else {
        distEl.innerText = 'No bus en route';
        timeEl.style.display = 'none';
      }
    }
  }
}

/* ==========================================================================
   Multi-Stop Real-Time Next Bus Predictions (UmoIQ + TTC API)
   ========================================================================== */
async function fetchPredictions() {
  const allStops = [...TRACKED_STOPS.northbound, ...TRACKED_STOPS.southbound];

  // 1. Fetch official TTC website API (GetNextBuses) for all tracked stops in parallel
  // This matches the user's original ttc app 1:1
  const ttcPromises = allStops.map(async stop => {
    try {
      const res = await fetch(`${TTC_BASE_URL}/GetNextBuses?routeId=103&stopCode=${stop.stopCode}&_t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          ttcNextBusesByStopCode.set(stop.stopCode, data);
        }
      }
    } catch (e) {
      console.warn(`TTC GetNextBuses fetch failed for stop ${stop.stopCode}:`, e);
    }
  });

  // 2. Fetch raw UmoIQ real-time GPS predictions in parallel for vehicle IDs & layover data
  const stopTagsQuery = allStops.map(s => `stops=103|${s.tag}`).join('&');
  const umoiqPromise = (async () => {
    try {
      const res = await fetch(`${UMOIQ_BASE_URL}?command=predictionsForMultiStops&a=ttc&${stopTagsQuery}&_t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        let predsList = data.predictions || [];
        if (!Array.isArray(predsList)) predsList = [predsList];
        predsList.forEach(p => {
          multiStopPredictions[p.stopTag] = p;
        });
      }
    } catch (err) {
      console.warn("UmoIQ prediction fetch error:", err);
    }
  })();

  await Promise.allSettled([...ttcPromises, umoiqPromise]);

  TRACKED_STOPS.northbound.forEach(stop => populateNextBus(stop));
  TRACKED_STOPS.southbound.forEach(stop => populateNextBus(stop));
}

async function populateNextBus(stop) {
  let elementId = '';
  if (stop.id === 'nb-eglinton') elementId = 'nb-stClairStationAtLowerPlatform-nextbus';
  else if (stop.id === 'nb-eglintonEast') elementId = 'nb-mtPleasantRdAtEglintonAveEastNorthSide-nextbus';
  else if (stop.id === 'nb-home') elementId = 'nb-mtPleasantRdatBlythwoodRd-nextbus';
  else if (stop.id === 'sb-doncliffe') elementId = 'sb-doncliffeLoopAtGlenEchoRd-nextbus';
  else if (stop.id === 'sb-lawrence') elementId = 'sb-mtPleasantRdAtLawrenceAveEastSouthSide-nextbus';
  else if (stop.id === 'sb-home') elementId = 'sb-mtPleasantRdAtStibbardAve-nextbus';

  const nextBusDiv = $(elementId);
  if (!nextBusDiv) return;

  let rawPredictions = [];

  // 1. Read from official TTC GetNextBuses first (matches original ttc app 1:1)
  const ttcList = ttcNextBusesByStopCode.get(stop.stopCode);
  if (ttcList && Array.isArray(ttcList) && ttcList.length > 0) {
    ttcList.forEach(item => {
      let m = item.nextBusMinutes;
      if (m === 'D') m = 'Delayed';
      else if (m === '0') m = 'Due';
      rawPredictions.push({
        minutes: m,
        scheduledTime: item.scheduledTime,
        vehicle: null,
        layover: false,
        isDeparture: false
      });
    });
  }

  // 2. Read UmoIQ raw GPS feed for vehicle ID & layover metadata, or as fallback
  const predData = multiStopPredictions[stop.tag];
  if (predData && predData.direction) {
    let dirList = predData.direction;
    if (!Array.isArray(dirList)) dirList = [dirList];

    let umoiqList = [];
    dirList.forEach(dirObj => {
      let list = dirObj.prediction || [];
      if (!Array.isArray(list)) list = [list];
      list.forEach(item => {
        umoiqList.push({
          minutes: item.minutes === '0' ? 'Due' : item.minutes,
          seconds: item.seconds,
          vehicle: item.vehicle,
          layover: item.affectedByLayover === 'true',
          isDeparture: item.isDeparture === 'true'
        });
      });
    });

    if (rawPredictions.length === 0) {
      rawPredictions = umoiqList;
    } else if (umoiqList.length > 0) {
      // Enrich with vehicle ID and layover status from UmoIQ
      rawPredictions[0].vehicle = umoiqList[0].vehicle;
      rawPredictions[0].layover = umoiqList[0].layover;
      rawPredictions[0].isDeparture = umoiqList[0].isDeparture;
    }
  }

  nextBusDiv.innerHTML = '';

  if (rawPredictions.length === 0) {
    const span = document.createElement("span");
    span.innerText = "No upcoming buses scheduled.";
    span.style.color = "var(--text-muted)";
    nextBusDiv.appendChild(span);
    return;
  }

  // Cross-reference with live GPS proximity
  const isNorthbound = stop.direction === "1";
  const candidateBuses = currentVehicles.filter(v => {
    return isNorthbound ? (v.dirTag && v.dirTag.includes('_1_')) : (v.dirTag && !v.dirTag.includes('_1_'));
  });
  const status = evaluateStopBusStatus(stop, candidateBuses, isNorthbound);

  // Case 1: Bus is AT STOP right now (< 180m)
  if (status.busAtStop) {
    const bus = status.busAtStop.bus;
    const badge = document.createElement("span");
    badge.className = "badge-live-status badge-at-stop";
    badge.innerText = "AT STOP";
    nextBusDiv.appendChild(badge);

    const text = document.createElement("span");
    text.innerHTML = `Bus <b>#${bus.id}</b> is arriving now! `;
    nextBusDiv.appendChild(text);

    if (rawPredictions.length > 0) {
      const nextText = document.createElement("span");
      nextText.style.fontSize = "0.82rem";
      nextText.style.color = "var(--text-secondary)";
      nextText.innerHTML = `(Next departure in <b>${rawPredictions[0].minutes} min</b>)`;
      nextBusDiv.appendChild(nextText);
    }
    return;
  }

  // Case 2: Terminal Stop with bus on layover
  const firstPred = rawPredictions[0];
  if ((stop.id === 'nb-eglinton' || stop.id === 'sb-doncliffe') && status.terminalLayoverBus) {
    const bus = status.terminalLayoverBus.bus;
    const badge = document.createElement("span");
    badge.className = "badge-live-status badge-layover";
    badge.innerText = "AT STATION";
    nextBusDiv.appendChild(badge);

    const text = document.createElement("span");
    text.innerHTML = `Bus <b>#${bus.id}</b> departs in <span class="minutes">${firstPred.minutes}</span> minutes <span style="font-size:0.8rem;color:var(--text-secondary)">(layover at platform)</span>`;
    nextBusDiv.appendChild(text);
    return;
  }

  // Case 3: Standard Next Bus Countdown
  let minutesArr = rawPredictions.map(p => p.minutes === '0' ? 'Due' : p.minutes);

  let span = document.createElement("span");
  span.innerText = "Next bus is in ";
  nextBusDiv.appendChild(span);

  span = document.createElement("span");
  span.classList.add("minutes");
  span.innerText = minutesArr[0];
  nextBusDiv.appendChild(span);

  if (minutesArr.length === 1) {
    span = document.createElement("span");
    span.innerText = " minutes.";
    nextBusDiv.appendChild(span);
  } else {
    span = document.createElement("span");
    span.innerText = " minutes and in ";
    nextBusDiv.appendChild(span);

    span = document.createElement("span");
    span.classList.add("minutes");
    span.innerText = minutesArr[1];
    nextBusDiv.appendChild(span);

    span = document.createElement("span");
    span.innerText = " minutes.";
    nextBusDiv.appendChild(span);
  }

  if (firstPred.layover && stop.id !== 'nb-eglinton' && stop.id !== 'sb-doncliffe') {
    const layoverNote = document.createElement("span");
    layoverNote.style.fontSize = "0.78rem";
    layoverNote.style.color = "var(--text-muted)";
    layoverNote.style.marginLeft = "6px";
    const terminalName = isNorthbound ? "Eglinton Station" : "Doncliffe Loop";
    layoverNote.innerText = `(originates at ${terminalName})`;
    nextBusDiv.appendChild(layoverNote);
  }
}

/* ==========================================================================
   Daily Timetable Schedules (Multi-layer Cache, Daily Refresh & Fallback)
   ========================================================================== */
let lastCalendarDate = new Date().toISOString().split('T')[0];

async function fetchSchedule(stopCode, direction, forceRefresh = false) {
  const cacheKey = `${direction}_${stopCode}`;
  const todayStr = new Date().toISOString().split('T')[0]; // e.g. "2026-09-11"

  // 1. In-memory cache (valid only for today's date)
  if (!forceRefresh && scheduleMemoryCache.has(cacheKey)) {
    const mem = scheduleMemoryCache.get(cacheKey);
    if (mem && mem.date === todayStr && mem.data) {
      return mem.data;
    }
  }

  // 2. LocalStorage cache (valid only for today's date and < 24h)
  const storageKey = `ttc_schedule_103_${cacheKey}`;
  if (!forceRefresh) {
    try {
      const cachedItem = localStorage.getItem(storageKey);
      if (cachedItem) {
        const parsed = JSON.parse(cachedItem);
        if (parsed.date === todayStr && (Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) && parsed.data) {
          scheduleMemoryCache.set(cacheKey, { date: todayStr, data: parsed.data });
          return parsed.data;
        }
      }
    } catch (e) {
      console.warn("Could not read localStorage cache:", e);
    }
  }

  // 3. Network fetch from official TTC API with retry
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${TTC_BASE_URL}/schedule?route=103&direction=${direction}&stopCode=${stopCode}`);
      if (response.ok) {
        const responseData = await response.json();
        const schedule = responseData["103"];
        if (schedule && Array.isArray(schedule) && schedule.length > 0) {
          scheduleMemoryCache.set(cacheKey, { date: todayStr, data: schedule });
          try {
            localStorage.setItem(storageKey, JSON.stringify({
              date: todayStr,
              timestamp: Date.now(),
              data: schedule
            }));
          } catch (e) {}
          return schedule;
        }
      }
    } catch (err) {
      console.warn(`Schedule attempt ${attempt} failed for stop ${stopCode}:`, err);
    }

    if (attempt < maxAttempts) {
      await new Promise(res => setTimeout(res, 250));
    }
  }

  // 4. Stale cache fallback (if network is temporarily offline)
  try {
    const stale = localStorage.getItem(storageKey);
    if (stale) {
      const parsed = JSON.parse(stale);
      if (parsed.data) {
        scheduleMemoryCache.set(cacheKey, { date: todayStr, data: parsed.data });
        return parsed.data;
      }
    }
  } catch (e) {}

  // 5. Static fallback schedules
  if (fallbackSchedules && fallbackSchedules[cacheKey]) {
    const fallback = fallbackSchedules[cacheKey];
    scheduleMemoryCache.set(cacheKey, { date: todayStr, data: fallback });
    return fallback;
  }

  return null;
}

function getDailySchedule(scheduleList, currentDay) {
  if (!scheduleList || !scheduleList.length) return null;
  if (currentDay === 'Sunday') {
    return scheduleList.find(s => s.serviceId === 3 || s.label?.includes('Sunday')) || scheduleList[2] || scheduleList[0];
  } else if (currentDay === 'Saturday') {
    return scheduleList.find(s => s.serviceId === 2 || s.label?.includes('Saturday')) || scheduleList[1] || scheduleList[0];
  } else {
    return scheduleList.find(s => s.serviceId === 1 || s.label?.includes('Monday')) || scheduleList[0];
  }
}

async function populateSchedule(stopCode, elementId, direction, forceRefresh = false) {
  const scheduleDiv = $(elementId);
  if (!scheduleDiv) return;

  try {
    const schedule = await fetchSchedule(stopCode, direction, forceRefresh);
    if (!schedule) return;

    const currentDay = getCurrentDay();
    const dailyScheduleObj = getDailySchedule(schedule, currentDay);
    const dailySchedule = dailyScheduleObj?.schedule || [];

    let allScheduledTimes = [];
    for (let i = 0; i < dailySchedule.length; i++) {
      const label = dailySchedule[i].label || '';
      const isAfternoonPM = !label.startsWith('12') && label.endsWith('PM');
      const stopTimes = dailySchedule[i].stopTimes || [];
      for (let j = 0; j < stopTimes.length; j++) {
        let timeStr = stopTimes[j];
        if (isAfternoonPM) {
          let [hours, minutes] = timeStr.split(":");
          hours = 12 + parseInt(hours, 10);
          timeStr = `${hours}:${minutes}`;
        }
        allScheduledTimes.push(timeStr);
      }
    }

    const currentTime = new Date().toLocaleString('en-US', {hour: 'numeric', minute: 'numeric', hour12: false});
    let missedTime = null;
    let upcomingTimes = [];

    for (let i = 0; i < allScheduledTimes.length; i++) {
      if (compareTimes(allScheduledTimes[i], currentTime) >= 0) {
        if (i > 0) {
          missedTime = allScheduledTimes[i - 1];
        }
        for (let j = i; j < allScheduledTimes.length && upcomingTimes.length < 5; j++) {
          upcomingTimes.push(allScheduledTimes[j]);
        }
        break;
      }
    }

    scheduleDiv.innerHTML = '';

    const displayEntries = [];
    if (missedTime) {
      displayEntries.push({ time: missedTime, type: 'missed' });
    }
    upcomingTimes.forEach((time, index) => {
      displayEntries.push({ time, type: index === 0 ? 'next' : 'regular' });
    });

    let counter = 0;
    for (let entry of displayEntries) {
      if (counter === 5) break;
      const td = document.createElement("td");
      td.innerText = entry.time;
      if (entry.type === 'missed') {
        td.classList.add('missed');
        td.title = "Previous departure (passed)";
      } else if (entry.type === 'next') {
        td.classList.add('next');
        td.title = "Next scheduled departure";
      }
      scheduleDiv.appendChild(td);
      counter++;
    }
  } catch (err) {
    console.error(`Failed to populate schedule for ${stopCode}:`, err);
  }
}

function refreshAllSchedules(forceRefresh = false) {
  populateSchedule(14674, "nb-stClairStationAtLowerPlatform-schedule", "1", forceRefresh);
  populateSchedule(5813, "nb-mtPleasantRdAtEglintonAveEastNorthSide-schedule", "1", forceRefresh);
  populateSchedule(5804, "nb-mtPleasantRdatBlythwoodRd-schedule", "1", forceRefresh);

  populateSchedule(5518, "sb-doncliffeLoopAtGlenEchoRd-schedule", "0", forceRefresh);
  populateSchedule(5827, "sb-mtPleasantRdAtLawrenceAveEastSouthSide-schedule", "0", forceRefresh);
  populateSchedule(5846, "sb-mtPleasantRdAtStibbardAve-schedule", "0", forceRefresh);
}

/* ==========================================================================
   Live Data Refresh Orchestrator (Vehicle GPS, Map & Predictions every 15s)
   ========================================================================== */
const LIVE_REFRESH_INTERVAL_MS = 15000;

async function refreshLiveData(manual = false) {
  const refreshBtn = $('refresh-btn');
  const refreshIcon = $('refresh-icon');

  if (refreshIcon) {
    refreshIcon.classList.add('spinning');
  }
  if (manual && refreshBtn) {
    refreshBtn.disabled = true;
  }

  const timeEl = $('currentTime');
  if (timeEl) timeEl.innerText = getCurrentTime();

  const lastUpdatedEl = $('last-updated-text');
  if (lastUpdatedEl) {
    lastUpdatedEl.innerText = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }

  try {
    await Promise.allSettled([
      fetchVehicleLocations(),
      fetchPredictions()
    ]);
  } catch (e) {
    console.warn("Live refresh error:", e);
  } finally {
    if (refreshIcon) {
      setTimeout(() => {
        refreshIcon.classList.remove('spinning');
      }, 600);
    }
    if (manual && refreshBtn) {
      setTimeout(() => {
        refreshBtn.disabled = false;
      }, 600);
    }
  }
}

/* ==========================================================================
   Event Handlers & Interactivity
   ========================================================================== */
function setupEventHandlers() {
  const refreshBtn = $('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await refreshLiveData(true);
      refreshAllSchedules();
    });
  }

  const recenterBtn = $('recenter-btn');
  if (recenterBtn) {
    recenterBtn.addEventListener('click', () => {
      if (map && lastBounds) {
        map.fitBounds(lastBounds.pad(0.08));
      }
    });
  }

  const pillNb = $('pill-home-nb');
  if (pillNb) {
    pillNb.addEventListener('click', () => {
      const stop = TRACKED_STOPS.northbound.find(s => s.isHome);
      if (stop && map) {
        map.flyTo([stop.lat, stop.lon], 16, { duration: 0.8 });
        const marker = stopMarkers.get(stop.id);
        if (marker) marker.openPopup();
      }
    });
  }

  const pillSb = $('pill-home-sb');
  if (pillSb) {
    pillSb.addEventListener('click', () => {
      const stop = TRACKED_STOPS.southbound.find(s => s.isHome);
      if (stop && map) {
        map.flyTo([stop.lat, stop.lon], 16, { duration: 0.8 });
        const marker = stopMarkers.get(stop.id);
        if (marker) marker.openPopup();
      }
    });
  }

  document.querySelectorAll('.btn-locate-stop').forEach(btn => {
    btn.addEventListener('click', () => {
      const lat = parseFloat(btn.dataset.lat);
      const lon = parseFloat(btn.dataset.lon);
      if (!isNaN(lat) && !isNaN(lon) && map) {
        map.flyTo([lat, lon], 16, { duration: 0.8 });
        for (const [id, marker] of stopMarkers.entries()) {
          const pos = marker.getLatLng();
          if (Math.abs(pos.lat - lat) < 0.0001 && Math.abs(pos.lng - lon) < 0.0001) {
            marker.openPopup();
            break;
          }
        }
      }
    });
  });

  document.querySelectorAll('.map-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.map-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderVehiclesOnMap(currentVehicles);
    });
  });

  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      const container = $('dashboard-container');
      if (container) {
        container.dataset.activeView = view;
      }
      if (map) {
        setTimeout(() => map.invalidateSize(), 150);
      }
    });
  });

  window.addEventListener('resize', () => {
    if (map) map.invalidateSize();
  });
}

/* ==========================================================================
   Bootstrapping
   ========================================================================== */
function init() {
  initMap();
  setupEventHandlers();

  // Initial load
  refreshLiveData();
  refreshAllSchedules();

  // Clock ticker every second & midnight day transition detector
  setInterval(() => {
    const timeEl = $('currentTime');
    if (timeEl) timeEl.innerText = getCurrentTime();

    // Check if midnight rolled over to a new calendar day
    const currentDayStr = new Date().toISOString().split('T')[0];
    if (currentDayStr !== lastCalendarDate) {
      console.log(`New calendar day detected (${currentDayStr} vs ${lastCalendarDate}). Fetching fresh daily schedule from TTC API...`);
      lastCalendarDate = currentDayStr;
      scheduleMemoryCache.clear();
      refreshAllSchedules(true); // Force daily network refresh
    }
  }, 1000);

  // Live GPS positions, bus map pins & arrival predictions refresh every 15 seconds
  setInterval(() => {
    refreshLiveData();
  }, LIVE_REFRESH_INTERVAL_MS);

  // Daily timetable schedules only re-evaluate cell highlights once per minute (cached in-memory)
  setInterval(() => {
    refreshAllSchedules();
  }, 60000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
