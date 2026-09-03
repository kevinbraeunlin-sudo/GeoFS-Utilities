// ==UserScript==
// @name         GeoFS Analog Brakes
// @namespace    KB-GeoFS-Tools
// @version      1.0.0
// @description  Adds calibrated proportional wheel braking to GeoFS using a joystick or pedal axis.
// @author       KB
// @license      Copyright (c) 2026 KB. Personal, non-commercial use only; modification or redistribution requires permission.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '1.0.0';
    const PUBLIC_API_NAME = 'GeoFSStandaloneAnalogBrakes';
    const OTHER_BRAKE_API_NAME = 'GeoFSAnalogBrakes';
    const STORAGE_KEY = 'kb-geofs-analog-brakes-public-v1';
    const HOST_ID = 'kb-geofs-analog-brakes-standalone-root';
    const EMERGENCY_ID = 'kb-geofs-analog-brakes-emergency';

    const CONFIG = Object.freeze({
        minGroundSpeedKts: 0.35,
        inputDeadzone: 0.015,
        maxDecelMps2: 4.20,
        brakeExponent: 1.12,
        yieldToNativeFullBrake: true,
        uiUpdateMs: 100,
    });

    const previousPublicInstance = window[PUBLIC_API_NAME];
    if (previousPublicInstance && typeof previousPublicInstance.destroy === 'function') {
        try { previousPublicInstance.destroy(); } catch (_) {}
    }

    const state = {
        destroyed: false,
        started: false,
        binding: null,
        runtimeGlobalAxisIndex: null,
        gamepadIndex: null,
        axisIndex: null,
        bindingAmbiguous: false,
        releasedRaw: null,
        fullRaw: null,
        rawAxis: null,
        brake01: 0,
        lastDecelMps2: 0,
        lastFrameMs: performance.now(),
        lastUiUpdateMs: -Infinity,
        rafId: null,
        uiCollapsed: false,
        panelPosition: null,
        launcherPosition: null,
        host: null,
        panel: null,
        launcher: null,
        axisSelect: null,
        deviceLabel: null,
        rawLabel: null,
        brakeLabel: null,
        statusLabel: null,
        detailLabel: null,
        decelLabel: null,
        runtimeBox: null,
        conflict: null,
        lastAxisListSignature: '',
    };

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function finiteOrNull(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function getAircraft() {
        return window.geofs?.aircraft?.instance || null;
    }

    function getAnimationValues() {
        const aircraft = getAircraft();
        return aircraft?.animationValue || window.geofs?.animation?.values || {};
    }

    function isSimPaused() {
        try {
            if (typeof window.geofs?.isPaused === 'function') {
                return !!window.geofs.isPaused();
            }
            return !!window.geofs?.pause;
        } catch (_) {
            return false;
        }
    }

    function isOnGround() {
        const aircraft = getAircraft();
        if (!aircraft) return false;

        if (typeof aircraft.groundContact !== 'undefined') {
            return !!aircraft.groundContact;
        }

        const groundContact = getAnimationValues().groundContact;
        return typeof groundContact !== 'undefined' && Number(groundContact) > 0;
    }

    function getRigidBody() {
        return getAircraft()?.rigidBody || null;
    }

    function getAircraftMassKg() {
        const aircraft = getAircraft();
        if (!aircraft) return null;

        const candidates = [
            aircraft.definition?.mass,
            aircraft.setup?.mass,
            aircraft.mass,
        ];

        for (const candidate of candidates) {
            const mass = Number(candidate);
            if (Number.isFinite(mass) && mass > 100) return mass;
        }

        return null;
    }

    function getHorizontalVelocity() {
        const velocity = getRigidBody()?.v_linearVelocity;
        if (!velocity || velocity.length < 2) return null;

        const vx = Number(velocity[0]);
        const vy = Number(velocity[1]);
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;

        return {
            vx,
            vy,
            speedMps: Math.hypot(vx, vy),
        };
    }

    function nativeFullBrakeActive() {
        try {
            return Number(getAnimationValues().brakes) >= 0.99;
        } catch (_) {
            return false;
        }
    }

    function getOtherBrakeController() {
        const other = window[OTHER_BRAKE_API_NAME];
        if (!other) return null;

        let version = null;
        try {
            version = String(other.status?.()?.version || other.version || '').trim() || null;
        } catch (_) {}

        return {
            apiName: OTHER_BRAKE_API_NAME,
            version,
        };
    }

    function getPhysicsHealth() {
        const aircraft = getAircraft();
        if (!aircraft) return { ok: false, reason: 'WAITING GEOFS' };

        const rigidBody = getRigidBody();
        if (!rigidBody) return { ok: false, reason: 'NO RIGID BODY' };

        const massKg = getAircraftMassKg();
        if (massKg === null) return { ok: false, reason: 'NO MASS DATA' };

        const canImpulse = typeof rigidBody.applyCentralImpulse === 'function';
        const canForce = typeof rigidBody.applyCentralForce === 'function';
        if (!canImpulse && !canForce) return { ok: false, reason: 'NO BRAKE FORCE API' };

        return { ok: true, reason: 'OK' };
    }

    function getGamepads() {
        try {
            return Array.from(navigator.getGamepads?.() || [])
                .filter(Boolean)
                .sort((a, b) => a.index - b.index);
        } catch (_) {
            return [];
        }
    }

    function normalizeGamepadId(id) {
        return String(id || 'Unknown Gamepad').trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function makeDeviceSignature(pad) {
        const id = normalizeGamepadId(pad?.id);
        const axesCount = Number(pad?.axes?.length || 0);
        const buttonsCount = Number(pad?.buttons?.length || 0);
        return `${id}|axes:${axesCount}|buttons:${buttonsCount}`;
    }

    function makeBinding(pad, axisIndex) {
        return Object.freeze({
            signature: makeDeviceSignature(pad),
            deviceId: String(pad?.id || `Gamepad ${pad?.index ?? '?'}`),
            axisIndex: Number(axisIndex),
            axesCount: Number(pad?.axes?.length || 0),
            buttonsCount: Number(pad?.buttons?.length || 0),
        });
    }

    function bindingKey(binding) {
        if (!binding?.signature || !Number.isInteger(binding.axisIndex)) return '';
        return `${encodeURIComponent(binding.signature)}::${binding.axisIndex}`;
    }

    function parseBindingKey(value, list) {
        const key = String(value || '');
        return list.find((item) => bindingKey(item.binding) === key)?.binding || null;
    }

    function buildGlobalAxisList() {
        const list = [];
        let globalIndex = 0;

        for (const pad of getGamepads()) {
            if (!pad.axes) continue;
            const signature = makeDeviceSignature(pad);

            for (let localIndex = 0; localIndex < pad.axes.length; localIndex += 1) {
                list.push({
                    globalIndex,
                    gamepadIndex: pad.index,
                    axisIndex: localIndex,
                    raw: Number(pad.axes[localIndex]),
                    gamepadId: pad.id || `Gamepad ${pad.index}`,
                    signature,
                    binding: makeBinding(pad, localIndex),
                });
                globalIndex += 1;
            }
        }

        return list;
    }

    function axisListSignature(list) {
        return list.map((item) => `${item.signature}:${item.gamepadIndex}:${item.axisIndex}:${item.globalIndex}`).join('|');
    }

    function resolveBinding(list = null) {
        state.runtimeGlobalAxisIndex = null;
        state.gamepadIndex = null;
        state.axisIndex = state.binding?.axisIndex ?? null;
        state.bindingAmbiguous = false;

        if (!state.binding?.signature || !Number.isInteger(state.binding.axisIndex)) return null;

        let candidates;
        if (Array.isArray(list)) {
            candidates = list.filter((item) =>
                item.signature === state.binding.signature &&
                item.axisIndex === state.binding.axisIndex
            );
        } else {
            candidates = [];
            let globalBase = 0;
            for (const pad of getGamepads()) {
                const axesCount = Number(pad?.axes?.length || 0);
                if (
                    makeDeviceSignature(pad) === state.binding.signature &&
                    state.binding.axisIndex < axesCount
                ) {
                    candidates.push({
                        globalIndex: globalBase + state.binding.axisIndex,
                        gamepadIndex: pad.index,
                        axisIndex: state.binding.axisIndex,
                        raw: Number(pad.axes[state.binding.axisIndex]),
                        gamepadId: pad.id || `Gamepad ${pad.index}`,
                        signature: state.binding.signature,
                    });
                }
                globalBase += axesCount;
            }
        }

        if (candidates.length > 1) {
            state.bindingAmbiguous = true;
            return null;
        }

        const match = candidates[0] || null;
        if (!match) return null;

        state.runtimeGlobalAxisIndex = match.globalIndex;
        state.gamepadIndex = match.gamepadIndex;
        state.axisIndex = match.axisIndex;
        return match;
    }

    function readSelectedRawAxis() {
        const resolved = resolveBinding();
        return resolved && Number.isFinite(resolved.raw) ? resolved.raw : null;
    }

    function calculateBrake01(raw) {
        if (raw === null || state.releasedRaw === null || state.fullRaw === null) {
            return 0;
        }

        const span = state.fullRaw - state.releasedRaw;
        if (Math.abs(span) < 0.05) return 0;

        let value = clamp((raw - state.releasedRaw) / span, 0, 1);

        if (value < CONFIG.inputDeadzone) {
            value = 0;
        } else {
            value = (value - CONFIG.inputDeadzone) / (1 - CONFIG.inputDeadzone);
        }

        return Math.pow(clamp(value, 0, 1), CONFIG.brakeExponent);
    }

    function parseUiPosition(value) {
        if (!value || typeof value !== 'object') return null;
        const x = Number(value.x);
        const y = Number(value.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x, y };
    }

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (!saved || typeof saved !== 'object') return;

            if (typeof saved.uiCollapsed === 'boolean') {
                state.uiCollapsed = saved.uiCollapsed;
            }
            state.panelPosition = parseUiPosition(saved.panelPosition);
            state.launcherPosition = parseUiPosition(saved.launcherPosition);

            if (saved.schemaVersion !== 3 || !saved.binding || typeof saved.binding !== 'object') {
                state.binding = null;
                state.releasedRaw = null;
                state.fullRaw = null;
                return;
            }

            const signature = String(saved.binding.signature || '').trim();
            const axisIndex = Number(saved.binding.axisIndex);
            if (signature && Number.isInteger(axisIndex) && axisIndex >= 0 && axisIndex <= 128) {
                state.binding = Object.freeze({
                    signature,
                    deviceId: String(saved.binding.deviceId || 'Saved Gamepad'),
                    axisIndex,
                    axesCount: Number(saved.binding.axesCount || 0),
                    buttonsCount: Number(saved.binding.buttonsCount || 0),
                });
            }

            state.releasedRaw = finiteOrNull(saved.releasedRaw);
            state.fullRaw = finiteOrNull(saved.fullRaw);
            if (
                state.releasedRaw !== null &&
                state.fullRaw !== null &&
                Math.abs(state.fullRaw - state.releasedRaw) < 0.05
            ) {
                state.releasedRaw = null;
                state.fullRaw = null;
            }
        } catch (_) {}
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                schemaVersion: 3,
                binding: state.binding ? {
                    signature: state.binding.signature,
                    deviceId: state.binding.deviceId,
                    axisIndex: state.binding.axisIndex,
                    axesCount: state.binding.axesCount,
                    buttonsCount: state.binding.buttonsCount,
                } : null,
                releasedRaw: state.releasedRaw,
                fullRaw: state.fullRaw,
                uiCollapsed: state.uiCollapsed,
                panelPosition: state.panelPosition,
                launcherPosition: state.launcherPosition,
            }));
        } catch (_) {}
    }

    function setBinding(binding, resetCalibration = true) {
        if (!binding?.signature || !Number.isInteger(binding.axisIndex) || binding.axisIndex < 0) return false;
        state.binding = Object.freeze({
            signature: String(binding.signature),
            deviceId: String(binding.deviceId || 'Gamepad'),
            axisIndex: Number(binding.axisIndex),
            axesCount: Number(binding.axesCount || 0),
            buttonsCount: Number(binding.buttonsCount || 0),
        });
        if (resetCalibration) {
            state.releasedRaw = null;
            state.fullRaw = null;
        }
        resolveBinding();
        saveSettings();
        refreshAxisList(true);
        updateUI();
        return true;
    }

    function clearBinding() {
        state.binding = null;
        state.runtimeGlobalAxisIndex = null;
        state.gamepadIndex = null;
        state.axisIndex = null;
        state.bindingAmbiguous = false;
        state.releasedRaw = null;
        state.fullRaw = null;
        saveSettings();
        refreshAxisList(true);
        updateUI();
        return true;
    }

    function captureReleased() {
        const raw = readSelectedRawAxis();
        if (raw === null) return false;
        state.releasedRaw = raw;
        if (state.fullRaw !== null && Math.abs(state.fullRaw - state.releasedRaw) < 0.05) {
            state.fullRaw = null;
        }
        saveSettings();
        updateUI();
        return true;
    }

    function captureFull() {
        const raw = readSelectedRawAxis();
        if (raw === null) return false;
        if (state.releasedRaw !== null && Math.abs(raw - state.releasedRaw) < 0.05) {
            return false;
        }
        state.fullRaw = raw;
        saveSettings();
        updateUI();
        return true;
    }

    function applyAnalogBrake(dt) {
        state.lastDecelMps2 = 0;
        state.rawAxis = readSelectedRawAxis();
        state.brake01 = calculateBrake01(state.rawAxis);

        if (state.conflict) return;
        if (state.brake01 <= 0 || !isOnGround()) return;
        if (CONFIG.yieldToNativeFullBrake && nativeFullBrakeActive()) return;

        const velocity = getHorizontalVelocity();
        const rigidBody = getRigidBody();
        const massKg = getAircraftMassKg();

        if (
            !velocity ||
            !rigidBody ||
            massKg === null ||
            velocity.speedMps < CONFIG.minGroundSpeedKts * 0.514444
        ) {
            return;
        }

        const canImpulse = typeof rigidBody.applyCentralImpulse === 'function';
        const canForce = typeof rigidBody.applyCentralForce === 'function';
        if (!canImpulse && !canForce) return;

        const requestedDecel = CONFIG.maxDecelMps2 * state.brake01;
        const maxSafeDecel = velocity.speedMps / Math.max(dt, 0.001);
        const decel = clamp(requestedDecel, 0, maxSafeDecel);

        const ux = velocity.vx / velocity.speedMps;
        const uy = velocity.vy / velocity.speedMps;

        try {
            if (canImpulse) {
                const impulse = massKg * decel * dt;
                rigidBody.applyCentralImpulse([-ux * impulse, -uy * impulse, 0]);
            } else {
                const force = massKg * decel;
                rigidBody.applyCentralForce([-ux * force, -uy * force, 0]);
            }
            state.lastDecelMps2 = decel;
        } catch (error) {
            console.warn('[GeoFS Analog Brakes] Brake-force application failed:', error);
        }
    }

    function activeUiPosition() {
        return state.uiCollapsed ? state.launcherPosition : state.panelPosition;
    }

    function styleHost(host) {
        const position = activeUiPosition();
        const critical = {
            position: 'fixed',
            'z-index': '2147483647',
            display: 'block',
            visibility: 'visible',
            opacity: '1',
            transform: 'none',
            'pointer-events': 'auto',
            width: 'auto',
            height: 'auto',
            margin: '0',
            padding: '0',
            border: '0',
            background: 'transparent',
        };

        if (position) {
            critical.left = `${position.x}px`;
            critical.top = `${position.y}px`;
            critical.right = 'auto';
            critical.bottom = 'auto';
        } else {
            critical.left = 'auto';
            critical.top = 'auto';
            critical.right = '16px';
            critical.bottom = '72px';
        }

        for (const [property, value] of Object.entries(critical)) {
            host.style.setProperty(property, value, 'important');
        }
    }

    function clampUiPosition(position, element) {
        if (!position || !element) return position;
        const rect = element.getBoundingClientRect();
        const margin = 4;
        const maxX = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxY = Math.max(margin, window.innerHeight - rect.height - margin);
        return {
            x: clamp(position.x, margin, maxX),
            y: clamp(position.y, margin, maxY),
        };
    }

    function applyUiPosition() {
        if (!state.host) return;
        const element = state.uiCollapsed ? state.launcher : state.panel;
        const position = activeUiPosition();
        if (!position || !element) {
            styleHost(state.host);
            return;
        }

        const clamped = clampUiPosition(position, element);
        if (state.uiCollapsed) {
            state.launcherPosition = clamped;
        } else {
            state.panelPosition = clamped;
        }
        styleHost(state.host);
    }

    function setActiveUiPosition(x, y, element) {
        const clamped = clampUiPosition({ x, y }, element);
        if (state.uiCollapsed) {
            state.launcherPosition = clamped;
        } else {
            state.panelPosition = clamped;
        }
        styleHost(state.host);
    }

    function installDragBehavior(handle, element, kind) {
        if (!handle || !element) return;

        let drag = null;
        let suppressNextClick = false;
        const thresholdPx = 4;

        handle.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            if (kind === 'panel' && event.target.closest('button, input, select, textarea, a')) return;

            const rect = state.host?.getBoundingClientRect();
            if (!rect) return;

            drag = {
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startX: rect.left,
                startY: rect.top,
                moved: false,
            };

            try { handle.setPointerCapture?.(event.pointerId); } catch (_) {}
            event.preventDefault();
        });

        handle.addEventListener('pointermove', (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;

            const dx = event.clientX - drag.startClientX;
            const dy = event.clientY - drag.startClientY;
            if (!drag.moved && Math.hypot(dx, dy) < thresholdPx) return;

            drag.moved = true;
            setActiveUiPosition(drag.startX + dx, drag.startY + dy, element);
            event.preventDefault();
        });

        const finishDrag = (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            const moved = drag.moved;
            drag = null;
            try { handle.releasePointerCapture?.(event.pointerId); } catch (_) {}

            if (moved) {
                if (kind === 'launcher') suppressNextClick = true;
                saveSettings();
                event.preventDefault();
            }
        };

        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);

        if (kind === 'launcher') {
            handle.addEventListener('click', (event) => {
                if (suppressNextClick) {
                    suppressNextClick = false;
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    return;
                }
                setUiCollapsed(false);
            });
        }
    }

    function preferredMountRoot() {
        const fullscreen = document.fullscreenElement;
        if (
            fullscreen &&
            fullscreen.tagName !== 'CANVAS' &&
            fullscreen.tagName !== 'VIDEO'
        ) {
            return fullscreen;
        }
        return document.body || document.documentElement;
    }

    function ensureHostMounted() {
        if (!state.host || !state.host.isConnected) {
            const existing = document.getElementById(HOST_ID);
            if (existing && existing !== state.host) existing.remove();
        }

        const root = preferredMountRoot();
        if (!root || !state.host) return false;

        if (state.host.parentNode !== root) {
            root.appendChild(state.host);
        }
        styleHost(state.host);
        return true;
    }

    function createUI() {
        document.getElementById(HOST_ID)?.remove();
        document.getElementById(EMERGENCY_ID)?.remove();

        const host = document.createElement('div');
        host.id = HOST_ID;
        styleHost(host);

        const shadow = typeof host.attachShadow === 'function'
            ? host.attachShadow({ mode: 'open' })
            : host;

        shadow.innerHTML = `
            <style>
                :host { all: initial; }
                * { box-sizing: border-box; }
                .panel {
                    width: 292px;
                    max-height: calc(100vh - 96px);
                    overflow: auto;
                    border: 1px solid rgba(255,255,255,.20);
                    border-radius: 9px;
                    background: rgba(16,18,22,.97);
                    color: #ddd;
                    font-family: Arial, sans-serif;
                    font-size: 10px;
                    box-shadow: 0 7px 24px rgba(0,0,0,.55);
                    backdrop-filter: blur(6px);
                }
                .head {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 8px 9px;
                    background: rgba(45,49,56,.99);
                    border-bottom: 1px solid rgba(255,255,255,.11);
                    color: #f2f2f2;
                    font-weight: 700;
                    letter-spacing: .6px;
                    cursor: grab;
                    user-select: none;
                    touch-action: none;
                }
                .head:active { cursor: grabbing; }
                .title { flex: 1; }
                .version {
                    color: #9ba2ab;
                    font-family: monospace;
                    font-size: 9px;
                    font-weight: 400;
                }
                .body { padding: 9px; }
                .runtime {
                    padding: 7px 8px;
                    border-radius: 5px;
                    background: rgba(114,228,160,.08);
                    border: 1px solid rgba(114,228,160,.20);
                    margin-bottom: 8px;
                }
                .runtime strong {
                    display: block;
                    color: #72e4a0;
                    font-family: monospace;
                    font-size: 10px;
                }
                .runtime small {
                    display: block;
                    margin-top: 3px;
                    color: #a5acb5;
                    line-height: 1.35;
                    font-size: 8px;
                }
                .axis-row {
                    display: grid;
                    grid-template-columns: 1fr 58px;
                    gap: 6px;
                    margin-top: 7px;
                }
                select, input {
                    width: 100%;
                    min-height: 28px;
                    border: 1px solid #575e68;
                    border-radius: 4px;
                    background: #111318;
                    color: #ffb24c;
                    padding: 4px 5px;
                    font-family: monospace;
                    font-size: 10px;
                }
                .buttons {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 6px;
                    margin-top: 7px;
                }
                button {
                    min-height: 28px;
                    border: 1px solid #575e68;
                    border-radius: 4px;
                    background: #30343b;
                    color: #e7e7e7;
                    cursor: pointer;
                    font-family: Arial, sans-serif;
                    font-size: 9px;
                    font-weight: 700;
                }
                button:hover { background: #3a3f47; }
                button:disabled { opacity: .55; cursor: default; }
                .collapse {
                    min-width: 26px;
                    min-height: 22px;
                    padding: 0 6px;
                    font-size: 13px;
                    line-height: 1;
                }
                .live {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 6px;
                    margin-top: 7px;
                }
                .live > div {
                    padding: 6px;
                    border-radius: 4px;
                    background: rgba(255,255,255,.045);
                }
                .label {
                    display: block;
                    color: #8f96a0;
                    font-size: 8px;
                    font-weight: 700;
                    letter-spacing: .4px;
                }
                .value {
                    display: block;
                    margin-top: 2px;
                    color: #72e4a0;
                    font-family: monospace;
                    font-size: 11px;
                    overflow-wrap: anywhere;
                }
                .note {
                    margin-top: 7px;
                    color: #8d949d;
                    font-size: 8px;
                    line-height: 1.45;
                }
                .launcher {
                    display: none;
                    min-height: 32px;
                    padding: 0 11px;
                    border: 1px solid rgba(255,255,255,.22);
                    border-radius: 7px;
                    background: rgba(45,49,56,.98);
                    color: #f2f2f2;
                    box-shadow: 0 5px 18px rgba(0,0,0,.45);
                    letter-spacing: .6px;
                    cursor: grab;
                    user-select: none;
                    touch-action: none;
                }
                .launcher:active { cursor: grabbing; }
                .bad strong, .bad .value { color: #ff7373; }
                .bad { border-color: rgba(255,115,115,.35); background: rgba(255,115,115,.08); }
                .warn strong, .warn .value { color: #ffb24c; }
                .warn { border-color: rgba(255,178,76,.30); background: rgba(255,178,76,.07); }
            </style>

            <div class="panel" id="panel">
                <div class="head">
                    <div class="title">ANALOG BRAKES</div>
                    <div class="version">v${VERSION}</div>
                    <button class="collapse" id="collapse" type="button" title="Hide panel" aria-label="Hide panel">−</button>
                </div>
                <div class="body">
                    <div class="runtime" id="runtime-box">
                        <strong id="status">STARTING</strong>
                        <small id="detail">Standalone controller is starting.</small>
                    </div>

                    <span class="label">SELECT BRAKE AXIS</span>
                    <div class="axis-row">
                        <select id="axis-select" aria-label="Brake device and local axis"></select>
                        <button id="clear-axis" type="button" title="Clear saved brake-axis binding">CLEAR</button>
                    </div>

                    <div class="buttons">
                        <button id="released" type="button">SET RELEASED</button>
                        <button id="full" type="button">SET FULL</button>
                    </div>

                    <div class="live">
                        <div><span class="label">DEVICE / AXIS</span><b class="value" id="device">---</b></div>
                        <div><span class="label">RAW</span><b class="value" id="raw">---</b></div>
                        <div><span class="label">BRAKE</span><b class="value" id="brake">0%</b></div>
                        <div><span class="label">DECEL</span><b class="value" id="decel">0.00</b></div>
                    </div>

                    <div class="note">
                        1) Select the physical device/local axis whose RAW value moves with the brake pedal.<br>
                        2) Pedal released → SET RELEASED.<br>
                        3) Pedal fully pressed → SET FULL.<br>
                        Device identity is saved; runtime Axis numbers may change after reconnect/restart.
                    </div>
                </div>
            </div>
            <button class="launcher" id="launcher" type="button" title="Show Analog Brakes panel">BRAKES</button>
        `;

        state.host = host;
        state.panel = shadow.getElementById ? shadow.getElementById('panel') : shadow.querySelector('#panel');
        state.launcher = shadow.getElementById ? shadow.getElementById('launcher') : shadow.querySelector('#launcher');
        state.axisSelect = shadow.getElementById ? shadow.getElementById('axis-select') : shadow.querySelector('#axis-select');
        state.deviceLabel = shadow.getElementById ? shadow.getElementById('device') : shadow.querySelector('#device');
        state.rawLabel = shadow.getElementById ? shadow.getElementById('raw') : shadow.querySelector('#raw');
        state.brakeLabel = shadow.getElementById ? shadow.getElementById('brake') : shadow.querySelector('#brake');
        state.statusLabel = shadow.getElementById ? shadow.getElementById('status') : shadow.querySelector('#status');
        state.detailLabel = shadow.getElementById ? shadow.getElementById('detail') : shadow.querySelector('#detail');
        state.decelLabel = shadow.getElementById ? shadow.getElementById('decel') : shadow.querySelector('#decel');
        state.runtimeBox = shadow.getElementById ? shadow.getElementById('runtime-box') : shadow.querySelector('#runtime-box');

        const clearAxisButton = shadow.getElementById ? shadow.getElementById('clear-axis') : shadow.querySelector('#clear-axis');
        const releasedButton = shadow.getElementById ? shadow.getElementById('released') : shadow.querySelector('#released');
        const fullButton = shadow.getElementById ? shadow.getElementById('full') : shadow.querySelector('#full');
        const collapseButton = shadow.getElementById ? shadow.getElementById('collapse') : shadow.querySelector('#collapse');
        const dragHandle = shadow.querySelector('.head');

        state.axisSelect.addEventListener('change', () => {
            const list = buildGlobalAxisList();
            const binding = parseBindingKey(state.axisSelect.value, list);
            if (binding) setBinding(binding, true);
        });
        clearAxisButton.addEventListener('click', clearBinding);
        releasedButton.addEventListener('click', captureReleased);
        fullButton.addEventListener('click', captureFull);
        collapseButton.addEventListener('click', () => setUiCollapsed(true));
        installDragBehavior(dragHandle, state.panel, 'panel');
        installDragBehavior(state.launcher, state.launcher, 'launcher');

        ensureHostMounted();
        syncAxisControls();
        refreshAxisList(true);
        applyUiVisibility();
        updateUI();
    }

    function applyUiVisibility() {
        if (state.panel) state.panel.style.display = state.uiCollapsed ? 'none' : 'block';
        if (state.launcher) state.launcher.style.display = state.uiCollapsed ? 'block' : 'none';
        applyUiPosition();
    }

    function setUiCollapsed(collapsed) {
        state.uiCollapsed = !!collapsed;
        applyUiVisibility();
        saveSettings();
    }

    function syncAxisControls() {
        if (!state.axisSelect) return;
        state.axisSelect.value = bindingKey(state.binding);
    }

    function shortDeviceName(id) {
        const value = String(id || 'Gamepad').trim().replace(/\s+/g, ' ');
        return value.length > 34 ? `${value.slice(0, 31)}...` : value;
    }

    function refreshAxisList(force = false, suppliedList = null) {
        if (!state.axisSelect) return;

        const list = suppliedList || buildGlobalAxisList();
        const signature = axisListSignature(list);
        const selectedKey = bindingKey(state.binding);
        if (!force && signature === state.lastAxisListSignature && state.axisSelect.value === selectedKey) return;
        state.lastAxisListSignature = signature;

        state.axisSelect.textContent = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '-- select device / local axis --';
        state.axisSelect.appendChild(placeholder);

        for (const item of list) {
            const option = document.createElement('option');
            option.value = bindingKey(item.binding);
            option.textContent = `${shortDeviceName(item.gamepadId)} · A${item.axisIndex} · runtime AX${item.globalIndex}`;
            state.axisSelect.appendChild(option);
        }

        if (state.binding && !list.some((item) => bindingKey(item.binding) === selectedKey)) {
            const option = document.createElement('option');
            option.value = selectedKey;
            option.textContent = `${shortDeviceName(state.binding.deviceId)} · A${state.binding.axisIndex} · waiting`;
            state.axisSelect.appendChild(option);
        }

        state.axisSelect.value = selectedKey;
    }

    function setRuntimeMessage(kind, status, detail) {
        if (!state.statusLabel || !state.detailLabel || !state.runtimeBox) return;
        state.statusLabel.textContent = status;
        state.detailLabel.textContent = detail;
        state.runtimeBox.classList.remove('bad', 'warn');
        if (kind === 'bad') state.runtimeBox.classList.add('bad');
        if (kind === 'warn') state.runtimeBox.classList.add('warn');
    }

    function updateUI() {
        if (!state.panel) return;
        ensureHostMounted();

        const list = buildGlobalAxisList();
        refreshAxisList(false, list);
        const resolved = resolveBinding(list);
        state.rawAxis = resolved && Number.isFinite(resolved.raw) ? resolved.raw : null;
        state.brake01 = calculateBrake01(state.rawAxis);
        state.conflict = getOtherBrakeController();

        state.deviceLabel.textContent = resolved
            ? `${shortDeviceName(resolved.gamepadId)} · A${resolved.axisIndex} · AX${resolved.globalIndex}`
            : state.binding
                ? `${shortDeviceName(state.binding.deviceId)} · A${state.binding.axisIndex}`
                : 'NOT BOUND';
        state.rawLabel.textContent = state.rawAxis === null ? '---' : state.rawAxis.toFixed(3);
        state.brakeLabel.textContent = `${Math.round(state.brake01 * 100)}%`;
        state.decelLabel.textContent = `${state.lastDecelMps2.toFixed(2)} m/s²`;

        if (state.conflict) {
            const suffix = state.conflict.version ? ` (${state.conflict.version})` : '';
            setRuntimeMessage(
                'bad',
                'OTHER BRAKE CONTROLLER ACTIVE',
                `Custom braking is blocked to prevent force stacking${suffix}. Disable the other analog-brake controller and fully reload GeoFS.`
            );
            return;
        }

        if (!getAircraft()) {
            setRuntimeMessage('warn', 'WAITING GEOFS', 'UI is active. Waiting for the GeoFS aircraft instance.');
            return;
        }

        if (isSimPaused()) {
            setRuntimeMessage('warn', 'PAUSED', 'GeoFS is paused; no custom brake force is applied.');
            return;
        }

        if (!state.binding) {
            setRuntimeMessage('warn', 'SELECT AXIS', 'Select the physical brake device and its local axis once. Runtime global Axis numbers are not saved.');
            return;
        }

        if (state.bindingAmbiguous) {
            setRuntimeMessage('bad', 'DEVICE ID AMBIGUOUS', 'Multiple connected devices have the same hardware signature. Braking is blocked rather than guessing which device is the brake pedal.');
            return;
        }

        if (!resolved) {
            setRuntimeMessage('warn', 'WAITING FOR DEVICE', `${state.binding.deviceId} · local A${state.binding.axisIndex} is not currently exposed. It will reconnect automatically when available.`);
            return;
        }

        if (state.releasedRaw === null) {
            setRuntimeMessage('warn', 'SET RELEASED', 'Release the brake pedal completely, then press SET RELEASED.');
            return;
        }

        if (state.fullRaw === null) {
            setRuntimeMessage('warn', 'SET FULL', 'Press the brake pedal fully, then press SET FULL.');
            return;
        }

        const physics = getPhysicsHealth();
        if (!physics.ok) {
            setRuntimeMessage('bad', 'PHYSICS N/A', `Brake input is calibrated, but GeoFS braking cannot be applied: ${physics.reason}.`);
            return;
        }

        if (nativeFullBrakeActive()) {
            setRuntimeMessage('warn', 'NATIVE FULL', 'GeoFS native full brake owns the full-brake endpoint; custom force is yielding.');
            return;
        }

        if (state.brake01 > 0.01) {
            setRuntimeMessage('good', 'BRAKING', `Analog brake demand: ${Math.round(state.brake01 * 100)}%.`);
            return;
        }

        setRuntimeMessage('good', 'READY', 'Standalone analog braking is armed and ready.');
    }

    function frame(realNow) {
        if (state.destroyed) return;

        state.conflict = getOtherBrakeController();

        if (isSimPaused()) {
            state.lastFrameMs = realNow;
            state.lastDecelMps2 = 0;
            state.rawAxis = readSelectedRawAxis();
            state.brake01 = calculateBrake01(state.rawAxis);
        } else {
            const dt = clamp((realNow - state.lastFrameMs) / 1000, 0.001, 0.08);
            state.lastFrameMs = realNow;
            applyAnalogBrake(dt);
        }

        if (realNow - state.lastUiUpdateMs >= CONFIG.uiUpdateMs) {
            state.lastUiUpdateMs = realNow;
            updateUI();
        }

        state.rafId = requestAnimationFrame(frame);
    }

    function status() {
        const physics = getPhysicsHealth();
        return Object.freeze({
            version: VERSION,
            started: state.started,
            paused: isSimPaused(),
            conflict: state.conflict,
            uiMounted: !!state.host?.isConnected,
            uiCollapsed: state.uiCollapsed,
            panelPosition: state.panelPosition ? { ...state.panelPosition } : null,
            launcherPosition: state.launcherPosition ? { ...state.launcherPosition } : null,
            binding: state.binding ? { ...state.binding } : null,
            runtimeGlobalAxisIndex: state.runtimeGlobalAxisIndex,
            gamepadIndex: state.gamepadIndex,
            axisIndex: state.axisIndex,
            bindingAmbiguous: state.bindingAmbiguous,
            releasedRaw: state.releasedRaw,
            fullRaw: state.fullRaw,
            rawAxis: state.rawAxis,
            brake: state.brake01,
            decelMps2: state.lastDecelMps2,
            nativeFullBrake: nativeFullBrakeActive(),
            aircraftReady: !!getAircraft(),
            physicsReady: physics.ok,
            physicsReason: physics.reason,
        });
    }

    function showEmergencyBadge(error) {
        const message = String(error?.message || error || 'Unknown startup error');
        const mount = document.body || document.documentElement;
        if (!mount) {
            console.error('[GeoFS Analog Brakes] Startup failed before DOM mount:', error);
            return;
        }

        document.getElementById(EMERGENCY_ID)?.remove();
        const badge = document.createElement('div');
        badge.id = EMERGENCY_ID;
        badge.textContent = `ANALOG BRAKES STARTUP ERROR · ${message}`;
        badge.style.setProperty('position', 'fixed', 'important');
        badge.style.setProperty('right', '16px', 'important');
        badge.style.setProperty('top', '16px', 'important');
        badge.style.setProperty('z-index', '2147483647', 'important');
        badge.style.setProperty('display', 'block', 'important');
        badge.style.setProperty('visibility', 'visible', 'important');
        badge.style.setProperty('opacity', '1', 'important');
        badge.style.setProperty('padding', '10px 12px', 'important');
        badge.style.setProperty('max-width', '420px', 'important');
        badge.style.setProperty('background', '#5b1111', 'important');
        badge.style.setProperty('color', '#fff', 'important');
        badge.style.setProperty('border', '2px solid #ff7373', 'important');
        badge.style.setProperty('font', '12px monospace', 'important');
        mount.appendChild(badge);
        console.error('[GeoFS Analog Brakes] Startup failed:', error);
    }

    function onGamepadConnected() {
        refreshAxisList(true);
        updateUI();
    }

    function onGamepadDisconnected() {
        refreshAxisList(true);
        updateUI();
    }

    function onFullscreenChange() {
        ensureHostMounted();
        applyUiPosition();
    }

    function onWindowResize() {
        applyUiPosition();
    }

    function destroy() {
        if (state.destroyed) return true;
        state.destroyed = true;
        if (state.rafId !== null) cancelAnimationFrame(state.rafId);
        window.removeEventListener('gamepadconnected', onGamepadConnected);
        window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
        window.removeEventListener('resize', onWindowResize);
        state.host?.remove();
        document.getElementById(EMERGENCY_ID)?.remove();
        try {
            if (window[PUBLIC_API_NAME]?.version === VERSION) delete window[PUBLIC_API_NAME];
        } catch (_) {}
        return true;
    }

    const api = Object.freeze({
        version: VERSION,
        status,
        setBinding,
        clearBinding,
        captureReleased,
        captureFull,
        refreshAxisList: () => refreshAxisList(true),
        show: () => setUiCollapsed(false),
        hide: () => setUiCollapsed(true),
        destroy,
    });

    try {
        Object.defineProperty(window, PUBLIC_API_NAME, {
            value: api,
            writable: false,
            configurable: true,
            enumerable: false,
        });
    } catch (error) {
        console.warn('[GeoFS Analog Brakes] Could not publish standalone API:', error);
    }

    function boot() {
        if (state.destroyed || state.started) return;

        const mount = document.body || document.documentElement;
        if (!mount) {
            requestAnimationFrame(boot);
            return;
        }

        try {
            loadSettings();
            createUI();

            window.addEventListener('gamepadconnected', onGamepadConnected);
            window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
            document.addEventListener('fullscreenchange', onFullscreenChange);
            window.addEventListener('resize', onWindowResize);

            state.started = true;
            state.lastFrameMs = performance.now();
            state.rafId = requestAnimationFrame(frame);
            updateUI();

            console.info(`[GeoFS Analog Brakes] v${VERSION} standalone active`);
        } catch (error) {
            showEmergencyBadge(error);
        }
    }

    boot();
})();
