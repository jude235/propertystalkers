// Runs after "npx cap add android": adds the permissions the app needs and sets the version.
import fs from "node:fs";
const manifest = "android/app/src/main/AndroidManifest.xml";
let m = fs.readFileSync(manifest, "utf8");
const perms = [
  "android.permission.ACCESS_COARSE_LOCATION", // "Use my location" and the locate button
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.CAMERA" // taking listing photos straight from the camera
];
for (const p of perms) if (!m.includes(p)) m = m.replace("</manifest>", `    <uses-permission android:name="${p}" />\n</manifest>`);
if (!m.includes("android.hardware.camera")) m = m.replace("</manifest>", `    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    <uses-feature android:name="android.hardware.location.gps" android:required="false" />\n</manifest>`);
fs.writeFileSync(manifest, m);

const gradle = "android/app/build.gradle";
let g = fs.readFileSync(gradle, "utf8");
const code = Number(process.env.VERSION_CODE || 1);
const name = process.env.VERSION_NAME || "1.0." + code;
g = g.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${name}"`);
fs.writeFileSync(gradle, g);
console.log("Android project patched:", { code, name });
