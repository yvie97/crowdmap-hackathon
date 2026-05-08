import React, { useState, useEffect, useCallback } from 'react';
import { MapContainer, ImageOverlay, Polygon, Popup, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

// Remove default marker icon to prevent ghost icons on divIcon markers
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: '', shadowUrl: '', iconRetinaUrl: '' });

const MAP_WIDTH = 1520;
const MAP_HEIGHT = 1442;
const MAP_BOUNDS = [[0, 0], [MAP_HEIGHT, MAP_WIDTH]];
const MAP_MAX_BOUNDS = [[-300, -200], [MAP_HEIGHT + 1200, MAP_WIDTH + 200]];
const MAP_BG = 'rgb(247, 244, 240)';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:8000';
const WS_BASE = API_BASE.replace(/^http/, 'ws');
const FETCH_HEADERS = { 'ngrok-skip-browser-warning': '1' };
const GITHUB_URL = 'https://github.com/jyxu97/crowdmap-hackathon';


const AREAS = [
  { id: 'area_225_2f_1', name: 'North Corridor',      shortName: 'ZONE A', polygon: [[1045, 535],[1045, 1007],[1107, 1007],[1107, 535]] },
  { id: 'area_225_2f_2', name: 'Northeast Open Area', shortName: 'ZONE B', polygon: [[1130,985],[1435,985],[1435,1212],[1130,1345]] },
  { id: 'area_225_2f_3', name: 'Northwest Open Area', shortName: 'ZONE C', polygon: [[1177,131],[1177,557],[1435,557],[1435,131]] },
  { id: 'area_225_2f_4', name: 'East Corridor',       shortName: 'ZONE D', polygon: [[480,1095],[480,1150],[825,1150],[825,1095]] },
];

const HISTORY_LEN = 60;
const CHART_COLOR = '#7a5e3e';
const LINE_STYLES = [
  { dasharray: 'none',      label: '——' },
  { dasharray: '6,3',       label: '- -' },
  { dasharray: '2,3',       label: '···' },
  { dasharray: '10,3,2,3',  label: '—·—' },
];

function getColorFromLevel(level) {
  switch (level) {
    case 'low':    return 'rgb(120,168,135)';
    case 'medium': return 'rgb(215,196,145)';
    case 'high':   return 'rgb(205,140,118)';
    default:       return 'rgb(203,192,176)';
  }
}

function colorAlpha(rgbStr, opacity) {
  return rgbStr.replace('rgb(', 'rgba(').replace(')', `,${opacity})`);
}

function polygonCentroid(pts) {
  const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lng = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [lat, lng];
}

/** Shoelace formula — polygon points are [lat, lng] */
function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [y1, x1] = pts[i];
    const [y2, x2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

// Pre-compute each zone's area in map units²
const AREA_SQUNITS = Object.fromEntries(
  AREAS.map(a => [a.id, polygonArea(a.polygon)])
);

// Thresholds in people per 10 000 map-unit²
// Max full-capacity density across zones ≈ 5.0 (East Corridor 10p / ~20k u²)
const D_LOW = 1.65;   // < 33 % of max
const D_HIGH = 3.3;   // > 66 % of max
const D_MAX  = 5.0;

function getDensityInfo(count, areaId) {
  const sq  = AREA_SQUNITS[areaId] || 1;
  const d   = (count / sq) * 10000;               // people per 10k u²
  const pct = Math.min((d / D_MAX) * 100, 100);
  const level = d < D_LOW ? 'low' : d < D_HIGH ? 'medium' : 'high';
  return { pct, level };
}

function capitalizeLevel(level) {
  if (!level) return 'Unknown';
  return level.charAt(0).toUpperCase() + level.slice(1);
}



function FitBounds() {
  const map = useMap();
  React.useEffect(() => {
    map.fitBounds(MAP_BOUNDS, { padding: [20, 20] });
  }, [map]);
  return null;
}

/* ── Occupancy history sparkline chart ───────── */
function OccupancyChart({ historyData }) {
  const W = 260, H = 90;
  const pL = 26, pR = 8, pT = 8, pB = 14;
  const cW = W - pL - pR, cH = H - pT - pB;

  const allVals = Object.values(historyData).flat();
  const maxVal = Math.max(...allVals, 5);

  function toPolyline(pts) {
    return pts.map((v, i) => {
      const x = pL + (i / (pts.length - 1)) * cW;
      const y = pT + cH - (v / maxVal) * cH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  const gridYs = [0, 0.5, 1].map(t => ({ y: pT + cH * (1 - t), label: Math.round(maxVal * t) }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {/* Grid lines */}
      {gridYs.map((g, i) => (
        <g key={i}>
          <line x1={pL} y1={g.y} x2={pL + cW} y2={g.y} stroke="#ddd5c0" strokeWidth="1" />
          <text x={pL - 3} y={g.y + 3.5} fontSize="8" fill="#7a5e3e" textAnchor="end">{g.label}</text>
        </g>
      ))}
      {/* Zone lines */}
      {AREAS.map((area, idx) => {
        const data = historyData[area.id];
        if (!data || data.length < 2) return null;
        const style = LINE_STYLES[idx % LINE_STYLES.length];
        const pts = toPolyline(data);
        const last = pts.split(' ').pop().split(',');
        return (
          <g key={area.id}>
            <polyline points={pts} fill="none" stroke={CHART_COLOR} strokeWidth="1.1"
              strokeDasharray={style.dasharray === 'none' ? undefined : style.dasharray}
              strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={parseFloat(last[0])} cy={parseFloat(last[1])} r="3" fill={CHART_COLOR} />
          </g>
        );
      })}
      {/* X axis labels */}
      <text x={pL}      y={H - 4} fontSize="8" fill="#7a5e3e">−1h</text>
      <text x={pL + cW} y={H - 4} fontSize="8" fill="#7a5e3e" textAnchor="end">Now</text>
    </svg>
  );
}

/* ── Crowding Alert Banner ───────────────────── */
function CrowdingAlert({ areaData }) {
  const crowded = AREAS.filter(a => (areaData[a.id] || {}).level === 'high');
  if (crowded.length === 0) return null;
  return (
    <div className="crowding-alert">
      <span className="crowding-alert-icon">⚠</span>
      <span className="crowding-alert-text">
        <strong>High occupancy:</strong> {crowded.map(a => a.shortName).join(', ')}
      </span>
    </div>
  );
}

/* ── Find Seat Banner ────────────────────────── */
function FindSeatBanner({ recommendations }) {
  if (!recommendations || recommendations.length === 0) return null;
  const best = recommendations[0];
  const areaInfo = AREAS.find(a => a.id === best.area_id);
  const name  = areaInfo?.name || best.area_id;
  const count = best.count ?? 0;
  return (
    <div className="find-seat-banner">
      <span className="find-seat-icon">🔍</span>
      <span className="find-seat-text">
        <strong>Find me a seat</strong>
        <span className="find-seat-sub">{name} — only {count} {count === 1 ? 'person' : 'people'} detected</span>
      </span>
      <span className="find-seat-arrow">→</span>
    </div>
  );
}

/* ── Viewers tooltip ─────────────────────────── */
function ViewersTooltip({ count }) {
  return (
    <div className="viewers-tooltip">
      <span className="viewers-dot" />
      <span className="viewers-count">{count ?? '—'}</span>
      <span className="viewers-label">
        {count === 1 ? ' person' : ' people'} viewing now
      </span>
    </div>
  );
}

/* ── Info modal ──────────────────────────────── */
function InfoModal({ connected, onClose }) {
  return (
    <div className="info-modal-overlay" onClick={onClose}>
      <div className="info-modal" onClick={e => e.stopPropagation()}>
        <div className="info-modal-header">
          <span>CrowdMap</span>
          <button className="info-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="info-modal-body">
          <div className="info-row">
            <span className="info-label">Mode</span>
            <span className={`info-mode ${connected ? 'live' : 'mock'}`}>
              {connected ? '((·)) Live Camera' : '◎ Mock Stream'}
            </span>
          </div>
          <div className="info-row">
            <span className="info-label">CV</span>
            <span className="info-value">YOLOv8 · OpenCV</span>
          </div>
          <div className="info-row">
            <span className="info-label">Backend</span>
            <span className="info-value">FastAPI · Redis · SQLite</span>
          </div>
          <div className="info-row">
            <span className="info-label">Frontend</span>
            <span className="info-value">React · Leaflet</span>
          </div>
          <div className="info-row">
            <span className="info-label">Realtime</span>
            <span className="info-value">WebSocket · 1s push</span>
          </div>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="info-github-link"
          >
            View on GitHub →
          </a>
        </div>
      </div>
    </div>
  );
}

/* ── Left panel ──────────────────────────────── */
function LeftPanel({ areaData }) {
  const total = Object.values(areaData).reduce((s, d) => s + (d.count ?? 0), 0);
  return (
    <div className="side-panel left-panel">
      <div className="panel-card stat-summary">
        <div className="summary-number">{total}</div>
        <div className="summary-label">People Detected</div>
      </div>
      <div className="panel-card">
        <div className="panel-title">ZONES</div>
        {AREAS.map(area => {
          const info = areaData[area.id] || {};
          const count    = info.count    ?? 0;
          const capacity = info.capacity ?? 20;
          const level    = info.level    || 'low';
          const color    = getColorFromLevel(level);
          const pct      = Math.min(Math.round((count / capacity) * 100), 100);
          return (
            <div key={area.id} className="zone-card">
              <div className="zone-card-top">
                <span className="zone-short-name">{area.shortName}</span>
                <span className="zone-level-tag" style={{ color: '#4a3a28', borderColor: colorAlpha(color, 0.6), background: colorAlpha(color, 0.7) }}>
                  {capitalizeLevel(level)}
                </span>
              </div>
              <div className="zone-full-name">{area.name}</div>
              <div className="zone-bar-track">
                <div className="zone-bar-fill" style={{ width: `${pct}%`, background: color }} />
              </div>
              <div className="zone-count-row">
                <span className="zone-count" style={{ color }}>{count}</span>
                <span className="zone-cap"> / {capacity} capacity</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="panel-card">
        <div className="panel-title">OCCUPANCY LEVEL</div>
        {[
          { label: 'LOW',    sub: '< 33% occupied',  grad: 'linear-gradient(90deg,rgb(120,168,135),rgb(155,198,168))' },
          { label: 'MEDIUM', sub: '33–66% occupied',  grad: 'linear-gradient(90deg,rgb(215,196,145),rgb(232,215,170))' },
          { label: 'HIGH',   sub: '> 66% occupied',   grad: 'linear-gradient(90deg,rgb(205,140,118),rgb(225,168,150))' },
        ].map(e => (
          <div key={e.label} className="legend-entry">
            <div className="legend-bar" style={{ background: e.grad }} />
            <div className="legend-entry-text">
              <span className="legend-entry-label">{e.label}</span>
              <span className="legend-entry-sub">{e.sub}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Right panel ─────────────────────────────── */
function RightPanel({ areaData, connected, historyData }) {
  const lastUpdated = Math.max(...Object.values(areaData).map(d => d.timestamp ?? 0));
  const lowAreas  = Object.values(areaData).filter(d => d.level === 'low').length;
  const highAreas = Object.values(areaData).filter(d => d.level === 'high').length;
  return (
    <div className="side-panel right-panel">
      <div className="panel-card">
        <div className="panel-title">QUICK STATS</div>
        {[
          { label: 'Areas Monitored', value: AREAS.length, color: null },
          { label: 'Available',  value: lowAreas,  color: '#22c55e' },
          { label: 'Crowded',    value: highAreas, color: highAreas > 0 ? '#ef4444' : '#22c55e' },
        ].map(s => (
          <div key={s.label} className="stat-row-item">
            <span className="stat-row-label">{s.label}</span>
            <span className="stat-row-value" style={s.color ? { color: s.color } : {}}>{s.value}</span>
          </div>
        ))}
      </div>

      <div className="panel-card">
        <div className="panel-title">OCCUPANCY HISTORY</div>
        <OccupancyChart historyData={historyData} areaData={areaData} />
        <div className="chart-legend-row">
          {AREAS.map((area, idx) => {
            const style = LINE_STYLES[idx % LINE_STYLES.length];
            return (
              <span key={area.id} className="chart-legend-item">
                <svg width="24" height="10" viewBox="0 0 24 10" style={{ flexShrink: 0 }}>
                  <line x1="0" y1="5" x2="24" y2="5"
                    stroke={CHART_COLOR} strokeWidth="2"
                    strokeDasharray={style.dasharray === 'none' ? undefined : style.dasharray}
                    strokeLinecap="round" />
                </svg>
                {area.shortName}
              </span>
            );
          })}
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-title">SPACE DENSITY</div>
        <div className="density-subtitle">People per unit area · cross-zone comparison</div>
        {(() => {
          return AREAS.map((area, idx) => {
          const count = (areaData[area.id] || {}).count ?? 0;
          const { level, pct } = getDensityInfo(count, area.id);
          const color = getColorFromLevel(level);
          const tag   = level === 'low' ? 'Low' : level === 'medium' ? 'Med' : 'High';
          return (
            <div key={area.id} className="density-row">
              <span className="density-zone">{area.shortName}</span>
              <div className="density-bar-track">
                <div className="density-bar-fill" style={{ width: `${pct}%`, background: color }} />
              </div>
              <span className="density-tag" style={{
                color: '#4a3a28', border: `1px solid ${colorAlpha(color, 0.6)}`, background: colorAlpha(color, 0.7)
              }}>{tag}</span>
            </div>
          );
        });
        })()}
      </div>

      <div className="panel-card">
        <div className="panel-title">SYSTEM STATUS</div>
        <div className="status-item">
          <span className={`status-dot ${connected ? 'online' : 'offline'}`} />
          <span className="status-label">{connected ? 'Live Data Stream' : 'Mock Data Mode'}</span>
        </div>
        <div className="status-item">
          <span className="status-dot online" />
          <span className="status-label">Sensor Network</span>
        </div>
        <div className="status-time">
          Last updated: {lastUpdated ? new Date(lastUpdated * 1000).toLocaleTimeString() : '—'}
        </div>
      </div>

      <div className="panel-card privacy-card">
        <div className="panel-title">PRIVACY</div>
        <div className="privacy-item">
          <span className="privacy-icon">🎥</span>
          <span className="privacy-text">Video never leaves the device</span>
        </div>
        <div className="privacy-item">
          <span className="privacy-icon">🔢</span>
          <span className="privacy-text">Only headcounts are transmitted</span>
        </div>
        <div className="privacy-item">
          <span className="privacy-icon">🚫</span>
          <span className="privacy-text">No facial recognition or tracking</span>
        </div>
      </div>
    </div>
  );
}

/* ── App ─────────────────────────────────────── */
function App() {
  const [areaData,       setAreaData]       = useState({});
  const [historyData,    setHistoryData]    = useState({});
  const [recommendations,setRecommendations]= useState([]);
  const [connected, setConnected] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const [viewerCount, setViewerCount] = useState(null);
  const [showInfo, setShowInfo] = useState(false);

  const fetchAreas = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/areas`, { headers: FETCH_HEADERS });
      if (!res.ok) throw new Error();
      const data = await res.json();
      // Only apply real data if CV is actually running (at least one area has count > 0)
      const hasRealData = data.some(item => item.count > 0);
      if (!hasRealData) return;
      const mapped = {};
      data.forEach(item => { mapped[item.area_id] = { count: item.count, capacity: item.capacity, level: item.level, timestamp: item.timestamp }; });
      setAreaData(mapped);
    } catch { /* use mock */ }
  }, []);

  // Fetch real history from SQLite via /api/areas/{id}/history, downsample to HISTORY_LEN points
  const fetchHistory = useCallback(async () => {
    try {
      const results = await Promise.all(
        AREAS.map(area =>
          fetch(`${API_BASE}/api/areas/${area.id}/history?hours=1`, { headers: FETCH_HEADERS })
            .then(r => { if (!r.ok) throw new Error(); return r.json(); })
            .then(rows => ({ id: area.id, rows }))
        )
      );
      const next = {};
      results.forEach(({ id, rows }) => {
        if (!rows || rows.length === 0) {
          // No data yet for this area — keep existing history
          return;
        }
        // Downsample: pick HISTORY_LEN evenly-spaced points
        const counts = rows.map(r => r.count);
        if (counts.length <= HISTORY_LEN) {
          next[id] = counts;
        } else {
          const step = (counts.length - 1) / (HISTORY_LEN - 1);
          next[id] = Array.from({ length: HISTORY_LEN }, (_, i) =>
            counts[Math.round(i * step)]
          );
        }
      });
      // Only update if we got at least one real area's data
      if (Object.keys(next).length > 0) {
        setHistoryData(prev => ({ ...prev, ...next }));
      }
    } catch {
      // Backend unavailable — keep seeded mock data as fallback
    }
  }, []);

  const fetchRecommendations = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/recommend`, { headers: FETCH_HEADERS });
      if (!res.ok) throw new Error();
      const data = await res.json();
      // Only use backend data if CV is running (at least one area has count > 0)
      if (!data.length || !data.some(item => item.count > 0)) return;
      setRecommendations(data);
    } catch {
      const fallback = Object.entries(areaData)
        .map(([id, d]) => ({ area_id: id, count: d.count, capacity: d.capacity, level: d.level }))
        .sort((a, b) => a.count - b.count);
      setRecommendations(fallback);
    }
  }, [areaData]);

  const handleAvatarClick = useCallback(async (e) => {
    e.stopPropagation();
    setShowInfo(false);
    if (!showViewers) {
      setViewerCount(null);   // reset to show loading state
      setShowViewers(true);   // show tooltip immediately
      try {
        const res = await fetch(`${API_BASE}/api/viewers`, { headers: FETCH_HEADERS });
        if (res.ok) setViewerCount((await res.json()).count);
      } catch { /* backend unavailable */ }
    } else {
      setShowViewers(false);
    }
  }, [showViewers]);

  const handleGearClick = useCallback((e) => {
    e.stopPropagation();
    setShowViewers(false);
    setShowInfo(v => !v);
  }, []);

  // Close viewers tooltip when clicking anywhere outside
  useEffect(() => {
    if (!showViewers) return;
    const close = () => setShowViewers(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [showViewers]);

  useEffect(() => {
    let ws;
    let reconnectTimer;

    function connect() {
      ws = new WebSocket(`${WS_BASE}/ws/density`);

      ws.onopen = () => setConnected(true);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        setAreaData(prev => {
          const next = { ...prev };
          msg.areas.forEach(item => {
            next[item.area_id] = {
              ...(prev[item.area_id] || {}),
              count: item.count,
              level: item.level,
              timestamp: msg.timestamp,
            };
          });
          return next;
        });
      };

      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      ws.close();
    };
  }, []);

  useEffect(() => {
    fetchAreas();
    fetchRecommendations();
    fetchHistory();
    const areas = setInterval(fetchAreas, 3000);
    const rec  = setInterval(fetchRecommendations, 30000);
    const hist = setInterval(fetchHistory, 60000);   // refresh history every minute
    return () => { clearInterval(areas); clearInterval(rec); clearInterval(hist); };
  }, [fetchAreas, fetchRecommendations, fetchHistory]);

  return (
    <div className="App">
      <header className="app-header">
        <div className="header-left">
          <div className="header-logo">N</div>
          <div className="header-text">
            <h1>Northeastern University - Seattle</h1>
            <p className="subtitle">225 Second Floor · Real-time Occupancy</p>
          </div>
        </div>
        <div className="header-right">
          <span className={`connection-badge ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? '((·)) LIVE' : '○ OFFLINE'}
          </span>
          <div className="header-avatars">
            <div className="avatar-wrapper">
              <div className="avatar avatar-primary" title="Viewers" onClick={handleAvatarClick}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
                </svg>
              </div>
              {showViewers && <ViewersTooltip count={viewerCount} />}
            </div>
            <div className="avatar avatar-secondary" title="About" onClick={handleGearClick}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a6.97 6.97 0 0 0-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54a6.95 6.95 0 0 0-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.36 1.04.67 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54a6.95 6.95 0 0 0 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/>
              </svg>
            </div>
            <div className="header-menu-btn" title="Menu">
              <span/><span/><span/>
            </div>
          </div>
          {showInfo && <InfoModal connected={connected} onClose={() => setShowInfo(false)} />}
        </div>
      </header>

      <div className="content-wrapper">
        <FindSeatBanner recommendations={recommendations} />
        <CrowdingAlert areaData={areaData} />

        <div className="dashboard-layout">
          <LeftPanel areaData={areaData} />

          <div className="map-wrapper">
            <div className="map-label">
              <span className="map-label-title">CrowdMap · Floor Plan — Level 2</span>
              <span className="map-label-hint">Click a highlighted zone for details</span>
            </div>
            {/* map-canvas uses aspect-ratio to constrain width to map image */}
            <div className="map-canvas">
              <div className="compass">
                <svg viewBox="0 0 40 40" width="40" height="40">
                  <polygon points="20,4 24,20 20,17 16,20" fill="#a03020" />
                  <polygon points="20,36 24,20 20,23 16,20" fill="#c8b89a" />
                  <circle cx="20" cy="20" r="3" fill="#3a2810" />
                </svg>
                <div className="compass-n">N</div>
              </div>
              <MapContainer
                crs={L.CRS.Simple}
                bounds={MAP_BOUNDS}
                maxBounds={MAP_MAX_BOUNDS}
                maxBoundsViscosity={0.85}
                style={{ background: MAP_BG }}
                zoomSnap={0.25}
                minZoom={-2}
                maxZoom={2}
                attributionControl={false}
              >
                <FitBounds />
                <ImageOverlay url="/assets/floor_map.png" bounds={MAP_BOUNDS} />
                {AREAS.map(area => {
                  const centroid = polygonCentroid(area.polygon);
                  const labelIcon = L.divIcon({
                    className: 'zone-map-label-wrapper',
                    html: `<span class="zone-map-label">${area.name}</span>`,
                    iconSize: [220, 30],
                    iconAnchor: [110, 15],
                  });
                  return (
                    <Marker key={`label-${area.id}`} position={centroid} icon={labelIcon} interactive={false} zIndexOffset={1000} />
                  );
                })}
                {AREAS.map(area => {
                  const info  = areaData[area.id] || {};
                  const count = info.count ?? 0;
                  const level = info.level || 'low';
                  const color = getColorFromLevel(level);
                  return (
                    <Polygon
                      key={area.id}
                      positions={area.polygon}
                      pathOptions={{ color, fillColor: color, fillOpacity: 0.55, weight: level === 'high' ? 3 : 2, className: level === 'high' ? 'zone-high-pulse' : '' }}
                      eventHandlers={{
                        mouseover: e => e.target.setStyle({ fillOpacity: 0.72 }),
                        mouseout:  e => e.target.setStyle({ fillOpacity: 0.55 }),
                      }}
                    >
                      <Popup autoPan={false}
                        offset={['area_225_2f_2','area_225_2f_3'].includes(area.id) ? [0, 220] : [0, 0]}
                        className={['area_225_2f_2','area_225_2f_3'].includes(area.id) ? 'popup-below' : ''}
                      >
                        <div className="popup-content">
                          <div className="popup-short">{area.shortName}</div>
                          <h3>{area.name}</h3>
                          <div className="popup-count" style={{ color }}>
                            {count}
                            {info.capacity && <span className="popup-capacity"> / {info.capacity}</span>}
                          </div>
                          <div className="popup-count-sub">{count === 1 ? 'person' : 'people'} detected</div>
                          <div className="popup-label" style={{ background: color }}>{capitalizeLevel(level)}</div>
                          <div className="popup-time">{new Date((info.timestamp ?? 0) * 1000).toLocaleTimeString()}</div>
                        </div>
                      </Popup>
                    </Polygon>
                  );
                })}
              </MapContainer>
            </div>
          </div>

          <RightPanel areaData={areaData} connected={connected} historyData={historyData} />
        </div>
      </div>
    </div>
  );
}

export default App;
