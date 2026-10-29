# Property Stalkers app (Android and iPhone)

The app opens propertystalkers.com inside a native shell (Capacitor), so every change to the site shows in the app too.
Code that should only run inside the app checks `IN_APP` in `public/index.html`.

- Android preview: every change to this folder builds a new installable file on GitHub
  (Actions → "Android preview app"), attached to the `android-preview` release.
- iPhone: needs an Apple Developer account ($99/year) for TestFlight previews and the App Store.

Files: `capacitor.config.json` (app name, id, colours), `assets/` (icon and splash, made into every size at build time),
`www/offline.html` (shown when there is no internet), `scripts/patch-android.mjs` (permissions and version number),
`preview.keystore` (preview signing key only; the Play Store build will use a private key).
