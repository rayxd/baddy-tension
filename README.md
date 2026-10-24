# Baddy Tension

A phone web app that listens to you tap your badminton strings and estimates the tension.

## Put it on your phone

Phones only allow microphone access over **https**, so the app needs hosting. Both options below are free:

**Netlify Drop (quickest, no git needed)**
1. Go to https://app.netlify.com/drop on your PC.
2. Drag this whole `BaddyApp` folder onto the page.
3. Open the `https://….netlify.app` link it gives you on your phone.
4. Add it to your home screen: Share → *Add to Home Screen* on iPhone (Safari), or ⋮ → *Install app* on Android (Chrome).

**GitHub Pages**: push the folder to a GitHub repo, then turn on Settings → Pages → "Deploy from branch".

## Run it locally (PC only)

```
node serve.js
```
Then open http://localhost:8080. A PC microphone works on localhost.

## Using it
1. Set up your racket (**Edit**): string bed size, string gauge, and the tension it was strung at.
2. **Start listening**, then flick the centre of the strings 3 times.
3. After a fresh restring, press **Calibrate…** and enter the strung tension. Every later reading on that racket will be much more accurate.
4. **Save reading** to track tension loss over time. The app warns you once the loss passes your restring threshold.

## How it works
The string bed is modelled as a drum membrane. Its pitch is f = 2.405·c / (2πR), where the wave speed is c = √(T / 2μ), T is the string tension, μ is the string's mass per metre (from the gauge), and R is the radius of a circle with the same area as the head. A 0.8 empirical factor accounts for frame flex and air loading. Calibration then scales the result for each racket. Pitch is found with a 32k-point FFT over 150 ms just after each tap, with parabolic peak interpolation, and the reading is the median of several taps.

Data is stored only on your phone (localStorage). Use **Export backup** to keep a copy.
