// ==UserScript==
// @name         GeoFS Ground Steering
// @namespace    https://github.com/kevinbraeunlin-sudo/GeoFS-Utilities
// @version      1.0.0
// @description  Compact nosewheel steering with aircraft profiles, pedal calibration and A380 handling. GeoFS simulation.
// @author       KB
// @homepageURL  https://github.com/kevinbraeunlin-sudo/GeoFS-Utilities
// @match        https://www.geo-fs.com/*
// @match        https://geo-fs.com/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  // The legacy ID avoids running older standalone tests in parallel during upgrades.
  const SCRIPT_ID = 'kb-a350-ground-steering-test';
  const VERSION = '1.0.0';

  if (PAGE[SCRIPT_ID]) {
    try { PAGE[SCRIPT_ID].destroy?.(); } catch (_) {}
  }

  // Retain the old internal namespace so existing 0.0.5/0.0.6 pedal calibration works.
  const CAL_STORAGE_KEY = 'kb-a350-ground-steering-pedal-cal-v1';
  const LAW_STORAGE_KEY = 'kb-geofs-ground-steering-law-mode-v1';
  const A380_LIMIT_STORAGE_KEY = 'kb-geofs-ground-steering-a380-effective-limit-v1';
  const A380_RATE_STORAGE_KEY = 'kb-geofs-ground-steering-a380-slew-rate-v1';

  const CONFIG = Object.freeze({
    // 0.0.10 validated A350 reference maximum. Unknown aircraft KEEP this
    // previous fallback (a simulated value, NOT a verified aircraft limit).
    maxNosewheelDeg: 72,

    // Conservative simulated protection curve requested for GeoFS.
    // This is intentionally more restrictive than Airbus' published system authority below 30 kt.
    // We will calibrate it after physical turning-radius tests.
    tillerLimitCurve: [
      [0,   72],
      [4,   72],
      [6,   60],
      [8,   48],
      [10,  36],
      [12,  28],
      [15,  20],
      [20,  12],
      [25,   8],
      [30,   6],
    ],

    // Below this speed, the normal rudder-pedal input is also used as a
    // virtual tiller command, limited by tillerLimitCurve above. At 30 kt the
    // curve has already reduced to 6°, so the handover is continuous.
    pedalTillerCutoverKt: 30,

    // Normal pedal-linked nosewheel authority after the low-speed tiller
    // assist has faded out. This then fades away at high takeoff speed.
    rudderNwsDegBelow100Kt: 6,
    rudderNwsFadeStartKt: 100,
    rudderNwsZeroKt: 130,

    uiIntervalMs: 250,
    turnRadiusIntervalMs: 500,
    turnRadiusSmoothing: 0.30,
    compatibilityHistorySize: 24, // 12 seconds at the existing 500-ms diagnostic rate
    pedalDeadband: 0.015,

    // Display-only phase tracking: never changes steering authority.
    // A brief loss of contact during rotation/taxi must not be interpreted
    // as a completed flight followed by a landing.
    phaseAirborneConfirmMs: 2000,
    phaseGroundConfirmMs: 350,
    phaseTakeoffAboveKt: 30,
    phaseTaxiBelowKt: 25,
  });

  // ================================================================
  // AIRCRAFT STEERING PROFILE DATABASE – v1.0.0
  // OEM maximum NWS deflections are NOT exact speed-dependent steering laws.
  // Positive/negative angles are symmetric in this experimental controller.
  // Missing type limits intentionally retain the 0.0.10 72-degree fallback
  // with UNVERIFIED labeling; a recognized NAME is not an OEM angle source.
  // Small GA aircraft can have pedal-linked or free-castering steering that
  // this virtual-tiller model does not reproduce fully.
  // Steering, timing, wheel-binding and pedal-calibration code inherited from v0.0.21.
  //
  // Manufacturer figures have profile-level source URLs. Secondary technical
  // sources are clearly distinguished from manufacturer airport manuals.
  const OEM_PROFILE = (model, maxDeg, type, confidence, source, note) =>
    Object.freeze({ model, maxDeg, type, confidence, source, note });
  const ESTIMATED_PROFILE = (model, note) => OEM_PROFILE(
    model, 72, 'VIRTUAL_TILLER_ESTIMATE', 'UNVERIFIED FALLBACK', null,
    `${note} No verified NWS limit stored; preserves 72-degree simulated fallback.`);

  const STEERING_PROFILES = Object.freeze({
    A220: OEM_PROFILE('Airbus A220-100 / -300', 80, 'TILLER', 'MANUFACTURER SYSTEM RANGE',
      'https://aircraft.airbus.com/sites/g/files/jlcbta126/files/2023-11/A220-RSP-Issue110-00-19Oct2023.pdf',
      'Airbus A220 active steering +/-80 degrees; passive/towing limit is NOT its powered steering limit.'),
    A318: OEM_PROFILE('Airbus A318', 75, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-01/AC_A318_0624.pdf', '75 degrees; individual GeoFS wheel physics may differ.'),
    A319: OEM_PROFILE('Airbus A319 / A319neo', 75, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2024-06/AC_A319_0624.pdf', 'A319-111/-112 and other A319 subvariants share the family profile; GeoFS ID 3140 has an oversized simulated turn radius.'),
    A320: OEM_PROFILE('Airbus A320 / A320neo', 75, 'TILLER', 'MANUFACTURER LIMIT',
      'https://aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-07/AC_A320_20250715.pdf', 'Community model collision/suspension characteristics are not modified.'),
    A321: OEM_PROFILE('Airbus A321 / A321neo', 75, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-07/AC_A321_20250715.pdf', 'A321 XLR and A321 subvariants use the 75-degree family profile.'),
    A330_200: ESTIMATED_PROFILE('Airbus A330-200', 'A330 turning configurations vary; do not assume the A330-300 reference is an exact -200 limit.'),
    A330_300: OEM_PROFILE('Airbus A330-300', 72, 'TILLER', 'DOCUMENTED CONFIGURATION',
      'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-12/AC_A330_20251201.pdf', '72 and 65 degree configurations are documented. 72 degrees retained for the successfully tested LRX A330-300.'),
    A330_NEO: ESTIMATED_PROFILE('Airbus A330neo (-800 / -900)', 'Variant-specific max steering limit is not verified for this database.'),
    A340_200_300: OEM_PROFILE('Airbus A340-200 / -300', 72, 'TILLER', 'DOCUMENTED CONFIGURATION',
      'https://www.aircraft.airbus.com/en/customer-care/fleet-wide-care/airport-operations-and-aircraft-characteristics/aircraft-characteristics', 'Airport-turning charts show 72 and 65-degree configurations; 72 degrees selected as one documented configuration, not an all-airframes guarantee.'),
    A340_500_600: ESTIMATED_PROFILE('Airbus A340-500 / -600', 'Exact subvariant turning system not yet validated.'),
    A350_FAMILY: ESTIMATED_PROFILE('Airbus A350 (variant unspecified)',
      'A350 family confirmed but exact -900/-1000 variant is not identified. 72-degree TEST fallback remains, NOT a verified aircraft-specific limit. The A350-style speed law may still be used as a clearly modeled approximation.'),
    A350_900: OEM_PROFILE('Airbus A350-900', 72, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2024-06/AC_A350_0524.pdf', 'Preserves validated A350-900 72-degree reference.'),
    A350_1000: OEM_PROFILE('Airbus A350-1000', 75, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2024-06/AC_A350_0524.pdf', 'A350-1000 not to be confused with the 72-degree -900.'),
    A380_800: OEM_PROFILE('Airbus A380-800', 70, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2023-12/ac_a380_1223.pdf', 'A380 has complex multi-gear turning physics; only nosewheel command is modeled here.'),
    B737_200: ESTIMATED_PROFILE('Boeing 737-200', 'Original 737 variant; NWS limit unverified.'),
    B737_CLASSIC: ESTIMATED_PROFILE('Boeing 737 Classic (-300/-400/-500)', 'Do not borrow 737NG or MAX manufacturer limit without confirming classic variants.'),
    B737_NG: OEM_PROFILE('Boeing 737 NG (-600/-700/-800/-900)', 78, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.boeing.com/commercial/airports/plan-manuals', 'Boeing 737NG 78-degree maximum steering; 75 degrees effective after assumed tire slip is a separate measurement.'),
    B737_MAX: OEM_PROFILE('Boeing 737 MAX (-7/-8/-9/-10)', 78, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.boeing.com/commercial/airports/plan-manuals', 'Boeing 737 MAX 78-degree physical steering limit in airport planning; not the 75-degree effective tire-slip angle.'),
    B747_SP: ESTIMATED_PROFILE('Boeing 747SP', 'Separate shorter 747SP airframe; steering limit unverified.'),
    B747_100: ESTIMATED_PROFILE('Boeing 747-100 / SCA', 'Classic Boeing 747; steering limit unverified.'),
    B747_400: ESTIMATED_PROFILE('Boeing 747-400 / -400ER', 'Four-main-gear turning geometry is not implemented; manufacturer NWS limit not confirmed here.'),
    B747_8: OEM_PROFILE('Boeing 747-8 / -8F', 70, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.boeing.com/commercial/airports/plan-manuals', 'Body gear steering is separate, not simulated by the virtual tiller.'),
    B757: ESTIMATED_PROFILE('Boeing 757 (-200/-300)', 'Specific max active nosewheel steering is not yet verified.'),
    B767: ESTIMATED_PROFILE('Boeing 767 (-200/-300/-400)', 'Specific max active nosewheel steering is not yet verified.'),
    B777_CLASSIC: ESTIMATED_PROFILE('Boeing 777-200/-200ER/-300', 'Separate planning document from -200LR/-300ER; max angle not confirmed in this release.'),
    B777_LR_ER_F: OEM_PROFILE('Boeing 777-200LR / -300ER / 777F', 70, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.boeing.com/commercial/airports/plan-manuals', 'Boeing airport plan D6-58329-2 Rev G shows 70-degree maximum; aft-axle main-gear steering is separate.'),
    B777X: ESTIMATED_PROFILE('Boeing 777X (777-8/-9)', 'Preliminary 777X characteristics exist but actual max NWS angle has not been verified in this database.'),
    B787_8: OEM_PROFILE('Boeing 787-8', 70, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/787_Rev_P.pdf', 'Boeing 787 -8 70-degree max.'),
    B787_9: OEM_PROFILE('Boeing 787-9', 70, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/787_Rev_P.pdf', 'Boeing 787 -9 70-degree max.'),
    B787_10: OEM_PROFILE('Boeing 787-10', 70, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/787_Rev_P.pdf', 'Boeing 787 -10 70-degree max.'),
    E170: ESTIMATED_PROFILE('Embraer E170', 'E170 variant angle not independently verified in this database.'),
    E175: ESTIMATED_PROFILE('Embraer E175', 'E175 variant angle not independently verified in this database.'),
    E190: OEM_PROFILE('Embraer E190 (E1)', 76, 'TILLER', 'MANUFACTURER LIMIT',
      'https://embraer.com/media/jwsj1u1u/e190apm_apm_190-1.pdf', 'Embraer E190 maximum 76-degree active NWS deflection.'),
    E195: OEM_PROFILE('Embraer E195 (E1)', 76, 'TILLER', 'AIRPORT PLAN (SECONDARY COPY)',
      'https://www.scribd.com/document/1054831984/E195-APM-APM-195-1', 'Embraer E195 airport planning manual copy shows max 76 degrees.'),
    E190_E2: OEM_PROFILE('Embraer E190-E2', 76, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.embraer.com/media/vmsjxvk5/e-jets-e2_apm_e-jetse2.pdf', 'Embraer E-Jets E2 airport plan shows 76 degrees for E190-E2.'),
    E195_E2: OEM_PROFILE('Embraer E195-E2', 76, 'TILLER', 'MANUFACTURER LIMIT',
      'https://www.embraer.com/media/vmsjxvk5/e-jets-e2_apm_e-jetse2.pdf', 'Embraer E-Jets E2 airport plan shows 76 degrees for E195-E2.'),
    ERJ145: ESTIMATED_PROFILE('Embraer ERJ-135/-140/-145', 'Older ERJ regional aircraft steering maximum not verified.'),
    EMB120: ESTIMATED_PROFILE('Embraer EMB-120 Brasilia', 'Regional turboprop steering maximum not verified.'),
    CRJ200: ESTIMATED_PROFILE('Bombardier CRJ100/200', 'CRJ200 steering maximum unverified.'),
    P8I: ESTIMATED_PROFILE('Boeing P-8I Neptune', 'Military variant; steering angle unverified.'),
    LEARJET45: ESTIMATED_PROFILE('Learjet 45 XR', 'Business jet steering maximum unverified; flight dynamics unusually sensitive in GeoFS.'),
    C919: ESTIMATED_PROFILE('COMAC C919', 'C919 steering maximum unverified; monitor delayed reversal.'),
    L1011: ESTIMATED_PROFILE('Lockheed L-1011 TriStar', 'Steering animation absent on tested airframe; fail closed.'),
    SAAB340: OEM_PROFILE('Saab 340 – GeoFS TEST cap', 45, 'VIRTUAL_TILLER_ESTIMATE', 'UNVERIFIED SIMULATOR TEST', null, 'GeoFS-specific provisional 45-degree cap from flight-test handling feedback; NOT an OEM steering limit. Original animation was yaw ratio 20.'),
    CRJ700: ESTIMATED_PROFILE('Bombardier CRJ700', 'CRJ900 has 80 degrees but this number must not silently be applied to CRJ700.'),
    CRJ900: OEM_PROFILE('Bombardier CRJ900', 80, 'TILLER', 'INVESTIGATION / FLIGHT MANUAL',
      'https://asn.flightsafety.org/reports/2020/20200910_CRJ9_ES-ACD.pdf', 'CRJ900 80-degree tiller limit and 8-degree pedal-linked limit documented in an official accident investigation quoting FCOM.'),
    CRJ1000: ESTIMATED_PROFILE('Bombardier CRJ1000', 'CRJ1000 angle not independently confirmed.'),
    ATR_600: OEM_PROFILE('ATR 42-600 / 72-600', 60, 'TILLER', 'TECHNICAL SYSTEMS GUIDE',
      'https://studylib.net/doc/28413831/atr-systems', 'ATR 42/72-600 powered nosewheel tiller +/-60 degrees. 90-degree passive castor range is NOT powered steering.'),
    ATR_LEGACY: ESTIMATED_PROFILE('ATR 42 / ATR 72 (older variants)', 'Do not assume ATR-600 steering specification applies to all earlier ATR versions.'),
    DASH8: ESTIMATED_PROFILE('DHC-8 / Dash 8 / Q400', 'NWS limit and steering arrangement must be checked for exact variant.'),
    C172: OEM_PROFILE('Cessna 172 (pedal linked)', 10, 'PEDAL_LINKED', 'MODEL HANDBOOK',
      'https://manualzz.com/doc/23607378/cessna-172-n-airplane-pilot-s-operating-handbook', 'C172N: approximately 10 degrees via rudder pedals; differential braking produces additional turning, NOT simulated here.'),
    C208: OEM_PROFILE('Cessna 208 Caravan (pedal linked)', 15, 'PEDAL_LINKED', 'PILOT TRAINING MANUAL',
      'https://studylib.net/doc/25876331/flightsafety-208g1000-ptm-1', 'Approx 15 degrees pedal-linked; differential braking yields additional turning; variant-specific data requires validation.'),
    UNKNOWN: ESTIMATED_PROFILE('UNKNOWN AIRCRAFT', 'No identifiable supported manufacturer/model; do not assume this is a real aircraft value.'),
  });

  // Prefer explicit aircraft names / paths, NOT author's name (which might
  // mention other aircraft), wheel counts, number of engines, or gear names.
  function getAircraftIdentity(ac) {
    const labels = [ac?.definition?.name, ac?.definition?.model,
      ac?.setup?.name, ac?.setup?.model, ac?.aircraftRecord?.name,
      ac?.aircraftRecord?.fullPath, ac?.aircraftRecord?.model,
      ac?.aircraftRecord?.icao, ac?.definition?.type, ac?.name]
      .filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
    return { id: ac?.id == null ? null : String(ac.id), labels, text: labels.join(' | ').toLowerCase() };
  }

  function resolveSteeringProfile(ac) {
    const identity = getAircraftIdentity(ac);
    const displayedName = (identity.labels[0] || '').toLowerCase().replace(/_/g, ' ');
    const t = identity.text.replace(/_/g, ' ');
    // Match from most specific variants to generic families. In particular,
    // do NOT confuse 737 MAX-8 / B38M with 737NG -800 / B738.
    // /\\b/ intentionally used at aircraft token boundaries; model revision
    // digits inside a manufacturer suffix (A330-343, A350-941) are recognized.
    const matches = [
      // A35K/A359 are ICAO codes; a35k0 is used in some community repository paths.
      [/\b(?:a35k|a35k0|a350[\s_-]?10(?:00|\d\d)|airbus[\s_-]?350[\s_-]?10(?:00|\d\d))\b/, 'A350_1000'],
      [/\b(?:a359|a350[\s_-]?9\d\d|airbus[\s_-]?350[\s_-]?9\d\d)\b/, 'A350_900'],

      [/\b(?:a380(?:[\s_-]?8\d\d)?|airbus[\s_-]?380(?:[\s_-]?8\d\d)?)\b/, 'A380_800'],
      [/\b(?:a340[\s_-]?[56]\d\d|airbus[\s_-]?340[\s_-]?[56]\d\d)\b/, 'A340_500_600'],
      [/\b(?:a340[\s_-]?[23]\d\d|airbus[\s_-]?340[\s_-]?[23]\d\d)\b/, 'A340_200_300'],
      [/\b(?:a330[\s_-]?[89]\d\d(?:neo)?|airbus[\s_-]?330[\s_-]?[89]\d\d(?:neo)?|a330neo)\b/, 'A330_NEO'],
      [/\b(?:a330[\s_-]?3\d\d|airbus[\s_-]?330[\s_-]?3\d\d)\b/, 'A330_300'],
      [/\b(?:a330[\s_-]?2\d\d|airbus[\s_-]?330[\s_-]?2\d\d)\b/, 'A330_200'],
      [/\b(?:a220[\s_-]?[13]\d\d|a220|airbus[\s_-]?220|cs[13]00|cseries)\b/, 'A220'],
      [/\b(?:a318|airbus[\s_-]?318)(?=\b|neo\b|ceo\b|xlr\b)/, 'A318'],
      [/\b(?:a319|airbus[\s_-]?319)(?=\b|neo\b|ceo\b|xlr\b)/, 'A319'],
      [/\b(?:a320|airbus[\s_-]?320)(?=\b|neo\b|ceo\b|xlr\b)/, 'A320'],
      [/\b(?:a321|airbus[\s_-]?321)(?=\b|neo\b|ceo\b|xlr\b)/, 'A321'],
      // A318-112, A319-111, A320-214, A321-271: match base name
      // despite numeric engineering suffixes, without mistaking another type.
      [/\b(?:a318|airbus[\s_-]?318)[\s_-]?1\d\d\b/, 'A318'],
      [/\b(?:a319|airbus[\s_-]?319)[\s_-]?[12]\d\d\b/, 'A319'],
      [/\b(?:a320|airbus[\s_-]?320)[\s_-]?[12]\d\d\b/, 'A320'],
      [/\b(?:a321|airbus[\s_-]?321)[\s_-]?[12]\d\d\b/, 'A321'],
      [/\b(?:737[\s_-]?max(?:[\s_-]?(?:7|8|9|10|200))?|b3[789]m|boeing[\s_-]?737[\s_-]?max|737[\s_-]?(?:7|8|9|10)\b)\b/, 'B737_MAX'],
      [/\b(?:737[\s_-]?(?:6\d\d|7\d\d|8\d\d|9\d\d)|b73[6789]|boeing[\s_-]?737[\s_-]?(?:6\d\d|7\d\d|8\d\d|9\d\d))\b/, 'B737_NG'],
      [/\b(?:737[\s_-]?200|b732)\b/, 'B737_200'],
      [/\b(?:737[\s_-]?[345]\d\d|b73[345])\b/, 'B737_CLASSIC'],
      [/\b(?:747[\s_-]?(?:8f?|8i)|b748|boeing[\s_-]?747[\s_-]?(?:8f?|8i)|747[\s_-]?8[\s_-]?(?:freighter|intercontinental))\b/, 'B747_8'],
      [/\b(?:747[\s_-]?sp|b74sp)\b/, 'B747_SP'],
      [/\b(?:747[\s_-]?(?:100|200)|boeing[\s_-]?747[\s_-]?(?:100|200))\b/, 'B747_100'],
      [/\b(?:747[\s_-]?4\d\d(?:d|er)?|b744|boeing[\s_-]?747[\s_-]?4\d\d(?:d|er)?)\b/, 'B747_400'],
      [/\b(?:757(?:[\s_-]?[23]\d\d)?|b75[23]|boeing[\s_-]?757)\b/, 'B757'],
      [/\b(?:767(?:[\s_-]?[234]\d\d)?|b76[234]|boeing[\s_-]?767)\b/, 'B767'],
      [/\b(?:777[\s_-]?9|b779|777x|boeing[\s_-]?777x)\b/, 'B777X'],
      [/\b(?:777[\s_-]?(?:200lr|300er|f|freighter)|b77[wl]|b77f|boeing[\s_-]?777[\s_-]?(?:200lr|300er|f|freighter))\b/, 'B777_LR_ER_F'],
      [/\b(?:777[\s_-]?(?:200er|200|300)|b77[23]|boeing[\s_-]?777[\s_-]?(?:200er|200|300))\b/, 'B777_CLASSIC'],
      [/\b(?:787[\s_-]?10|b78x|boeing[\s_-]?787[\s_-]?10)\b/, 'B787_10'],
      [/\b(?:787[\s_-]?9|b789|boeing[\s_-]?787[\s_-]?9)\b/, 'B787_9'],
      [/\b(?:787[\s_-]?8|b788|boeing[\s_-]?787[\s_-]?8)\b/, 'B787_8'],
      [/\b(?:e[\s_-]?195[\s_-]?e2|e195e2|embraer[\s_-]?195[\s_-]?e2)\b/, 'E195_E2'],
      [/\b(?:e[\s_-]?190[\s_-]?e2|e190e2|embraer[\s_-]?190[\s_-]?e2)\b/, 'E190_E2'],
      [/\b(?:e[\s_-]?195|erj[\s_-]?195(?:ar|lr)?|embraer[\s_-]?195)\b/, 'E195'],
      [/\b(?:e[\s_-]?190|erj[\s_-]?190|embraer[\s_-]?190)\b/, 'E190'],
      [/\b(?:e[\s_-]?175|erj[\s_-]?175|embraer[\s_-]?175)\b/, 'E175'],
      [/\b(?:e[\s_-]?170|erj[\s_-]?170|embraer[\s_-]?170)\b/, 'E170'],
      [/\b(?:erj[\s_-]?1(?:35|40|45)(?:lr|er|ar)?|embraer[\s_-]?145)\b/, 'ERJ145'],
      [/\b(?:emb[\s_-]?120|embraer[\s_-]?emb[\s_-]?120|brasilia)\b/, 'EMB120'],
      [/\b(?:crj[\s_-]?(?:100|200)|bombardier[\s_-]?crj[\s_-]?200)\b/, 'CRJ200'],
      [/\b(?:p[\s_-]?8i|p8i[\s_-]?neptune)\b/, 'P8I'],
      [/\b(?:learjet[\s_-]?45(?:[\s_-]?xr)?)\b/, 'LEARJET45'],
      [/\b(?:c919|comac[\s_-]?c919)\b/, 'C919'],
      [/\b(?:l[\s_-]?1011|tristar)\b/, 'L1011'],
      [/\b(?:saab[\s_-]?340|sf340)\b/, 'SAAB340'],
      [/\b(?:crj[\s_-]?1000|crj10|cl[\s_-]?600[\s_-]?2e25)\b/, 'CRJ1000'],
      [/\b(?:crj[\s_-]?900|crj9|cl[\s_-]?600[\s_-]?2d24)\b/, 'CRJ900'],
      [/\b(?:crj[\s_-]?700|crj7|cl[\s_-]?600[\s_-]?2c10)\b/, 'CRJ700'],
      [/\b(?:atr[\s_-]?(?:42|72)[\s_-]?600|at[47]6)\b/, 'ATR_600'],
      [/\b(?:atr[\s_-]?(?:42|72)(?:[\s_-]?(?:200|300|500))?|at[47][235])\b/, 'ATR_LEGACY'],
      [/\b(?:dash[\s_-]?8|dhc[\s_-]?8|q400|dh8d|dh8[abc])\b/, 'DASH8'],
      [/\b(?:cessna[\s_-]?208|c[\s_-]?208|caravan)\b/, 'C208'],
      [/\b(?:cessna[\s_-]?172|c[\s_-]?172|skyhawk)\b/, 'C172'],
    ];
    // Prefer the visible aircraft name. Several community models reuse a
    // repository directory whose path names ANOTHER aircraft (e.g. 747SP in
    // a 737-600 directory, 787-9 in a 787-10 directory).
    for (const [pattern, key] of matches) {
      if (pattern.test(displayedName)) return { key, profile: STEERING_PROFILES[key], match: 'DISPLAYED AIRCRAFT NAME', identity };
    }
    // Only consult legacy setup/repository metadata if no displayed name matched.
    for (const [pattern, key] of matches) {
      if (pattern.test(t)) return { key, profile: STEERING_PROFILES[key], match: 'AIRCRAFT METADATA / REPOSITORY FALLBACK', identity };
    }
    // Explicit geoFS IDs collected from actual test reports, never from wheel count.
    // Official GeoFS A380 is catalogued under ID 10; only a fallback when names are absent.
    if (identity.id === '10') return { key: 'A380_800', profile: STEERING_PROFILES.A380_800,
      match: 'GEOFS AIRCRAFT ID 10 · A380 (EXTERNAL CATALOG)', identity };
    if (identity.id === '4') return { key: 'B737_NG', profile: STEERING_PROFILES.B737_NG, match: 'USER-OBSERVED GEOFS ID 4 (ASSUMED NG)', identity };
    if (identity.id === '244') return { key: 'A330_300', profile: STEERING_PROFILES.A330_300, match: 'USER-VERIFIED GEOFS ID 244', identity };
    if (identity.id === '3140') return { key: 'A319', profile: STEERING_PROFILES.A319, match: 'USER-VERIFIED GEOFS ID 3140', identity };
    if (identity.id === '3534') return { key: 'A320', profile: STEERING_PROFILES.A320, match: 'USER-VERIFIED GEOFS ID 3534', identity };
    // Some GeoFS instances expose only 'A350' or aircraft ID 2973.
    // A public add-on catalog lists ID 2973 as A350-1000, but the bare ID is
    // deliberately NOT treated as proof of subtype: use an honest family profile.
    if (identity.id === '2973' || /\b(?:a[\s_-]?350|airbus[\s_-]?350)\b/.test(t)) {
      return { key: 'A350_FAMILY', profile: STEERING_PROFILES.A350_FAMILY,
        match: 'A350 FAMILY · UNCONFIRMED VARIANT / 72-DEG TEST FALLBACK', identity };
    }
    return { key: 'UNKNOWN', profile: STEERING_PROFILES.UNKNOWN, match: 'NO IDENTIFIABLE MODEL', identity };
  }

  function getMaxNwsDeg() {
    return state.profile?.maxDeg ?? CONFIG.maxNosewheelDeg;
  }


  // SPEED LAW SELECTOR – deliberately independent of profile recognition,
  // calibrated pedal normalization, steering animation binding and control sync.
  // CLASSIC is unchanged for all aircraft except A380, which has a
  // simulator-specific low-speed 70-degree request curve and AUTO TAXI ASSIST.
  // REALISTIC is an OEM-inspired *simulator approximation*, not a certified
  // Airbus/Boeing/Embraer Flight Control Computer or hydraulic NWS model.
  // A known maximum steering angle alone does NOT establish a speed law.
  // Unknown/unsupported types transparently use CLASSIC as a fallback.
  //
  // A key distinction: the user's ONE physical pedal axis still acts as a
  // virtual tiller at low speed. At speed, the authority smoothly hands off
  // to simulated pedal-NWS authority; the aircraft's normal yaw is untouched.
  // Manufacturer-published speed breakpoints are preserved where available;
  // interpolation and some washout endpoints are simulator assumptions.
  //
  // Normalized tiller control points are fractions of aircraft profile.maxDeg.
  // Rudder control points below specify absolute steering degrees.
  const AIRCRAFT_SPEED_LAWS = Object.freeze({
    A320_FAMILY: Object.freeze({
      label: 'A320 FAMILY · OEM-INSPIRED',
      confidence: 'PUBLISHED BREAKPOINTS + INTERPOLATION',
      note: 'Up to 75 deg tiller through 20 kt, washes out by 80 kt; rudder 6 deg through 40 kt then fades toward 0 at 130 kt. No hydraulic/anti-skid logic modeled.',
      sources: [
        'https://docs.flybywiresim.com/aircraft/a32nx/feature-guides/nw-tiller/',
        'https://studylib.net/doc/28435483/toliss-airbusa320-aircraftmanual',
      ],
      tiller: [[0,1], [20,1], [80,0]],
      rudder: [[0,6], [40,6], [130,0]],
    }),
    A330: Object.freeze({
      label: 'A330 · OEM-INSPIRED',
      confidence: 'DOCUMENTED HIGH-LEVEL LAW + MODELED INTERPOLATION',
      note: '72-deg model limit preserved for LRX A330-300; tiller begins fading after 10 kt. 100-kt tiller washout end and 150-kt rudder washout end are approximations. No distinct landing-direction rule.',
      sources: ['https://airbusflightinstructor.com/a330/ata-32/ata-32-17-steering-angle-protection'],
      tiller: [[0,1],[10,1],[100,0]],
      rudder: [[0,6],[100,6],[150,0]],
    }),
    A350: Object.freeze({
      label: 'A350 · OEM-INSPIRED',
      confidence: 'PUBLISHED START OF WASHOUT + MODELED ENDPOINT',
      note: 'Tiller available at full profile angle below 30 kt, then progressively reduced. 100-kt tiller end is an explicit simulator assumption; pedal NWS 6 deg up to 100 kt then fades to 0 by modeled 130 kt.',
      sources: [
        'https://fliphtml5.com/ognnl/wwao/A350-1000-FCOM/2878/',
        'https://www.smartcockpit.com/wp_quiz/airbus-a350-landing-gear/',
      ],
      tiller: [[0,1],[30,1],[100,0]],
      rudder: [[0,6],[100,6],[130,0]],
    }),
    A380: Object.freeze({
      label: 'A380 · FCTM-INSPIRED SIMULATION',
      confidence: 'DOCUMENTED STEERING MAXIMUM/PEDAL RANGE + MODELED SPEED LAW',
      note: '70-deg active tiller and 6-deg pedal NWS are documented. Pedal steering remains effective to approximately 150 kt during takeoff (A380 FCTM). The tiller points 20/80 kt and straight-line interpolation, and the pedal 100-kt washout start, are SIMULATOR ASSUMPTIONS, not a verified OEM speed schedule. A380 body-wheel steering (BWS) is not controlled by this standalone.',
      sources: [
        'https://docs.flybywiresim.com/pilots-corner/a380x/a380x-briefing/flight-deck/overviews/lateral-console/',
        'https://studylib.net/doc/28002580/fctm-20110826',
        'https://aircraft.airbus.com/sites/g/files/jlcbta126/files/2023-12/ac_a380_1223.pdf',
      ],
      tiller: [[0,1],[20,1],[80,0]],
      rudder: [[0,6],[100,6],[150,0]],
    }),
    B737: Object.freeze({
      label: '737 NG/MAX · OPERATIONAL SIMULATION',
      confidence: 'PUBLISHED MAXIMA + SIMULATED PILOT TECHNIQUE',
      note: 'Tiller 78 deg and pedal NWS 7 deg are documented. Boeing 737 has no automatic high-speed tiller washout in the cited description: the tiller reduction here is a pilot-technique simulation, NOT an OEM automatic speed law.',
      sources: [
        'https://assets.publishing.service.gov.uk/media/698c54d69db95e3291140b74/Boeing_737-8K5_G-TAWD_12-24.pdf',
        'https://manuals.pmdg.com/737/PMDG_737_MSFS_Introduction.pdf',
      ],
      tiller: [[0,1],[10,1],[30,0.33],[50,7/78],[65,0]],
      rudder: [[0,7],[100,7],[130,0]],
    }),
    E190: Object.freeze({
      label: 'EMBRAER E190 · OEM-INSPIRED',
      confidence: 'SYSTEM RANGE + MODELED HIGH-SPEED ENDPOINT',
      note: '76 deg through 10 kt, 20 deg at 26.2–89 kt, 7 deg from 100 kt; interpolation between bands. Rudder high-speed washout beyond 100 kt is modeled, not sourced.',
      sources: [
        'https://flite.ch/emb/Summary_E190.pdf',
        'https://github.com/YV3399/E-jet-family-YV/blob/master/Documentation/guide.markdown',
      ],
      tiller: [[0,1],[10,1],[26.2,20/76],[89,20/76],[100,7/76],[130,0]],
      rudder: [[0,7],[100,7],[130,0]],
    }),
  });

  const SPEED_LAW_BY_PROFILE = Object.freeze({
    A318:'A320_FAMILY', A319:'A320_FAMILY', A320:'A320_FAMILY', A321:'A320_FAMILY',
    A330_300:'A330', A350_FAMILY:'A350', A350_900:'A350', A350_1000:'A350', A380_800:'A380',
    B737_NG:'B737', B737_MAX:'B737', E190:'E190',
  });

  // A380 AUTO TAXI ASSIST (BOTH LAWS) – GeoFS-only experimental handling.
  // Telemetry from A380 Test 5 (v0.0.19) shows rolling speed stagnation
  // near 1.4–1.8 kt while the previous assist released >40 deg. The revised
  // envelope is a TEST HYPOTHESIS, NOT an Airbus/OEM steering law:
  // hold 30 deg through 2 kt, then release 43 deg at 3 kt, 50 deg at
  // 3.5 kt, 54 deg at 4 kt, 63 deg at 5 kt and 70 deg at 6 kt.
  // There is no tire-slip sensor or slip feedback; no physical wheel tuning.
  // A380 CLASSIC is deliberately allowed to REQUEST up to 70 deg through 6 kt
  // so the vehicle can START a tight turn from rest as its speed builds.
  // The geometry cannot physically complete a moving turn while at 0 kt.
  const A380_TAXI_ASSIST_CURVE = Object.freeze([
    [0, 30], [0.5, 30], [1, 30], [1.5, 30], [2, 30],
    [3, 43], [3.5, 50], [4, 54], [5, 63], [6, 70], [8, 70],
  ]);
  // Only A380 CLASSIC changes; beyond ~12 kt it rejoins its previous curve.
  // At high speed we never keep the large 70-degree taxi request.
  const A380_CLASSIC_REQUEST_CURVE = Object.freeze([
    [0, 70], [6, 70], [8, 64], [10, 48], [12, 28],
    [15, 20], [20, 12], [25, 8], [30, 6],
  ]);
  const A380_EFFECTIVE_LIMIT_CHOICES = Object.freeze([50, 55, 60, 65, 70]);
  const A380_RATE_MODES = Object.freeze({
    SOFT: Object.freeze([[0, 6], [5, 10], [15, 14], [30, 18], [80, 24]]),
    NORMAL: Object.freeze([[0, 10], [5, 15], [15, 20], [30, 25], [80, 30]]),
    QUICK: Object.freeze([[0, 18], [5, 25], [15, 32], [30, 40], [80, 50]]),
    // Diagnostic mode only; not recommended for abrupt taxi steering.
    OFF: null,
  });

  function a380HandlingEnabled() {
    // Mandatory for A380 on the ground regardless of CLASSIC / REALISTIC.
    return state.profileKey === 'A380_800';
  }

  function a380AssistMaxForSpeed(speedKt) {
    return clamp(interpCurve(A380_TAXI_ASSIST_CURVE, Math.max(0, speedKt)), 0, STEERING_PROFILES.A380_800.maxDeg);
  }

  function loadA380HandlingSettings() {
    try {
      const storedLimit = Number(localStorage.getItem(A380_LIMIT_STORAGE_KEY));
      if (A380_EFFECTIVE_LIMIT_CHOICES.includes(storedLimit)) state.a380EffectiveLimitDeg = storedLimit;
      const storedRate = localStorage.getItem(A380_RATE_STORAGE_KEY);
      if (Object.prototype.hasOwnProperty.call(A380_RATE_MODES, storedRate)) state.a380RateMode = storedRate;
    } catch (_) {}
  }

  function setA380HandlingSetting(which, value) {
    // A sudden new limit or slew-rate change in a taxi turn is undesirable.
    if (!a380HandlingEnabled() || state.lastSpeedKt >= 1.0 || (getAircraft() && !getAircraft().groundContact)) return false;
    if (which === 'limit') {
      // In CLASSIC the pilot can request 70 deg; this selector is REALISTIC-only.
      if (state.selectedLaw !== 'REALISTIC') return false;
      const limit = Number(value);
      if (!A380_EFFECTIVE_LIMIT_CHOICES.includes(limit)) return false;
      state.a380EffectiveLimitDeg = limit;
      try { localStorage.setItem(A380_LIMIT_STORAGE_KEY, String(limit)); } catch (_) {}
      return true;
    }
    if (which === 'rate' && Object.prototype.hasOwnProperty.call(A380_RATE_MODES, value)) {
      state.a380RateMode = value;
      try { localStorage.setItem(A380_RATE_STORAGE_KEY, value); } catch (_) {}
      return true;
    }
    return false;
  }

  function clearA380SlewState() {
    state.a380SlewedAngleDeg = 0;
    state.a380LastUpdateMs = null;
    state.a380CurrentRateDegPerSec = null;
    state.a380SpeedCapDeg = null;
    state.a380RequestBeforeAssistDeg = 0;
    state.a380LawMaxDeg = 0;
  }

  function limitA380SteeringRate(targetDeg, speedKt, nowMs) {
    const curve = A380_RATE_MODES[state.a380RateMode];
    if (!curve) {
      state.a380SlewedAngleDeg = targetDeg;
      state.a380LastUpdateMs = nowMs;
      state.a380CurrentRateDegPerSec = null;
      return targetDeg;
    }
    const rateDegPerSec = interpCurve(curve, speedKt);
    // Synchronized with controls.update; clamp long frame gaps (background
    // tab, pause, scene loading) to prevent a sudden NWS jump on resume.
    const dtSeconds = state.a380LastUpdateMs == null ? 1 / 60 :
      clamp((nowMs - state.a380LastUpdateMs) / 1000, 0, 0.10);
    state.a380LastUpdateMs = nowMs;
    state.a380CurrentRateDegPerSec = rateDegPerSec;
    const previous = state.a380SlewedAngleDeg;
    const step = rateDegPerSec * dtSeconds;
    const next = previous + clamp(targetDeg - previous, -step, step);
    state.a380SlewedAngleDeg = next;
    return next;
  }

  function selectedSpeedLaw() {
    if (state.selectedLaw !== 'REALISTIC') return null;
    const lawKey = SPEED_LAW_BY_PROFILE[state.profileKey];
    return lawKey ? AIRCRAFT_SPEED_LAWS[lawKey] ?? null : null;
  }

  function loadLawSelection() {
    try {
      const saved = localStorage.getItem(LAW_STORAGE_KEY);
      state.selectedLaw = saved === 'REALISTIC' ? 'REALISTIC' : 'CLASSIC';
    } catch (_) { state.selectedLaw = 'CLASSIC'; }
  }

  function setLawSelection(mode) {
    if (mode !== 'CLASSIC' && mode !== 'REALISTIC') return false;
    // Protect the pilot from abrupt authority jumps in motion. The selection
    // is saved and applied immediately on the ground when nearly stopped.
    if (state.lastSpeedKt >= 1.0 || (getAircraft() && !getAircraft().groundContact)) return false;
    state.selectedLaw = mode;
    clearA380SlewState();
    try { localStorage.setItem(LAW_STORAGE_KEY, mode); } catch (_) {}
    return true;
  }

  function getSteeringLimitForCurrentLaw(speedKt) {
    const max = getMaxNwsDeg();
    const law = selectedSpeedLaw();
    if (!law) {
      // Preserve 0.0.14 EXACTLY, including the 30 kt cutover.
      state.effectiveLaw = state.selectedLaw === 'REALISTIC' ? 'CLASSIC FALLBACK' : 'CLASSIC';
      state.lawDescription = state.selectedLaw === 'REALISTIC'
        ? 'NO TYPE-SPECIFIC REALISTIC LAW · USING CLASSIC' : '0.0.14 LEGACY CURVE';
      if (speedKt <= CONFIG.pedalTillerCutoverKt) {
        state.steeringMode = state.profileKey === 'A380_800' ? 'A380 CLASSIC TILLER · AUTO ASSIST' : 'PEDAL TILLER';
        // A380-only simulator correction: its classic 0.0.18 curve fell below
        // 70 deg at 5–6 kt, exactly where 70 deg can start to roll cleanly.
        if (state.profileKey === 'A380_800')
          return Math.max(0, interpCurve(A380_CLASSIC_REQUEST_CURVE, speedKt));
        return Math.max(0, interpCurve(CONFIG.tillerLimitCurve, speedKt) * (max / CONFIG.maxNosewheelDeg));
      }
      const limit = Math.max(0, getRudderLimitDeg(speedKt) * (max / CONFIG.maxNosewheelDeg));
      state.steeringMode = limit > 0.05 ? 'RUDDER/NWS' : 'RUDDER ONLY';
      return limit;
    }

    state.effectiveLaw = law.label;
    state.lawDescription = law.confidence;
    // Virtual-tiller and rudder axes are multiplexed onto a single set of
    // pedals. Never ADD both full authorities – clamp to the dominant bound.
    const tillerDeg = max * clamp(interpCurve(law.tiller, speedKt), 0, 1);
    const pedalDeg = Math.min(max, Math.max(0, interpCurve(law.rudder, speedKt)));
    let limit = clamp(Math.max(tillerDeg, pedalDeg), 0, max);
    // The user-adjustable REALISTIC ceiling is distinct from the mandatory
    // low-speed AUTO TAXI ASSIST used in BOTH law selections.
    if (a380HandlingEnabled()) limit = Math.min(limit, state.a380EffectiveLimitDeg);
    state.steeringMode = tillerDeg > pedalDeg + 0.05 ? 'PEDAL TILLER · REALISTIC' :
      limit > 0.05 ? 'RUDDER/NWS · REALISTIC' : 'RUDDER ONLY';
    return limit;
  }

  const state = {
    enabled: true,
    pedalInput: 0, // normalized/calibrated -1..+1 virtual tiller input
    rawPedalInput: 0,
    pedalSource: 'yaw',
    pedalCalibration: { left: -1, center: 0, right: 1, source: null },
    steeringMode: 'WAITING',
    selectedLaw: 'CLASSIC',
    a380EffectiveLimitDeg: 55, // 0.0.17 STARTING TEST VALUE, not a real A380 limit
    a380RateMode: 'NORMAL',
    a380SpeedCapDeg: null,
    a380RequestBeforeAssistDeg: 0,
    a380LawMaxDeg: 0,
    a380TargetAngleDeg: 0,
    a380SlewedAngleDeg: 0,
    a380LastUpdateMs: null,
    a380CurrentRateDegPerSec: null,
    effectiveLaw: 'CLASSIC',
    lawDescription: '0.0.14 LEGACY CURVE',
    profileKey: 'UNKNOWN',
    profile: STEERING_PROFILES.UNKNOWN,
    profileMatch: 'NO IDENTIFIABLE MODEL',
    profileIdentity: null,
    flightPhase: 'WAITING',
    groundLeg: 'TAXI',
    airborneSinceMs: null,
    groundSinceMs: null,
    airborneConfirmed: false,
    selectedWheelIndex: null,
    autoWheelIndex: null,
    aircraftToken: null,
    aircraftRef: null,
    originalControlsUpdate: null,
    wrapperInstalled: false,
    pendingNormalized: 0,
    wheelOriginalAnimation: null,
    nosewheelLabel: '—',
    nosewheelDetection: 'NONE',
    steeringBinding: 'NOT CONNECTED',
    wheelDetectionDetails: null,
    compatibilitySamples: [],
    compatibilityAssessment: 'UNTESTED',
    lastHeading: null,
    lastHeadingTime: 0,
    yawRateRadSec: 0,
    turnRadiusM: null,
    lastCommandDeg: 0,
    lastLimitDeg: CONFIG.maxNosewheelDeg,
    lastSpeedKt: 0,
    status: 'WAITING FOR GEOFS',
    diagnosticRafId: null,
    lastUiUpdateMs: -Infinity,
    lastRadiusUpdateMs: -Infinity,
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function interpCurve(curve, x) {
    if (x <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      const [x1, y1] = curve[i - 1];
      const [x2, y2] = curve[i];
      if (x <= x2) {
        const t = (x - x1) / Math.max(1e-9, x2 - x1);
        return lerp(y1, y2, t);
      }
    }
    return curve[curve.length - 1][1];
  }

  function getAircraft() {
    return PAGE.geofs?.aircraft?.instance || null;
  }

  function getControls() {
    return PAGE.controls || null;
  }


  function loadPedalCalibration() {
    try {
      const saved = JSON.parse(localStorage.getItem(CAL_STORAGE_KEY) || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.center) && Number.isFinite(saved.right)) {
        state.pedalCalibration = {
          left: Number(saved.left),
          center: Number(saved.center),
          right: Number(saved.right),
          source: typeof saved.source === 'string' ? saved.source : null,
        };
      }
    } catch (_) {}
  }

  function savePedalCalibration() {
    try { localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(state.pedalCalibration)); } catch (_) {}
  }

  function getRawPedalSignal() {
    const controls = getControls();
    if (!controls) return { value: 0, source: 'NONE' };

    // Prefer GeoFS' pre-processed raw rudder channel when present. controls.yaw
    // may already include sensitivity/exponential shaping and can therefore
    // have asymmetric endpoints even with full physical pedal travel.
    const candidates = [
      ['controls.rawYaw', Number(controls.rawYaw)],
      ['animation.rawYaw', Number(PAGE.geofs?.animation?.values?.rawYaw)],
      ['controls.yaw', Number(controls.yaw)],
    ];
    for (const [source, value] of candidates) {
      if (Number.isFinite(value)) return { value: clamp(value, -2, 2), source };
    }
    return { value: 0, source: 'NONE' };
  }

  function normalizePedal(raw, source) {
    const c = state.pedalCalibration;
    const valid = c && c.source === source &&
      Number.isFinite(c.left) && Number.isFinite(c.center) && Number.isFinite(c.right) &&
      c.left < c.center - 1e-4 && c.right > c.center + 1e-4;

    let value;
    if (valid) {
      value = raw < c.center
        ? -(c.center - raw) / (c.center - c.left)
        :  (raw - c.center) / (c.right - c.center);
    } else {
      value = raw;
    }

    value = clamp(value, -1, 1);
    if (Math.abs(value) < CONFIG.pedalDeadband) value = 0;
    return value;
  }

  function capturePedalCalibration(point) {
    const sample = getRawPedalSignal();
    state.rawPedalInput = sample.value;
    state.pedalSource = sample.source;
    const c = { ...state.pedalCalibration, source: sample.source };
    c[point] = sample.value;
    state.pedalCalibration = c;
    savePedalCalibration();
  }

  function getRollingSpeedKt() {
    const v = Number(PAGE.geofs?.animation?.values?.rollingSpeed);
    if (Number.isFinite(v)) return Math.abs(v) * 1.943844492;

    const ac = getAircraft();
    try {
      const vel = ac?.rigidBody?.getLinearVelocity?.();
      if (Array.isArray(vel) && vel.length >= 3) {
        const mps = Math.hypot(Number(vel[0]) || 0, Number(vel[1]) || 0, Number(vel[2]) || 0);
        return mps * 1.943844492;
      }
    } catch (_) {}

    const ktas = Number(PAGE.geofs?.animation?.values?.ktas ?? PAGE.geofs?.animation?.values?.tas);
    return Number.isFinite(ktas) ? Math.abs(ktas) : 0;
  }

  function getHeadingDeg() {
    const h = Number(PAGE.geofs?.animation?.values?.heading360);
    if (Number.isFinite(h)) return ((h % 360) + 360) % 360;
    const ac = getAircraft();
    const h2 = Number(ac?.htr?.[0]);
    return Number.isFinite(h2) ? ((h2 % 360) + 360) % 360 : null;
  }

  function headingDeltaDeg(a, b) {
    let d = b - a;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  function updateTurnRadius() {
    const ac = getAircraft();
    if (!ac?.groundContact || state.lastSpeedKt < 1) {
      state.turnRadiusM = null;
      state.lastHeading = null;
      state.lastHeadingTime = 0;
      state.yawRateRadSec = 0;
      return;
    }

    const now = performance.now();
    const h = getHeadingDeg();
    if (h == null) return;

    if (state.lastHeading != null && state.lastHeadingTime > 0) {
      const dt = (now - state.lastHeadingTime) / 1000;
      if (dt > 0.05 && dt < 1.2) {
        const dRad = headingDeltaDeg(state.lastHeading, h) * Math.PI / 180;
        const rawRate = dRad / dt;
        state.yawRateRadSec = lerp(state.yawRateRadSec, rawRate, CONFIG.turnRadiusSmoothing);

        const speedMps = state.lastSpeedKt / 1.943844492;
        const absRate = Math.abs(state.yawRateRadSec);
        state.turnRadiusM = speedMps > 0.7 && absRate > 0.002 ? speedMps / absRate : null;
      }
    }

    state.lastHeading = h;
    state.lastHeadingTime = now;
  }

  // Record only small, read-only steering snapshots at the existing slow
  // radius-telemetry cadence. This NEVER applies steering or yaw torque.
  // The 12-second history allows direct comparisons between a working and
  // non-working CC plane at 3-5 kt while holding a moderate pedal input.
  function recordCompatibilitySample(nowMs) {
    const ac = getAircraft();
    const controls = getControls();
    const values = PAGE.geofs?.animation?.values;
    if (!ac || !controls) return;
    const sample = {
      elapsedMs: Math.round(nowMs),
      groundContact: !!ac.groundContact,
      speedKt: +state.lastSpeedKt.toFixed(2),
      pedalsPercent: Math.round(state.pedalInput * 100),
      commandedAngleDeg: +state.lastCommandDeg.toFixed(2),
      yawRateDegSec: +(state.yawRateRadSec * 180 / Math.PI).toFixed(3),
      turnRadiusM: state.turnRadiusM == null ? null : +state.turnRadiusM.toFixed(1),
      headingDeg: getHeadingDeg(),
      controlsYaw: finiteOrNull(controls.yaw),
      controlsRawYaw: finiteOrNull(controls.rawYaw),
      controlsRoll: finiteOrNull(controls.roll),
      controlsNwAngle: finiteOrNull(controls.nwAngle),
      animationYaw: finiteOrNull(values?.yaw),
      animationSteering: finiteOrNull(values?.steering),
      animationSteeringAngle: finiteOrNull(values?.steeringAngle),
      steeringBinding: state.steeringBinding,
    };
    state.compatibilitySamples.push(sample);
    if (state.compatibilitySamples.length > CONFIG.compatibilityHistorySize) {
      state.compatibilitySamples.shift();
    }
    assessCompatibilitySamples();
  }

  function finiteOrNull(x) {
    if (x == null || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? +n.toFixed(4) : null;
  }

  function assessCompatibilitySamples() {
    if (!state.wheelOriginalAnimation) {
      state.compatibilityAssessment = 'NWS NOT CONNECTED';
      return;
    }
    const data = state.compatibilitySamples.filter(s =>
      s.groundContact && s.speedKt >= 2 && s.speedKt <= 10 &&
      Math.abs(s.commandedAngleDeg) >= 8);
    if (data.length < 3) {
      state.compatibilityAssessment = 'NEEDS 3-5 KT TEST';
      return;
    }
    const turning = data.filter(s => Math.abs(s.yawRateDegSec) >= 0.30);
    // A displayed animation connection is not sufficient evidence of
    // actual turning. This status only describes observed heading response.
    state.compatibilityAssessment = turning.length >= 2
      ? 'TURN OBSERVED'
      : 'NO CLEAR TURN OBSERVED';
  }

  function getSteeringDriverReport(ac) {
    const idx = state.selectedWheelIndex;
    const wheel = idx == null ? null : ac?.wheels?.[idx];
    const original = state.wheelOriginalAnimation?.original;
    const candidates = Array.isArray(wheel?.animations) ? wheel.animations.map((a,i) => ({
      index: i, type: a?.type ?? null, value: a?.value ?? null,
      ratio: a?.ratio ?? null, axis: a?.axis ?? null,
      isSteeringCandidate: steeringAnimationIndex({animations:[a]}) >= 0,
    })) : [];
    return {
      wheelIndex: idx,
      wheelName: state.nosewheelLabel,
      selectedAnimationOriginalValue: original?.value ?? null,
      selectedAnimationOriginalRatio: original?.ratio ?? null,
      wheelSuspension: wheel?.suspension ?? null,
      wheelContactType: wheel?.contactType ?? null,
      animationsCurrent: candidates,
      // An original 'yaw' driver suggests a possible LEGACY YAW steering
      // convention, NOT proof that the aircraft's physics can turn.
      likelyLegacyYawAnimation: (Array.isArray(original?.value)
        ? original.value : [original?.value]).some(v =>
          typeof v === 'string' && v.toLowerCase() === 'yaw'),
    };
  }

  function getAircraftToken(ac) {
    if (!ac) return null;
    return `${ac.id ?? 'unknown'}|${ac.definition?.name ?? ac.setup?.name ?? ''}`;
  }

  function looksLikeA350(ac) {
    const id = String(ac?.id ?? '');
    const text = [
      ac?.definition?.name,
      ac?.setup?.name,
      ac?.aircraftRecord?.fullPath,
      ac?.definition?.type,
    ].filter(Boolean).join(' ').toLowerCase();

    // 2973 is a commonly observed GeoFS A350 ID; name/path detection remains primary fallback.
    return id === '2973' || /a350|a-350|airbus\s*350/.test(text);
  }


  // The A350 labels its nose wheel "Front Gear Suspension", while other
  // GeoFS aircraft may use "frontWheel", "noseGear", and similar names.
  // Never select left/right MAIN gear: changing their steering animation can
  // destabilize the airplane. If identification is uncertain, fail CLOSED.
  function wheelLabel(w, idx) {
    const name = [w?.name, w?.partName, w?.part?.name, w?.definition?.name,
      w?.setup?.name, w?.id].find(v => typeof v === 'string' && v.trim());
    return name ? String(name) : `wheel #${idx}`;
  }

  function wheelNormalizedName(w, idx) {
    const value = wheelLabel(w, idx)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .toLowerCase();
    return value.replace(/\s+/g, ' ').trim();
  }

  // An animation's `value` can be a string OR an array of driving signals.
  // Example from GeoFS aircraft ID 4 (737): ["yaw", "steering"]. In v0.0.7
  // String(["yaw", "steering"]) became "yaw,steering", which failed the
  // exact scalar matcher. Consequently prepareWheelAnimation did nothing.
  const STEER_VALUE_KEYS = new Set([
    'yaw', 'rawyaw', 'nwangle', 'rawnwangle', 'steeringangle',
    'nosewheelsteering', 'nosewheelangle', 'steering',
  ]);

  function steeringAnimationIndex(w) {
    const anims = Array.isArray(w?.animations) ? w.animations : [];
    return anims.findIndex(a => {
      const type = String(a?.type ?? '').toLowerCase();
      if (type && type !== 'rotate' && type !== 'rotation') return false;
      const values = Array.isArray(a?.value) ? a.value : [a?.value];
      // Do not infer steering from an arbitrary compound animation. Its
      // channels must have at least one yaw/nosewheel steering driver.
      const normalized = values.map(v =>
        typeof v === 'string' ? v.replace(/\s|_|-/g, '').toLowerCase() : ''
      );
      if (normalized.some(v => !v)) return false;
      const reliable = normalized.some(v => STEER_VALUE_KEYS.has(v) && v !== 'steering');
      const scalarSteering = normalized.length === 1 && normalized[0] === 'steering' &&
        isNoseGearName(wheelNormalizedName(w, 0));
      return reliable || scalarSteering;
    });
  }

  function isMainGearName(normalized) {
    return /\b(main|left|right|rear|back|aft|tail|bogie|truck|door)\b/.test(normalized);
  }

  function isNoseGearName(normalized) {
    return /\b(nose|front|forward|fwd)\b.*\b(gear|wheel|strut|suspension)\b/.test(normalized) ||
      /\b(gear|wheel|strut|suspension)\b.*\b(nose|front|forward|fwd)\b/.test(normalized) ||
      /\b(nws)\b/.test(normalized);
  }

  // Community-aircraft models may contain extra invisible steering helper wheels
  // (e.g., ID 2899 has both "Front gear suspension" and "frontGearFake").
  // A front-name match is NOT sufficient: prefer the REAL, steerable, sprung
  // nosewheel and never bind blindly to a fake/door/decorative part.
  function isAuxiliaryGearName(normalized) {
    return /\b(fake|dummy|helper|visual|visualonly|decorative|decoration|display|shadow|mock|door)\b/.test(normalized);
  }

  function hasSuspensionEvidence(wheel) {
    if (wheel?.suspension && typeof wheel.suspension === 'object') return true;
    return Array.isArray(wheel?.animations) && wheel.animations.some(a => {
      const type = String(a?.type ?? '').toLowerCase();
      const values = Array.isArray(a?.value) ? a.value : [a?.value];
      return (type === 'translate' || type === 'translation') &&
        values.some(v => typeof v === 'string' && /suspension/i.test(v));
    });
  }

  function findNosewheel(ac) {
    const wheels = Array.isArray(ac?.wheels) ? ac.wheels : [];
    const records = wheels.map((wheel, index) => {
      const normalized = wheelNormalizedName(wheel, index);
      return {
        wheel, index, name: wheelLabel(wheel, index), normalized,
        main: isMainGearName(normalized),
        auxiliary: isAuxiliaryGearName(normalized),
        namedFront: isNoseGearName(normalized),
        steerAnimationIndex: steeringAnimationIndex(wheel),
        sprung: hasSuspensionEvidence(wheel),
      };
    });
    const details = records.map(r => ({
      wheelIndex: r.index, name: r.name,
      namedFront: r.namedFront, mainGearExcluded: r.main,
      auxiliaryExcluded: r.auxiliary,
      hasSteeringAnimation: r.steerAnimationIndex >= 0,
      suspensionEvidence: r.sprung,
    }));
    const matched = (r, method) => ({
      index: r.index, name: r.name, method, details,
    });
    const ambiguous = (reason) => ({
      index: null, name: 'AMBIGUOUS FRONT GEAR', method: 'AMBIGUOUS',
      details, reason,
    });

    const safe = records.filter(r => !r.main && !r.auxiliary);
    const named = safe.filter(r => r.namedFront);
    const steerNamed = named.filter(r => r.steerAnimationIndex >= 0);
    // Prefer the uniquely steerable nose gear over another front-labeled item.
    if (steerNamed.length === 1) return matched(steerNamed[0], 'STEERABLE NOSE GEAR');
    if (steerNamed.length > 1) {
      const sprung = steerNamed.filter(r => r.sprung);
      if (sprung.length === 1) return matched(sprung[0], 'STEERABLE + SUSPENSION');
      return ambiguous('MULTIPLE STEERABLE FRONT WHEELS');
    }

    // Preserve safe fallback reporting when a unique front wheel lacks a
    // steering animation (NWS remains OFF; we do not invent an actuator).
    if (named.length === 1) return matched(named[0], 'NAME');
    if (named.length > 1) return ambiguous('MULTIPLE FRONT WHEELS WITHOUT STEERING');

    // Nonstandard names: permit only ONE unambiguous steering candidate.
    const steeringCandidates = safe.filter(r => r.steerAnimationIndex >= 0);
    if (steeringCandidates.length === 1) return matched(steeringCandidates[0], 'STEERING ANIMATION');
    if (steeringCandidates.length > 1) {
      const sprung = steeringCandidates.filter(r => r.sprung);
      if (sprung.length === 1) return matched(sprung[0], 'STEERING + SUSPENSION');
      return ambiguous('MULTIPLE STEERING CANDIDATES');
    }
    return {index: null, name: wheels.length ? 'NOT IDENTIFIED' : 'NO WHEELS',
      method: 'NONE', details, reason: 'NO SAFE STEERING ANIMATION'};
  }

  function restoreWheelAnimation(aircraft = state.aircraftRef || getAircraft()) {
    if (!aircraft || !state.wheelOriginalAnimation) return;
    const saved = state.wheelOriginalAnimation;
    // Restore only our original animation, not an unrelated aircraft's wheel.
    if (aircraft.wheels?.[saved.wheelIndex] === saved.wheel &&
        saved.wheel.animations?.[saved.animationIndex] === saved.animation) {
      Object.assign(saved.animation, saved.original);
    }
    state.wheelOriginalAnimation = null;
  }

  function prepareWheelAnimation(ac, idx) {
    if (!ac || idx == null) return false;
    const wheel = ac.wheels?.[idx];
    if (!wheel) return false;

    // Preserve the reference A350 behavior exactly. For all other aircraft,
    // modify ONLY an existing, explicitly identified steering rotation.
    // Suspension travel, retraction and main wheels remain untouched.
    const isOriginalA350Gear = wheelNormalizedName(wheel, idx) === 'front gear suspension';
    const animIndex = isOriginalA350Gear ? 0 : steeringAnimationIndex(wheel);
    if (animIndex < 0) return false;
    const anim = wheel.animations?.[animIndex];
    if (!anim || (!isOriginalA350Gear &&
       String(anim.type).toLowerCase() !== 'rotate' &&
       String(anim.type).toLowerCase() !== 'rotation')) return false;

    const original = { value: anim.value, ratio: anim.ratio, type: anim.type, axis: anim.axis };
    // Retarget this steering ROTATION to the calibrated per-frame steering
    // signal; do not touch the wheel's independent suspension animation.
    anim.value = 'steeringAngle';
    anim.ratio = getMaxNwsDeg();
    state.wheelOriginalAnimation = {
      wheel, wheelIndex: idx, animation: anim, animationIndex: animIndex,
      original,
    };
    return true;
  }

  function collectGearDiagnostics(ac) {
    const wheels = Array.isArray(ac?.wheels) ? ac.wheels : [];
    return {
      version: VERSION,
      steeringProfile: {
        databaseVersion: VERSION,
        databaseEntries: Object.keys(STEERING_PROFILES).length,
        key: state.profileKey,
        model: state.profile.model,
        maxSteeringDeg: state.profile.maxDeg,
        steeringType: state.profile.type,
        sourceConfidence: state.profile.confidence,
        sourceUrl: state.profile.source,
        provenance: state.profileMatch,
        notes: state.profile.note,
        identity: state.profileIdentity,
        speedLaw: state.effectiveLaw,
        selectedSpeedLaw: state.selectedLaw,
        lawConfidence: state.lawDescription,
        lawNotes: selectedSpeedLaw()?.note ?? 'Original CLASSIC speed curve from v0.0.14 is active.',
        lawReferences: selectedSpeedLaw()?.sources ?? [],
        geofsA380Handling: {
          active: a380HandlingEnabled(),
          autoTaxiAssist: a380HandlingEnabled(),
          enabledIn: 'CLASSIC + REALISTIC',
          oemMaxAngleDeg: STEERING_PROFILES.A380_800.maxDeg,
          selectedRealisticCeilingDeg: state.a380EffectiveLimitDeg,
          currentLawMaxDeg: state.a380LawMaxDeg,
          currentSpeedAssistCapDeg: state.a380SpeedCapDeg,
          requestedBeforeAssistDeg: state.a380RequestBeforeAssistDeg,
          limitedTargetDeg: state.a380TargetAngleDeg,
          rateMode: state.a380RateMode,
          currentRateDegPerSec: state.a380CurrentRateDegPerSec,
          deliveredAngleDeg: state.lastCommandDeg,
          note: 'Always-on A380-only GeoFS auto taxi speed cap; CLASSIC can request 70 deg but initially applies ~30 deg at 0 kt. Values are experimental, not OEM; physical wheel slip is not measured.',
        },
      },
      aircraftId: ac?.id ?? null,
      aircraftName: ac?.definition?.name ?? ac?.setup?.name ?? null,
      selectedWheelIndex: state.selectedWheelIndex,
      detection: state.nosewheelDetection,
      steeringBinding: state.steeringBinding,
      wheelDetectionDetails: state.wheelDetectionDetails,
      currentPedalPercent: Math.round(state.pedalInput * 100),
      commandedAngleDeg: state.lastCommandDeg,
      actualTurnRadiusM: state.turnRadiusM,
      compatibilityAssessment: state.compatibilityAssessment,
      measurementGuide: 'At 3-5 kt on level ground, hold 40-70% LEFT for 5-6 seconds, then RIGHT for 5-6 seconds; copy the report. Repeat on a known-working plane.',
      steeringDriver: getSteeringDriverReport(ac),
      measurementsLast12Seconds: state.compatibilitySamples.slice(),
      physicsMetadata: {
        contactProperties: ac?.definition?.contactProperties ?? null,
        collisionPointCount: Array.isArray(ac?.collisionPoints) ? ac.collisionPoints.length : null,
        wheelCount: Array.isArray(ac?.wheels) ? ac.wheels.length : null,
        sourceAircraftId: ac?.id ?? null,
      },
      yawValues: {
        controlsYaw: Number(getControls()?.yaw),
        animationYaw: Number(PAGE.geofs?.animation?.values?.yaw),
        customSteeringAngle: Number(PAGE.geofs?.animation?.values?.steeringAngle),
      },
      originalSteeringAnimation: state.wheelOriginalAnimation?.original ?? null,
      wheels: wheels.map((w, index) => ({
        index,
        name: wheelLabel(w, index),
        type: w?.type ?? w?.part?.type ?? null,
        position: Array.isArray(w?.position) ? w.position.slice(0, 3) : null,
        animations: (Array.isArray(w?.animations) ? w.animations : [])
          .map(a => ({ value: a?.value, type: a?.type, axis: a?.axis, ratio: a?.ratio })),
      })),
    };
  }

  function refreshAircraft(force = false) {
    const ac = getAircraft();
    if (!ac) {
      state.status = 'WAITING FOR GEOFS';
      if (state.aircraftRef) resetFlightPhase();
      state.aircraftRef = null;
      state.selectedWheelIndex = null;
      state.nosewheelLabel = '—';
      state.nosewheelDetection = 'NONE';
      state.steeringBinding = 'NOT CONNECTED';
      state.wheelDetectionDetails = null;
      state.profileKey = 'UNKNOWN';
      state.profile = STEERING_PROFILES.UNKNOWN;
      state.profileMatch = 'NO AIRCRAFT';
      state.profileIdentity = null;
      clearA380SlewState();
      return;
    }

    const token = getAircraftToken(ac);
    if (!force && ac === state.aircraftRef && token === state.aircraftToken) return;

    const previousAircraft = state.aircraftRef;
    if (previousAircraft && recorder.running) {
      markRecordingEvent('AIRCRAFT_CHANGED', 'Recording stopped automatically because aircraft changed.');
      stopRecording('Aircraft changed');
    }
    if (previousAircraft) restoreWheelAnimation(previousAircraft);
    state.aircraftRef = ac;
    state.aircraftToken = token;
    resetFlightPhase();
    clearA380SlewState();
    const selection = resolveSteeringProfile(ac);
    state.profileKey = selection.key;
    state.profile = selection.profile;
    state.profileMatch = selection.match;
    state.profileIdentity = selection.identity;
    state.lastLimitDeg = getMaxNwsDeg();
    const match = findNosewheel(ac);
    state.autoWheelIndex = match.index;
    state.selectedWheelIndex = match.index;
    state.nosewheelLabel = match.name;
    state.nosewheelDetection = match.method;
    state.wheelDetectionDetails = { reason: match.reason ?? null, candidates: match.details };
    state.wheelOriginalAnimation = null;
    state.compatibilitySamples = [];
    state.compatibilityAssessment = 'NEEDS 3-5 KT TEST';

    const bound = state.selectedWheelIndex != null &&
      prepareWheelAnimation(ac, state.selectedWheelIndex);
    state.steeringBinding = bound ? 'ANIMATION CONNECTED' : 'NO STEERING ANIMATION';
    if (bound) {
      state.status = looksLikeA350(ac) ? 'A350 STEERING BOUND' : 'STEERING ANIMATION BOUND · TEST TURNING';
    } else {
      state.status = match.method === 'AMBIGUOUS' ? 'AMBIGUOUS NOSE GEAR · NWS OFF' :
        state.selectedWheelIndex != null ? 'NO STEERING ANIMATION · NWS OFF' :
        'NO SAFE NOSE GEAR FOUND · NWS OFF';
    }

  }

  function resetFlightPhase() {
    state.flightPhase = 'WAITING';
    state.groundLeg = 'TAXI';
    state.airborneSinceMs = null;
    state.groundSinceMs = null;
    state.airborneConfirmed = false;
  }

  // This is an indication-only, flight-history-based phase tracker.
  // The nosewheel steering law MUST remain independent of its output.
  function updateFlightPhase(ac, speedKt, nowMs) {
    if (!ac) {
      state.flightPhase = 'WAITING';
      return;
    }

    if (!ac.groundContact) {
      if (state.airborneSinceMs == null) state.airborneSinceMs = nowMs;
      state.groundSinceMs = null;
      if (nowMs - state.airborneSinceMs >= CONFIG.phaseAirborneConfirmMs) {
        state.airborneConfirmed = true;
      }
      // Immediately show AIRBORNE while contact is absent, but only a
      // sustained airborne interval qualifies the next touchdown as LANDING.
      state.flightPhase = 'AIRBORNE';
      return;
    }

    if (state.groundSinceMs == null) state.groundSinceMs = nowMs;
    state.airborneSinceMs = null;

    if (state.airborneConfirmed) {
      // Avoid interpreting a single noisy contact frame as a touchdown.
      if (nowMs - state.groundSinceMs < CONFIG.phaseGroundConfirmMs) {
        state.flightPhase = 'AIRBORNE';
        return;
      }
      state.groundLeg = 'LANDING ROLL';
      state.airborneConfirmed = false;
    }

    if (state.groundLeg === 'LANDING ROLL') {
      // Landing rollout persists through the high-speed and tiller regions;
      // switch back to TAXI only after a genuine low-speed deceleration.
      if (speedKt <= CONFIG.phaseTaxiBelowKt) state.groundLeg = 'TAXI';
      state.flightPhase = state.groundLeg;
      return;
    }

    // No reliable preceding flight: classify the >30 kt ground run as
    // TAKEOFF ROLL. Hysteresis prevents mode flicker around 30 kt.
    if (speedKt > CONFIG.phaseTakeoffAboveKt) {
      state.groundLeg = 'TAKEOFF ROLL';
    } else if (state.groundLeg === 'TAKEOFF ROLL' && speedKt <= CONFIG.phaseTaxiBelowKt) {
      state.groundLeg = 'TAXI';
    }
    state.flightPhase = state.groundLeg;
  }

  function getRudderLimitDeg(speedKt) {
    if (speedKt <= CONFIG.rudderNwsFadeStartKt) return CONFIG.rudderNwsDegBelow100Kt;
    if (speedKt >= CONFIG.rudderNwsZeroKt) return 0;
    const t = (speedKt - CONFIG.rudderNwsFadeStartKt) /
      (CONFIG.rudderNwsZeroKt - CONFIG.rudderNwsFadeStartKt);
    return lerp(CONFIG.rudderNwsDegBelow100Kt, 0, t);
  }

  function computeSteeringCommand() {
    const ac = getAircraft();
    const controls = getControls();
    if (!ac || !controls) return;

    const speedKt = getRollingSpeedKt();
    state.lastSpeedKt = speedKt;
    updateFlightPhase(ac, speedKt, performance.now());

    if (!state.enabled || !ac.groundContact || state.selectedWheelIndex == null || !state.wheelOriginalAnimation) {
      clearA380SlewState();
      state.a380TargetAngleDeg = 0;
      state.lastCommandDeg = 0;
      state.pendingNormalized = 0;
      const sample = getRawPedalSignal();
      state.rawPedalInput = sample.value;
      state.pedalSource = sample.source;
      state.pedalInput = normalizePedal(sample.value, sample.source);
      state.steeringMode = !ac.groundContact ? 'AIRBORNE · RUDDER ONLY' : 'NWS OFF';
      return;
    }

    const sample = getRawPedalSignal();
    state.rawPedalInput = sample.value;
    state.pedalSource = sample.source;
    const yawInput = normalizePedal(sample.value, sample.source);
    state.pedalInput = yawInput;

    const limitDeg = getSteeringLimitForCurrentLaw(speedKt);

    // First calculate the pilot's full law request, then the mandatory A380
    // GeoFS assist speed cap. At 0 kt a requested 70 deg is NOT delivered
    // immediately: we start around 30 deg and progressively release 70 deg
    // as the aircraft obtains sufficient rolling speed.
    state.a380LawMaxDeg = limitDeg;
    state.a380RequestBeforeAssistDeg = clamp(yawInput * limitDeg, -limitDeg, limitDeg);
    state.a380SpeedCapDeg = a380HandlingEnabled() ? a380AssistMaxForSpeed(speedKt) : null;
    const assistedLimitDeg = state.a380SpeedCapDeg == null
      ? limitDeg : Math.min(limitDeg, state.a380SpeedCapDeg);
    state.lastLimitDeg = assistedLimitDeg;
    const targetDeg = clamp(state.a380RequestBeforeAssistDeg, -assistedLimitDeg, assistedLimitDeg);
    state.a380TargetAngleDeg = targetDeg;
    let commandDeg = targetDeg;
    if (a380HandlingEnabled()) {
      commandDeg = limitA380SteeringRate(targetDeg, speedKt, performance.now());
      // Do NOT hard-clamp immediately to a newly SHRUNK speed cap: during
      // deceleration that could jerk the gear from 70 to 30 deg. Let the
      // existing servo slew rate bring the output down smoothly. The output
      // always remains within the physical 70-degree profile limit.
      commandDeg = clamp(commandDeg, -getMaxNwsDeg(), getMaxNwsDeg());
      state.a380SlewedAngleDeg = commandDeg;
    } else if (state.a380LastUpdateMs !== null) {
      clearA380SlewState();
    }

    state.lastCommandDeg = commandDeg;
    state.pendingNormalized = clamp(commandDeg / getMaxNwsDeg(), -1, 1);
  }

  function applySteeringOutput() {
    const ac = getAircraft();
    const controls = getControls();
    if (!ac || !controls) return;

    const normalized = state.enabled && ac.groundContact && state.selectedWheelIndex != null && !!state.wheelOriginalAnimation
      ? state.pendingNormalized
      : 0;

    // Keep the per-frame hook intentionally tiny: only scalar assignments.
    // Speed, protection curve and aircraft handling happen in this same control update.
    controls.rawNwAngle = normalized;
    controls.nwAngle = normalized;
    if (ac.animationValue) ac.animationValue.steeringAngle = normalized;
    if (PAGE.geofs?.animation?.values) PAGE.geofs.animation.values.steeringAngle = normalized;
  }

  function installControlWrapper() {
    const controls = getControls();
    if (!controls || typeof controls.update !== 'function') return false;
    if (state.wrapperInstalled) return true;

    const original = controls.update;
    state.originalControlsUpdate = original;

    controls.update = function (...args) {
      const out = original.apply(this, args);
      try {
        const ac = getAircraft();
        if (ac !== state.aircraftRef || getAircraftToken(ac) !== state.aircraftToken) {
          refreshAircraft(false);
        }
        computeSteeringCommand();
        applySteeringOutput();
      } catch (_) {}
      return out;
    };

    state.wrapperInstalled = true;
    return true;
  }

  function uninstallControlWrapper() {
    const controls = getControls();
    if (state.wrapperInstalled && controls && state.originalControlsUpdate) {
      controls.update = state.originalControlsUpdate;
    }
    state.wrapperInstalled = false;
    state.originalControlsUpdate = null;
  }


  // ================================================================
  // OPTIONAL TAXI TELEMETRY RECORDER – v0.0.18
  // Read-only instrumentation sampled in the existing diagnostic RAF.
  // NO extra controls.update interception, physics changes or wheel writes.
  // NWS command is NOT the physical tire slip angle; actual yaw response is
  // independently derived from observed heading movement.
  // ================================================================
  const RECORD_INTERVAL_MS = 100;             // target 10 Hz (browser RAF permitting)
  const RECORD_MAX_SAMPLES = 24000;          // about 40 minutes at 10 Hz
  const recorder = {
    running: false,
    startedISO: null,
    stoppedISO: null,
    startedMs: 0,
    lastSampleMs: -Infinity,
    previous: null,
    aircraftId: null,
    identity: null,
    profileAtStart: null,
    label: '',
    samples: [],
    events: [],
    reasonStopped: null,
    lastError: null,
  };

  function safeRound(value, digits = 3) {
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? null : Number(n.toFixed(digits));
  }

  function readVector3(vector) {
    if (!vector) return null;
    const components = Array.isArray(vector) ? vector.slice(0, 3) : [vector.x, vector.y, vector.z];
    return components.length === 3 && components.every(x => Number.isFinite(Number(x)))
      ? components.map(x => safeRound(x, 4)) : null;
  }

  function getTelemetrySample(nowMs) {
    const ac = getAircraft();
    const controls = getControls();
    const values = PAGE.geofs?.animation?.values;
    if (!ac || !controls) return null;
    const elapsedMs = nowMs - recorder.startedMs;
    const headingDeg = getHeadingDeg();
    const speedKt = getRollingSpeedKt();
    const dt = recorder.previous == null ? null : (nowMs - recorder.previous.timeMs) / 1000;
    const validDelta = dt !== null && dt > 0.025 && dt < 0.50;
    const yawDegPerSecond = validDelta && headingDeg != null && recorder.previous.headingDeg != null
      ? headingDeltaDeg(recorder.previous.headingDeg, headingDeg) / dt : null;
    const longitudinalAccMps2 = validDelta
      ? ((speedKt - recorder.previous.speedKt) / 1.943844492) / dt : null;
    const vMps = speedKt / 1.943844492;
    const omega = yawDegPerSecond == null ? null : yawDegPerSecond * Math.PI / 180;
    const radiusM = omega != null && vMps > 0.7 && Math.abs(omega) > 0.002
      ? vMps / Math.abs(omega) : null;
    const outputSteeringRate = validDelta
      ? (state.lastCommandDeg - recorder.previous.commandedAngleDeg) / dt : null;
    const steerTargetRate = validDelta
      ? (state.a380TargetAngleDeg - recorder.previous.targetAngleDeg) / dt : null;
    // Reading these optional physics channels is best effort. Their axes are
    // GeoFS/world coordinates; they are NOT nose-wheel tire slip sensors.
    let linearVelocity = null;
    let angularVelocity = null;
    try {
      linearVelocity = readVector3(ac.rigidBody?.getLinearVelocity?.());
      angularVelocity = readVector3(ac.rigidBody?.getAngularVelocity?.());
    } catch (_) {}
    const rawThrottle = safeRound(controls.throttle, 5);
    const distanceM = recorder.previous && validDelta
      ? recorder.previous.distanceM + 0.5 * (recorder.previous.speedKt + speedKt) / 1.943844492 * dt : 0;
    const sample = {
      tMs: Math.round(elapsedMs),
      timestampUTC: new Date().toISOString(),
      aircraftId: String(ac.id ?? ''),
      groundContact: !!ac.groundContact,
      flightPhase: state.flightPhase,
      speedKt: safeRound(speedKt, 3),
      speedSource: Number.isFinite(Number(values?.rollingSpeed)) ? 'animation.rollingSpeed' : 'FALLBACK (not necessarily groundspeed)',
      distanceM: safeRound(distanceM, 2),
      rollingSpeedRawMps: safeRound(values?.rollingSpeed, 4),
      headingDeg: safeRound(headingDeg, 4),
      yawRateDegSec: safeRound(yawDegPerSecond, 4),
      turnRadiusM: safeRound(radiusM, 2),
      longitudinalAccMps2: safeRound(longitudinalAccMps2, 4),
      estimatedLateralAccMps2: omega == null ? null : safeRound(vMps * omega, 4),
      // GeoFS controls: pilot commands, not actual propulsive force.
      throttleCommandRaw: rawThrottle,
      throttleCommandPercent: rawThrottle == null ? null : safeRound(rawThrottle * 100, 2),
      throttleAnimation: safeRound(values?.throttle, 5),
      thrustAnimation: safeRound(values?.thrust, 4),
      rpmAnimation: safeRound(values?.rpm, 4),
      reverseCommand: typeof controls.reverse === 'boolean' ? controls.reverse : safeRound(controls.reverse, 5),
      brakesCommand: safeRound(controls.brakes, 5),
      brakesAnimation: safeRound(values?.brakes, 5),
      // Pilot-to-NWS chain; output is commanded wheel animation angle,
      // NOT a physically measured wheel deflection or tire slip angle.
      pedalPercent: safeRound(state.pedalInput * 100, 2),
      rawPedal: safeRound(state.rawPedalInput, 5),
      pedalSource: state.pedalSource,
      controlsYaw: safeRound(controls.yaw, 5),
      controlsRawYaw: safeRound(controls.rawYaw, 5),
      controlsNwAngle: safeRound(controls.nwAngle, 5),
      controlsRawNwAngle: safeRound(controls.rawNwAngle, 5),
      animationSteeringAngle: safeRound(values?.steeringAngle, 5),
      nwsTargetDeg: safeRound(state.a380TargetAngleDeg, 3),
      nwsOutputDeg: safeRound(state.lastCommandDeg, 3),
      nwsTrackingErrorDeg: safeRound(state.a380TargetAngleDeg - state.lastCommandDeg, 3),
      nwsOutputRateDegSec: safeRound(outputSteeringRate, 3),
      nwsTargetRateDegSec: safeRound(steerTargetRate, 3),
      nwsLimitDeg: safeRound(state.lastLimitDeg, 3),
      a380AutoTaxiAssist: a380HandlingEnabled(),
      a380UnassistedRequestDeg: state.profileKey === 'A380_800' ? safeRound(state.a380RequestBeforeAssistDeg, 3) : null,
      a380LawLimitDeg: state.profileKey === 'A380_800' ? safeRound(state.a380LawMaxDeg, 3) : null,
      a380SpeedAssistCapDeg: state.profileKey === 'A380_800' ? safeRound(state.a380SpeedCapDeg, 3) : null,
      nwsSlewLimitDegSec: safeRound(state.a380CurrentRateDegPerSec, 3),
      nwsConnected: !!state.wheelOriginalAnimation,
      selectedLaw: state.selectedLaw,
      effectiveLaw: state.effectiveLaw,
      steeringMode: state.steeringMode,
      a380EffectiveMaxDeg: state.profileKey === 'A380_800' ? state.a380EffectiveLimitDeg : null,
      a380SteerRateMode: state.profileKey === 'A380_800' ? state.a380RateMode : null,
      linearVelocityWorld: linearVelocity,
      angularVelocityWorld: angularVelocity,
    };
    recorder.previous = { timeMs: nowMs, headingDeg, speedKt,
      commandedAngleDeg: state.lastCommandDeg, targetAngleDeg: state.a380TargetAngleDeg, distanceM };
    return sample;
  }

  function markRecordingEvent(kind, detail = '') {
    if (!recorder.startedISO || !recorder.running) return false;
    const nowMs = performance.now();
    const event = {
      tMs: Math.round(nowMs - recorder.startedMs),
      timestampUTC: new Date().toISOString(),
      type: kind,
      detail: String(detail || '').slice(0, 300),
      sampleIndex: Math.max(0, recorder.samples.length - 1),
      latestSpeedKt: safeRound(state.lastSpeedKt, 2),
      latestThrottleRaw: safeRound(getControls()?.throttle, 4),
      latestTargetDeg: safeRound(state.a380TargetAngleDeg, 2),
      latestOutputDeg: safeRound(state.lastCommandDeg, 2),
    };
    recorder.events.push(event);
    return true;
  }

  function stopRecording(reason = 'Manual stop') {
    if (!recorder.running) return false;
    markRecordingEvent('RECORDING_STOP', reason);
    recorder.running = false;
    recorder.stoppedISO = new Date().toISOString();
    recorder.reasonStopped = reason;
    return true;
  }

  function startRecording(label = '') {
    const ac = getAircraft();
    if (!ac || !getControls()) {
      recorder.lastError = 'GeoFS aircraft/controls not available';
      return false;
    }
    if (recorder.running) return false;
    if (recorder.samples.length || recorder.events.length) {
      recorder.lastError = 'Download/export and CLEAR the previous recording first';
      return false;
    }
    recorder.startedISO = new Date().toISOString();
    recorder.stoppedISO = null;
    recorder.startedMs = performance.now();
    recorder.lastSampleMs = -Infinity;
    recorder.previous = null;
    recorder.aircraftId = String(ac.id ?? 'unknown');
    recorder.identity = getAircraftIdentity(ac);
    recorder.profileAtStart = {
      profileKey: state.profileKey,
      profileModel: state.profile.model,
      maxNwsDeg: getMaxNwsDeg(),
      selectedLaw: state.selectedLaw,
      effectiveLaw: state.effectiveLaw,
      a380EffectiveMaxDeg: state.a380EffectiveLimitDeg,
      a380SteerRateMode: state.a380RateMode,
      a380AutoTaxiAssist: state.profileKey === 'A380_800',
      a380AssistSpeedCurve: A380_TAXI_ASSIST_CURVE,
      a380ClassicRequestCurve: A380_CLASSIC_REQUEST_CURVE,
      pedalCalibration: { ...state.pedalCalibration },
      gear: getSteeringDriverReport(ac),
    };
    recorder.label = String(label || '').slice(0, 100);
    recorder.reasonStopped = null;
    recorder.lastError = null;
    recorder.running = true;
    markRecordingEvent('RECORDING_START', recorder.label);
    return true;
  }

  function clearRecording() {
    if (recorder.running) return false;
    Object.assign(recorder, {
      startedISO: null, stoppedISO: null, startedMs: 0,
      lastSampleMs: -Infinity, previous: null, aircraftId: null,
      identity: null, profileAtStart: null, label: '', samples: [], events: [],
      reasonStopped: null, lastError: null,
    });
    return true;
  }

  function sampleRecording(nowMs) {
    if (!recorder.running || nowMs - recorder.lastSampleMs < RECORD_INTERVAL_MS) return;
    if (recorder.samples.length >= RECORD_MAX_SAMPLES) {
      stopRecording('Maximum session size reached (24000 samples)');
      return;
    }
    recorder.lastSampleMs = nowMs;
    try {
      const sample = getTelemetrySample(nowMs);
      if (!sample) {
        stopRecording('GeoFS signals unavailable');
        return;
      }
      if (sample.aircraftId !== recorder.aircraftId) {
        stopRecording('Aircraft changed');
        return;
      }
      recorder.samples.push(sample);
      if (recorder.samples.length > 1) {
        const last = recorder.samples[recorder.samples.length - 2];
        if (sample.tMs - last.tMs > 700) {
          markRecordingEvent('SAMPLE_GAP', `Browser sampling pause: ${sample.tMs - last.tMs} ms`);
        }
      }
    } catch (e) {
      recorder.lastError = String(e?.message ?? e);
      stopRecording(`Recorder error: ${recorder.lastError}`);
    }
  }

  function calculateRecordingSummary() {
    const rows = recorder.samples;
    const numeric = (field) => rows.map(r => r[field]).filter(x => typeof x === 'number' && Number.isFinite(x));
    const range = (field) => {
      const xs = numeric(field);
      return xs.length ? { min: safeRound(Math.min(...xs), 3), max: safeRound(Math.max(...xs), 3) } : null;
    };
    // Bounded to ~24k samples; avoid large spread calls for very long captures.
    const sectors = [[0,2],[2,4],[4,6],[6,10],[10,15],[15,20],[20,40],[40,Infinity]];
    return {
      sampleCount: rows.length,
      eventCount: recorder.events.length,
      durationSeconds: rows.length ? safeRound(rows[rows.length - 1].tMs / 1000, 2) : 0,
      nominalSamplingHz: 10,
      observedSamplesPerSecond: rows.length > 1 && rows.at(-1).tMs > 0 ? safeRound((rows.length - 1) * 1000 / rows.at(-1).tMs, 2) : null,
      ranges: {
        speedKt: range('speedKt'), throttlePercent: range('throttleCommandPercent'),
        brakes: range('brakesCommand'), nwsOutputDeg: range('nwsOutputDeg'),
        nwsTargetDeg: range('nwsTargetDeg'), yawRateDegSec: range('yawRateDegSec'),
        turnRadiusM: range('turnRadiusM'), accelerationMps2: range('longitudinalAccMps2'),
      },
      speedBands: sectors.map(([lower,upper]) => {
        const band = rows.filter(r => r.speedKt != null && r.speedKt >= lower && r.speedKt < upper);
        const radiusSamples = band.map(r => r.turnRadiusM).filter(r => typeof r === 'number' && r < 10000);
        const mean = key => {
          const xs = band.map(r => r[key]).filter(x => typeof x === 'number');
          return xs.length ? safeRound(xs.reduce((s,x) => s + x, 0) / xs.length, 2) : null;
        };
        return { speedKt: upper === Infinity ? `${lower}+` : `${lower}-${upper}`,
          count: band.length, avgThrottlePercent: mean('throttleCommandPercent'),
          avgNwsTargetDeg: mean('nwsTargetDeg'), avgNwsOutputDeg: mean('nwsOutputDeg'),
          avgAbsYawRateDegSec: band.length ? safeRound(band.reduce((a,b)=>a+Math.abs(b.yawRateDegSec ?? 0),0)/band.length,2) : null,
          minObservedTurnRadiusM: radiusSamples.length ? Math.min(...radiusSamples) : null,
        };
      }),
      eventTypes: Object.fromEntries([...new Set(recorder.events.map(e => e.type))].map(type => [type, recorder.events.filter(e => e.type === type).length])),
      warning: 'Recorded nosewheel angle is the commanded animation output, NOT a measured physical tire angle. Manual SKID/BRAKE marks are subjective observations.',
    };
  }

  function makeRecordingExport() {
    return {
      format: 'GeoFS Ground Steering Taxi Telemetry v1',
      userscriptVersion: VERSION,
      label: recorder.label,
      startUTC: recorder.startedISO,
      stopUTC: recorder.stoppedISO,
      recordedAircraftId: recorder.aircraftId,
      identity: recorder.identity,
      setup: recorder.profileAtStart,
      reasonStopped: recorder.reasonStopped,
      summary: calculateRecordingSummary(),
      events: recorder.events,
      samples: recorder.samples,
      methodology: {
        throttle: 'controls.throttle (command, nominal 0..1); animation.throttle, thrust, RPM recorded separately when available',
        speed: 'GeoFS animation rollingSpeed in m/s if available, else physical/airspeed fallback; see rollingSpeedRawMps',
        yaw: 'Unwrapped change in GeoFS heading360 divided by sample time, not angular velocity of tire',
        acceleration: 'Finite difference of groundspeed, not an inertial accelerometer reading',
        turnRadius: 'Groundspeed divided by absolute measured yaw rate, only when speed and yaw rate are large enough',
        nws: 'nwsOutputDeg is controller command, not measured physical wheel deflection',
        a380AutoTaxiAssist: 'If A380, a380UnassistedRequestDeg is pre-assist pilot command; a380SpeedAssistCapDeg is the always-on speed cap; nwsTargetDeg is the cap-limited target; nwsOutputDeg is rate-limited command. This is simulator calibration, not Airbus certification.',
        events: 'Manual observations timestamped by user; symptoms cannot be inferred as verified tire slip',
        physics: 'No physics values are modified by the recorder',
      },
    };
  }

  function recordingCsv() {
    const rows = recorder.samples;
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]).filter(k => !['linearVelocityWorld','angularVelocityWorld'].includes(k))
      .concat(['linearVelWorldXYZ', 'angularVelWorldXYZ', 'manualEvent']);
    const evBySample = new Map();
    for (const e of recorder.events) {
      const k = e.sampleIndex;
      evBySample.set(k, (evBySample.get(k) || []).concat([`${e.type}: ${e.detail}`]));
    }
    const esc = v => {
      const value = v == null ? '' : Array.isArray(v) ? v.join('|') : String(v);
      return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    };
    return '\uFEFF' + [cols.join(','), ...rows.map((r,i)=>cols.map(k => esc(
      k === 'linearVelWorldXYZ' ? r.linearVelocityWorld :
      k === 'angularVelWorldXYZ' ? r.angularVelocityWorld :
      k === 'manualEvent' ? (evBySample.get(i) || []).join(' | ') : r[k]
    )).join(','))].join('\r\n');
  }

  function downloadRecording(type) {
    if (!recorder.samples.length) return false;
    const safeName = (recorder.label || recorder.aircraftId || 'geofs').replace(/[^a-z0-9_-]+/gi,'_').slice(0,45);
    const utc = (recorder.startedISO || new Date().toISOString()).replace(/[:.-]/g,'').replace('T','_').slice(0,15);
    const fileName = `GeoFS_NWS_${safeName}_${utc}.${type}`;
    const blob = new Blob([type === 'json' ? JSON.stringify(makeRecordingExport(), null, 2) : recordingCsv()],
      { type: type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      return true;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
  }

  function renderRecorderUi() {
    if (!els.recStatus) return;
    const count = recorder.samples.length;
    const secs = recorder.running
      ? Math.max(0,(performance.now() - recorder.startedMs) / 1000)
      : count ? recorder.samples[count - 1].tMs / 1000 : 0;
    setText(els.recStatus, recorder.running ? '● REC' : count ? 'READY TO EXPORT' : 'IDLE');
    els.recStatus.style.color = recorder.running ? '#ff9f9f' : '#9fe3ba';
    setText(els.recStats, `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2,'0')} · ${count} samples · ${recorder.events.length} marks`);
    setText(els.recThrottle, `${safeRound(getControls()?.throttle * 100,1) ?? '—'}%`);
    setText(els.recError, recorder.lastError || (recorder.reasonStopped ? `Stopped: ${recorder.reasonStopped}` : ''));
    els.recStart.disabled = recorder.running || count > 0 || recorder.events.length > 0;
    els.recStop.disabled = !recorder.running;
    els.recClear.disabled = recorder.running || (count === 0 && recorder.events.length === 0);
    els.recJson.disabled = !count;
    els.recCsv.disabled = !count;
    els.recLabel.disabled = recorder.running;
    for (const button of els.recMarkButtons) button.disabled = !recorder.running;
  }

  // ---------------- UI ----------------
  const style = document.createElement('style');
  style.textContent = `
    /* The following palette intentionally matches GeoFS Analog Brakes 1.0.0. */
    #kb-nws-test-panel, #kb-nws-launcher { box-sizing: border-box; }
    #kb-nws-test-panel * { box-sizing: border-box; }
    #kb-nws-test-panel {
      position:fixed; right:18px; top:190px; z-index:2147483000;
      width:292px; max-width:calc(100vw - 16px); max-height:calc(100vh - 96px);
      overflow:auto; border:1px solid rgba(255,255,255,.20); border-radius:9px;
      background:rgba(16,18,22,.97); color:#ddd; font-family:Arial,sans-serif;
      font-size:10px; line-height:1.4; box-shadow:0 7px 24px rgba(0,0,0,.55);
      backdrop-filter:blur(6px); user-select:none;
    }
    #kb-nws-test-head {
      display:flex; align-items:center; gap:8px; padding:8px 9px;
      background:rgba(45,49,56,.99); border-bottom:1px solid rgba(255,255,255,.11);
      color:#f2f2f2; font-size:10px; font-weight:700; letter-spacing:.6px;
      cursor:grab; touch-action:none;
    }
    #kb-nws-test-head:active { cursor:grabbing; }
    #kb-nws-title {flex:1;}
    #kb-nws-version {font:400 9px monospace; color:#9ba2ab; letter-spacing:0;}
    #kb-nws-test-body { padding:9px; }
    #kb-nws-test-panel .kb-nws-row {
      display:flex; align-items:center; justify-content:space-between; gap:7px; margin:7px 0;
      min-height:20px;
    }
    #kb-nws-test-panel .kb-nws-big {font-size:10px; font-weight:700;}
    #kb-nws-test-panel .kb-nws-muted {color:#8f96a0; font-size:9px;}
    #kb-nws-test-panel .kb-nws-grid {display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; margin:9px 0 8px;}
    #kb-nws-test-panel .kb-nws-cell {padding:6px 3px; background:rgba(255,255,255,.045); border-radius:4px; text-align:center; min-width:0;}
    #kb-nws-test-panel .kb-nws-cell .kb-nws-muted {display:block; color:#8f96a0; font-size:8px; font-weight:700; letter-spacing:.4px;}
    #kb-nws-test-panel .kb-nws-cell b {display:block; margin-top:2px; color:#72e4a0; font:700 11px monospace; overflow-wrap:anywhere;}
    #kb-nws-test-panel select, #kb-nws-test-panel input[type=text] {
      background:#111318; color:#ffb24c; border:1px solid #575e68;
      border-radius:4px; padding:4px 5px; min-height:28px;
      font:10px monospace; max-width:100%;
    }
    #kb-nws-law-select { min-width:120px; width:130px; }
    #kb-nws-test-panel button {
      min-height:28px; padding:3px 7px; border:1px solid #575e68;
      border-radius:4px; background:#30343b; color:#e7e7e7;
      cursor:pointer; font:700 9px Arial,sans-serif;
    }
    #kb-nws-test-panel button:hover { background:#3a3f47; }
    #kb-nws-test-panel button:disabled, #kb-nws-test-panel select:disabled {opacity:.55; cursor:default;}
    #kb-nws-test-panel input[type=checkbox] { accent-color:#72e4a0; }
    #kb-nws-status-box {
      padding:7px 8px; margin-bottom:8px; border-radius:5px;
      background:rgba(114,228,160,.08); border:1px solid rgba(114,228,160,.20);
    }
    #kb-nws-status-box.kb-nws-status-off {
      background:rgba(255,115,115,.08); border-color:rgba(255,115,115,.35);
    }
    #kb-nws-status {color:#72e4a0; font:700 10px monospace; max-width:205px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
    #kb-nws-status-box.kb-nws-status-off #kb-nws-status { color:#ff7373; }
    #kb-nws-test-panel .kb-nws-warn {color:#ffb24c;}
    #kb-nws-test-panel #kb-nws-minimize {min-width:26px; min-height:22px; padding:0 6px; font-size:13px; line-height:1;}
    #kb-nws-test-panel details.kb-nws-fold {border-top:1px solid rgba(255,255,255,.11); margin-top:8px; padding-top:7px;}
    #kb-nws-test-panel details.kb-nws-fold > summary {cursor:pointer; color:#a5acb5; font-size:9px; font-weight:700; letter-spacing:.3px; padding:4px 0;}
    #kb-nws-test-panel details.kb-nws-fold[open] > summary {margin-bottom:8px;}
    #kb-nws-test-panel #kb-nws-a380-options[hidden] {display:none !important;}
    #kb-nws-test-panel #kb-nws-a380-options {border-top:1px solid rgba(255,255,255,.10); margin-top:9px; padding-top:7px;}
    #kb-nws-test-panel #kb-nws-a380-options select {max-width:155px;}
    #kb-nws-test-panel #kb-nws-recorder {margin:6px 0; padding:2px 0; background:transparent; border:0;}
    #kb-nws-test-panel #kb-nws-recorder > summary {color:#a5acb5; cursor:pointer; padding:3px 0; font-size:9px; font-weight:700;}
    #kb-nws-test-panel #kb-nws-recorder input {width:100%; user-select:text; margin:3px 0;}
    #kb-nws-test-panel .kb-nws-rec-actions {display:flex; flex-wrap:wrap; gap:5px; margin:6px 0;}
    #kb-nws-test-panel .kb-nws-rec-actions button {flex:1; min-width:55px;}
    #kb-nws-test-panel .kb-nws-rec-primary {background:#215c51;}
    #kb-nws-test-panel .kb-nws-rec-alert {background:#693936;}
    #kb-nws-test-panel #kb-nws-rec-error {color:#ffb24c; white-space:normal;}
    #kb-nws-test-panel .kb-nws-calibration button {min-width:0; font-size:8px;}
    #kb-nws-test-panel .kb-nws-foot {color:#8f96a0; font-size:9px; line-height:1.45; margin-top:6px;}
    #kb-nws-test-panel #kb-nws-profile {max-width:185px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;}
    #kb-nws-launcher {
      position:fixed; right:18px; top:190px; z-index:2147483000; display:none;
      min-height:32px; padding:0 11px; border:1px solid rgba(255,255,255,.22);
      border-radius:7px; background:rgba(45,49,56,.98); color:#f2f2f2;
      box-shadow:0 5px 18px rgba(0,0,0,.45);
      cursor:grab; user-select:none; touch-action:none;
      font:700 10px Arial,sans-serif; letter-spacing:.6px;
    }
    #kb-nws-launcher:active {cursor:grabbing;}
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'kb-nws-test-panel';
  panel.innerHTML = `
    <div id="kb-nws-test-head">GROUND STEERING</div>
    <div id="kb-nws-test-body">
      <div class="kb-nws-row"><span id="kb-nws-status">WAITING FOR GEOFS</span><label><input id="kb-nws-enable" type="checkbox" checked> ON</label></div>


      <div class="kb-nws-row"><label for="kb-nws-law-select">Steering law</label>
        <select id="kb-nws-law-select" title="Switch while stopped (under 1 kt)">
          <option value="CLASSIC">CLASSIC</option>
          <option value="REALISTIC">REALISTIC</option>
        </select>
      </div>
      <div class="kb-nws-row"><span>Active speed law</span><b id="kb-nws-law-active">CLASSIC</b></div>
      <div class="kb-nws-row"><span>Law details</span><span class="kb-nws-muted" id="kb-nws-law-quality">—</span></div>

      <div id="kb-nws-a380-options" hidden>
        <div class="kb-nws-row"><b>A380 · AUTO TAXI ASSIST</b><span class="kb-nws-muted">ALWAYS ON · BOTH LAWS</span></div>
        <div class="kb-nws-row"><label for="kb-nws-a380-max">REALISTIC max only</label>
          <select id="kb-nws-a380-max" title="GeoFS handling limit – not the Airbus hardware limit">
            <option value="50">50°</option><option value="55">55° · DEFAULT</option>
            <option value="60">60°</option><option value="65">65°</option><option value="70">70° · OEM MAX</option>
          </select>
        </div>
        <div class="kb-nws-row"><label for="kb-nws-a380-rate">Steering response</label>
          <select id="kb-nws-a380-rate" title="Maximum NWS turning speed; slower at low taxi speed">
            <option value="SOFT">SOFT · EXTRA SLOW</option>
            <option value="NORMAL">NORMAL · SMOOTH</option>
            <option value="QUICK">QUICK · LESS DAMPING</option>
            <option value="OFF">OFF · NO SLEW LIMIT (ASSIST ON)</option>
          </select>
        </div>
        <div class="kb-nws-row"><span>Requested / limited target / output</span><b id="kb-nws-a380-target">0° / 0° / 0°</b></div>
        <div class="kb-nws-row"><span>Auto assist limit / speed</span><b id="kb-nws-a380-speed-cap">30° at 0 kt</b></div>
        <div class="kb-nws-row"><span>Current steering rate</span><b id="kb-nws-a380-rate-value">—</b></div>
        <div class="kb-nws-muted">AUTO limits an A380 request to 30° from a standstill through 2 kt, then releases 50° at 3.5 kt and 70° at 6 kt. CLASSIC retains full 70° request for tight low-speed turns; REALISTIC uses the selectable cap above. Steering is rate-limited when SOFT/NORMAL/QUICK. These are experimental GeoFS values, NOT Airbus limits. Adjust settings below 1 kt; a 70° moving turn cannot happen at 0 kt.</div>
      </div>

      <div class="kb-nws-grid">
        <div class="kb-nws-cell"><span class="kb-nws-muted">GS</span><b id="kb-nws-gs">0.0 KT</b></div>
        <div class="kb-nws-cell"><span class="kb-nws-muted">LIMIT</span><b id="kb-nws-limit">72.0°</b></div>
        <div class="kb-nws-cell"><span class="kb-nws-muted">NWS</span><b id="kb-nws-cmd">0.0°</b></div>
      </div>

      <div class="kb-nws-row"><span>Aircraft profile</span><b id="kb-nws-profile">UNKNOWN</b></div>
      <div class="kb-nws-row"><span>Steering type</span><b id="kb-nws-profile-type">LEGACY FALLBACK</b></div>
      <div class="kb-nws-row"><span>Max NWS (profile)</span><b id="kb-nws-profile-max">72° · EST.</b></div>
      <div class="kb-nws-row"><span>Source / matching</span><span class="kb-nws-muted" id="kb-nws-profile-provenance">UNVERIFIED</span></div>
      <div class="kb-nws-row"><span>Turn radius</span><b id="kb-nws-radius">—</b></div>
      <div class="kb-nws-row"><span>Nose gear</span><b id="kb-nws-wheel">—</b></div>
      <div class="kb-nws-row"><span>Gear detection</span><b id="kb-nws-detection">—</b></div>
      <div class="kb-nws-row"><span>Steering binding</span><b id="kb-nws-binding">—</b></div>
      <div class="kb-nws-row"><span>Actual turning</span><b id="kb-nws-response">UNTESTED</b></div>
      <div class="kb-nws-row"><span>Flight phase</span><b id="kb-nws-phase">WAITING</b></div>
      <div class="kb-nws-row"><span>Steering mode</span><b id="kb-nws-mode">WAITING</b></div>
      <div class="kb-nws-row"><span class="kb-nws-big">Pedals</span><b id="kb-nws-input">0%</b></div>
      <div class="kb-nws-row"><span>Raw input</span><b id="kb-nws-raw">0.000</b></div>
      <div class="kb-nws-row"><span>Source</span><b id="kb-nws-source">—</b></div>
      <div class="kb-nws-grid">
        <button id="kb-nws-cal-left">FULL LEFT</button>
        <button id="kb-nws-cal-center">CENTER</button>
        <button id="kb-nws-cal-right">FULL RIGHT</button>
      </div>


      <details id="kb-nws-recorder" open>
        <summary>Telemetry recorder</summary>
        <div class="kb-nws-row"><span id="kb-nws-rec-status">IDLE</span><b id="kb-nws-rec-throttle">THR —%</b></div>
        <div class="kb-nws-muted" id="kb-nws-rec-stats">0:00 · 0 samples · 0 marks</div>
        <label class="kb-nws-muted" for="kb-nws-rec-label">Test name (e.g. A380 55° NORMAL)</label>
        <input id="kb-nws-rec-label" type="text" maxlength="100" placeholder="A380 55deg NORMAL / trial 1">
        <div class="kb-nws-rec-actions">
          <button type="button" id="kb-nws-rec-start" class="kb-nws-rec-primary">▶ START</button>
          <button type="button" id="kb-nws-rec-stop">■ STOP</button>
          <button type="button" id="kb-nws-rec-clear" title="Clear AFTER exporting">CLEAR</button>
        </div>
        <div class="kb-nws-muted">Mark a symptom WHILE it happens:</div>
        <input id="kb-nws-rec-note" type="text" maxlength="200" placeholder="Optional note (e.g. throttle 35%, skids at 4 kt)">
        <div class="kb-nws-rec-actions">
          <button class="kb-nws-rec-primary" type="button" data-rec-mark="GOOD">✓ GOOD</button>
          <button class="kb-nws-rec-alert" type="button" data-rec-mark="SKID">⚠ SKID</button>
          <button class="kb-nws-rec-alert" type="button" data-rec-mark="NOSE_DRAG">⚠ NOSE DRAG</button>
          <button type="button" data-rec-mark="NOTE">+ NOTE</button>
        </div>
        <div class="kb-nws-rec-actions">
          <button type="button" id="kb-nws-rec-json">⬇ JSON</button>
          <button type="button" id="kb-nws-rec-csv">⬇ CSV</button>
        </div>
        <div class="kb-nws-muted" id="kb-nws-rec-error"></div>
        <div class="kb-nws-muted">Throttle, brake/reverse, steering target/output, speed, acceleration, heading/yaw-rate and estimated turn radius. No physical tire-slip sensor. Recording stays in memory until you download or clear it. Stops automatically on aircraft change or 24000 samples.</div>
      </details>

      <div class="kb-nws-row"><button id="kb-nws-gear-info" type="button">COPY COMPAT REPORT</button><button id="kb-nws-reset-probe" type="button">RESET CHECK</button></div>
      <div class="kb-nws-muted">
        0.0.22: prefer displayed aircraft name over misleading repository paths; safely support scalar steering rotation on explicitly named nose gear (B737-400); Saab 340 uses provisional ±45° GeoFS test cap; unsteerable L-1011 and ambiguous 747-8F remain fail-closed pending gear evidence. A330neo/B767-400 physics remains unchanged. Preserves all 0.0.20 A380 functions and telemetry. 0.0.20: always-on A380 AUTO TAXI ASSIST in CLASSIC and REALISTIC now stays at 30° through 2 kt, allows 43° at 3 kt / 50° at 3.5 kt, and the full 70° at 6 kt, if requested. CLASSIC A380 now retains a 70° request through 6 kt; other CLASSIC aircraft and all other REALISTIC types are unchanged. REALISTIC A380 retains the selectable 50–70° maximum. Steering rate SOFT/NORMAL/QUICK is common to both laws. These are GeoFS simulator test values, not OEM laws. Switch law and A380 settings while stopped (&lt;1 kt).<br>
        C172/C208: pedal-linked steering only; additional differential-braking capability is NOT simulated. The original cockpit rudder remains untouched.<br>
        Community models may show clipping or nose sinking at high deflection; this script does not modify GeoFS wheel collision/suspension physics. Calibrate pedals as before. For turn-radius tests, roll at 3–5 kt and hold 40–70% pedal left, then right. COPY COMPAT REPORT includes profile, model matching, steering/physics diagnostics. Gear ambiguity still fails closed.
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // Small user-facing view, same design language as Analog Brakes / BTV.
  const body = panel.querySelector('#kb-nws-test-body');
  const head = panel.querySelector('#kb-nws-test-head');
  head.textContent = '';
  const title = document.createElement('span');
  title.id = 'kb-nws-title'; title.textContent = 'GROUND STEERING';
  const versionBadge = document.createElement('span');
  versionBadge.id = 'kb-nws-version'; versionBadge.textContent = `v${VERSION}`;
  const minBtn = document.createElement('button');
  minBtn.type = 'button'; minBtn.id = 'kb-nws-minimize'; minBtn.textContent = '−';
  minBtn.title = 'Minimize Ground Steering'; minBtn.setAttribute('aria-label','Minimize Ground Steering');
  head.append(title,versionBadge,minBtn);
  const launcher = document.createElement('button');
  launcher.id = 'kb-nws-launcher'; launcher.type = 'button'; launcher.textContent = 'STEERING';
  launcher.title = 'Open Ground Steering';
  document.body.appendChild(launcher);

  function rowFor(id) {
    const el = panel.querySelector('#' + id);
    return el?.closest('.kb-nws-row,.kb-nws-grid') || el;
  }
  // Collapse the full set of optional controls into ONE small Settings entry.
  const settingsFold = document.createElement('details');
  settingsFold.className = 'kb-nws-fold';
  const settingsTitle = document.createElement('summary');
  settingsTitle.textContent = 'SETTINGS';
  settingsFold.appendChild(settingsTitle);
  body.appendChild(settingsFold);

  // Keep the original calibration buttons and A380 options fully functional.
  const advancedIds = ['kb-nws-mode','kb-nws-input','kb-nws-law-active','kb-nws-law-quality',
    'kb-nws-a380-options','kb-nws-cal-left'];
  for (const id of advancedIds) {
    const el = rowFor(id);
    if (el) settingsFold.appendChild(el);
  }
  const calibrationButtons = settingsFold.querySelector('#kb-nws-cal-left')?.closest('.kb-nws-grid');
  if (calibrationButtons) calibrationButtons.classList.add('kb-nws-calibration');

  const diagnosticFold = document.createElement('details');
  diagnosticFold.className='kb-nws-fold';
  diagnosticFold.innerHTML='<summary>DIAGNOSTICS</summary>';
  settingsFold.appendChild(diagnosticFold);
  for (const id of ['kb-nws-profile-type','kb-nws-profile-max','kb-nws-profile-provenance',
    'kb-nws-radius','kb-nws-wheel','kb-nws-detection','kb-nws-binding','kb-nws-response',
    'kb-nws-phase','kb-nws-raw','kb-nws-source','kb-nws-gear-info']) {
    const el = rowFor(id);
    if (el) diagnosticFold.appendChild(el);
  }
  // Telemetry remains available for support, but never clutters the normal panel.
  const recorderPanel=panel.querySelector('#kb-nws-recorder');
  recorderPanel.open=false;
  diagnosticFold.appendChild(recorderPanel);
  // Remove the lengthy old test-build explanatory text from the live UI.
  for (const child of [...body.children]) {
    if (child.classList.contains('kb-nws-muted') && child.textContent.length>200) child.remove();
  }
  const a380Help=panel.querySelector('#kb-nws-a380-options > .kb-nws-muted');
  if (a380Help) a380Help.remove();

  const statusRow = rowFor('kb-nws-status');
  if (statusRow) statusRow.id = 'kb-nws-status-box';
  const steeringLawLabel=panel.querySelector('label[for="kb-nws-law-select"]');
  if (steeringLawLabel) steeringLawLabel.textContent='STEERING LAW';
  const aircraftLabel=panel.querySelector('#kb-nws-profile')?.previousElementSibling;
  if (aircraftLabel) aircraftLabel.textContent='AIRCRAFT';
  panel.querySelector('#kb-nws-profile')?.setAttribute('title','Detected aircraft profile');

  const layoutKey = 'kb-geofs-ground-steering-ui-v1';
  let uiLayout = {collapsed:false,panel:null,launcher:null};
  try { const saved=JSON.parse(localStorage.getItem(layoutKey)||'null');
    if (saved && typeof saved==='object') uiLayout={...uiLayout,...saved}; } catch (_) {}
  function saveLayout() {try {localStorage.setItem(layoutKey,JSON.stringify(uiLayout));} catch (_) {}}
  function place(el,pos) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    el.style.left=Math.min(Math.max(0,pos.x),Math.max(0,innerWidth-el.offsetWidth))+'px';
    el.style.top=Math.min(Math.max(0,pos.y),Math.max(0,innerHeight-el.offsetHeight))+'px';
    el.style.right='auto';
  }
  function setCollapsed(value) {
    uiLayout.collapsed=!!value;
    panel.style.display=value?'none':'block';
    launcher.style.display=value?'block':'none';
    if(value) place(launcher,uiLayout.launcher); else place(panel,uiLayout.panel);
    saveLayout();
  }
  minBtn.addEventListener('click',e=>{e.stopPropagation();setCollapsed(true);});
  let launcherDrag=null,launcherMoved=false;
  launcher.addEventListener('pointerdown',e=>{
    launcherDrag={id:e.pointerId,x:e.clientX,y:e.clientY,l:launcher.offsetLeft,t:launcher.offsetTop};
    launcherMoved=false;launcher.setPointerCapture(e.pointerId);
  });
  launcher.addEventListener('pointermove',e=>{
    if(!launcherDrag)return;
    const dx=e.clientX-launcherDrag.x,dy=e.clientY-launcherDrag.y;
    if(Math.hypot(dx,dy)>4) launcherMoved=true;
    if(!launcherMoved)return;
    const x=Math.max(0,Math.min(innerWidth-launcher.offsetWidth,launcherDrag.l+dx));
    const y=Math.max(0,Math.min(innerHeight-launcher.offsetHeight,launcherDrag.t+dy));
    launcher.style.left=x+'px';launcher.style.top=y+'px';launcher.style.right='auto';
  });
  launcher.addEventListener('pointerup',()=>{
    if(launcherDrag && launcherMoved){uiLayout.launcher={x:launcher.offsetLeft,y:launcher.offsetTop};saveLayout();}
    launcherDrag=null;
  });
  launcher.addEventListener('pointercancel',()=>{launcherDrag=null;});
  launcher.addEventListener('click',()=>{if(launcherMoved){launcherMoved=false;return;}setCollapsed(false);});
  setCollapsed(uiLayout.collapsed);

  const els = {
    head: panel.querySelector('#kb-nws-test-head'),
    status: panel.querySelector('#kb-nws-status'),
    enable: panel.querySelector('#kb-nws-enable'),
    lawSelect: panel.querySelector('#kb-nws-law-select'),
    lawActive: panel.querySelector('#kb-nws-law-active'),
    lawQuality: panel.querySelector('#kb-nws-law-quality'),
    a380Options: panel.querySelector('#kb-nws-a380-options'),
    a380Max: panel.querySelector('#kb-nws-a380-max'),
    a380Rate: panel.querySelector('#kb-nws-a380-rate'),
    a380Target: panel.querySelector('#kb-nws-a380-target'),
    a380SpeedCap: panel.querySelector('#kb-nws-a380-speed-cap'),
    a380RateValue: panel.querySelector('#kb-nws-a380-rate-value'),
    gs: panel.querySelector('#kb-nws-gs'),
    limit: panel.querySelector('#kb-nws-limit'),
    cmd: panel.querySelector('#kb-nws-cmd'),
    radius: panel.querySelector('#kb-nws-radius'),
    profile: panel.querySelector('#kb-nws-profile'),
    profileType: panel.querySelector('#kb-nws-profile-type'),
    profileMax: panel.querySelector('#kb-nws-profile-max'),
    profileProvenance: panel.querySelector('#kb-nws-profile-provenance'),
    wheel: panel.querySelector('#kb-nws-wheel'),
    detection: panel.querySelector('#kb-nws-detection'),
    binding: panel.querySelector('#kb-nws-binding'),
    response: panel.querySelector('#kb-nws-response'),
    resetProbe: panel.querySelector('#kb-nws-reset-probe'),
    gearInfo: panel.querySelector('#kb-nws-gear-info'),
    phase: panel.querySelector('#kb-nws-phase'),
    mode: panel.querySelector('#kb-nws-mode'),
    input: panel.querySelector('#kb-nws-input'),
    raw: panel.querySelector('#kb-nws-raw'),
    source: panel.querySelector('#kb-nws-source'),
    calLeft: panel.querySelector('#kb-nws-cal-left'),
    calCenter: panel.querySelector('#kb-nws-cal-center'),
    calRight: panel.querySelector('#kb-nws-cal-right'),
    recStatus: panel.querySelector('#kb-nws-rec-status'),
    recStats: panel.querySelector('#kb-nws-rec-stats'),
    recThrottle: panel.querySelector('#kb-nws-rec-throttle'),
    recError: panel.querySelector('#kb-nws-rec-error'),
    recStart: panel.querySelector('#kb-nws-rec-start'),
    recStop: panel.querySelector('#kb-nws-rec-stop'),
    recClear: panel.querySelector('#kb-nws-rec-clear'),
    recJson: panel.querySelector('#kb-nws-rec-json'),
    recCsv: panel.querySelector('#kb-nws-rec-csv'),
    recLabel: panel.querySelector('#kb-nws-rec-label'),
    recNote: panel.querySelector('#kb-nws-rec-note'),
    recMarkButtons: [...panel.querySelectorAll('[data-rec-mark]')],
  };


  els.enable.addEventListener('change', () => { state.enabled = els.enable.checked; });
  els.lawSelect.addEventListener('change', () => {
    if (!setLawSelection(els.lawSelect.value)) {
      els.lawSelect.value = state.selectedLaw;
      state.status = 'CHANGE LAW ONLY BELOW 1 KT ON GROUND';
    } else {
      state.status = `STEERING LAW: ${state.selectedLaw}`;
      markRecordingEvent('LAW_CHANGED', state.selectedLaw);
    }
    updateUi();
  });
  els.a380Max.addEventListener('change', () => {
    if (!setA380HandlingSetting('limit', els.a380Max.value)) {
      els.a380Max.value = String(state.a380EffectiveLimitDeg);
      state.status = 'A380 HANDLING: CHANGE ONLY BELOW 1 KT ON GROUND';
    } else {
      state.status = `A380 GEOFS EFFECTIVE LIMIT: ${state.a380EffectiveLimitDeg}°`;
      markRecordingEvent('A380_LIMIT_CHANGED', String(state.a380EffectiveLimitDeg));
    }
    updateUi();
  });
  els.a380Rate.addEventListener('change', () => {
    if (!setA380HandlingSetting('rate', els.a380Rate.value)) {
      els.a380Rate.value = state.a380RateMode;
      state.status = 'A380 HANDLING: CHANGE ONLY BELOW 1 KT ON GROUND';
    } else {
      state.status = `A380 GEOFS STEER RESPONSE: ${state.a380RateMode}`;
      markRecordingEvent('A380_RATE_CHANGED', state.a380RateMode);
    }
    updateUi();
  });

  els.recStart.addEventListener('click', () => {
    startRecording(els.recLabel.value);
    renderRecorderUi();
  });
  els.recStop.addEventListener('click', () => { stopRecording(); renderRecorderUi(); });
  els.recClear.addEventListener('click', () => { clearRecording(); renderRecorderUi(); });
  els.recJson.addEventListener('click', () => { downloadRecording('json'); renderRecorderUi(); });
  els.recCsv.addEventListener('click', () => { downloadRecording('csv'); renderRecorderUi(); });
  for (const button of els.recMarkButtons) {
    button.addEventListener('click', () => {
      if (markRecordingEvent(button.dataset.recMark, els.recNote.value)) {
        els.recNote.value = '';
        renderRecorderUi();
      }
    });
  }
  els.calLeft.addEventListener('click', () => capturePedalCalibration('left'));
  els.calCenter.addEventListener('click', () => capturePedalCalibration('center'));
  els.calRight.addEventListener('click', () => capturePedalCalibration('right'));
  els.resetProbe.addEventListener('click', () => {
    state.compatibilitySamples = [];
    state.compatibilityAssessment = 'NEEDS 3-5 KT TEST';
    els.gearInfo.textContent = 'COPY COMPAT REPORT';
  });
  els.gearInfo.addEventListener('click', async () => {
    const report = JSON.stringify(collectGearDiagnostics(getAircraft()), null, 2);
    try {
      await navigator.clipboard.writeText(report);
      els.gearInfo.textContent = 'GEAR INFO COPIED';
    } catch (_) {
      console.log('[GeoFS Ground Steering] GEAR DIAGNOSTICS', report);
      els.gearInfo.textContent = 'GEAR INFO IN CONSOLE';
    }
  });

  // Prevent GeoFS keyboard shortcuts while interacting with the test UI.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    panel.addEventListener(type, (e) => e.stopPropagation(), true);
  }

  // Basic draggable panel.
  (() => {
    let drag = null;
    els.head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      drag = { x: e.clientX, y: e.clientY, left: panel.offsetLeft, top: panel.offsetTop };
      els.head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    els.head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const left = clamp(drag.left + e.clientX - drag.x, 0, Math.max(0, innerWidth - panel.offsetWidth));
      const top = clamp(drag.top + e.clientY - drag.y, 0, Math.max(0, innerHeight - panel.offsetHeight));
      panel.style.left = `${left}px`; panel.style.top = `${top}px`; panel.style.right = 'auto';
    });
    const stop = () => { if (drag) { uiLayout.panel={x:panel.offsetLeft,y:panel.offsetTop};saveLayout(); } drag = null; };
    els.head.addEventListener('pointerup', stop);
    els.head.addEventListener('pointercancel', stop);
  })();

  function setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
  }

  function updateUi() {
    setText(els.status, state.status);
    const statusBox = panel.querySelector('#kb-nws-status-box');
    if (statusBox) statusBox.classList.toggle('kb-nws-status-off', !state.enabled || !state.nwsConnected);
    if (els.lawSelect.value !== state.selectedLaw) els.lawSelect.value = state.selectedLaw;
    els.lawSelect.disabled = state.lastSpeedKt >= 1 || !!(getAircraft() && !getAircraft().groundContact);
    setText(els.lawActive, state.effectiveLaw);
    setText(els.lawQuality, state.lawDescription);
    const a380Active = a380HandlingEnabled();
    els.a380Options.hidden = !a380Active;
    if (a380Active) {
      const locked = state.lastSpeedKt >= 1 || !!(getAircraft() && !getAircraft().groundContact);
      els.a380Max.disabled = locked || state.selectedLaw !== 'REALISTIC';
      els.a380Rate.disabled = locked;
      if (els.a380Max.value !== String(state.a380EffectiveLimitDeg)) els.a380Max.value = String(state.a380EffectiveLimitDeg);
      if (els.a380Rate.value !== state.a380RateMode) els.a380Rate.value = state.a380RateMode;
      setText(els.a380Target, `${state.a380RequestBeforeAssistDeg.toFixed(1)}° / ${state.a380TargetAngleDeg.toFixed(1)}° / ${state.lastCommandDeg.toFixed(1)}°`);
      setText(els.a380SpeedCap, `${state.a380SpeedCapDeg == null ? '—' : state.a380SpeedCapDeg.toFixed(1) + '°'} at ${state.lastSpeedKt.toFixed(1)} kt`);
      setText(els.a380RateValue, state.a380CurrentRateDegPerSec == null ? 'OFF' : `${state.a380CurrentRateDegPerSec.toFixed(1)}°/s`);
    }
    setText(els.gs, `${state.lastSpeedKt.toFixed(1)} KT`);
    setText(els.limit, `${state.lastLimitDeg.toFixed(1)}°`);
    setText(els.cmd, `${state.lastCommandDeg.toFixed(1)}°`);
    setText(els.profile, state.profile.model);
    setText(els.profileType, state.profile.type);
    setText(els.profileMax, `${state.profile.maxDeg}° ${state.profile.confidence.includes('UNVERIFIED') ? '· EST.' : ''}`);
    setText(els.profileProvenance, `${state.profile.confidence} · ${state.profileMatch}`);
    setText(els.radius, state.turnRadiusM && state.turnRadiusM < 5000 ? `${state.turnRadiusM.toFixed(1)} m` : '—');
    setText(els.wheel, state.nosewheelLabel);
    setText(els.detection, state.nosewheelDetection);
    setText(els.binding, state.steeringBinding);
    setText(els.response, state.compatibilityAssessment);
    setText(els.phase, state.flightPhase);
    setText(els.mode, state.steeringMode);
    setText(els.input, `${Math.round(state.pedalInput * 100)}%`);
    setText(els.raw, state.rawPedalInput.toFixed(3));
    setText(els.source, state.pedalSource);
    renderRecorderUi();
  }

  loadPedalCalibration();
  loadLawSelection();
  loadA380HandlingSettings();
  els.a380Max.value = String(state.a380EffectiveLimitDeg);
  els.a380Rate.value = state.a380RateMode;
  els.lawSelect.value = state.selectedLaw;

  // Install once. After installation, steering piggybacks on GeoFS' own controls.update
  // instead of using independent periodic timers. This avoids timer bunching / micro-stutter.
  const bootTimer = setInterval(() => {
    if (installControlWrapper()) {
      clearInterval(bootTimer);
      refreshAircraft(true);
      computeSteeringCommand();
      applySteeringOutput();
    }
  }, 250);

  function diagnosticFrame(nowMs) {
    if (recorder.running) sampleRecording(nowMs);
    if (nowMs - state.lastRadiusUpdateMs >= CONFIG.turnRadiusIntervalMs) {
      state.lastRadiusUpdateMs = nowMs;
      try { updateTurnRadius(); recordCompatibilitySample(nowMs); } catch (_) {}
    }
    if (nowMs - state.lastUiUpdateMs >= CONFIG.uiIntervalMs) {
      state.lastUiUpdateMs = nowMs;
      try { updateUi(); } catch (_) {}
    }
    state.diagnosticRafId = requestAnimationFrame(diagnosticFrame);
  }

  state.diagnosticRafId = requestAnimationFrame(diagnosticFrame);

  PAGE[SCRIPT_ID] = {
    version: VERSION,
    state,
    config: CONFIG,
    gearDiagnostics: () => collectGearDiagnostics(getAircraft()),
    telemetry: {
      get status() { return { running: recorder.running, samples: recorder.samples.length,
        events: recorder.events.length, startedISO: recorder.startedISO, lastError: recorder.lastError }; },
      start: (label = '') => startRecording(label),
      stop: () => stopRecording(),
      mark: (type, detail = '') => markRecordingEvent(type, detail),
      clear: () => clearRecording(),
      exportObject: () => makeRecordingExport(),
      downloadJSON: () => downloadRecording('json'),
      downloadCSV: () => downloadRecording('csv'),
    },
    // Read-only profile summary for future Suite integration.
    currentProfile: () => ({ ...state.profile, key: state.profileKey, match: state.profileMatch }),
    currentSpeedLaw: () => ({ selected: state.selectedLaw, effective: state.effectiveLaw, confidence: state.lawDescription,
      source: selectedSpeedLaw()?.sources ?? [], notes: selectedSpeedLaw()?.note ?? null,
      a380GeofsHandling: { active: a380HandlingEnabled(), autoTaxiAssist: a380HandlingEnabled(),
        selectedRealisticMaxDeg: state.a380EffectiveLimitDeg,
        speedAssistCapDeg: state.a380SpeedCapDeg,
        unassistedRequestDeg: state.a380RequestBeforeAssistDeg,
        limitedTargetDeg: state.a380TargetAngleDeg,
        rateMode: state.a380RateMode, currentRateDegPerSec: state.a380CurrentRateDegPerSec } }),
    profileCatalog: () => Object.fromEntries(Object.entries(STEERING_PROFILES).map(([key, value]) => [key, { ...value }])),
    destroy() {
      if (recorder.running) stopRecording('Userscript removed/reloaded');
      clearInterval(bootTimer);
      if (state.diagnosticRafId != null) cancelAnimationFrame(state.diagnosticRafId);
      state.diagnosticRafId = null;
      state.pendingNormalized = 0;
      state.lastCommandDeg = 0;
      clearA380SlewState();
      restoreWheelAnimation(state.aircraftRef);
      uninstallControlWrapper();
      state.aircraftRef = null;
      panel.remove();
      launcher.remove();
      style.remove();
      delete PAGE[SCRIPT_ID];
    },
  };
})();
