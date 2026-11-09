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

The web app (`index.html`, `app.js`, `style.css`) is the whole app. The `android/` and `ios/` folders are [Capacitor](https://capacitorjs.com) shells that bundle it.

```
npm install
node serve.js       # try it on your PC at http://localhost:8080
npm run sync        # copy web changes into android/ and ios/
npm run android     # open in Android Studio to run on a plugged-in phone
```
After changing `assets/icon-*.png` or the splash images, run `npx capacitor-assets generate --android --ios`.

Inside the phone app, **Export backup** opens the share sheet (save to Drive, Files, email…), and the screen stays awake while it's listening.

## Using it
1. Set up your racket (**Edit**): string bed size, string gauge, and the tension it was strung at.
2. **Start listening**, then flick the centre of the strings 3 times.
3. After a fresh restring, press **Calibrate…** and enter the strung tension. Every later reading on that racket will be much more accurate.
4. **Save reading** to track tension loss over time. The app warns you once the loss passes your restring threshold.

## How it works
The string bed is modelled as a drum membrane. Its pitch is f = 2.405·c / (2πR), where the wave speed is c = √(T / 2μ), T is the string tension, μ is the string's mass per metre (from the gauge), and R is the radius of a circle with the same area as the head. A 0.8 empirical factor accounts for frame flex and air loading. Calibration then scales the result for each racket. Pitch is found with a 32k-point FFT over 150 ms just after each tap, with parabolic peak interpolation, and the reading is the median of several taps.

Data is stored only on your phone (localStorage). Use **Export backup** to keep a copy.
