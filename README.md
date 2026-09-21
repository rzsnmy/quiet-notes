# Quiet Notes PWA — Local-first edition

A tiny personal notes web app:

- multiple notes
- rich text paste
- simple search
- immediate local autosave in IndexedDB
- delayed Firestore sync with automatic retry
- conflict copies instead of silent overwrites
- PWA manifest
- service worker
- no login
- no folders
- no tags

## Files

- `index.html`
- `style.css`
- `app.js`
- `manifest.webmanifest`
- `sw.js`
- `icons/`

## Setup

1. Create a Firebase project.
2. Create a Firestore database.
3. Register a Web app in Firebase.
4. Copy your `firebaseConfig` into `app.js`.
5. Create a long secret key in the app.
6. Put that key into Firestore Security Rules.
7. Upload these files to GitHub Pages.
8. Open the app with `#YOUR_SECRET_KEY` at the end of the URL.
9. Add it to Home Screen / Dock.

## How saving works

Every edit is written to IndexedDB on this device first. Firestore is the second layer used to sync other devices. If Firestore or the network is unavailable, the local copy remains and is retried on the next launch, edit, or reconnect.

The status in the top-right means:

- `Saving…`: safe locally; waiting for or sending cloud sync
- `Saved`: local and Firestore copies are synchronized
- `Offline`: safe locally; cloud sync will retry after reconnecting
- `Sync error`: safe locally; Firestore rejected or failed to accept the change

If two devices independently edit the same revision, Quiet Notes creates a separate `Conflict copy` so neither version is silently discarded.

## Firestore rules template

Replace `YOUR_LONG_SECRET_KEY`:

```js
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /spaces/YOUR_LONG_SECRET_KEY/notes/{noteId} {
      allow read, write: if true;
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

This is not full authentication. Anyone with the exact secret key can read/write.
Do not use this for passwords, addresses, visa documents, medical documents, or other sensitive information.

deploy retry 

## Important privacy note

The secret-key rule is not full authentication or encryption. Anyone who learns the key can read and write that space. Do not store passwords or highly sensitive personal information in this app.
