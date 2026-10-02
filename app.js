// ExerShuffle v2.0
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, getDocs, query, orderBy, writeBatch, deleteField } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDurLInuh3evYBN1AjFwphV54XM-Lqa2-w",
  authDomain: "exercise-randomizer-58028.firebaseapp.com",
  projectId: "exercise-randomizer-58028",
  storageBucket: "exercise-randomizer-58028.firebasestorage.app",
  messagingSenderId: "571651956900",
  appId: "1:571651956900:web:6441b302b6ef8399634631"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

// ---------- STATE ----------
let currentUser = null;
let currentAreaId = null;
let currentAreaName = '';
let exercises = [];
let editingExerciseId = null;
let formLastDone = null;          // pending lastDone value in the form
let lastResults = null;           // current shuffle results
let shuffleShown = new Set();     // shown in this shuffle series (Shuffle Again prefers new ones)
let randomSeen = new Set();       // done/skipped in this Random session
let currentRandomExercise = null;
let returnToScreen = 'screen-manage';
let isRestoring = false;

// ---------- HELPERS ----------
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Fair Fisher-Yates shuffle
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dayStart(ts) {
  if (!ts) return -1;
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysAgo(ts) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - dayStart(ts)) / 86400000);
}

function isDoneToday(ex) {
  return !!ex.lastDone && daysAgo(ex.lastDone) === 0;
}

function lastDoneText(ts) {
  if (!ts) return 'Never done';
  const d = daysAgo(ts);
  if (d <= 0) return 'Done today';
  if (d === 1) return 'Last done: yesterday';
  return `Last done: ${d} days ago`;
}

function metaText(ex) {
  const stars = ex.stars ? '\u2605'.repeat(ex.stars) : '';
  const mins = ex.minutes ? ex.minutes + ' min' : '';
  return [stars, mins].filter(Boolean).join(' \u00b7 ');
}

// Rotation priority: never done first, then oldest day first. Same day = random order.
function prioritize(list) {
  return shuffleArray(list).sort((a, b) => dayStart(a.lastDone) - dayStart(b.lastDone));
}

function isAvailable(ex) {
  return ex.active !== false && !ex.excluded;
}

function exRef(id) {
  return doc(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises', id);
}

async function updateExercise(id, data) {
  try {
    await updateDoc(exRef(id), data);
  } catch (e) {
    showToast('Could not save \u2013 check your connection');
  }
}

// ---------- SCREEN NAVIGATION ----------
const show = (screenId) => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(screenId).classList.add('active');
  if (!isRestoring) saveAppState(screenId);
};

// ---------- TOAST ----------
let toastTimer = null;
let toastUndo = null;

function showToast(message, undoFn = null) {
  $('toast-msg').textContent = message;
  toastUndo = undoFn;
  $('toast-undo').style.display = undoFn ? 'block' : 'none';
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  $('toast').classList.remove('visible');
  toastUndo = null;
}

$('toast-undo').addEventListener('click', async () => {
  const fn = toastUndo;
  hideToast();
  if (fn) await fn();
});

// ---------- STATE PERSISTENCE ----------
function getStateKey() {
  return `exershuffle_state_${currentUser?.uid}`;
}

function saveAppState(screenId) {
  if (!currentUser) return;
  if (screenId === 'screen-exercise-form' || screenId === 'screen-login') return;
  try {
    const state = {
      areaId: currentAreaId,
      areaName: currentAreaName,
      screen: screenId,
      shuffleConfig: {
        mode: $('shuffle-mode').value,
        value: $('shuffle-value').value,
        starFilter: $('shuffle-star-filter').value,
        timeFilter: $('shuffle-time-filter').value,
      },
      shuffleResultIds: lastResults ? lastResults.map(e => e.id) : null,
      shuffleConfigVisible: $('shuffle-config').style.display !== 'none',
      randomCurrentId: currentRandomExercise ? currentRandomExercise.id : null,
      randomSeen: [...randomSeen],
    };
    localStorage.setItem(getStateKey(), JSON.stringify(state));
  } catch { /* ignore */ }
}

function saveCurrentState() {
  const active = document.querySelector('.screen.active');
  if (active) saveAppState(active.id);
}

async function restoreAppState() {
  if (!currentUser) return false;
  try {
    const stored = localStorage.getItem(getStateKey());
    if (!stored) return false;
    const state = JSON.parse(stored);
    if (!state.areaId || !state.screen || state.screen === 'screen-login') return false;

    currentAreaId = state.areaId;
    currentAreaName = state.areaName;
    await loadExercises();
    $('area-overview-title').textContent = currentAreaName;

    if (state.screen === 'screen-areas') {
      show('screen-areas');
      loadAreas();
      return true;
    }
    if (state.screen === 'screen-manage') {
      show('screen-manage');
      renderExerciseList();
      return true;
    }
    if (state.screen === 'screen-essentials') {
      show('screen-essentials');
      renderEssentials();
      return true;
    }
    if (state.screen === 'screen-shuffle') {
      if (state.shuffleConfig) {
        $('shuffle-mode').value = state.shuffleConfig.mode;
        $('shuffle-value').value = state.shuffleConfig.value;
        $('shuffle-star-filter').value = state.shuffleConfig.starFilter;
        $('shuffle-time-filter').value = state.shuffleConfig.timeFilter;
        updateShuffleModeUI();
      }
      if (state.shuffleResultIds && !state.shuffleConfigVisible) {
        lastResults = state.shuffleResultIds
          .map(id => exercises.find(e => e.id === id))
          .filter(Boolean);
        lastResults.forEach(e => shuffleShown.add(e.id));
        showShuffleResults();
      } else {
        showShuffleConfig();
      }
      show('screen-shuffle');
      return true;
    }
    if (state.screen === 'screen-random') {
      randomSeen = new Set(state.randomSeen || []);
      const cur = exercises.find(e => e.id === state.randomCurrentId);
      show('screen-random');
      if (cur && isAvailable(cur)) {
        currentRandomExercise = cur;
        renderRandom();
      } else {
        showNextRandom();
      }
      return true;
    }

    renderStats();
    show('screen-area-overview');
    return true;
  } catch {
    return false;
  }
}

// ---------- AUTH ----------
$('btn-login').addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    alert('Sign-in failed: ' + e.message);
  }
});

$('btn-logout').addEventListener('click', async () => {
  if (currentUser) localStorage.removeItem(getStateKey());
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    isRestoring = true;
    const restored = await restoreAppState();
    isRestoring = false;
    if (!restored) {
      show('screen-areas');
      loadAreas();
    }
  } else {
    show('screen-login');
  }
});

// ---------- AREAS ----------
async function loadAreas() {
  const ref = collection(db, 'users', currentUser.uid, 'areas');
  const snap = await getDocs(query(ref, orderBy('name')));
  const list = $('areas-list');
  if (snap.empty) {
    list.innerHTML = '<p class="empty-state">No areas yet. Create one below!</p>';
    return;
  }
  list.innerHTML = '';
  snap.forEach(d => {
    const div = document.createElement('div');
    div.className = 'area-card';
    div.textContent = d.data().name;
    div.addEventListener('click', () => openArea(d.id, d.data().name));
    list.appendChild(div);
  });
}

$('btn-add-area').addEventListener('click', async () => {
  const name = $('input-new-area').value.trim();
  if (!name) return;
  const ref = collection(db, 'users', currentUser.uid, 'areas');
  await addDoc(ref, { name });
  $('input-new-area').value = '';
  loadAreas();
});

$('input-new-area').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-add-area').click();
});

// ---------- AREA OVERVIEW ----------
async function openArea(areaId, areaName) {
  currentAreaId = areaId;
  currentAreaName = areaName;
  lastResults = null;
  shuffleShown = new Set();
  randomSeen = new Set();
  currentRandomExercise = null;
  $('area-overview-title').textContent = areaName;
  $('area-stats').innerHTML = '';
  show('screen-area-overview');
  await loadExercises();
  renderStats();
}

function renderStats() {
  const total = exercises.length;
  const active = exercises.filter(e => e.active !== false).length;
  const essentials = exercises.filter(e => e.essential).length;
  const excluded = exercises.filter(e => e.excluded).length;
  const available = exercises.filter(isAvailable);
  const neverDone = available.filter(e => !e.lastDone).length;
  const doneToday = available.filter(isDoneToday).length;
  const totalTime = exercises.reduce((s, e) => s + (e.minutes || 0), 0);
  $('area-stats').innerHTML = `
    <div class="stat"><strong>${total}</strong> exercise${total !== 1 ? 's' : ''}</div>
    <div class="stat"><strong>${active}</strong> active</div>
    <div class="stat"><strong>${essentials}</strong> essential</div>
    <div class="stat"><strong>${excluded}</strong> excluded</div>
    <div class="stat"><strong>${neverDone}</strong> never done</div>
    <div class="stat"><strong>${doneToday}</strong> done today</div>
    <div class="stat" style="grid-column: 1 / -1;"><strong>${totalTime}</strong> total minutes</div>
  `;
}

function goToOverview() {
  show('screen-area-overview');
  renderStats();
}

$('btn-back-to-areas').addEventListener('click', () => {
  currentAreaId = null;
  currentAreaName = '';
  show('screen-areas');
  loadAreas();
});

$('btn-rename-area').addEventListener('click', () => {
  $('rename-input').value = currentAreaName;
  $('rename-overlay').style.display = 'flex';
});

$('rename-cancel').addEventListener('click', () => {
  $('rename-overlay').style.display = 'none';
});

$('rename-confirm').addEventListener('click', async () => {
  const newName = $('rename-input').value.trim();
  if (!newName) return;
  await updateDoc(doc(db, 'users', currentUser.uid, 'areas', currentAreaId), { name: newName });
  currentAreaName = newName;
  $('area-overview-title').textContent = newName;
  $('rename-overlay').style.display = 'none';
  saveCurrentState();
});

$('btn-delete-area').addEventListener('click', () => {
  showConfirm('Delete this area and all its exercises?', async () => {
    const ref = collection(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises');
    const snap = await getDocs(ref);
    const batch = writeBatch(db);
    snap.forEach(d => batch.delete(d.ref));
    batch.delete(doc(db, 'users', currentUser.uid, 'areas', currentAreaId));
    await batch.commit();
    currentAreaId = null;
    currentAreaName = '';
    show('screen-areas');
    loadAreas();
  });
});

// ---------- EXERCISES (load + one-time migration from v1) ----------
async function loadExercises() {
  const ref = collection(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises');
  const snap = await getDocs(ref);
  exercises = [];
  snap.forEach(d => exercises.push({ id: d.id, ...d.data() }));
  exercises.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  await migrateFromV1();
}

async function migrateFromV1() {
  const legacyKey = `exershuffle_excluded_${currentUser.uid}_${currentAreaId}`;
  let legacyExcluded = new Set();
  try {
    const stored = localStorage.getItem(legacyKey);
    if (stored) legacyExcluded = new Set(JSON.parse(stored));
  } catch { /* ignore */ }

  const batch = writeBatch(db);
  let changes = 0;
  exercises.forEach(ex => {
    const updates = {};
    if (ex.essential === undefined) {
      updates.essential = ex.alwaysInclude === true;
      ex.essential = updates.essential;
    }
    if ('alwaysInclude' in ex) {
      updates.alwaysInclude = deleteField();
      delete ex.alwaysInclude;
    }
    if (legacyExcluded.has(ex.id) && !ex.excluded) {
      updates.excluded = true;
      ex.excluded = true;
    }
    if (Object.keys(updates).length > 0) {
      batch.update(exRef(ex.id), updates);
      changes++;
    }
  });
  try {
    if (changes > 0) await batch.commit();
    localStorage.removeItem(legacyKey);
  } catch { /* try again next time */ }
}

// ---------- MANAGE EXERCISES ----------
$('btn-manage-exercises').addEventListener('click', () => {
  show('screen-manage');
  renderExerciseList();
});

$('btn-back-to-overview').addEventListener('click', goToOverview);

function renderExerciseList() {
  const searchTerm = $('input-search').value.toLowerCase();
  const sortBy = $('select-sort').value;

  let filtered = exercises.filter(e => (e.name || '').toLowerCase().includes(searchTerm));
  filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (sortBy === 'stars') filtered.sort((a, b) => (b.stars || 0) - (a.stars || 0));
  else if (sortBy === 'status') filtered.sort((a, b) => (isAvailable(b) ? 1 : 0) - (isAvailable(a) ? 1 : 0));
  else if (sortBy === 'lastdone') filtered.sort((a, b) => dayStart(a.lastDone) - dayStart(b.lastDone));

  const list = $('exercises-list');
  if (filtered.length === 0) {
    list.innerHTML = exercises.length === 0
      ? '<p class="empty-state">No exercises yet. Tap + to add one!</p>'
      : '<p class="empty-state">No exercises found.</p>';
    return;
  }
  list.innerHTML = '';
  filtered.forEach(ex => {
    const div = document.createElement('div');
    div.className = 'exercise-card' + (ex.active === false ? ' inactive' : '') + (ex.excluded ? ' excluded' : '');

    let badges = '';
    if (ex.essential) badges += '<span class="badge badge-pinned">\uD83D\uDCCC essential</span>';
    if (ex.excluded) badges += '<span class="badge badge-excluded">\uD83D\uDEAB excluded</span>';

    div.innerHTML = `
      <div class="ex-info">
        <div class="ex-name">${esc(ex.name)}</div>
        <div class="ex-meta">${esc(metaText(ex))}</div>
        <div class="ex-last">${esc(lastDoneText(ex.lastDone))}</div>
        ${badges ? '<div class="ex-badges">' + badges + '</div>' : ''}
      </div>
      <div class="mini-toggle">
        <label class="toggle">
          <input type="checkbox" ${ex.active !== false ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;
    div.querySelector('.ex-info').addEventListener('click', (e) => {
      if (e.target.classList.contains('badge-excluded')) return;
      openExerciseForm(ex, 'screen-manage');
    });
    const excludedBadge = div.querySelector('.badge-excluded');
    if (excludedBadge) {
      excludedBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        ex.excluded = false;
        updateExercise(ex.id, { excluded: false });
        renderExerciseList();
        showToast(`Included again: ${ex.name}`);
      });
    }
    div.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
      e.stopPropagation();
      ex.active = e.target.checked;
      updateExercise(ex.id, { active: ex.active });
      renderExerciseList();
    });
    list.appendChild(div);
  });
}

$('input-search').addEventListener('input', renderExerciseList);
$('select-sort').addEventListener('change', renderExerciseList);

async function setAllActive(active) {
  const batch = writeBatch(db);
  exercises.forEach(ex => {
    batch.update(exRef(ex.id), { active });
    ex.active = active;
  });
  renderExerciseList();
  try { await batch.commit(); } catch { showToast('Could not save \u2013 check your connection'); }
}

$('btn-activate-all').addEventListener('click', () => setAllActive(true));
$('btn-deactivate-all').addEventListener('click', () => setAllActive(false));

// ---------- EXERCISE FORM ----------
$('btn-add-exercise').addEventListener('click', () => openExerciseForm(null, 'screen-manage'));

function openExerciseForm(ex, fromScreen) {
  returnToScreen = fromScreen || 'screen-manage';
  editingExerciseId = ex ? ex.id : null;
  formLastDone = ex ? (ex.lastDone || null) : null;
  $('exercise-form-title').textContent = ex ? 'Edit Exercise' : 'New Exercise';
  $('btn-delete-exercise').style.display = ex ? 'block' : 'none';
  $('ex-name').value = ex ? ex.name : '';
  $('ex-minutes').value = ex ? (ex.minutes || '') : '';
  $('ex-note').value = ex ? (ex.note || '') : '';
  $('ex-active').checked = ex ? (ex.active !== false) : true;
  $('ex-essential').checked = ex ? (ex.essential === true) : false;
  $('ex-excluded').checked = ex ? (ex.excluded === true) : false;
  $('last-done-row').style.display = ex ? 'flex' : 'none';
  updateFormLastDone();
  setStars(ex ? (ex.stars || 0) : 0);
  show('screen-exercise-form');
  $('screen-exercise-form').querySelector('.content').scrollTop = 0;
}

function updateFormLastDone() {
  $('form-last-done').textContent = lastDoneText(formLastDone);
  $('btn-reset-last-done').style.display = formLastDone ? 'block' : 'none';
}

$('btn-reset-last-done').addEventListener('click', () => {
  formLastDone = null;
  updateFormLastDone();
});

let selectedStars = 0;
function setStars(n) {
  selectedStars = n;
  document.querySelectorAll('#star-picker .star').forEach(s => {
    s.classList.toggle('active', parseInt(s.dataset.value) <= n);
  });
}

document.querySelectorAll('#star-picker .star').forEach(s => {
  s.addEventListener('click', () => {
    const val = parseInt(s.dataset.value);
    setStars(val === selectedStars ? 0 : val);
  });
});

$('btn-back-to-manage').addEventListener('click', navigateBackFromForm);

function navigateBackFromForm() {
  if (returnToScreen === 'screen-shuffle') {
    if (lastResults) {
      lastResults = lastResults
        .map(r => exercises.find(e => e.id === r.id))
        .filter(e => e && isAvailable(e));
      showShuffleResults();
    }
    show('screen-shuffle');
  } else if (returnToScreen === 'screen-random') {
    show('screen-random');
    const ex = exercises.find(e => e.id === editingExerciseId);
    if (ex && isAvailable(ex)) {
      currentRandomExercise = ex;
      renderRandom();
    } else {
      showNextRandom();
    }
  } else if (returnToScreen === 'screen-essentials') {
    show('screen-essentials');
    renderEssentials();
  } else {
    show('screen-manage');
    renderExerciseList();
  }
}

$('exercise-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const minutes = parseInt($('ex-minutes').value);
  const data = {
    name: $('ex-name').value.trim(),
    stars: selectedStars || null,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
    note: $('ex-note').value.trim() || null,
    active: $('ex-active').checked,
    essential: $('ex-essential').checked,
    excluded: $('ex-excluded').checked,
    lastDone: formLastDone || null,
  };
  if (!data.name) return;

  try {
    if (editingExerciseId) {
      await updateDoc(exRef(editingExerciseId), data);
      const idx = exercises.findIndex(x => x.id === editingExerciseId);
      if (idx >= 0) exercises[idx] = { id: editingExerciseId, ...data };
    } else {
      const ref = collection(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises');
      const docRef = await addDoc(ref, data);
      exercises.push({ id: docRef.id, ...data });
    }
  } catch {
    alert('Could not save. Check your connection and try again.');
    return;
  }
  navigateBackFromForm();
});

$('btn-delete-exercise').addEventListener('click', () => {
  showConfirm('Delete this exercise?', async () => {
    const deletedId = editingExerciseId;
    await deleteDoc(exRef(deletedId));
    exercises = exercises.filter(x => x.id !== deletedId);
    if (lastResults) lastResults = lastResults.filter(r => r.id !== deletedId);
    navigateBackFromForm();
  });
});

// ---------- SHARED RESULT CARD ----------
function buildResultCard(ex, { single = false, onDone, onExclude, from }) {
  const div = document.createElement('div');
  const doneToday = isDoneToday(ex);
  div.className = 'result-card tappable' + (single ? ' single' : '') + (doneToday ? ' done-today' : '');
  const meta = metaText(ex);
  div.innerHTML = `
    <div class="result-name">${esc(ex.name)}</div>
    ${meta ? `<div class="result-meta">${esc(meta)}</div>` : ''}
    ${ex.essential ? '<div class="result-pinned">\uD83D\uDCCC Essential</div>' : ''}
    <div class="result-last-done${doneToday ? ' today' : ''}">${esc(lastDoneText(ex.lastDone))}</div>
    ${ex.note ? `<div class="result-note">${esc(ex.note)}</div>` : ''}
    <div class="card-actions">
      ${onDone ? `<button class="btn-done${doneToday ? ' is-done' : ''}">${doneToday ? 'Done today \u2713' : 'Done \u2713'}</button>` : ''}
      ${onExclude ? '<button class="btn-exclude">Exclude</button>' : ''}
    </div>
  `;
  div.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openExerciseForm(ex, from);
  });
  const doneBtn = div.querySelector('.btn-done');
  if (doneBtn) {
    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!doneToday) onDone(ex);
    });
  }
  const exclBtn = div.querySelector('.btn-exclude');
  if (exclBtn) {
    exclBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onExclude(ex);
    });
  }
  return div;
}

// Mark as done with undo. afterChange re-renders the current view.
function markDone(ex, afterChange, afterUndo) {
  const prev = ex.lastDone || null;
  ex.lastDone = Date.now();
  updateExercise(ex.id, { lastDone: ex.lastDone });
  afterChange();
  showToast(`\u2713 Done: ${ex.name}`, () => {
    ex.lastDone = prev;
    updateExercise(ex.id, { lastDone: prev });
    (afterUndo || afterChange)();
  });
}

// ---------- ESSENTIALS ----------
$('btn-essentials').addEventListener('click', () => {
  show('screen-essentials');
  renderEssentials();
});

$('btn-back-from-essentials').addEventListener('click', goToOverview);

function renderEssentials() {
  const all = exercises.filter(e => e.essential);
  const list = all.filter(isAvailable)
    .sort((a, b) => dayStart(a.lastDone) - dayStart(b.lastDone) || (a.name || '').localeCompare(b.name || ''));
  const hidden = all.length - list.length;
  const container = $('essentials-list');
  container.innerHTML = '';

  if (list.length === 0) {
    $('essentials-summary').innerHTML = '';
    container.innerHTML = '<p class="empty-state">No essentials yet.<br>Open an exercise and switch on \uD83D\uDCCC Essential.</p>';
  } else {
    const time = list.reduce((s, e) => s + (e.minutes || 0), 0);
    const stars = list.reduce((s, e) => s + (e.stars || 0), 0);
    const doneToday = list.filter(isDoneToday).length;
    const parts = [`<strong>${list.length}</strong> exercise${list.length !== 1 ? 's' : ''}`];
    if (time) parts.push(`<strong>${time}</strong> min`);
    if (stars) parts.push(`<strong>${stars}</strong> \u2605`);
    $('essentials-summary').innerHTML = parts.join(' \u00b7 ') +
      `<br>Done today: <strong>${doneToday}</strong> of ${list.length}`;
    list.forEach(ex => {
      container.appendChild(buildResultCard(ex, {
        from: 'screen-essentials',
        onDone: (e) => markDone(e, renderEssentials),
      }));
    });
  }
  $('essentials-hidden').textContent = hidden > 0
    ? `${hidden} inactive or excluded essential${hidden !== 1 ? 's' : ''} not shown`
    : '';
}

// ---------- SHUFFLE ----------
$('shuffle-mode').addEventListener('change', updateShuffleModeUI);

function updateShuffleModeUI() {
  const mode = $('shuffle-mode').value;
  const label = $('shuffle-value-label');
  const input = $('shuffle-value');
  if (mode === 'count') {
    label.textContent = 'Number of exercises';
    input.placeholder = 'e.g. 5';
    input.value = input.value || '1';
  } else if (mode === 'time') {
    label.textContent = 'Total minutes';
    input.placeholder = 'e.g. 30';
    input.value = input.value || '10';
  } else if (mode === 'stars') {
    label.textContent = 'Total stars';
    input.placeholder = 'e.g. 6';
    input.value = input.value || '3';
  }
}

function showShuffleConfig() {
  $('shuffle-config').style.display = 'block';
  $('shuffle-results').style.display = 'none';
}

function showShuffleResults() {
  $('shuffle-config').style.display = 'none';
  $('shuffle-results').style.display = 'block';
  renderResults();
}

$('btn-shuffle-exercises').addEventListener('click', () => {
  lastResults = null;
  shuffleShown = new Set();
  showShuffleConfig();
  updateShuffleModeUI();
  show('screen-shuffle');
});

$('btn-back-to-overview2').addEventListener('click', goToOverview);

$('btn-shuffle').addEventListener('click', () => {
  shuffleShown = new Set();
  doShuffle();
});
$('btn-reshuffle').addEventListener('click', doShuffle);

$('btn-new-shuffle').addEventListener('click', () => {
  lastResults = null;
  shuffleShown = new Set();
  showShuffleConfig();
  saveCurrentState();
});

$('btn-reset-excluded').addEventListener('click', () => {
  const excluded = exercises.filter(e => e.excluded);
  if (excluded.length === 0) {
    showToast('No excluded exercises in this area');
    return;
  }
  showConfirm(`Include all ${excluded.length} excluded exercise${excluded.length !== 1 ? 's' : ''} again?`, async () => {
    const batch = writeBatch(db);
    excluded.forEach(ex => {
      batch.update(exRef(ex.id), { excluded: false });
      ex.excluded = false;
    });
    try { await batch.commit(); } catch { showToast('Could not save \u2013 check your connection'); }
    shuffleShown = new Set();
    doShuffle();
  }, 'Reset', false);
});

function getFilteredPool() {
  const starFilter = $('shuffle-star-filter').value;
  const timeFilter = $('shuffle-time-filter').value;
  let pool = exercises.filter(isAvailable);

  if (starFilter === 'gte1') pool = pool.filter(e => (e.stars || 0) >= 1);
  else if (starFilter === 'gte2') pool = pool.filter(e => (e.stars || 0) >= 2);
  else if (starFilter === 'gte3') pool = pool.filter(e => (e.stars || 0) >= 3);
  else if (starFilter === 'lte1') pool = pool.filter(e => (e.stars || 0) <= 1);
  else if (starFilter === 'lte2') pool = pool.filter(e => (e.stars || 0) <= 2);

  if (timeFilter === 'lte5') pool = pool.filter(e => (e.minutes || 0) <= 5);
  else if (timeFilter === 'lte10') pool = pool.filter(e => (e.minutes || 0) <= 10);
  else if (timeFilter === 'lte15') pool = pool.filter(e => (e.minutes || 0) <= 15);
  else if (timeFilter === 'gte5') pool = pool.filter(e => e.minutes && e.minutes >= 5);
  else if (timeFilter === 'gte10') pool = pool.filter(e => e.minutes && e.minutes >= 10);

  return pool;
}

function doShuffle() {
  const mode = $('shuffle-mode').value;
  const value = parseInt($('shuffle-value').value) || 1;
  const pool = getFilteredPool();
  const warning = $('shuffle-warning');
  const warnings = [];

  if (pool.length === 0) {
    warnings.push('No exercises available. Try adjusting filters or resetting excluded.');
    lastResults = [];
  } else {
    // Not-yet-shown first (so "Shuffle Again" gives new ones), each group in rotation order
    const fresh = pool.filter(e => !shuffleShown.has(e.id));
    const seen = pool.filter(e => shuffleShown.has(e.id));
    if (fresh.length === 0) shuffleShown = new Set();
    const ordered = [...prioritize(fresh), ...prioritize(seen)];

    if (mode === 'count') {
      if (pool.length < value) warnings.push(`Only ${pool.length} exercise(s) available.`);
      lastResults = ordered.slice(0, value);
    } else {
      const field = mode === 'time' ? 'minutes' : 'stars';
      lastResults = budgetFill(ordered, value, field);
      if (lastResults.length === 0) {
        warnings.push(mode === 'time'
          ? 'No exercises fit the time budget. Exercises need a time set to be included.'
          : 'No exercises fit the star budget. Exercises need stars set to be included.');
      }
    }
    lastResults.forEach(e => shuffleShown.add(e.id));
  }

  if (warnings.length > 0) {
    warning.textContent = warnings.join(' ');
    warning.style.display = 'block';
  } else {
    warning.style.display = 'none';
  }

  showShuffleResults();
  $('screen-shuffle').querySelector('.content').scrollTop = 0;
  saveAppState('screen-shuffle');
}

function budgetFill(ordered, budget, field) {
  const picked = [];
  let remaining = budget;
  for (const ex of ordered) {
    const cost = ex[field] || 0;
    if (cost === 0) continue;
    if (cost <= remaining) {
      picked.push(ex);
      remaining -= cost;
      if (remaining <= 0) break;
    }
  }
  return picked;
}

function renderResults() {
  const results = lastResults || [];
  const container = $('results-container');
  container.innerHTML = '';
  const single = results.length === 1;

  results.forEach(ex => {
    container.appendChild(buildResultCard(ex, {
      single,
      from: 'screen-shuffle',
      onDone: (e) => markDone(e, renderResults),
      onExclude: (e) => excludeFromResults(e),
    }));
  });

  const totalDiv = $('results-total');
  if (results.length === 0) {
    totalDiv.textContent = '';
    return;
  }
  const totalTime = results.reduce((s, e) => s + (e.minutes || 0), 0);
  const totalStars = results.reduce((s, e) => s + (e.stars || 0), 0);
  const doneCount = results.filter(isDoneToday).length;
  const parts = [`${results.length} exercise${results.length !== 1 ? 's' : ''}`];
  if (totalTime > 0) parts.push(`${totalTime} min`);
  if (totalStars > 0) parts.push(`${totalStars} \u2605`);
  totalDiv.textContent = `Total: ${parts.join(' \u00b7 ')} \u00b7 ${doneCount} done`;
}

function excludeFromResults(ex) {
  const idx = lastResults.findIndex(r => r.id === ex.id);
  ex.excluded = true;
  updateExercise(ex.id, { excluded: true });
  lastResults = lastResults.filter(r => r.id !== ex.id);
  renderResults();
  saveCurrentState();
  showToast(`\uD83D\uDEAB Excluded: ${ex.name}`, () => {
    ex.excluded = false;
    updateExercise(ex.id, { excluded: false });
    if (lastResults && !lastResults.some(r => r.id === ex.id)) {
      lastResults.splice(Math.max(0, idx), 0, ex);
    }
    renderResults();
    saveCurrentState();
  });
}

// ---------- RANDOM EXERCISE (rotation) ----------
$('btn-random-exercise').addEventListener('click', () => {
  randomSeen = new Set();
  currentRandomExercise = null;
  show('screen-random');
  showNextRandom();
});

$('btn-back-to-overview3').addEventListener('click', goToOverview);

function showNextRandom() {
  const available = exercises.filter(isAvailable);
  if (available.length === 0) {
    currentRandomExercise = null;
    renderRandom();
    return;
  }
  let candidates = available.filter(e => !randomSeen.has(e.id));
  if (candidates.length === 0) {
    // Everything seen this session -> start a new round
    randomSeen = new Set();
    candidates = available;
  }
  // Avoid showing the same exercise twice in a row when possible
  if (candidates.length > 1 && currentRandomExercise) {
    candidates = candidates.filter(e => e.id !== currentRandomExercise.id);
  }
  currentRandomExercise = prioritize(candidates)[0];
  renderRandom();
  saveCurrentState();
}

function renderRandom() {
  const ex = currentRandomExercise;
  const wrapper = $('random-card-wrapper');
  const buttons = $('random-buttons');
  const empty = $('random-empty');

  if (!ex) {
    wrapper.style.display = 'none';
    buttons.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  wrapper.style.display = 'block';
  buttons.style.display = 'flex';
  empty.style.display = 'none';

  const card = $('random-card');
  const doneToday = isDoneToday(ex);
  const meta = metaText(ex);
  card.className = 'result-card single tappable' + (doneToday ? ' done-today' : '');
  card.innerHTML = `
    <div class="result-name">${esc(ex.name)}</div>
    ${meta ? `<div class="result-meta">${esc(meta)}</div>` : ''}
    ${ex.essential ? '<div class="result-pinned">\uD83D\uDCCC Essential</div>' : ''}
    <div class="result-last-done${doneToday ? ' today' : ''}">${esc(lastDoneText(ex.lastDone))}</div>
    ${ex.note ? `<div class="result-note">${esc(ex.note)}</div>` : ''}
  `;
  card.onclick = () => openExerciseForm(ex, 'screen-random');

  const available = exercises.filter(isAvailable);
  const doneCount = available.filter(isDoneToday).length;
  const neverCount = available.filter(e => !e.lastDone).length;
  $('random-progress').textContent =
    `Done today: ${doneCount} of ${available.length} \u00b7 Never done: ${neverCount}`;
}

$('btn-random-done').addEventListener('click', () => {
  const ex = currentRandomExercise;
  if (!ex) return;
  randomSeen.add(ex.id);
  markDone(ex, showNextRandom, () => {
    randomSeen.delete(ex.id);
    currentRandomExercise = ex;
    renderRandom();
    saveCurrentState();
  });
});

$('btn-random-skip').addEventListener('click', () => {
  if (!currentRandomExercise) return;
  randomSeen.add(currentRandomExercise.id);
  showNextRandom();
});

$('btn-random-exclude').addEventListener('click', () => {
  const ex = currentRandomExercise;
  if (!ex) return;
  ex.excluded = true;
  updateExercise(ex.id, { excluded: true });
  showNextRandom();
  showToast(`\uD83D\uDEAB Excluded: ${ex.name}`, () => {
    ex.excluded = false;
    updateExercise(ex.id, { excluded: false });
    currentRandomExercise = ex;
    renderRandom();
    saveCurrentState();
  });
});

// ---------- CONFIRM DIALOG ----------
let confirmCallback = null;

function showConfirm(message, callback, confirmLabel = 'Delete', danger = true) {
  $('dialog-message').textContent = message;
  const btn = $('dialog-confirm');
  btn.textContent = confirmLabel;
  btn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
  $('dialog-overlay').style.display = 'flex';
  confirmCallback = callback;
}

$('dialog-cancel').addEventListener('click', () => {
  $('dialog-overlay').style.display = 'none';
  confirmCallback = null;
});

$('dialog-confirm').addEventListener('click', async () => {
  $('dialog-overlay').style.display = 'none';
  const cb = confirmCallback;
  confirmCallback = null;
  if (cb) await cb();
});
