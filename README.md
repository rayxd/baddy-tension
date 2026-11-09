# Baddy Tension

A phone web app that listens to you tap your badminton strings and estimates the tension.

## Put it on your phone

### Android app (APK)
Every push to the default branch builds the app with GitHub Actions (`.github/workflows/android.yml`) and publishes it as a release.

1. On your Android phone, open
   **https://github.com/rayxd/baddy-tension/releases/latest/download/baddy-tension.apk**
2. Open the downloaded file. If Android asks, allow your browser to *install unknown apps*.
3. Open **Baddy Tension** and allow the microphone when asked.

New builds install over the old one and keep your rackets and history, because the APK is always signed with the same key (`android/app/debug.keystore`). This is a debug key, which is fine for installing it yourself. For the Play Store you would need your own release key.

Builds from other branches skip the release: get the APK from the run's **Artifacts** on the Actions tab.

### iPhone app
This needs a Mac with Xcode (a free Apple ID works for your own phone, but the app expires after 7 days; a paid developer account removes that limit).

```
npm install
npm run ios        # copies the web app in and opens Xcode
```
In Xcode pick your phone as the target, set your team under *Signing & Capabilities*, then press Run.

### Web app (any phone, no install)
Phones only allow microphone access over **https**, so the web version needs hosting. Turn on GitHub Pages (Settings → Pages → "Deploy from branch"), or drag the folder onto https://app.netlify.com/drop. Open the link on your phone and add it to your home screen.

## Developing

The web app (`index.html`, `app.js`, `scene3d.js`, `style.css`) is the whole app. Fonts (Saira Condensed, IBM Plex Sans, JetBrains Mono; OFL) are bundled in `vendor/fonts/`. `scene3d.js` draws the 3D racket with [three.js](https://threejs.org) (r160, MIT, bundled in `vendor/` so it works offline). Real taps drive it: each tap rings the strings and sends a wave across the screen, rejected taps fade out grey or orange, and a confirmed reading turns the racket to face you. With Reduce Motion on, the racket stays still and only changes colour; without WebGL, a flat racket picture stands in. The `android/` and `ios/` folders are [Capacitor](https://capacitorjs.com) shells that bundle it.

```
npm install
node serve.js       # try it on your PC at http://localhost:8080
npm run sync        # copy web changes into android/ and ios/
npm run android     # open in Android Studio to run on a plugged-in phone
```
After changing `assets/icon-*.png` or the splash images, run `npx capacitor-assets generate --android --ios`.

Inside the phone app, **Export backup** opens the share sheet (save to Drive, Files, email…), and the screen stays awake while it's listening.

## Using it
1. Tap the racket name at the top to pick or add a racket: its model, string, and the tension it was strung at.
2. Press **Start listening**, then flick the centre of the strings 3 times. Each tap rings the 3D strings and sends a wave across the screen; when the taps agree, the racket turns to face you and the reading is confirmed, with a ± showing how closely the taps agreed.
3. After a fresh restring, set the date strung to today. The app offers to calibrate on your next reading, which makes every later reading on that racket much more accurate.
4. **Save reading** to track tension loss. Swipe up on the reading (or tap ☰) for history, the sound spectrum, settings and backups.
5. Swipe left or right on the racket to switch rackets.

## How it works
The string bed is modelled as a drum membrane. Its pitch is f = 2.405·c / (2πR), where the wave speed is c = √(T / 2μ), T is the string tension, μ is the string's mass per metre (from the gauge), and R is the radius of a circle with the same area as the head. That sets the tension at 1200 Hz for your racket and string. Away from 1200 Hz, tension follows pitch^1.47 instead of the ideal pitch², because real frames give a little more at higher tension. Calibration then scales the result for each racket.

The 0.88 frame factor and the 1.47 exponent were fitted to a reference recording of one racket strung at four tensions. The fit is within 0.3 lbs at every point:

| Strung at | Pitch | App reads |
|---|---|---|
| 24 lbs | 1177 Hz | 24.0 lbs |
| 26 lbs | 1237 Hz | 25.8 lbs |
| 28 lbs | 1316 Hz | 28.3 lbs |
| 30 lbs | 1362 Hz | 29.7 lbs |

Pitch is found with a 32k-point FFT over 120 ms just after each tap, with parabolic peak interpolation. Only 600–1800 Hz is searched. The second ring mode (about 1.56× the fundamental) is often as loud as the fundamental, so the app takes the lowest clear peak within 12 dB of the loudest one. It also skips any tap that reads 1.45–1.75× the others. Sounds whose peak is under 20 dB above the background, such as talking, are ignored. The reading is the median of several taps.

Data is stored only on your phone (localStorage). Use **Export backup** to keep a copy.
