/*
  Quiet Notes - debug/fix version

  Paste your Firebase config below.
  Firebase Console > Project settings > General > Your apps > SDK setup and configuration > Config
*/
const firebaseConfig = {
  apiKey: "AIzaSyC7SK1Ztw_hgYt7xkNh3JOxLTkThzwXdEo",
  authDomain: "minimum-notepad.firebaseapp.com",
  projectId: "minimum-notepad",
  storageBucket: "minimum-notepad.firebasestorage.app",
  messagingSenderId: "933732498861",
  appId: "1:933732498861:web:474bc75de238367cfab524"
};

// Stable Firebase CDN version.
const FIREBASE_VERSION = "10.12.2";

const $ = (id) => document.getElementById(id);

let editor;
let noteList;
let search;
let status;
let setupNotice;
let spaceKeyInput;

let db;
let collection;
let addDoc;
let doc;
let updateDoc;
let deleteDoc;
let onSnapshot;
let query;
let orderBy;
let serverTimestamp;

let spaceId = "";
let notes = [];
let currentId = null;
let saveTimer = null;
let unsubscribe = null;
let lastSavedHtml = "";

function setStatus(text) {
  if (status) status.textContent = text;
}

function showError(label, err) {
  console.error(label, err);
  const text = err && (err.message || err.code || String(err)) ? (err.message || err.code || String(err)) : String(err);
  setStatus(`${label}: ${text}`);
}

window.addEventListener("error", (event) => {
  showError("script error", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showError("promise error", event.reason);
});

function assertFirebaseConfigLooksFilled() {
  const raw = JSON.stringify(firebaseConfig);
  if (raw.includes("PASTE_YOUR")) {
    throw new Error("firebaseConfig is still placeholder. Paste your Firebase config into app.js.");
  }
  if (!firebaseConfig.projectId || firebaseConfig.projectId.includes("PASTE")) {
    throw new Error("firebaseConfig.projectId is missing.");
  }
}

async function loadFirebase() {
  setStatus("loading firebase…");

  const appMod = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`);
  const firestoreMod = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`);

  const app = appMod.initializeApp(firebaseConfig);

  db = firestoreMod.getFirestore(app);
  collection = firestoreMod.collection;
  addDoc = firestoreMod.addDoc;
  doc = firestoreMod.doc;
  updateDoc = firestoreMod.updateDoc;
  deleteDoc = firestoreMod.deleteDoc;
  onSnapshot = firestoreMod.onSnapshot;
  query = firestoreMod.query;
  orderBy = firestoreMod.orderBy;
  serverTimestamp = firestoreMod.serverTimestamp;

  setStatus("firebase loaded");
}

function normalizeKey(raw) {
  return decodeURIComponent(raw || "")
    .trim()
    .replace(/^#/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

function getInitialSpaceId() {
  const fromHash = normalizeKey(location.hash.slice(1));
  if (fromHash) {
    localStorage.setItem("quietNotesSpaceId", fromHash);
    return fromHash;
  }
  return normalizeKey(localStorage.getItem("quietNotesSpaceId") || "");
}

function setSpaceId(key) {
  const clean = normalizeKey(key);
  if (!clean) {
    setStatus("secret key is empty");
    return;
  }

  localStorage.setItem("quietNotesSpaceId", clean);
  spaceId = clean;

  if (location.hash.slice(1) !== clean) {
    history.replaceState(null, "", "#" + clean);
  }

  setupNotice.hidden = true;

  if (!unsubscribe && db) {
    startRealtime();
  }
}

function sanitize(html) {
  if (!window.DOMPurify) {
    const div = document.createElement("div");
    div.innerHTML = html || "";
    return div.innerText || "";
  }

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "a", "b", "strong", "i", "em", "u", "s",
      "p", "br", "div", "span",
      "ul", "ol", "li",
      "h1", "h2", "h3", "h4",
      "blockquote",
      "pre", "code",
      "hr"
    ],
    ALLOWED_ATTR: ["href", "target", "rel"],
    ADD_ATTR: ["target"]
  });
}

function textFromHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = sanitize(html);
  return div.innerText.replace(/\u00a0/g, " ").trim();
}

function titleFromText(text) {
  const first = text.split(/\n/).map(s => s.trim()).find(Boolean);
  if (!first) return "Untitled";
  return first.length > 34 ? first.slice(0, 34) + "…" : first;
}

function notesRef() {
  return collection(db, "spaces", spaceId, "notes");
}

function noteRef(id) {
  return doc(db, "spaces", spaceId, "notes", id);
}

function renderList() {
  const q = search.value.trim().toLowerCase();
  noteList.innerHTML = "";

  const filtered = notes.filter(n => {
    if (!q) return true;
    return (n.text || "").toLowerCase().includes(q);
  });

  for (const note of filtered) {
    const button = document.createElement("button");
    button.className = "noteItem" + (note.id === currentId ? " selected" : "");
    button.textContent = titleFromText(note.text || "");
    button.addEventListener("click", () => selectNote(note.id));
    noteList.appendChild(button);
  }
}

function selectNote(id) {
  const note = notes.find(n => n.id === id);
  if (!note) return;

  currentId = id;
  const safeHtml = sanitize(note.html || "");
  editor.innerHTML = safeHtml;
  lastSavedHtml = safeHtml;
  renderList();
  editor.focus();
  setStatus("saved");
}

async function createNote() {
  if (!spaceId) {
    setupNotice.hidden = false;
    setStatus("enter secret key first");
    return;
  }

  setStatus("creating…");
  const ref = await addDoc(notesRef(), {
    html: "",
    text: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  currentId = ref.id;
  editor.innerHTML = "";
  lastSavedHtml = "";
  setStatus("saved");
  editor.focus();
}

async function saveNow() {
  if (!currentId) return;

  const cleanHtml = sanitize(editor.innerHTML);

  if (cleanHtml !== editor.innerHTML) {
    editor.innerHTML = cleanHtml;
  }

  if (cleanHtml === lastSavedHtml) {
    setStatus("saved");
    return;
  }

  setStatus("saving…");

  await updateDoc(noteRef(currentId), {
    html: cleanHtml,
    text: textFromHtml(cleanHtml),
    updatedAt: serverTimestamp()
  });

  lastSavedHtml = cleanHtml;
  setStatus("saved");
}

function scheduleSave() {
  setStatus("editing…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow().catch(err => showError("save error", err));
  }, 650);
}

function startRealtime() {
  if (!spaceId) {
    setupNotice.hidden = false;
    setStatus("waiting for secret key");
    return;
  }

  setStatus("connecting…");

  const q = query(notesRef(), orderBy("updatedAt", "desc"));

  unsubscribe = onSnapshot(q, snapshot => {
    notes = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    renderList();

    if (!currentId && notes.length > 0) {
      selectNote(notes[0].id);
      return;
    }

    if (currentId) {
      const current = notes.find(n => n.id === currentId);
      if (!current) {
        currentId = notes[0]?.id || null;
        if (currentId) selectNote(currentId);
        else editor.innerHTML = "";
        return;
      }

      if (document.activeElement !== editor) {
        const safeHtml = sanitize(current.html || "");
        editor.innerHTML = safeHtml;
        lastSavedHtml = safeHtml;
      }
    }

    setStatus("saved");
  }, err => {
    showError("connection error", err);
  });
}

function exportHtml() {
  const body = notes.map(note => {
    const title = titleFromText(note.text || "");
    return `<section><h1>${escapeHtml(title)}</h1>${sanitize(note.html || "")}</section><hr>`;
  }).join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Quiet Notes Export</title></head><body>${body}</body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `quiet-notes-export-${new Date().toISOString().slice(0,10)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[ch]);
}

function wireUi() {
  editor = $("editor");
  noteList = $("noteList");
  search = $("search");
  status = $("status");
  setupNotice = $("setupNotice");
  spaceKeyInput = $("spaceKeyInput");

  if (!editor || !noteList || !search || !status) {
    throw new Error("Required HTML elements are missing. Upload the PWA index.html too.");
  }

  editor.addEventListener("input", scheduleSave);

  editor.addEventListener("paste", () => {
    setTimeout(scheduleSave, 0);
  });

  search.addEventListener("input", renderList);

  $("newNote").addEventListener("click", () => {
    createNote().catch(err => showError("create error", err));
  });

  $("deleteNote").addEventListener("click", async () => {
    if (!currentId) return;
    const note = notes.find(n => n.id === currentId);
    const label = titleFromText(note?.text || "");
    if (!confirm(`Delete "${label}"?`)) return;

    const id = currentId;
    currentId = null;
    editor.innerHTML = "";
    await deleteDoc(noteRef(id));
  });

  $("exportHtml").addEventListener("click", exportHtml);

  $("useKey")?.addEventListener("click", () => {
    setSpaceId(spaceKeyInput.value);
  });

  spaceKeyInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") setSpaceId(spaceKeyInput.value);
  });

  $("makeKey")?.addEventListener("click", () => {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    const key = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    if (spaceKeyInput) spaceKeyInput.value = key;
    setSpaceId(key);
  });
}

async function main() {
  wireUi();
  setStatus("starting…");

  assertFirebaseConfigLooksFilled();

  spaceId = getInitialSpaceId();

  if (!spaceId) {
    setupNotice.hidden = false;
    setStatus("waiting for secret key");
  } else {
    localStorage.setItem("quietNotesSpaceId", spaceId);
    setupNotice.hidden = true;
  }

  await loadFirebase();

  if (spaceId) {
    startRealtime();
  }
}

window.addEventListener("beforeunload", () => {
  if (unsubscribe) unsubscribe();
});

main().catch(err => {
  showError("startup error", err);
});
