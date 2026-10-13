# GeoFS Utilities

A small collection of tools and quality-of-life improvements for GeoFS.

This repository currently contains:

- **GeoFS A350 BTV v1.0.3** — Airbus A350-inspired Brake-To-Vacate, runway overrun monitoring/protection, airport moving map, landing-performance prediction, Analog Brakes integration, and embedded A350-style aural callouts.
- **GeoFS Analog Brakes v1.0.0** — proportional wheel braking from a joystick/pedal axis instead of the normal on/off brake input.

---

## GeoFS A350 BTV v1.0.3

Airbus A350-inspired Brake-To-Vacate (BTV), runway overrun monitoring/protection (ROW/ROP), airport moving map, and landing-performance visualization for GeoFS.

### What you need

- GeoFS
- Tampermonkey
- Optional: **GeoFS Analog Brakes v1.0.0** for calibrated pedal input and manual BTV takeover

### Installation

1. Install **Tampermonkey** in your browser if you do not already have it.
2. Open the userscript here on GitHub:
   **[GeoFS_A350_BTV_v1.0.3.user.js](./a350-btv/GeoFS_A350_BTV_v1.0.3.user.js)**
3. On the file page, click **Raw** in the top-right area of the code view.
4. Tampermonkey should open its installation screen automatically.
5. Click **Install**.
6. Open GeoFS or reload the GeoFS page completely.

If Tampermonkey does not open the installation screen automatically, open the Tampermonkey dashboard, create a new script, paste in the complete contents of the `.user.js` file, save it, and reload GeoFS.

On current Chrome-based browsers, Tampermonkey may also require **Allow User Scripts** to be enabled in the extension settings.

### Main features

- Remote ICAO airport loading before TOD / descent, even when the destination is far outside GeoFS `nearRunways`.
- Airport-wide runway/taxiway preload for fast runway changes after the initial airport load.
- Interactive airport map using GeoFS' existing Leaflet environment.
- Runway and landing-direction selection.
- Selectable 90-degree exits and forward high-speed exits.
- Default target speeds:
  - Standard / 90-degree exit: **10 kt**
  - High-speed exit: **25 kt**
- Automatic runway-end fallback when no taxiway exit is selected:
  - **10 kt at 300 m before runway end**.
- Automatic BTV braking after touchdown; no manual ARM button required.
- A350-style BTV authority:
  - Normal BTV ceiling: **0.20 g**
  - Missed-exit authority: up to **0.35 g**
- ROP maximum-braking protection when a runway overrun is predicted.
- Manual brake takeover with GeoFS Analog Brakes integration.
- Pilot brake takeover is latched for the landing cycle and triggers **AUTOBRAKE OFF**.
- Reverse thrust remains pilot-controlled; BTV accounts for its deceleration.
- MAX REV detection for the GeoFS A350 at approximately **80% reverse thrust**.
- Magenta maximum-braking prediction lines for **NO REV** and **MAX REV** assumptions.
- TDZ reference based on the actual landing threshold when threshold/displaced-threshold data is available.
- Learned GeoFS full-brake performance calibration.
- Compact SETUP/LIVE UI with draggable panel and draggable collapsed launcher.
- GeoFS keyboard shortcuts are suppressed while typing in BTV input fields.
- Once the selected BTV target is complete, all BTV/ROW/ROP landing-cycle aurals are immediately silenced and inhibited for the remainder of that rollout.

### Active A350-style aurals

The following callouts are implemented and operationally validated in GeoFS:

- **RUNWAY TOO SHORT**
- **AUTOBRAKE OFF**
- **BRAKE / MAX BRAKING, MAX BRAKING**
- **SET MAX REVERSE**

Aural playback includes priority/queue handling to prevent overlapping callouts.

### Analog Brakes interoperability

GeoFS Analog Brakes v1.0.0 is supported through its public API (`GeoFSStandaloneAnalogBrakes`).

During BTV braking, partial pedal input can blend with the automatic controller. When the pilot brake demand reaches or exceeds the current BTV command, BTV disconnects and the pilot takes over. The disconnect is latched for the remainder of the landing cycle.

### Landing-performance display

The NO REV / MAX REV lines are simulator performance aids, not certified Airbus landing-performance data. They use GeoFS-observed/calibrated braking behavior and are intended to show whether the runway is likely to be sufficient and approximately where maximum braking would stop the aircraft.

The planned touchdown speed can be entered manually. The prediction is anchored to the TDZ reference and remains fixed through the rollout for comparison with the actual stopping point.

### Data sources / network access

- GeoFS supplies live aircraft state and, when available nearby, its own runway geometry.
- OurAirports provides a public-domain remote runway fallback by ICAO so destination airports can be loaded before TOD.
- OpenStreetMap supplies airport taxiway and threshold geometry through the standard OSM map API.
- OpenStreetMap tiles are used for the airport moving map.

The first remote-airport lookup downloads the current OurAirports runway dataset once for the GeoFS page session; later remote ICAO lookups reuse it from memory. OSM requests remain limited to the selected airport area. The script does not require Overpass.

### Notes

- Current profile is tuned for the Airbus A350 in GeoFS.
- GeoFS currently exposes a largely fixed aircraft mass model; mass-dependent landing-performance modeling is therefore not yet used for braking predictions.
- Runway-condition-specific DRY/WET/CONTAM performance is not yet modeled as certified Airbus data.
- This is a flight-simulator enhancement only and must not be used for real-world flight planning or aircraft operation.

---

## GeoFS Analog Brakes v1.0.0

Normally, braking in GeoFS is essentially an on/off input. This script lets the braking force follow a physical axis from 0% to 100%, so you can brake progressively instead of always applying full braking.

### What you need

- GeoFS
- Tampermonkey
- A controller with an axis you want to use for braking

### Installation

1. Install **Tampermonkey** in your browser if you do not already have it.
2. Open the userscript here on GitHub:
   **[GeoFS_Analog_Brakes_v1.0.0.user.js](./analog-brakes/GeoFS_Analog_Brakes_v1.0.0.user.js)**
3. On the file page, click **Raw** in the top-right area of the code view.
4. Tampermonkey should open its installation screen automatically.
5. Click **Install**.
6. Open GeoFS or reload the GeoFS page completely.

If Tampermonkey does not open the installation screen automatically, open the Tampermonkey dashboard, create a new script, paste in the complete contents of the `.user.js` file, save it, and reload GeoFS.

On current Chrome-based browsers, Tampermonkey may also require **Allow User Scripts** to be enabled in the extension settings.

### First setup

When GeoFS is open, the **ANALOG BRAKES** panel should appear on screen.

1. Move the brake pedal or axis you want to use.
2. Under **SELECT BRAKE AXIS**, choose the device and local axis whose **RAW** value moves with your input.
3. Release the brake completely and click **SET RELEASED**.
4. Press the brake fully and click **SET FULL**.
5. Move the pedal slowly through its travel and check that **BRAKE** moves smoothly from 0% to 100%.

The selected device, local axis and calibration are saved automatically.

The temporary runtime `AX` number shown by the browser can change after reconnecting devices or restarting the browser. The script does **not** use that number as the permanent identity of your brake device, so the saved binding can reconnect to the same physical controller automatically.

### Moving and hiding the panel

The full Analog Brakes panel can be dragged by its top bar, so you can move it away from the normal GeoFS interface.

Click the **−** button to collapse it. The small **BRAKES** button can also be dragged independently. Click that button normally to open the full panel again.

Both positions are saved and restored the next time you open GeoFS.

### Reconnecting hardware

If the selected controller is disconnected while GeoFS is running, the script waits for that device instead of silently switching to another one.

When the same device comes back, it reconnects automatically and keeps the existing calibration.

If two connected devices report exactly the same hardware identity, braking is blocked rather than guessing which device should be used.

### Native GeoFS full braking

GeoFS native full braking still has priority at the full-brake endpoint. If GeoFS reports native full braking, the custom analog brake force yields to it instead of stacking another full braking force on top.

### Troubleshooting

**The panel does not appear**  
Make sure the script is enabled in Tampermonkey and reload the GeoFS page completely.

**The script says `SELECT AXIS`**  
Choose your physical brake device and the correct local axis, then calibrate **RELEASED** and **FULL**.

**The script says `WAITING FOR DEVICE`**  
The saved controller is currently not available to the browser. Reconnect it and the script should bind to it automatically.

**The script says `OTHER BRAKE CONTROLLER ACTIVE`**  
Another custom analog-brake controller is active. Disable the other brake script or module and fully reload GeoFS so two controllers do not apply braking force at the same time.

---

## Copyright and use

Copyright © 2026 KB. All rights reserved.

You may install and use these scripts for personal, non-commercial use. You may not modify, redistribute, republish, sell, sublicense, or distribute modified versions without prior permission from KB.

These are unofficial community add-ons and are not affiliated with or endorsed by GeoFS or Airbus.
