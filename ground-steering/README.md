# GeoFS Ground Steering v1.0.0

Compact, standalone nosewheel steering controller for [GeoFS](https://www.geo-fs.com/).

## Installation

1. Install the Tampermonkey browser extension.
2. Open [`GeoFS_Ground_Steering_v1.0.0.user.js`](./GeoFS_Ground_Steering_v1.0.0.user.js), select **Raw**, and confirm installation in Tampermonkey. Alternatively, extract the ZIP download and install the `.user.js` file directly.
3. **Disable/remove any older GeoFS Ground Steering Test userscript** to avoid two controllers writing the same commands.
4. Open GeoFS. The **GROUND STEERING** window appears; drag the header to move it, or minimize to the **STEERING** launcher.

## UI

Matches the dark gray Analog Brakes / BTV palette. The default view contains only connection status, enable switch, steering law, ground speed, nosewheel limit/output and detected aircraft. **SETTINGS** contains steering mode, pedal readout, three-point calibration and A380 handling controls. **DIAGNOSTICS** (nested inside Settings) contains optional compatibility data and the support telemetry recorder. Panel/launcher positions and collapsed state persist locally.

## Important notes

- A simulated steering controller for GeoFS; NOT real-aircraft or certified steering software. Realistic law is a simulator approximation.
- v1.0.0 keeps the tested steering calculations, profiles and A380 handling from v0.0.22; this release chiefly changes the visual interface/metadata.
- Saab 340: provisional 45° limit based on community test feedback; physical feel requires confirmation.
- Known GeoFS model limitations: B747-8F (ambiguous front gear), L-1011 (no steerable animation detected), A330-900neo and B767-400 (weak physical steering) remain unfixed. No speculative gear modifications were made.
- If NWS shows OFF, avoid repeatedly forcing the steering input on an unsupported model. A script connection does not prove that GeoFS physical wheel steering works.
- Analog Brakes and BTV remain independent scripts; their functionality is not modified.

## Repository

This version is published in the [`ground-steering/`](./) folder of [`GeoFS-Utilities`](https://github.com/kevinbraeunlin-sudo/GeoFS-Utilities). The userscript and this README are the official v1.0.0 source files. ZIP packages are also available through the project's ChatGPT delivery workflow.

## Test status

JavaScript syntax and basic UI structure are checked locally. Browser integration / GeoFS in-simulator acceptance testing is still recommended before publicly announcing a stable release.
