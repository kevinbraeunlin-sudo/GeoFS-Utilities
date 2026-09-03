# GeoFS Utilities

A small collection of tools and quality-of-life improvements for GeoFS.

Right now this repository contains **GeoFS Analog Brakes**, a Tampermonkey userscript that adds proportional wheel braking when you use pedals, a joystick axis, or another game controller.

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

## Copyright and use

Copyright © 2026 KB. All rights reserved.

You may install and use this script for personal, non-commercial use. You may not modify, redistribute, republish, sell, sublicense, or distribute modified versions of the script without prior permission from KB.

This is an unofficial community add-on and is not affiliated with or endorsed by GeoFS.
