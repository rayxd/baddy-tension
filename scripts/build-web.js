// Copies the web app into www/, which Capacitor bundles into the phone app.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const FILES = [
  'index.html', 'app.js', 'scene3d.js', 'style.css', 'sw.js', 'manifest.webmanifest',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'vendor/three.module.min.js',
  'vendor/fonts/ibm-plex-sans-latin-400-normal.woff2',
  'vendor/fonts/ibm-plex-sans-latin-600-normal.woff2',
  'vendor/fonts/jetbrains-mono-latin-400-normal.woff2',
  'vendor/fonts/jetbrains-mono-latin-600-normal.woff2',
  'vendor/fonts/saira-condensed-latin-600-normal.woff2',
  'vendor/fonts/saira-condensed-latin-700-normal.woff2',
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of FILES) {
  fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
  fs.copyFileSync(path.join(root, f), path.join(out, f));
}
console.log(`Copied ${FILES.length} files to www/`);
