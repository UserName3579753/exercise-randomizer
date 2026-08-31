// ExerShuffle v1.2
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, getDocs, query, orderBy, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

// State
let currentUser = null;
let currentAreaId = null;
let currentAreaName = '';
let exercises = [];
let editingExerciseId = null;
let excludedIds = new Set();
let lastResults = null;
let randomQueue = [];

// Excluded persistence (localStorage, per area)
function getExcludedKey() {
  return `exershuffle_excluded_${currentUser?.uid}_${currentAreaId}`;
}
function loadExcluded() {
  try {
    const stored = localStorage.getItem(getExcludedKey());
    excludedIds = stored ? new Set(JSON.parse(stored)) : new Set();
  } catch { excludedIds = new Set(); }
}
function saveExcluded() {
  localStorage.setItem(getExcludedKey(), JSON.stringify([...excludedIds]));
}

// DOM helpers
const $ = (id) => document.getElementById(id);
const show = (screenId) => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(screenId).classList.add('active');
};

// Auth
$('btn-login').addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    alert('Sign-in failed: ' + e.message);
  }
});

$('btn-logout').addEventListener('click', async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    show('screen-areas');
    loadAreas();
  } else {
    show('screen-login');
  }
});

// --- AREAS ---
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

// --- AREA OVERVIEW ---
async function openArea(areaId, areaName) {
  currentAreaId = areaId;
  currentAreaName = areaName;
  $('area-overview-title').textContent = areaName;
  show('screen-area-overview');
  await loadExercises();
  loadExcluded();
  lastResults = null;
  randomQueue = [];
  renderStats();
}

function renderStats() {
  const active = exercises.filter(e => e.active !== false);
  const total = exercises.length;
  const totalTime = exercises.reduce((s, e) => s + (e.minutes || 0), 0);
  const pinnedCount = exercises.filter(e => e.alwaysInclude).length;
  const excludedCount = excludedIds.size;
  $('area-stats').innerHTML = `
    <div class="stat"><strong>${total}</strong> exercise${total !== 1 ? 's' : ''}</div>
    <div class="stat"><strong>${active.length}</strong> active</div>
    <div class="stat"><strong>${pinnedCount}</strong> pinned</div>
    <div class="stat"><strong>${excludedCount}</strong> excluded</div>
    <div class="stat"><strong>${totalTime}</strong> total minutes</div>
  `;
}

$('btn-back-to-areas').addEventListener('click', () => {
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
  const ref = doc(db, 'users', currentUser.uid, 'areas', currentAreaId);
  await updateDoc(ref, { name: newName });
  currentAreaName = newName;
  $('area-overview-title').textContent = newName;
  $('rename-overlay').style.display = 'none';
});

$('btn-delete-area').addEventListener('click', () => {
  showConfirm('Delete this area and all its exercises?', async () => {
    const exRef = collection(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises');
    const snap = await getDocs(exRef);
    const batch = writeBatch(db);
    snap.forEach(d => batch.delete(d.ref));
    batch.delete(doc(db, 'users', currentUser.uid, 'areas', currentAreaId));
    await batch.commit();
    localStorage.removeItem(getExcludedKey());
    show('screen-areas');
    loadAreas();
  });
});

// --- EXERCISES ---
async function loadExercises() {
  const ref = collection(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises');
  const snap = await getDocs(ref);
  exercises = [];
  snap.forEach(d => exercises.push({ id: d.id, ...d.data() }));
  exercises.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

$('btn-manage-exercises').addEventListener('click', () => {
  show('screen-manage');
  renderExerciseList();
});

$('btn-back-to-overview').addEventListener('click', () => {
  show('screen-area-overview');
  renderStats();
});

function renderExerciseList() {
  const searchTerm = $('input-search').value.toLowerCase();
  const sortBy = $('select-sort').value;

  let filtered = exercises.filter(e => e.name.toLowerCase().includes(searchTerm));

  if (sortBy === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortBy === 'stars') filtered.sort((a, b) => (b.stars || 0) - (a.stars || 0));
  else if (sortBy === 'status') filtered.sort((a, b) => (b.active === false ? 0 : 1) - (a.active === false ? 0 : 1));

  const list = $('exercises-list');
  if (filtered.length === 0) {
    list.innerHTML = '<p class="empty-state">No exercises found.</p>';
    return;
  }
  list.innerHTML = '';
  filtered.forEach(ex => {
    const isExcluded = excludedIds.has(ex.id);
    const div = document.createElement('div');
    div.className = 'exercise-card' + (ex.active === false ? ' inactive' : '') + (isExcluded ? ' excluded' : '');
    const stars = ex.stars ? '\u2605'.repeat(ex.stars) : '';
    const mins = ex.minutes ? ex.minutes + ' min' : '';
    const meta = [stars, mins].filter(Boolean).join(' \u00b7 ');

    let badges = '';
    if (ex.alwaysInclude) badges += '<span class="badge badge-pinned">\uD83D\uDCCC pinned</span>';
    if (isExcluded) badges += '<span class="badge badge-excluded" data-exid="' + ex.id + '">\uD83D\uDEAB excluded</span>';

    div.innerHTML = `
      <div class="ex-info">
        <div class="ex-name">${ex.name}</div>
        <div class="ex-meta">${meta}</div>
        ${badges ? '<div class="ex-badges">' + badges + '</div>' : ''}
      </div>
      <div class="mini-toggle">
        <label class="toggle">
          <input type="checkbox" ${ex.active !== false ? 'checked' : ''} data-id="${ex.id}">
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;
    div.querySelector('.ex-info').addEventListener('click', (e) => {
      if (e.target.classList.contains('badge-excluded')) return;
      openExerciseForm(ex);
    });
    const excludedBadge = div.querySelector('.badge-excluded');
    if (excludedBadge) {
      excludedBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        excludedIds.delete(ex.id);
        saveExcluded();
        renderExerciseList();
      });
    }
    div.querySelector('input[type="checkbox"]').addEventListener('change', async (e) => {
      e.stopPropagation();
      const active = e.target.checked;
      const ref = doc(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises', ex.id);
      await updateDoc(ref, { active });
      ex.active = active;
      renderExerciseList();
    });
    list.appendChild(div);
  });
}

$('input-search').addEventListener('input', renderExerciseList);
$('select-sort').addEventListener('change', renderExerciseList);

$('btn-activate-all').addEventListener('click', async () => {
  const batch = writeBatch(db);
  exercises.forEach(ex => {
    batch.update(doc(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises', ex.id), { active: true });
    ex.active = true;
  });
  await batch.commit();
  renderExerciseList();
});

$('btn-deactivate-all').addEventListener('click', async () => {
  const batch = writeBatch(db);
  exercises.forEach(ex => {
    batch.update(doc(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises', ex.id), { active: false });
    ex.active = false;
  });
  await batch.commit();
  renderExerciseList();
});

// --- EXERCISE FORM ---
$('btn-add-exercise').addEventListener('click', () => openExerciseForm(null));

function openExerciseForm(ex) {
  editingExerciseId = ex ? ex.id : null;
  $('exercise-form-title').textContent = ex ? 'Edit Exercise' : 'New Exercise';
  $('btn-delete-exercise').style.display = ex ? 'block' : 'none';
  $('ex-name').value = ex ? ex.name : '';
  $('ex-minutes').value = ex ? (ex.minutes || '') : '';
  $('ex-note').value = ex ? (ex.note || '') : '';
  $('ex-active').checked = ex ? (ex.active !== false) : true;
  $('ex-always-include').checked = ex ? (ex.alwaysInclude === true) : false;
  setStars(ex ? (ex.stars || 0) : 0);
  show('screen-exercise-form');
}

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

$('btn-back-to-manage').addEventListener('click', () => {
  show('screen-manage');
  renderExerciseList();
});

$('exercise-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    name: $('ex-name').value.trim(),
    stars: selectedStars || null,
    minutes: $('ex-minutes').value ? parseInt($('ex-minutes').value) : null,
    note: $('ex-note').value.trim() || null,
    active: $('ex-active').checked,
    alwaysInclude: $('ex-always-include').checked
  };
  if (!data.name) return;

  if (editingExerciseId) {
    const ref = doc(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises', editingExerciseId);
    await updateDoc(ref, data);
    const idx = exercises.findIndex(x => x.id === editingExerciseId);
    if (idx >= 0) exercises[idx] = { id: editingExerciseId, ...data };
  } else {
    const ref = collection(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises');
    const docRef = await addDoc(ref, data);
    exercises.push({ id: docRef.id, ...data });
  }
  show('screen-manage');
  renderExerciseList();
});

$('btn-delete-exercise').addEventListener('click', () => {
  showConfirm('Delete this exercise?', async () => {
    const ref = doc(db, 'users', currentUser.uid, 'areas', currentAreaId, 'exercises', editingExerciseId);
    await deleteDoc(ref);
    exercises = exercises.filter(x => x.id !== editingExerciseId);
    excludedIds.delete(editingExerciseId);
    saveExcluded();
    show('screen-manage');
    renderExerciseList();
  });
});

// --- SHUFFLE ---

// Shuffle mode dropdown: update label and placeholder
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

// Always show filter screen when entering shuffle (fix for bug #2)
$('btn-shuffle-exercises').addEventListener('click', () => {
  lastResults = null;
  $('shuffle-config').style.display = 'block';
  $('shuffle-results').style.display = 'none';
  updateShuffleModeUI();
  show('screen-shuffle');
});

$('btn-back-to-overview2').addEventListener('click', () => {
  show('screen-area-overview');
  renderStats();
});

$('btn-shuffle').addEventListener('click', doShuffle);
$('btn-reshuffle').addEventListener('click', doShuffle);

$('btn-new-shuffle').addEventListener('click', () => {
  lastResults = null;
  $('shuffle-config').style.display = 'block';
  $('shuffle-results').style.display = 'none';
});

$('btn-reset-excluded').addEventListener('click', () => {
  excludedIds.clear();
  saveExcluded();
  doShuffle();
});

function getFilteredPool() {
  const starFilter = $('shuffle-star-filter').value;
  const timeFilter = $('shuffle-time-filter').value;

  // Pinned: active + alwaysInclude + not excluded
  const pinned = exercises.filter(e => e.active !== false && e.alwaysInclude && !excludedIds.has(e.id));

  // Regular pool: active + not pinned + not excluded
  let pool = exercises.filter(e => e.active !== false && !e.alwaysInclude && !excludedIds.has(e.id));

  // Apply filters only to regular pool
  if (starFilter) {
    if (starFilter === 'gte1') pool = pool.filter(e => (e.stars || 0) >= 1);
    else if (starFilter === 'gte2') pool = pool.filter(e => (e.stars || 0) >= 2);
    else if (starFilter === 'gte3') pool = pool.filter(e => (e.stars || 0) >= 3);
    else if (starFilter === 'lte1') pool = pool.filter(e => (e.stars || 0) <= 1);
    else if (starFilter === 'lte2') pool = pool.filter(e => (e.stars || 0) <= 2);
  }

  if (timeFilter) {
    if (timeFilter === 'lte5') pool = pool.filter(e => (e.minutes || 0) <= 5);
    else if (timeFilter === 'lte10') pool = pool.filter(e => (e.minutes || 0) <= 10);
    else if (timeFilter === 'lte15') pool = pool.filter(e => (e.minutes || 0) <= 15);
    else if (timeFilter === 'gte5') pool = pool.filter(e => e.minutes && e.minutes >= 5);
    else if (timeFilter === 'gte10') pool = pool.filter(e => e.minutes && e.minutes >= 10);
  }

  return { pinned, pool };
}

function doShuffle() {
  const mode = $('shuffle-mode').value;
  const value = parseInt($('shuffle-value').value) || 1;
  const { pinned, pool } = getFilteredPool();

  const warning = $('shuffle-warning');

  if (pinned.length === 0 && pool.length === 0) {
    warning.textContent = 'No exercises available. Try adjusting filters or resetting excluded.';
    warning.style.display = 'block';
    lastResults = [];
    $('shuffle-config').style.display = 'none';
    $('shuffle-results').style.display = 'block';
    $('results-container').innerHTML = '';
    $('results-total').innerHTML = '';
    return;
  }

  let results;
  let warnings = [];

  if (mode === 'count') {
    const count = value;
    const remainingSlots = Math.max(0, count - pinned.length);
    if (pinned.length > count) {
      warnings.push(`You have ${pinned.length} pinned exercises but requested only ${count}. Showing all pinned.`);
    }
    if (remainingSlots > 0 && pool.length < remainingSlots) {
      warnings.push(`Only ${pool.length} additional exercise(s) available beyond pinned.`);
    }
    const randomCount = Math.min(remainingSlots, pool.length);
    const randomPicked = randomPick(pool, randomCount);
    results = [...pinned, ...randomPicked];

  } else if (mode === 'time') {
    const budget = value;
    const pinnedTime = pinned.reduce((s, e) => s + (e.minutes || 0), 0);
    if (pinnedTime > budget) {
      warnings.push(`Pinned exercises already use ${pinnedTime} min, which exceeds the ${budget} min budget. Showing pinned only.`);
      results = [...pinned];
    } else {
      const remainingBudget = budget - pinnedTime;
      const randomPicked = budgetFill(pool, remainingBudget, 'minutes');
      results = [...pinned, ...randomPicked];
    }

  } else if (mode === 'stars') {
    const budget = value;
    const pinnedStars = pinned.reduce((s, e) => s + (e.stars || 0), 0);
    if (pinnedStars > budget) {
      warnings.push(`Pinned exercises already have ${pinnedStars} stars, which exceeds the ${budget} star budget. Showing pinned only.`);
      results = [...pinned];
    } else {
      const remainingBudget = budget - pinnedStars;
      const randomPicked = budgetFill(pool, remainingBudget, 'stars');
      results = [...pinned, ...randomPicked];
    }
  }

  if (warnings.length > 0) {
    warning.textContent = warnings.join(' ');
    warning.style.display = 'block';
  } else {
    warning.style.display = 'none';
  }

  lastResults = results;
  $('shuffle-config').style.display = 'none';
  $('shuffle-results').style.display = 'block';
  renderResults(results);
}

function randomPick(pool, n) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// Greedily fill exercises until budget is reached
function budgetFill(pool, budget, field) {
  if (budget <= 0 || pool.length === 0) return [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const picked = [];
  let remaining = budget;

  for (const ex of shuffled) {
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

function renderResults(results) {
  const container = $('results-container');
  const isSingle = results.length === 1;
  container.innerHTML = '';

  results.forEach(ex => {
    const div = document.createElement('div');
    div.className = 'result-card' + (isSingle ? ' single' : '');
    const stars = ex.stars ? ' \u00b7 ' + '\u2605'.repeat(ex.stars) : '';
    const mins = ex.minutes ? ' \u00b7 ' + ex.minutes + ' min' : '';
    const note = ex.note ? `<div class="result-note">${ex.note}</div>` : '';
    const pinnedLabel = ex.alwaysInclude ? '<div class="result-pinned">\uD83D\uDCCC Always included</div>' : '';
    div.innerHTML = `
      <div class="result-name">${ex.name}</div>
      <div class="result-meta">${stars}${mins}</div>
      ${pinnedLabel}
      ${note}
      <button class="btn-exclude">Exclude this</button>
    `;
    div.querySelector('.btn-exclude').addEventListener('click', () => {
      excludedIds.add(ex.id);
      saveExcluded();
      doShuffle();
    });
    container.appendChild(div);
  });

  const totalDiv = $('results-total');
  const totalTime = results.reduce((s, e) => s + (e.minutes || 0), 0);
  const totalStars = results.reduce((s, e) => s + (e.stars || 0), 0);
  const parts = [];
  if (totalTime > 0) parts.push(`${totalTime} min`);
  if (totalStars > 0) parts.push(`${totalStars} \u2605`);
  totalDiv.textContent = parts.length > 0 ? `Total: ${parts.join(' \u00b7 ')} \u00b7 ${results.length} exercises` : `${results.length} exercise(s)`;
}

// --- RANDOM EXERCISE ---
$('btn-random-exercise').addEventListener('click', () => {
  randomQueue = [];
  show('screen-random');
  showNextRandom();
});

$('btn-back-to-overview3').addEventListener('click', () => {
  show('screen-area-overview');
  renderStats();
});

$('btn-next-random').addEventListener('click', showNextRandom);

function buildRandomQueue() {
  const pinned = exercises.filter(e => e.active !== false && e.alwaysInclude && !excludedIds.has(e.id));
  const rest = exercises.filter(e => e.active !== false && !e.alwaysInclude && !excludedIds.has(e.id));
  const shuffledPinned = [...pinned].sort(() => Math.random() - 0.5);
  const shuffledRest = [...rest].sort(() => Math.random() - 0.5);
  return [...shuffledPinned, ...shuffledRest];
}

function showNextRandom() {
  if (randomQueue.length === 0) {
    randomQueue = buildRandomQueue();
  }

  const card = $('random-card');
  const empty = $('random-empty');
  const wrapper = $('random-card-wrapper');
  const nextBtn = $('btn-next-random');

  if (randomQueue.length === 0) {
    wrapper.style.display = 'none';
    empty.style.display = 'block';
    nextBtn.style.display = 'none';
    return;
  }

  wrapper.style.display = 'block';
  empty.style.display = 'none';
  nextBtn.style.display = 'block';

  const ex = randomQueue.shift();
  const stars = ex.stars ? '\u2605'.repeat(ex.stars) : '';
  const mins = ex.minutes ? ex.minutes + ' min' : '';
  const meta = [stars, mins].filter(Boolean).join(' \u00b7 ');
  const note = ex.note ? `<div class="result-note">${ex.note}</div>` : '';
  const pinnedLabel = ex.alwaysInclude ? '<div class="result-pinned">\uD83D\uDCCC Always included</div>' : '';

  card.innerHTML = `
    <div class="result-name">${ex.name}</div>
    <div class="result-meta">${meta}</div>
    ${pinnedLabel}
    ${note}
  `;
}

// --- CONFIRM DIALOG ---
let confirmCallback = null;

function showConfirm(message, callback) {
  $('dialog-message').textContent = message;
  $('dialog-overlay').style.display = 'flex';
  confirmCallback = callback;
}

$('dialog-cancel').addEventListener('click', () => {
  $('dialog-overlay').style.display = 'none';
  confirmCallback = null;
});

$('dialog-confirm').addEventListener('click', async () => {
  $('dialog-overlay').style.display = 'none';
  if (confirmCallback) await confirmCallback();
  confirmCallback = null;
});
