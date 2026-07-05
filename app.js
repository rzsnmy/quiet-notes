import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

/*
  1. Firebase Console > Project settings > Your apps > SDK setup and configuration
  2. Copy your own firebaseConfig object here.
*/
cconst firebaseConfig = {
  apiKey: "AIzaSyC7SK1Ztw_hgYt7xkNh3JOxLTkThzwXdEo",
  authDomain: "minimum-notepad.firebaseapp.com",
  projectId: "minimum-notepad",
  storageBucket: "minimum-notepad.firebasestorage.app",
  messagingSenderId: "933732498861",
  appId: "1:933732498861:web:474bc75de238367cfab524"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);

const editor = $("editor");
const noteList = $("noteList");
const search = $("search");
const status = $("status");
const setupNotice = $("setupNotice");
const spaceKeyInput = $("spaceKeyInput");

let spaceId = getInitialSpaceId();
let notes = [];
let currentId = null;
let saveTimer = null;
let unsubscribe = null;
let lastSavedHtml = "";

const sanitize = (html) => DOMPurify.sanitize(html, {
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
  if (!clean) return;
  localStorage.setItem("quietNotesSpaceId", clean);
  spaceId = clean;
  if (location.hash.slice(1) !== clean) {
    history.replaceState(null, "", "#" + clean);
  }
  setupNotice.hidden = true;
  if (!unsubscribe) startRealtime();
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

function setStatus(text) {
  status.textContent = text;
}

function showSetupIfNeeded() {
  if (!spaceId) {
    setupNotice.hidden = false;
    return true;
  }
  localStorage.setItem("quietNotesSpaceId", spaceId);
  setupNotice.hidden = true;
  return false;
}

$("useKey").addEventListener("click", () => {
  setSpaceId(spaceKeyInput.value);
});

spaceKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") setSpaceId(spaceKeyInput.value);
});

$("makeKey").addEventListener("click", () => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  spaceKeyInput.value = key;
  setSpaceId(key);
});

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
    saveNow().catch(err => {
      console.error(err);
      setStatus("save error");
    });
  }, 650);
}

function startRealtime() {
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

      // Do not disturb the caret while typing.
      if (document.activeElement !== editor) {
        const safeHtml = sanitize(current.html || "");
        editor.innerHTML = safeHtml;
        lastSavedHtml = safeHtml;
      }
    }

    setStatus("saved");
  }, err => {
    console.error(err);
    setStatus("connection error");
  });
}

editor.addEventListener("input", scheduleSave);

editor.addEventListener("paste", () => {
  // Let the browser paste rich text first, then sanitize and save.
  setTimeout(scheduleSave, 0);
});

search.addEventListener("input", renderList);

$("newNote").addEventListener("click", () => {
  createNote().catch(err => {
    console.error(err);
    setStatus("create error");
  });
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

$("exportHtml").addEventListener("click", () => {
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
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[ch]);
}

window.addEventListener("beforeunload", () => {
  if (unsubscribe) unsubscribe();
});

if (!showSetupIfNeeded()) {
  startRealtime();
}
