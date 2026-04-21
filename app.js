// ── Firebase ──
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCrNdm3Lz5ZjKjpiwJM1XDIbomZBp1C-WU',
  authDomain: 'hare-family-apps.firebaseapp.com',
  projectId: 'hare-family-apps',
  appId: '1:1023984004573:web:a93fcf54eeb313b6b49a34',
  storageBucket: 'hare-family-apps.firebasestorage.app',
  messagingSenderId: '1023984004573'
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
const stateRef = doc(db, 'trackTimer', 'state');

setPersistence(auth, browserLocalPersistence).catch(() => {});

// ── Event Configuration ──
const EVENT_CONFIG = {
  '1600m':          { laps: 4, relay: false },
  '800m':           { laps: 2, relay: false },
  '400m':           { laps: 1, relay: false },
  '300m Hurdles':   { laps: 1, relay: false },
  '100m Hurdles':   { laps: 1, relay: false },
  '4x800m Relay':   { legs: 4, relay: true },
  '4x400m Relay':   { legs: 4, relay: true },
  '4x200m Relay':   { legs: 4, relay: true },
};

function getEventConfig(eventName) {
  return EVENT_CONFIG[eventName] || { laps: null, relay: false };
}

function getExpectedSplits(eventName) {
  const cfg = getEventConfig(eventName);
  if (cfg.relay) return cfg.legs || null;
  return cfg.laps || null;
}

const PACING_PROFILES = {
  '1600m':         [0.2475, 0.2500, 0.2550, 0.2475],
  '800m':          [0.4925, 0.5075],
  '400m':          [1.0000],
  '300m Hurdles':  [1.0000],
  '100m Hurdles':  [1.0000],
  '4x800m Relay':  [0.25, 0.25, 0.25, 0.25],
  '4x400m Relay':  [0.25, 0.25, 0.25, 0.25],
  '4x200m Relay':  [0.25, 0.25, 0.25, 0.25],
};

function getPacingProfile(eventName) {
  return PACING_PROFILES[eventName] || null;
}

function parseTargetTime(str) {
  if (!str) return null;
  str = String(str).trim();
  if (!str) return null;
  let totalSec;
  if (str.includes(':')) {
    const parts = str.split(':');
    if (parts.length !== 2) return null;
    const min = parseInt(parts[0], 10);
    const sec = parseFloat(parts[1]);
    if (!isFinite(min) || !isFinite(sec) || min < 0 || sec < 0 || sec >= 60) return null;
    totalSec = min * 60 + sec;
  } else {
    totalSec = parseFloat(str);
    if (!isFinite(totalSec)) return null;
  }
  if (totalSec <= 0) return null;
  return Math.round(totalSec * 1000);
}

function getTargetSplits(event, totalMs) {
  const profile = getPacingProfile(event);
  if (!profile || !totalMs) return null;
  const splits = profile.map(pct => Math.round(totalMs * pct));
  const sum = splits.reduce((a, b) => a + b, 0);
  splits[splits.length - 1] += (totalMs - sum);
  let cumulative = 0;
  return splits.map(s => {
    cumulative += s;
    return { splitMs: s, elapsedMs: cumulative };
  });
}

function formatDelta(ms) {
  const absSec = Math.abs(ms) / 1000;
  const sign = ms >= 0 ? '+' : '-';
  return sign + absSec.toFixed(2);
}

// ── Data Layer (Firestore) ──
const DEFAULT_DATA = {
  runners: ['Hanner', 'Billie'],
  events: ['1600m', '800m', '400m', '300m Hurdles', '100m Hurdles', '4x800m Relay', '4x400m Relay', '4x200m Relay'],
  races: []
};

const MEET_KEY = 'trackTimerMeet';
const TARGETS_KEY = 'trackTimerTargets';
const PENDING_RACES_KEY = 'trackTimerPendingRaces';

let data = { ...DEFAULT_DATA, races: [] };
let currentUser = null;
let dataUnsub = null;
let initialSyncDone = false;

function updateConnectionStatus(connected) {
  const dot = document.getElementById('connStatus');
  if (dot) {
    dot.className = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
    dot.title = connected ? 'Synced' : 'Offline — changes will sync when online';
  }
}

function subscribeToData() {
  unsubscribeFromData();
  dataUnsub = onSnapshot(
    stateRef,
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        data = {
          runners: Array.isArray(d.runners) ? d.runners : DEFAULT_DATA.runners,
          events: Array.isArray(d.events) ? d.events : DEFAULT_DATA.events,
          races: Array.isArray(d.races) ? d.races : []
        };
      } else {
        data = { ...DEFAULT_DATA, races: [] };
      }
      updateConnectionStatus(!snap.metadata.fromCache);

      populateSelects();
      loadTargetForCurrentEvent();
      if (timerState === 'idle') renderLaps();
      updateProgress();

      const historyActive = document.getElementById('historyView').classList.contains('active');
      const settingsActive = document.getElementById('settingsView').classList.contains('active');
      if (historyActive) renderHistory();
      if (settingsActive) renderSettings();

      if (!initialSyncDone && !snap.metadata.fromCache) {
        initialSyncDone = true;
        flushPendingRaces();
      }
    },
    (err) => {
      console.error('Firestore listener error:', err);
      if (err && err.code === 'permission-denied') {
        showAuthError('Your account is not authorized for Track Timer. Ask Wake to add your Gmail.');
        signOut(auth).catch(() => {});
      } else {
        updateConnectionStatus(false);
      }
    }
  );
}

function unsubscribeFromData() {
  if (dataUnsub) { dataUnsub(); dataUnsub = null; }
}

function getPendingRaces() {
  try {
    const raw = localStorage.getItem(PENDING_RACES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function setPendingRaces(races) {
  if (races && races.length > 0) {
    localStorage.setItem(PENDING_RACES_KEY, JSON.stringify(races));
  } else {
    localStorage.removeItem(PENDING_RACES_KEY);
  }
}

async function flushPendingRaces() {
  const pending = getPendingRaces();
  if (pending.length === 0) return;
  try {
    await mergeRaces(pending);
    setPendingRaces([]);
    console.log(`Flushed ${pending.length} pending races to Firestore`);
  } catch (e) {
    console.warn('Could not flush pending races yet:', e);
  }
}

async function mergeRaces(newRaces) {
  if (!currentUser) throw new Error('not signed in');
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(stateRef);
    const current = snap.exists() ? snap.data() : DEFAULT_DATA;
    const existingIds = new Set((current.races || []).map(r => r.id));
    const toAdd = (newRaces || []).filter(r => !existingIds.has(r.id));
    if (toAdd.length === 0) return;
    const merged = {
      runners: current.runners || DEFAULT_DATA.runners,
      events: current.events || DEFAULT_DATA.events,
      races: [...toAdd, ...(current.races || [])].sort((a, b) => new Date(b.date) - new Date(a.date)),
      updatedAt: serverTimestamp()
    };
    tx.set(stateRef, merged);
  });
}

async function saveData(newData) {
  if (!currentUser) return;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stateRef);
      const current = snap.exists() ? snap.data() : DEFAULT_DATA;
      const existingIds = new Set((current.races || []).map(r => r.id));
      const newOnly = (newData.races || []).filter(r => !existingIds.has(r.id));
      tx.set(stateRef, {
        runners: Array.isArray(newData.runners) ? newData.runners : (current.runners || DEFAULT_DATA.runners),
        events: Array.isArray(newData.events) ? newData.events : (current.events || DEFAULT_DATA.events),
        races: [...newOnly, ...(current.races || [])].sort((a, b) => new Date(b.date) - new Date(a.date)),
        updatedAt: serverTimestamp()
      });
    });
    updateConnectionStatus(true);
  } catch (e) {
    console.error('Save failed:', e);
    updateConnectionStatus(false);
  }
}

function queueRaceForSync(race) {
  const pending = getPendingRaces();
  pending.push(race);
  setPendingRaces(pending);
}

// ── PR Detection ──
function getPR(runner, event, excludeId) {
  const matching = data.races.filter(r =>
    r.runner === runner && r.event === event && r.id !== excludeId
  );
  if (matching.length === 0) return null;
  return Math.min(...matching.map(r => r.totalMs));
}

function isPR(race) {
  const previousBest = getPR(race.runner, race.event, race.id);
  if (previousBest === null) return true;
  return race.totalMs < previousBest;
}

function getPRDiff(race) {
  const previousBest = getPR(race.runner, race.event, race.id);
  if (previousBest === null) return null;
  const diff = race.totalMs - previousBest;
  if (diff < 0) {
    return { improved: true, text: '-' + formatTime(Math.abs(diff)) };
  } else {
    return { improved: false, text: '+' + formatTime(diff) };
  }
}

function showPRToast() {
  const toast = document.getElementById('prToast');
  toast.classList.add('show');
  if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
  setTimeout(() => { toast.classList.remove('show'); }, 2000);
}

// ── Timer State ──
let timerState = 'idle';
let startTime = 0;
let elapsed = 0;
let laps = [];
let lastLapTime = 0;
let rafId = null;
let lastTapTime = 0;
let targetMs = null;

// ── DOM Refs ──
const timerDisplay = document.getElementById('timerDisplay');
const mainBtn = document.getElementById('mainBtn');
const auxBtns = document.getElementById('auxBtns');
const lapList = document.getElementById('lapList');
const runnerSelect = document.getElementById('runnerSelect');
const eventSelect = document.getElementById('eventSelect');
const legRow = document.getElementById('legRow');
const legSelect = document.getElementById('legSelect');
const progressIndicator = document.getElementById('progressIndicator');
const meetInput = document.getElementById('meetInput');
const targetInput = document.getElementById('targetInput');

// ── Meet Name Persistence ──
meetInput.value = localStorage.getItem(MEET_KEY) || '';
meetInput.addEventListener('input', () => {
  localStorage.setItem(MEET_KEY, meetInput.value);
});

function getStoredTargets() {
  try {
    return JSON.parse(localStorage.getItem(TARGETS_KEY) || '{}');
  } catch { return {}; }
}

function setStoredTarget(event, value) {
  const all = getStoredTargets();
  if (value && parseTargetTime(value) !== null) {
    all[event] = value;
  } else {
    delete all[event];
  }
  localStorage.setItem(TARGETS_KEY, JSON.stringify(all));
}

function loadTargetForCurrentEvent() {
  const all = getStoredTargets();
  const val = all[eventSelect.value] || '';
  targetInput.value = val;
  targetMs = parseTargetTime(val);
}

targetInput.addEventListener('input', () => {
  targetMs = parseTargetTime(targetInput.value);
  setStoredTarget(eventSelect.value, targetInput.value);
  if (timerState === 'idle') {
    renderLaps();
  }
});

function formatTime(ms) {
  const totalSec = ms / 1000;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const sec = Math.floor(seconds);
  const hundredths = Math.floor((seconds - sec) * 100);
  return `${minutes}:${sec.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
}

function tick() {
  elapsed = performance.now() - startTime;
  timerDisplay.textContent = formatTime(elapsed);
  rafId = requestAnimationFrame(tick);
}

function getSplitLabel(index) {
  const cfg = getEventConfig(eventSelect.value);
  if (cfg.relay) return `Leg ${index + 1}`;
  return `Lap ${index + 1}`;
}

function renderLaps() {
  const cfg = getEventConfig(eventSelect.value);
  const runnerLeg = cfg.relay ? parseInt(legSelect.value) : null;
  const targets = getTargetSplits(eventSelect.value, targetMs);

  const actualRows = laps.map((lap, i) => {
    const label = getSplitLabel(i);
    const isRunnerLeg = runnerLeg && (i + 1) === runnerLeg;
    const labelClass = isRunnerLeg ? 'lap-label runner-leg' : 'lap-label';

    let deltaHtml = '<span class="lap-delta"></span>';
    if (targets && targets[i]) {
      const delta = lap.splitMs - targets[i].splitMs;
      const cls = Math.abs(delta) < 200 ? 'neutral' : (delta < 0 ? 'ahead' : 'behind');
      deltaHtml = `<span class="lap-delta ${cls}">${formatDelta(delta)}</span>`;
    }

    return `
      <div class="lap-item">
        <span class="${labelClass}">${label}</span>
        <span class="lap-split">${formatTime(lap.splitMs)}</span>
        ${deltaHtml}
        <span class="lap-elapsed">${formatTime(lap.elapsedMs)}</span>
      </div>
    `;
  }).reverse();

  const targetRows = [];
  if (targets && timerState !== 'stopped') {
    for (let i = laps.length; i < targets.length; i++) {
      const t = targets[i];
      const label = getSplitLabel(i);
      targetRows.push(`
      <div class="lap-item lap-target">
        <span class="lap-label">${label}</span>
        <span class="lap-split">${formatTime(t.splitMs)}</span>
        <span class="lap-delta tag">target</span>
        <span class="lap-elapsed">${formatTime(t.elapsedMs)}</span>
      </div>
    `);
    }
  }

  lapList.innerHTML = [...actualRows, ...targetRows].join('');
}

function updateProgress() {
  const expected = getExpectedSplits(eventSelect.value);
  const cfg = getEventConfig(eventSelect.value);
  const unit = cfg.relay ? 'Leg' : 'Lap';

  if (timerState === 'idle') {
    if (expected) {
      progressIndicator.textContent = `${expected} ${unit.toLowerCase()}s`;
    } else {
      progressIndicator.textContent = '';
    }
    return;
  }

  if (timerState === 'running') {
    if (expected) {
      progressIndicator.textContent = `${unit} ${laps.length} of ${expected}`;
    } else {
      progressIndicator.textContent = laps.length > 0 ? `${laps.length} splits` : '';
    }
    return;
  }

  if (timerState === 'stopped') {
    if (expected) {
      progressIndicator.textContent = `${expected} ${unit.toLowerCase()}s complete`;
    } else {
      progressIndicator.textContent = `${laps.length} splits`;
    }
  }
}

function updateMainButton() {
  const cfg = getEventConfig(eventSelect.value);
  const expected = getExpectedSplits(eventSelect.value);
  const unit = cfg.relay ? 'LEG' : 'LAP';

  mainBtn.classList.remove('state-start', 'state-lap', 'state-finish', 'state-save', 'state-split');

  if (timerState === 'idle') {
    mainBtn.textContent = 'START';
    mainBtn.classList.add('state-start');
  } else if (timerState === 'running') {
    if (expected === null) {
      mainBtn.textContent = 'SPLIT';
      mainBtn.classList.add('state-split');
    } else {
      const nextSplit = laps.length + 1;
      if (nextSplit >= expected) {
        mainBtn.textContent = 'FINISH';
        mainBtn.classList.add('state-finish');
      } else {
        mainBtn.textContent = `${unit} ${nextSplit}`;
        mainBtn.classList.add('state-lap');
      }
    }
  } else if (timerState === 'stopped') {
    mainBtn.textContent = 'SAVE';
    mainBtn.classList.add('state-save');
  }
}

function updateAuxButtons() {
  if (timerState === 'idle') {
    auxBtns.innerHTML = '';
  } else if (timerState === 'running') {
    auxBtns.innerHTML = `<button class="aux-btn aux-btn-stop" id="auxStop">Stop</button>`;
    document.getElementById('auxStop').addEventListener('click', doStop);
  } else if (timerState === 'stopped') {
    auxBtns.innerHTML = `
      <button class="aux-btn aux-btn-share" id="auxShare">Share</button>
      <button class="aux-btn aux-btn-reset" id="auxReset">Reset</button>
    `;
    document.getElementById('auxShare').addEventListener('click', () => {
      shareResult(runnerSelect.value, eventSelect.value, elapsed, laps);
    });
    document.getElementById('auxReset').addEventListener('click', doReset);
  }
}

function hapticTap() {
  if (navigator.vibrate) navigator.vibrate(40);
}

function doMainButton() {
  const now = Date.now();
  if (now - lastTapTime < 400) return;
  lastTapTime = now;

  if (timerState === 'idle') {
    hapticTap();
    doStart();
  } else if (timerState === 'running') {
    hapticTap();
    doLap();
    const expected = getExpectedSplits(eventSelect.value);
    if (expected !== null && laps.length >= expected) {
      doStop();
    } else {
      mainBtn.style.opacity = '0.6';
      setTimeout(() => { mainBtn.style.opacity = '1'; }, 100);
      updateMainButton();
      updateProgress();
    }
  } else if (timerState === 'stopped') {
    doSave();
  }
}

mainBtn.addEventListener('click', doMainButton);

function doStart() {
  timerState = 'running';
  startTime = performance.now();
  elapsed = 0;
  laps = [];
  lastLapTime = 0;
  renderLaps();
  timerDisplay.classList.add('running');
  timerDisplay.classList.remove('stopped');
  tick();

  runnerSelect.disabled = true;
  eventSelect.disabled = true;
  legSelect.disabled = true;
  meetInput.disabled = true;
  targetInput.disabled = true;

  updateMainButton();
  updateAuxButtons();
  updateProgress();
  requestWakeLock();
}

function doLap() {
  if (timerState !== 'running') return;
  const now = performance.now() - startTime;
  const split = now - lastLapTime;
  laps.push({ splitMs: split, elapsedMs: now });
  lastLapTime = now;
  renderLaps();
}

function doStop() {
  if (timerState !== 'running') return;
  timerState = 'stopped';
  cancelAnimationFrame(rafId);
  elapsed = performance.now() - startTime;
  timerDisplay.textContent = formatTime(elapsed);
  timerDisplay.classList.remove('running');
  timerDisplay.classList.add('stopped');

  if (laps.length > 0) {
    const lastElapsed = laps[laps.length - 1].elapsedMs;
    if (elapsed - lastElapsed > 50) {
      laps.push({ splitMs: elapsed - lastElapsed, elapsedMs: elapsed });
    }
  } else {
    laps.push({ splitMs: elapsed, elapsedMs: elapsed });
  }
  renderLaps();

  updateMainButton();
  updateAuxButtons();
  updateProgress();
  releaseWakeLock();
}

async function doSave() {
  const cfg = getEventConfig(eventSelect.value);
  const meetName = meetInput.value.trim() || null;

  const race = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    runner: runnerSelect.value,
    event: eventSelect.value,
    date: new Date().toISOString(),
    totalMs: elapsed,
    relayLeg: cfg.relay ? parseInt(legSelect.value) : null,
    meet: meetName,
    laps: laps.map(l => ({ splitMs: Math.round(l.splitMs), elapsedMs: Math.round(l.elapsedMs) }))
  };

  const isNewPR = isPR(race);

  queueRaceForSync(race);
  data.races.unshift(race);

  try {
    await mergeRaces([race]);
    const pending = getPendingRaces().filter(r => r.id !== race.id);
    setPendingRaces(pending);
  } catch (e) {
    console.warn('Race queued locally, will sync when online:', e);
  }

  if (isNewPR) {
    showPRToast();
  }

  doReset();
}

function doReset() {
  timerState = 'idle';
  elapsed = 0;
  laps = [];
  lastLapTime = 0;
  timerDisplay.textContent = '0:00.00';
  timerDisplay.classList.remove('running', 'stopped');
  runnerSelect.disabled = false;
  eventSelect.disabled = false;
  legSelect.disabled = false;
  meetInput.disabled = false;
  targetInput.disabled = false;

  updateMainButton();
  updateAuxButtons();
  updateProgress();
  renderLaps();
}

function updateLegSelector() {
  const cfg = getEventConfig(eventSelect.value);
  if (cfg.relay) {
    const legs = cfg.legs || 4;
    legSelect.innerHTML = Array.from({ length: legs }, (_, i) =>
      `<option value="${i + 1}">Leg ${i + 1}</option>`
    ).join('');
    legRow.style.display = 'flex';
  } else {
    legRow.style.display = 'none';
  }
  updateProgress();
}

eventSelect.addEventListener('change', () => {
  updateLegSelector();
  loadTargetForCurrentEvent();
  if (timerState === 'idle') renderLaps();
});

function populateSelects() {
  const prevRunner = runnerSelect.value;
  const prevEvent = eventSelect.value;
  runnerSelect.innerHTML = data.runners.map(r => `<option value="${r}">${r}</option>`).join('');
  eventSelect.innerHTML = data.events.map(e => `<option value="${e}">${e}</option>`).join('');
  if (prevRunner && data.runners.includes(prevRunner)) runnerSelect.value = prevRunner;
  if (prevEvent && data.events.includes(prevEvent)) eventSelect.value = prevEvent;
  updateLegSelector();
}

const tabs = document.querySelectorAll('.tab-bar button');
const views = document.querySelectorAll('.view');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'View').classList.add('active');

    if (tab.dataset.tab === 'history') renderHistory();
    if (tab.dataset.tab === 'settings') renderSettings();
  });
});

const filterRunner = document.getElementById('filterRunner');
const filterEvent = document.getElementById('filterEvent');
const filterMeet = document.getElementById('filterMeet');
const raceList = document.getElementById('raceList');

function populateFilters() {
  const prevR = filterRunner.value;
  const prevE = filterEvent.value;
  const prevM = filterMeet.value;

  filterRunner.innerHTML = '<option value="all">All Runners</option>' +
    data.runners.map(r => `<option value="${r}">${r}</option>`).join('');
  filterEvent.innerHTML = '<option value="all">All Events</option>' +
    data.events.map(e => `<option value="${e}">${e}</option>`).join('');

  const meets = [...new Set(data.races.map(r => r.meet).filter(Boolean))];
  filterMeet.innerHTML = '<option value="all">All Meets</option>' +
    meets.map(m => `<option value="${m}">${m}</option>`).join('');

  if (prevR) filterRunner.value = prevR;
  if (prevE) filterEvent.value = prevE;
  if (prevM) filterMeet.value = prevM;
}

function renderHistory() {
  populateFilters();
  const fr = filterRunner.value;
  const fe = filterEvent.value;
  const fm = filterMeet.value;

  let races = data.races;
  if (fr !== 'all') races = races.filter(r => r.runner === fr);
  if (fe !== 'all') races = races.filter(r => r.event === fe);
  if (fm !== 'all') races = races.filter(r => r.meet === fm);

  if (races.length === 0) {
    raceList.innerHTML = '<div class="empty-state">No races recorded yet.<br>Start timing!</div>';
    return;
  }

  const groups = [];
  let currentGroup = null;

  for (const race of races) {
    const meetKey = race.meet || null;
    const dateKey = new Date(race.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const groupKey = meetKey || dateKey;

    if (!currentGroup || currentGroup.key !== groupKey) {
      currentGroup = { key: groupKey, meet: meetKey, date: dateKey, races: [] };
      groups.push(currentGroup);
    }
    currentGroup.races.push(race);
  }

  let html = '';
  for (const group of groups) {
    if (group.meet) {
      html += `<div class="meet-header">${group.meet}<span class="meet-date">${group.date}</span></div>`;
    } else {
      html += `<div class="meet-header">${group.date}</div>`;
    }

    for (const race of group.races) {
      html += renderRaceCard(race);
    }
  }

  raceList.innerHTML = html;

  raceList.querySelectorAll('.share-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const race = data.races.find(r => r.id === btn.dataset.id);
      if (race) shareResult(race.runner, race.event, race.totalMs, race.laps);
    });
  });

  raceList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this race?')) return;
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(stateRef);
          const current = snap.exists() ? snap.data() : DEFAULT_DATA;
          tx.set(stateRef, {
            runners: current.runners || DEFAULT_DATA.runners,
            events: current.events || DEFAULT_DATA.events,
            races: (current.races || []).filter(r => r.id !== btn.dataset.id),
            updatedAt: serverTimestamp()
          });
        });
      } catch (e) {
        alert('Delete failed: ' + (e.message || e));
      }
    });
  });
}

function renderRaceCard(race) {
  const d = new Date(race.date);
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const runnerClass = race.runner.toLowerCase();
  const cfg = getEventConfig(race.event);

  const prFlag = isPR(race);
  const prDiff = getPRDiff(race);
  const prBadgeHtml = prFlag ? '<span class="pr-badge">PR</span>' : '';
  const prDiffHtml = prDiff
    ? `<span class="pr-diff ${prDiff.improved ? 'improved' : ''}">${prDiff.text}</span>`
    : '';
  const prCardClass = prFlag ? 'race-card is-pr' : 'race-card';

  const relayLegHtml = race.relayLeg
    ? `<div class="relay-leg-label">${race.runner} ran Leg ${race.relayLeg}</div>`
    : '';

  const splitsHtml = race.laps.length > 0
    ? `<div class="splits">${race.laps.map((l, i) => {
        const label = cfg.relay ? `Leg ${i + 1}` : `L${i + 1}`;
        const isRunnerLeg = race.relayLeg && (i + 1) === race.relayLeg;
        const chipClass = isRunnerLeg ? 'split-chip runner-leg' : 'split-chip';
        return `<span class="${chipClass}">${label}: ${formatTime(l.splitMs)}</span>`;
      }).join('')}</div>`
    : '';

  return `
    <div class="${prCardClass}">
      <div class="race-card-header">
        <span class="runner-name ${runnerClass}">${race.runner}${prBadgeHtml}</span>
        <span>
          <span class="race-date">${timeStr}</span>
          <button class="share-btn" data-id="${race.id}" title="Share">&#9993;</button>
          <button class="delete-btn" data-id="${race.id}" title="Delete">&times;</button>
        </span>
      </div>
      <div class="event-name">${race.event}</div>
      ${relayLegHtml}
      <div class="total-time">${formatTime(race.totalMs)}${prDiffHtml}</div>
      ${splitsHtml}
    </div>
  `;
}

filterRunner.addEventListener('change', renderHistory);
filterEvent.addEventListener('change', renderHistory);
filterMeet.addEventListener('change', renderHistory);

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

  runnerListEdit.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (data.runners.length <= 1) return alert('Need at least one runner.');
      const next = { ...data, runners: data.runners.filter(r => r !== btn.dataset.runner) };
      await saveData(next);
    });
  });

  eventListEdit.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (data.events.length <= 1) return alert('Need at least one event.');
      const next = { ...data, events: data.events.filter(e => e !== btn.dataset.event) };
      await saveData(next);
    });
  });

  updateAccountStatus();
}

function updateAccountStatus() {
  const el = document.getElementById('recoveryStatus');
  if (!el) return;
  const pending = getPendingRaces().length;
  const raceCount = data.races.length;
  const email = currentUser ? currentUser.email : '(signed out)';
  el.innerHTML = `
    <div class="recovery-info">
      Signed in as <b>${email}</b><br>
      ${raceCount} race${raceCount === 1 ? '' : 's'} synced${pending > 0 ? `, ${pending} pending` : ''}.
    </div>
    <button class="export-btn" id="signOutBtn" style="background:#3a1a1a;color:#e94560;margin-top:6px;">Sign out</button>
  `;
  const btn = document.getElementById('signOutBtn');
  if (btn) btn.addEventListener('click', doSignOut);
}

document.getElementById('addRunnerBtn').addEventListener('click', async () => {
  const input = document.getElementById('newRunnerInput');
  const name = input.value.trim();
  if (!name) return;
  if (data.runners.includes(name)) return alert('Runner already exists.');
  const next = { ...data, runners: [...data.runners, name] };
  input.value = '';
  await saveData(next);
});

document.getElementById('addEventBtn').addEventListener('click', async () => {
  const input = document.getElementById('newEventInput');
  const name = input.value.trim();
  if (!name) return;
  if (data.events.includes(name)) return alert('Event already exists.');
  const next = { ...data, events: [...data.events, name] };
  input.value = '';
  await saveData(next);
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `track-timer-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

function buildShareText(runner, event, totalMs, lapsArr) {
  let text = `${runner} - ${event}\nTime: ${formatTime(totalMs)}`;
  if (lapsArr && lapsArr.length > 0) {
    const cfg = getEventConfig(event);
    const splits = lapsArr.map((l, i) => {
      const label = cfg.relay ? `Leg ${i + 1}` : `L${i + 1}`;
      return `${label} ${formatTime(l.splitMs)}`;
    }).join(' | ');
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && timerState === 'running') {
    requestWakeLock();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Auth UI ──
const authGate = document.getElementById('authGate');
const appShell = document.querySelector('.app');
const signInBtn = document.getElementById('signInBtn');
const authErrorEl = document.getElementById('authError');

function showAuthError(msg) {
  if (authErrorEl) authErrorEl.textContent = msg || '';
}

function setAuthVisible(user) {
  if (user) {
    authGate.style.display = 'none';
    appShell.style.display = 'flex';
  } else {
    authGate.style.display = 'flex';
    appShell.style.display = 'none';
  }
}

async function doSignIn() {
  showAuthError('');
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
      try { await signInWithRedirect(auth, provider); } catch (e2) { showAuthError(e2.message || 'Sign-in failed'); }
      return;
    }
    showAuthError(e.message || 'Sign-in failed');
  }
}

async function doSignOut() {
  try { await signOut(auth); } catch {}
}

if (signInBtn) signInBtn.addEventListener('click', doSignIn);

getRedirectResult(auth).catch((e) => showAuthError(e.message || ''));

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  setAuthVisible(user);
  if (user) {
    initialSyncDone = false;
    subscribeToData();
    flushPendingRaces();
  } else {
    unsubscribeFromData();
    data = { ...DEFAULT_DATA, races: [] };
    populateSelects();
  }
});

// Initial paint before auth resolves: defaults are fine
populateSelects();
loadTargetForCurrentEvent();
updateProgress();
renderLaps();
