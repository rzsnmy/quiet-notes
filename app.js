/* Quiet Notes - local-first edition
   IndexedDB is the durable first save. Firestore is the sync layer. */

const firebaseConfig = {
  apiKey: "AIzaSyC7SK1Ztw_hgYt7xkNh3JOxLTkThzwXdEo",
  authDomain: "minimum-notepad.firebaseapp.com",
  projectId: "minimum-notepad",
  storageBucket: "minimum-notepad.firebasestorage.app",
  messagingSenderId: "933732498861",
  appId: "1:933732498861:web:474bc75de238367cfab524"
};

const FIREBASE_VERSION = "10.12.2";
const LOCAL_DB_NAME = "quiet-notes-local-v1";
const LOCAL_DB_VERSION = 1;
const SYNC_DELAY_MS = 650;
const FIRST_REMOTE_WAIT_MS = 6000;
const $ = id => document.getElementById(id);

let editor, noteList, search, status, setupNotice, spaceKeyInput;
let localDb, db, collection, doc, onSnapshot, query, orderBy, serverTimestamp, runTransaction;
let spaceId = "";
let notes = [];
let currentId = null;
let unsubscribe = null;
let bootGeneration = 0;
let editorReady = false;
const syncTimers = new Map();
const syncChains = new Map();
const localWrites = new Map();

const clientId = (() => {
  const existing = localStorage.getItem("quietNotesClientId");
  if (existing) return existing;
  const value = randomId();
  localStorage.setItem("quietNotesClientId", value);
  return value;
})();

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function setStatus(text) { if (status) status.textContent = text; }
function showError(label, err) {
  console.error(label, err);
  setStatus(`${label}: ${err?.message || err?.code || String(err)}`);
}
window.addEventListener("error", event => showError("Error", event.error || event.message));
window.addEventListener("unhandledrejection", event => showError("Error", event.reason));

function assertFirebaseConfigLooksFilled() {
  const raw = JSON.stringify(firebaseConfig);
  if (raw.includes("PASTE_YOUR") || !firebaseConfig.projectId) throw new Error("Firebase configuration is missing.");
}

async function loadFirebase() {
  assertFirebaseConfigLooksFilled();
  const appMod = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`);
  const firestoreMod = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`);
  const app = appMod.initializeApp(firebaseConfig);
  db = firestoreMod.getFirestore(app);
  collection = firestoreMod.collection;
  doc = firestoreMod.doc;
  onSnapshot = firestoreMod.onSnapshot;
  query = firestoreMod.query;
  orderBy = firestoreMod.orderBy;
  serverTimestamp = firestoreMod.serverTimestamp;
  runTransaction = firestoreMod.runTransaction;
}

function normalizeKey(raw) {
  try {
    return decodeURIComponent(raw || "").trim().replace(/^#/, "").replace(/[^a-zA-Z0-9_-]/g, "");
  } catch { return ""; }
}

function getInitialSpaceId() {
  const fromHash = normalizeKey(location.hash.slice(1));
  if (fromHash) {
    localStorage.setItem("quietNotesSpaceId", fromHash);
    return fromHash;
  }
  return normalizeKey(localStorage.getItem("quietNotesSpaceId") || "");
}

async function setSpaceId(key) {
  const clean = normalizeKey(key);
  if (!clean) { setStatus("Secret key is empty"); return; }
  await flushCurrentNote(true);
  await Promise.allSettled([...syncChains.values()]);
  localStorage.setItem("quietNotesSpaceId", clean);
  if (location.hash.slice(1) !== clean) history.replaceState(null, "", `#${clean}`);
  setupNotice.hidden = true;
  await bootSpace(clean);
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]);
}

function sanitize(html) {
  if (!window.DOMPurify) {
    const div = document.createElement("div");
    div.innerHTML = html || "";
    return escapeHtml(div.innerText || div.textContent || "").replace(/\n/g, "<br>");
  }
  return DOMPurify.sanitize(html || "", {
    ALLOWED_TAGS: ["a", "b", "strong", "i", "em", "u", "s", "p", "br", "div", "span", "ul", "ol", "li", "h1", "h2", "h3", "h4", "blockquote", "pre", "code", "hr"],
    ALLOWED_ATTR: ["href", "target", "rel"], ADD_ATTR: ["target"]
  });
}

function textFromHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = sanitize(html);
  return (div.innerText || div.textContent || "").replace(/\u00a0/g, " ").trim();
}
function trimTitle(title) {
  const clean = (title || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled";
  return clean.length > 34 ? `${clean.slice(0, 34)}…` : clean;
}
function titleFromHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = sanitize(html || "");
  const first = div.querySelector("h1, h2, h3, h4, p, div, li, blockquote, pre");
  return trimTitle(first?.innerText || first?.textContent || div.innerText || div.textContent || "");
}
function titleFromNote(note) {
  const title = note?.html ? titleFromHtml(note.html) : trimTitle(note?.text || "");
  return note?.conflictOf ? `Conflict copy · ${title}` : title;
}
function timestampMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}
function formatUpdatedAt(value) {
  const millis = timestampMs(value);
  if (!millis) return "";
  const date = new Date(millis), now = new Date(), yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `今日 ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `昨日 ${time}`;
  return date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

function openLocalDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("notes")) {
        const store = database.createObjectStore("notes", { keyPath: "key" });
        store.createIndex("spaceId", "spaceId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function localRecord(note) { return { ...note, key: `${spaceId}:${note.id}`, spaceId }; }
async function readLocalNotes(targetSpaceId) {
  const transaction = localDb.transaction("notes", "readonly");
  const rows = await idbRequest(transaction.objectStore("notes").index("spaceId").getAll(targetSpaceId));
  return rows.map(({ key, spaceId: ignored, ...note }) => note);
}
function persistLocal(note) {
  const snapshot = localRecord(note);
  const promise = new Promise((resolve, reject) => {
    const transaction = localDb.transaction("notes", "readwrite");
    transaction.objectStore("notes").put(snapshot);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Local save was aborted"));
  });
  localWrites.set(note.id, promise);
  promise.catch(err => showError("Local save error", err));
  return promise;
}
function deleteLocal(id) {
  return new Promise((resolve, reject) => {
    const transaction = localDb.transaction("notes", "readwrite");
    transaction.objectStore("notes").delete(`${spaceId}:${id}`);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function getNote(id) { return notes.find(note => note.id === id); }
function upsertNote(note) {
  const index = notes.findIndex(item => item.id === note.id);
  if (index === -1) notes.push(note); else notes[index] = note;
  notes.sort((a, b) => (b.updatedAtLocal || 0) - (a.updatedAtLocal || 0));
  return note;
}
function notesRef() { return collection(db, "spaces", spaceId, "notes"); }
function noteRef(id) { return doc(db, "spaces", spaceId, "notes", id); }

function renderList() {
  if (!noteList || !search) return;
  const q = search.value.trim().toLowerCase();
  noteList.innerHTML = "";
  for (const note of notes.filter(item => !q || (item.text || "").toLowerCase().includes(q))) {
    const button = document.createElement("button");
    button.className = `noteItem${note.id === currentId ? " selected" : ""}`;
    const title = document.createElement("div");
    title.className = "noteTitle";
    title.textContent = titleFromNote(note);
    const date = document.createElement("div");
    date.className = "noteDate";
    date.textContent = formatUpdatedAt(note.updatedAtLocal || note.updatedAtRemote);
    button.append(title, date);
    button.addEventListener("click", () => selectNote(note.id));
    noteList.appendChild(button);
  }
}

function updateStatusForCurrent() {
  const note = getNote(currentId);
  if (!editorReady) setStatus("Loading…");
  else if (!note || note.syncStatus === "saved") setStatus("Saved");
  else if (note.syncStatus === "error") setStatus(navigator.onLine ? "Sync error" : "Offline");
  else setStatus(navigator.onLine ? "Saving…" : "Offline");
}
function showNote(id, focus = true) {
  const note = getNote(id);
  if (!note) return;
  currentId = id;
  editor.innerHTML = sanitize(note.html || "");
  renderList();
  updateStatusForCurrent();
  if (focus && editorReady) editor.focus();
  if (window.matchMedia("(max-width: 700px)").matches) document.body.classList.remove("sidebar-open");
}
async function selectNote(id) {
  if (id === currentId) return;
  await flushCurrentNote();
  showNote(id);
}

function captureEditorNote() {
  const note = getNote(currentId);
  if (!note || !editorReady) return null;
  const html = sanitize(editor.innerHTML);
  if (html !== editor.innerHTML) editor.innerHTML = html;
  if (html === note.html) return note;
  const updated = { ...note, html, text: textFromHtml(html), updatedAtLocal: Date.now(), syncStatus: "dirty" };
  upsertNote(updated);
  persistLocal(updated);
  renderList();
  updateStatusForCurrent();
  return updated;
}
function syncPayload(note) {
  return {
    id: note.id, html: note.html || "", text: note.text || "",
    createdAt: note.createdAt || note.updatedAtLocal || Date.now(),
    updatedAtLocal: note.updatedAtLocal || Date.now(), revision: Number(note.revision || 0),
    conflictOf: note.conflictOf || null
  };
}
function scheduleSync(note, delay = SYNC_DELAY_MS) {
  if (!note) return;
  const payload = syncPayload(note);
  clearTimeout(syncTimers.get(note.id));
  syncTimers.set(note.id, setTimeout(() => {
    syncTimers.delete(note.id);
    enqueueRemoteSync(payload);
  }, delay));
}
function enqueueRemoteSync(payload) {
  const previous = syncChains.get(payload.id) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => syncNotePayload(payload));
  syncChains.set(payload.id, next);
  next.finally(() => { if (syncChains.get(payload.id) === next) syncChains.delete(payload.id); });
  return next;
}

async function syncNotePayload(payload) {
  const local = getNote(payload.id);
  if (!local) return;
  if (!db || !navigator.onLine) {
    if (local.updatedAtLocal === payload.updatedAtLocal) {
      local.syncStatus = "error";
      await persistLocal(local);
      updateStatusForCurrent();
    }
    return;
  }
  if (local.updatedAtLocal === payload.updatedAtLocal && local.html === payload.html) {
    local.syncStatus = "syncing";
    await persistLocal(local);
    updateStatusForCurrent();
  }
  const effectiveRevision = Number(getNote(payload.id)?.revision ?? payload.revision ?? 0);
  try {
    const outcome = await runTransaction(db, async transaction => {
      const ref = noteRef(payload.id);
      const snapshot = await transaction.get(ref);
      const remote = snapshot.exists() ? snapshot.data() : null;
      const remoteRevision = Number(remote?.revision || 0);
      if (remote && remoteRevision !== effectiveRevision && (remote.html || "") !== payload.html) {
        const conflictRef = doc(notesRef());
        transaction.set(conflictRef, {
          html: payload.html, text: payload.text, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
          updatedAtLocal: payload.updatedAtLocal, revision: 1, conflictOf: payload.id, updatedBy: clientId
        });
        return { kind: "conflict", conflictId: conflictRef.id, remote, remoteRevision };
      }
      if (remote && (remote.html || "") === payload.html) return { kind: "saved", revision: remoteRevision };
      const revision = remoteRevision + 1;
      const data = {
        html: payload.html, text: payload.text, updatedAt: serverTimestamp(),
        updatedAtLocal: payload.updatedAtLocal, revision, updatedBy: clientId
      };
      if (!remote) data.createdAt = serverTimestamp();
      if (payload.conflictOf) data.conflictOf = payload.conflictOf;
      transaction.set(ref, data, { merge: true });
      return { kind: "saved", revision };
    });

    if (outcome.kind === "conflict") {
      const latestBeforeConflict = getNote(payload.id);
      const hasNewerLocalEdit = Boolean(
        latestBeforeConflict &&
        (latestBeforeConflict.updatedAtLocal > payload.updatedAtLocal || latestBeforeConflict.html !== payload.html)
      );
      const remoteNote = remoteDataToLocal(payload.id, outcome.remote, outcome.remoteRevision);
      upsertNote(remoteNote);
      await persistLocal(remoteNote);
      const conflictNote = {
        id: outcome.conflictId,
        html: hasNewerLocalEdit ? latestBeforeConflict.html : payload.html,
        text: hasNewerLocalEdit ? latestBeforeConflict.text : payload.text,
        createdAt: payload.createdAt,
        updatedAtLocal: hasNewerLocalEdit ? latestBeforeConflict.updatedAtLocal : payload.updatedAtLocal,
        updatedAtRemote: Date.now(),
        revision: 1,
        syncStatus: hasNewerLocalEdit ? "dirty" : "saved",
        conflictOf: payload.id
      };
      upsertNote(conflictNote);
      await persistLocal(conflictNote);
      if (currentId === payload.id) showNote(conflictNote.id, false);
      if (hasNewerLocalEdit) scheduleSync(conflictNote, 0);
      renderList();
      updateStatusForCurrent();
      return;
    }

    const latest = getNote(payload.id);
    if (!latest) return;
    latest.revision = outcome.revision;
    latest.updatedAtRemote = Date.now();
    if (latest.updatedAtLocal === payload.updatedAtLocal && latest.html === payload.html) latest.syncStatus = "saved";
    else { latest.syncStatus = "dirty"; scheduleSync(latest); }
    await persistLocal(latest);
    renderList();
    updateStatusForCurrent();
  } catch (err) {
    console.error("Firestore sync failed", err);
    const latest = getNote(payload.id);
    if (latest && latest.updatedAtLocal === payload.updatedAtLocal && latest.html === payload.html) {
      latest.syncStatus = "error";
      await persistLocal(latest);
    }
    updateStatusForCurrent();
  }
}

async function flushCurrentNote(waitForRemote = false) {
  const note = captureEditorNote() || getNote(currentId);
  if (!note) return;
  clearTimeout(syncTimers.get(note.id));
  syncTimers.delete(note.id);
  const localWrite = localWrites.get(note.id);
  if (localWrite) await localWrite.catch(() => {});
  if (note.syncStatus !== "saved") {
    const remoteSave = enqueueRemoteSync(syncPayload(note));
    if (waitForRemote) await remoteSave;
  }
}

async function createNote(options = {}) {
  if (!spaceId) { setupNotice.hidden = false; setStatus("Enter secret key first"); return; }
  if (!options.skipFlush) await flushCurrentNote();
  const now = Date.now();
  const note = {
    id: randomId(), html: "", text: "", createdAt: now, updatedAtLocal: now,
    updatedAtRemote: 0, revision: 0, syncStatus: "dirty"
  };
  upsertNote(note);
  await persistLocal(note);
  showNote(note.id);
  scheduleSync(note, 0);
  return note;
}

function remoteDataToLocal(id, data, forcedRevision) {
  return {
    id, html: sanitize(data?.html || ""), text: data?.text || textFromHtml(data?.html || ""),
    createdAt: timestampMs(data?.createdAt) || data?.updatedAtLocal || Date.now(),
    updatedAtLocal: Number(data?.updatedAtLocal || timestampMs(data?.updatedAt) || Date.now()),
    updatedAtRemote: timestampMs(data?.updatedAt) || Date.now(),
    revision: Number(forcedRevision ?? data?.revision ?? 0), syncStatus: "saved",
    conflictOf: data?.conflictOf || null
  };
}

async function reconcileSnapshot(snapshot, isInitial, authoritative) {
  const remoteIds = new Set(), syncAfter = [];
  for (const documentSnapshot of snapshot.docs) {
    const id = documentSnapshot.id, remote = remoteDataToLocal(id, documentSnapshot.data());
    remoteIds.add(id);
    const local = getNote(id);
    if (!local) { upsertNote(remote); await persistLocal(remote); continue; }
    const unsynced = local.syncStatus !== "saved";
    const remoteIsNewer = remote.revision > Number(local.revision || 0);
    const differs = remote.html !== local.html;
    if (unsynced) {
      if (!differs && remote.revision >= Number(local.revision || 0) && authoritative) {
        local.revision = remote.revision;
        local.updatedAtRemote = remote.updatedAtRemote;
        local.syncStatus = "saved";
        await persistLocal(local);
      } else syncAfter.push(syncPayload(local));
    } else if (remoteIsNewer || (differs && remote.updatedAtLocal > local.updatedAtLocal)) {
      upsertNote(remote);
      await persistLocal(remote);
    }
  }
  if (isInitial && authoritative) {
    for (const local of [...notes]) {
      if (!remoteIds.has(local.id)) {
        if (local.syncStatus === "saved" && Number(local.revision || 0) > 0) {
          notes = notes.filter(note => note.id !== local.id);
          await deleteLocal(local.id);
        } else syncAfter.push(syncPayload(local));
      }
    }
  }
  renderList();
  const current = getNote(currentId);
  if (current && current.syncStatus === "saved" && sanitize(editor.innerHTML) !== current.html) editor.innerHTML = current.html;
  else if (!current && notes.length) showNote(notes[0].id, false);
  updateStatusForCurrent();
  for (const payload of syncAfter) enqueueRemoteSync(payload);
}

function startRealtime(generation) {
  return new Promise(resolve => {
    let first = true;
    unsubscribe = onSnapshot(query(notesRef(), orderBy("updatedAt", "desc")), snapshot => {
      if (generation !== bootGeneration) return;
      const wasFirst = first;
      first = false;
      const authoritative = !snapshot.metadata?.fromCache && !snapshot.metadata?.hasPendingWrites;
      reconcileSnapshot(snapshot, wasFirst, authoritative).catch(err => showError("Sync error", err)).finally(() => { if (wasFirst) resolve(); });
    }, err => {
      console.error("Firestore connection failed", err);
      if (first) resolve();
      first = false;
      unsubscribe = null;
      for (const note of notes) if (note.syncStatus !== "saved") note.syncStatus = "error";
      updateStatusForCurrent();
    });
  });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bootSpace(nextSpaceId) {
  const generation = ++bootGeneration;
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  for (const timer of syncTimers.values()) clearTimeout(timer);
  syncTimers.clear();
  editorReady = false;
  editor.contentEditable = "false";
  editor.setAttribute("aria-busy", "true");
  setStatus("Loading…");
  spaceId = nextSpaceId;
  currentId = null;
  notes = await readLocalNotes(spaceId);
  notes.sort((a, b) => (b.updatedAtLocal || 0) - (a.updatedAtLocal || 0));
  renderList();
  if (notes.length) showNote(notes[0].id, false);
  if (db) await Promise.race([startRealtime(generation), wait(FIRST_REMOTE_WAIT_MS)]);
  if (generation !== bootGeneration) return;
  if (!notes.length) await createNote({ skipFlush: true });
  if (!currentId && notes.length) showNote(notes[0].id, false);
  editorReady = true;
  editor.contentEditable = "true";
  editor.removeAttribute("aria-busy");
  updateStatusForCurrent();
  retryUnsyncedNotes();
}

function retryUnsyncedNotes() {
  if (!db || !navigator.onLine) { updateStatusForCurrent(); return; }
  if (!unsubscribe && spaceId) startRealtime(bootGeneration).catch(err => showError("Sync error", err));
  for (const note of notes) if (note.syncStatus !== "saved") scheduleSync(note, 0);
}

async function deleteCurrentNote() {
  const note = getNote(currentId);
  if (!note || !confirm(`Delete "${titleFromNote(note)}"?`)) return;
  await flushCurrentNote(true);
  if (currentId !== note.id) {
    setStatus("Conflict copy created");
    return;
  }
  clearTimeout(syncTimers.get(note.id));
  try {
    if (db && navigator.onLine) {
      await runTransaction(db, async transaction => {
        const ref = noteRef(note.id), snapshot = await transaction.get(ref);
        if (snapshot.exists()) {
          const remote = snapshot.data(), remoteRevision = Number(remote.revision || 0);
          if (remoteRevision !== Number(note.revision || 0) && (remote.html || "") !== note.html) {
            throw new Error("This note changed on another device. It was not deleted.");
          }
          transaction.delete(ref);
        }
      });
    } else if (Number(note.revision || 0) > 0) throw new Error("Offline: reconnect before deleting this synced note.");
    notes = notes.filter(item => item.id !== note.id);
    await deleteLocal(note.id);
    currentId = null;
    if (!notes.length) await createNote({ skipFlush: true }); else showNote(notes[0].id);
    renderList();
  } catch (err) {
    note.syncStatus = "error";
    await persistLocal(note);
    showError("Delete error", err);
  }
}

function exportHtml() {
  const body = notes.map(note => `<section><h1>${escapeHtml(titleFromNote(note))}</h1>${sanitize(note.html || "")}</section><hr>`).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Quiet Notes Export</title></head><body>${body}</body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `quiet-notes-export-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function wireUi() {
  editor = $("editor"); noteList = $("noteList"); search = $("search"); status = $("status");
  setupNotice = $("setupNotice"); spaceKeyInput = $("spaceKeyInput");
  if (!editor || !noteList || !search || !status) throw new Error("Required HTML elements are missing.");
  editor.contentEditable = "false";
  editor.addEventListener("input", () => { const note = captureEditorNote(); if (note) scheduleSync(note); });
  search.addEventListener("input", renderList);
  $("newNote").addEventListener("click", () => createNote().catch(err => showError("Create error", err)));
  $("deleteNote").addEventListener("click", () => deleteCurrentNote());
  $("exportHtml").addEventListener("click", exportHtml);
  $("openList")?.addEventListener("click", () => document.body.classList.add("sidebar-open"));
  $("sidebarBackdrop")?.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
  $("useKey")?.addEventListener("click", () => setSpaceId(spaceKeyInput.value));
  spaceKeyInput?.addEventListener("keydown", event => { if (event.key === "Enter") setSpaceId(spaceKeyInput.value); });
  $("makeKey")?.addEventListener("click", () => {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    const key = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    if (spaceKeyInput) spaceKeyInput.value = key;
    setSpaceId(key);
  });
}

function preserveCurrentLocally() {
  const note = captureEditorNote();
  if (note) persistLocal(note);
}

async function main() {
  wireUi();
  setStatus("Loading…");
  localDb = await openLocalDatabase();
  spaceId = getInitialSpaceId();
  if (!spaceId) { setupNotice.hidden = false; setStatus("Waiting for secret key"); }
  else setupNotice.hidden = true;
  const firebaseLoad = loadFirebase().catch(err => {
    console.error("Firebase is unavailable; local mode continues", err);
  });
  if (spaceId) {
    await Promise.race([firebaseLoad, wait(5000)]);
    await bootSpace(spaceId);
  }
  firebaseLoad.then(() => {
    if (db && spaceId && !unsubscribe) {
      startRealtime(bootGeneration).catch(err => showError("Sync error", err));
      retryUnsyncedNotes();
    }
  });
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") preserveCurrentLocally(); });
window.addEventListener("pagehide", preserveCurrentLocally);
window.addEventListener("online", retryUnsyncedNotes);
window.addEventListener("offline", updateStatusForCurrent);
window.addEventListener("beforeunload", () => { preserveCurrentLocally(); if (unsubscribe) unsubscribe(); });
main().catch(err => showError("Startup error", err));
