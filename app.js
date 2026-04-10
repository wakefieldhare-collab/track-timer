// ── Data Layer ──
const API_BASE = 'https://gtf-desktop.tail98708b.ts.net:3456';

const DEFAULT_DATA = {
  runners: ['Hanner', 'Billie'],
  events: ['1600m', '800m', '400m', '300m Hurdles', '100m Hurdles', '4x800m Relay', '4x400m Relay', '4x200m Relay'],
  races: []
};

const CACHE_KEY = 'trackTimerCache';
let serverConnected = false;
let dataLoadedFromServer = false;

// ── Connection Status ──
function updateConnectionStatus(connected) {
  serverConnected = connected;
  const dot = document.getElementById('connStatus');
  if (dot) {
    dot.className = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
    dot.title = connected ? 'Server connected' : 'Offline -- data saved locally only';
  }
}

async function checkConnection() {
  try {
    const res = await fetch(API_BASE + '/api/data', { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    updateConnectionStatus(res.ok);
  } catch {
    updateConnectionStatus(false);
  }
}

// Poll connection every 30s
setInterval(checkConnection, 30000);

async function loadData() {
  try {
    const res = await fetch(API_BASE + '/api/data', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const d = await res.json();
      updateConnectionStatus(true);
      dataLoadedFromServer = true;

      // Merge with local cache: keep whichever has more races, merge any unique ones
      const cached = getLocalCache();
      if (cached && cached.races && cached.races.length > 0) {
        const serverIds = new Set(d.races.map(r => r.id));
        const localOnly = cached.races.filter(r => !serverIds.has(r.id));
        if (localOnly.length > 0) {
          d.races = [...localOnly, ...d.races];
          d.races.sort((a, b) => new Date(b.date) - new Date(a.date));
          // Push merged data back to server
          fetch(API_BASE + '/api/data', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(d)
          }).catch(() => {});
        }
      }

      localStorage.setItem(CACHE_KEY, JSON.stringify(d));
      return d;
    }
  } catch (e) { /* server unreachable */ }

  updateConnectionStatus(false);

  // Fall back to cached data -- NEVER fall back to empty defaults
  const cached = getLocalCache();
  if (cached) {
    dataLoadedFromServer = false;
    return cached;
  }

  // Last resort: defaults, but flag that we have no real data
  dataLoadedFromServer = false;
  return { ...DEFAULT_DATA, races: [] };
}

function getLocalCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return null;
}

function saveData(d) {
  // Always save to localStorage immediately
  localStorage.setItem(CACHE_KEY, JSON.stringify(d));

  // Save to server
  fetch(API_BASE + '/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(d)
  }).then(res => {
    if (res.ok) {
      updateConnectionStatus(true);
      return res.json();
    }
    throw new Error('Server save failed');
  }).catch(() => {
    updateConnectionStatus(false);
  });
}

let data = { ...DEFAULT_DATA, races: [] };

// ── Timer State ──
let timerState = 'idle'; // idle | running | stopped
let startTime = 0;
let elapsed = 0;
let laps = []; // { splitMs, elapsedMs }
let lastLapTime = 0;
let rafId = null;

// ── DOM Refs ──
const timerDisplay = document.getElementById('timerDisplay');
const btnStart = document.getElementById('btnStart');
const btnLap = document.getElementById('btnLap');
const btnRow = document.getElementById('btnRow');
const lapList = document.getElementById('lapList');
const runnerSelect = document.getElementById('runnerSelect');
const eventSelect = document.getElementById('eventSelect');

// ── Format Time ──
function formatTime(ms) {
  const totalSec = ms / 1000;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const sec = Math.floor(seconds);
  const hundredths = Math.floor((seconds - sec) * 100);
  return `${minutes}:${sec.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
}

// ── Timer Loop ──
function tick() {
  elapsed = performance.now() - startTime;
  timerDisplay.textContent = formatTime(elapsed);
  rafId = requestAnimationFrame(tick);
}

// ── Render Laps ──
function renderLaps() {
  lapList.innerHTML = laps.map((lap, i) => `
    <div class="lap-item">
      <span class="lap-label">Lap ${i + 1}</span>
      <span class="lap-split">${formatTime(lap.splitMs)}</span>
      <span class="lap-elapsed">${formatTime(lap.elapsedMs)}</span>
    </div>
  `).reverse().join('');
}

// ── Button Actions ──
function doStart() {
  timerState = 'running';
  startTime = performance.now();
  elapsed = 0;
  laps = [];
  lastLapTime = 0;
  lapList.innerHTML = '';
  timerDisplay.classList.add('running');
  timerDisplay.classList.remove('stopped');
  tick();

  btnRow.innerHTML = `
    <button class="btn btn-stop" id="btnStop">Stop</button>
    <button class="btn btn-lap" id="btnLap2">Lap</button>
  `;
  document.getElementById('btnStop').addEventListener('click', doStop);
  document.getElementById('btnLap2').addEventListener('click', doLap);

  // Disable setup controls
  runnerSelect.disabled = true;
  eventSelect.disabled = true;
}

function doLap() {
  if (timerState !== 'running') return;
  const now = performance.now() - startTime;
  const split = now - lastLapTime;
  laps.push({ splitMs: split, elapsedMs: now });
  lastLapTime = now;
  renderLaps();
  // Quick flash feedback
  const lapBtn = document.getElementById('btnLap2');
  if (lapBtn) {
    lapBtn.style.background = '#4ecca3';
    setTimeout(() => { lapBtn.style.background = '#0f3460'; }, 120);
  }
}

function doStop() {
  if (timerState !== 'running') return;
  timerState = 'stopped';
  cancelAnimationFrame(rafId);
  elapsed = performance.now() - startTime;
  timerDisplay.textContent = formatTime(elapsed);
  timerDisplay.classList.remove('running');
  timerDisplay.classList.add('stopped');

  // Add final split if laps were taken and last lap != total
  if (laps.length > 0) {
    const lastElapsed = laps[laps.length - 1].elapsedMs;
    if (elapsed - lastElapsed > 50) {
      laps.push({ splitMs: elapsed - lastElapsed, elapsedMs: elapsed });
      renderLaps();
    }
  }

  btnRow.innerHTML = `
    <button class="btn btn-save" id="btnSave">Save</button>
    <button class="btn btn-share" id="btnShare">Share</button>
    <button class="btn btn-reset" id="btnReset">Reset</button>
  `;
  document.getElementById('btnSave').addEventListener('click', doSave);
  document.getElementById('btnShare').addEventListener('click', () => {
    shareResult(runnerSelect.value, eventSelect.value, elapsed, laps);
  });
  document.getElementById('btnReset').addEventListener('click', doReset);
}

function doSave() {
  const race = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    runner: runnerSelect.value,
    event: eventSelect.value,
    date: new Date().toISOString(),
    totalMs: elapsed,
    laps: laps.map(l => ({ splitMs: Math.round(l.splitMs), elapsedMs: Math.round(l.elapsedMs) }))
  };
  data.races.unshift(race);
  saveData(data);
  doReset();
}

function doReset() {
  timerState = 'idle';
  elapsed = 0;
  laps = [];
  lastLapTime = 0;
  lapList.innerHTML = '';
  timerDisplay.textContent = '0:00.00';
  timerDisplay.classList.remove('running', 'stopped');
  runnerSelect.disabled = false;
  eventSelect.disabled = false;

  btnRow.innerHTML = `
    <button class="btn btn-start" id="btnStart">Start</button>
    <button class="btn btn-lap" id="btnLap" disabled>Lap</button>
  `;
  document.getElementById('btnStart').addEventListener('click', doStart);
}

btnStart.addEventListener('click', doStart);

// ── Populate Selects ──
function populateSelects() {
  runnerSelect.innerHTML = data.runners.map(r => `<option value="${r}">${r}</option>`).join('');
  eventSelect.innerHTML = data.events.map(e => `<option value="${e}">${e}</option>`).join('');
}
// ── Init: load shared data from server ──
loadData().then(d => {
  data = d;
  populateSelects();
});

// ── Tab Navigation ──
const tabs = document.querySelectorAll('.tab-bar button');
const views = document.querySelectorAll('.view');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'View').classList.add('active');

    if (tab.dataset.tab === 'history') {
      loadData().then(d => { data = d; renderHistory(); });
    }
    if (tab.dataset.tab === 'settings') {
      loadData().then(d => { data = d; populateSelects(); renderSettings(); });
    }
  });
});

// ── History View ──
const filterRunner = document.getElementById('filterRunner');
const filterEvent = document.getElementById('filterEvent');
const raceList = document.getElementById('raceList');

function populateFilters() {
  filterRunner.innerHTML = '<option value="all">All Runners</option>' +
    data.runners.map(r => `<option value="${r}">${r}</option>`).join('');
  filterEvent.innerHTML = '<option value="all">All Events</option>' +
    data.events.map(e => `<option value="${e}">${e}</option>`).join('');
}

function renderHistory() {
  populateFilters();
  const fr = filterRunner.value;
  const fe = filterEvent.value;

  let races = data.races;
  if (fr !== 'all') races = races.filter(r => r.runner === fr);
  if (fe !== 'all') races = races.filter(r => r.event === fe);

  if (races.length === 0) {
    raceList.innerHTML = '<div class="empty-state">No races recorded yet.<br>Start timing!</div>';
    return;
  }

  raceList.innerHTML = races.map(race => {
    const d = new Date(race.date);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const runnerClass = race.runner.toLowerCase();
    const splitsHtml = race.laps.length > 0
      ? `<div class="splits">${race.laps.map((l, i) => `<span class="split-chip">L${i + 1}: ${formatTime(l.splitMs)}</span>`).join('')}</div>`
      : '';

    return `
      <div class="race-card">
        <div class="race-card-header">
          <span class="runner-name ${runnerClass}">${race.runner}</span>
          <span>
            <span class="race-date">${dateStr}</span>
            <button class="share-btn" data-id="${race.id}" title="Share">&#9993;</button>
            <button class="delete-btn" data-id="${race.id}" title="Delete">&times;</button>
          </span>
        </div>
        <div class="event-name">${race.event}</div>
        <div class="total-time">${formatTime(race.totalMs)}</div>
        ${splitsHtml}
      </div>
    `;
  }).join('');

  // Share handlers
  raceList.querySelectorAll('.share-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const race = data.races.find(r => r.id === btn.dataset.id);
      if (race) shareResult(race.runner, race.event, race.totalMs, race.laps);
    });
  });

  // Delete handlers
  raceList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this race?')) {
        data.races = data.races.filter(r => r.id !== btn.dataset.id);
        saveData(data);
        renderHistory();
      }
    });
  });
}

filterRunner.addEventListener('change', renderHistory);
filterEvent.addEventListener('change', renderHistory);

// ── Settings View ──
function renderSettings() {
  const runnerListEdit = document.getElementById('runnerListEdit');
  const eventListEdit = document.getElementById('eventListEdit');

  runnerListEdit.innerHTML = data.runners.map(r => `
    <div class="editable-item">
      <span>${r}</span>
      <button data-runner="${r}">&times;</button>
    </div>
  `).join('');

  eventListEdit.innerHTML = data.events.map(e => `
    <div class="editable-item">
      <span>${e}</span>
      <button data-event="${e}">&times;</button>
    </div>
  `).join('');

  // Delete runner
  runnerListEdit.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (data.runners.length <= 1) return alert('Need at least one runner.');
      data.runners = data.runners.filter(r => r !== btn.dataset.runner);
      saveData(data);
      populateSelects();
      renderSettings();
    });
  });

  // Delete event
  eventListEdit.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (data.events.length <= 1) return alert('Need at least one event.');
      data.events = data.events.filter(e => e !== btn.dataset.event);
      saveData(data);
      populateSelects();
      renderSettings();
    });
  });

  // Recovery status
  updateRecoveryStatus();
}

// ── Recovery ──
function updateRecoveryStatus() {
  const el = document.getElementById('recoveryStatus');
  if (!el) return;
  const cached = getLocalCache();
  const localRaces = cached ? (cached.races || []).length : 0;
  const serverRaces = data.races.length;

  if (localRaces > 0 && localRaces > serverRaces) {
    el.innerHTML = `<div class="recovery-alert">Found ${localRaces} races in local cache (server has ${serverRaces}). <button id="recoverLocalBtn" class="recover-btn">Recover Local Data</button></div>`;
    document.getElementById('recoverLocalBtn').addEventListener('click', recoverFromLocal);
  } else {
    el.innerHTML = `<div class="recovery-info">${serverRaces} races on server, ${localRaces} in local cache.</div>`;
  }
}

async function recoverFromLocal() {
  const cached = getLocalCache();
  if (!cached || !cached.races || cached.races.length === 0) {
    alert('No local data to recover.');
    return;
  }
  try {
    const res = await fetch(API_BASE + '/api/recover', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ races: cached.races })
    });
    if (res.ok) {
      const result = await res.json();
      alert(`Recovered ${result.recovered} races! Total: ${result.raceCount}`);
      loadData().then(d => { data = d; renderSettings(); });
    } else {
      alert('Recovery failed. Server may be unreachable.');
    }
  } catch {
    alert('Could not reach server for recovery.');
  }
}

// Add runner
document.getElementById('addRunnerBtn').addEventListener('click', () => {
  const input = document.getElementById('newRunnerInput');
  const name = input.value.trim();
  if (!name) return;
  if (data.runners.includes(name)) return alert('Runner already exists.');
  data.runners.push(name);
  saveData(data);
  input.value = '';
  populateSelects();
  renderSettings();
});

// Add event
document.getElementById('addEventBtn').addEventListener('click', () => {
  const input = document.getElementById('newEventInput');
  const name = input.value.trim();
  if (!name) return;
  if (data.events.includes(name)) return alert('Event already exists.');
  data.events.push(name);
  saveData(data);
  input.value = '';
  populateSelects();
  renderSettings();
});

// Export
document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `track-timer-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Share Logic ──
function buildShareText(runner, event, totalMs, lapsArr) {
  let text = `${runner} - ${event}\nTime: ${formatTime(totalMs)}`;
  if (lapsArr && lapsArr.length > 0) {
    const splits = lapsArr.map((l, i) => `L${i + 1} ${formatTime(l.splitMs)}`).join(' | ');
    text += `\nSplits: ${splits}`;
  }
  return text;
}

function shareResult(runner, event, totalMs, lapsArr) {
  const text = buildShareText(runner, event, totalMs, lapsArr);
  if (navigator.share) {
    navigator.share({ text }).catch(() => {});
  } else {
    window.location.href = 'sms:?body=' + encodeURIComponent(text);
  }
}

// ── Keep screen awake during timing ──
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* non-critical */ }
}
function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// Re-acquire wake lock if page becomes visible again
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && timerState === 'running') {
    requestWakeLock();
  }
});

// Wake lock via delegated click handler
(function patchWakeLock() {
  document.addEventListener('click', (e) => {
    if (e.target.id === 'btnStart' || e.target.textContent === 'Start') {
      requestWakeLock();
    }
    if (e.target.id === 'btnStop' || e.target.id === 'btnReset') {
      releaseWakeLock();
    }
  }, true);
})();

// ── Service Worker Registration ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
