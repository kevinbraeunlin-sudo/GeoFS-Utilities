# GeoFS Ground Steering v1.0.0 ✈️

First public release of the standalone **GeoFS Ground Steering** userscript — configurable nosewheel steering for [GeoFS](https://www.geo-fs.com/).

## Features

- **Compact cockpit-friendly UI** matching the dark-gray style of GeoFS Analog Brakes and A350 BTV
- **Movable, collapsible panel** with a small STEERING launcher; panel and launcher positions are saved
- **Nosewheel steering control** with aircraft-specific profiles and dynamic nose-gear/steering-animation detection where supported
- **CLASSIC / REALISTIC steering modes**, speed-sensitive steering behavior and adjustable pedal/tiller handling
- **Pedal calibration** and optional A380-specific steering settings
- **Optional diagnostics and taxi telemetry recorder**, tucked away from the main interface

## What's included in v1.0.0

- Release packaging and a simplified UI, based on the tested v0.0.22 code
- Aircraft identification improvements carried forward from v0.0.21
- Provisional **Saab 340 maximum NWS angle of ±45°** (further simulator testing recommended)
- Existing A380 steering behavior preserved; Analog Brakes and BTV remain independent

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Download **GeoFS_Ground_Steering_v1.0.0.zip** from the assets below and extract it.
3. Open **GeoFS_Ground_Steering_v1.0.0.user.js** with Tampermonkey and confirm installation.
4. **Disable any older Ground Steering test userscript** to prevent competing steering commands.
5. Open GeoFS and use the **GROUND STEERING** panel.

You can also install the [userscript directly from the repository](https://github.com/kevinbraeunlin-sudo/GeoFS-Utilities/blob/main/ground-steering/GeoFS_Ground_Steering_v1.0.0.user.js) via **Raw**.

## Known limitations

Community aircraft use varying gear animations and physics. Some models are not yet fully supported:

- **Boeing 747-8F (ID 252):** NWS not connected — ambiguous front-gear selection
- **Lockheed L-1011 (ID 5038):** NWS OFF — no compatible steering animation detected
- **Airbus A330-900neo (ID 4631):** very weak physical steering response
- **Boeing 767-400 (ID 4764):** limited physical steering response despite a script connection
- **Saab 340:** the new ±45° limit is provisional, pending feedback

A connected steering animation does **not** guarantee that a community aircraft's physical taxi behavior is correct. More model-specific fixes are planned for a later maintenance update.

## Requirements

- GeoFS in a desktop browser
- Tampermonkey
- Compatible aircraft model and steering input

This is an **unofficial simulator add-on** and is not affiliated with GeoFS or any aircraft manufacturer. No real-aircraft use intended.

For instructions and troubleshooting, see the [Ground Steering README](https://github.com/kevinbraeunlin-sudo/GeoFS-Utilities/tree/main/ground-steering).
