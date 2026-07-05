# Quiet Notes PWA Starter

A tiny personal notes web app:

- multiple notes
- rich text paste
- simple search
- autosave
- Firestore sync
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

PWA deploy retry.
