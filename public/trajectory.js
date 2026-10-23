/* =====================================================================
   trajectory.js — Global Launch Trajectory Engine (JS port)
   Ported from doc/ref_code.py (GlobalLaunchTrajectoryEngine)
   ---------------------------------------------------------------------
   Produces a realistic-looking ascent trajectory, drop zones, and
   flight events for any launch in the Launch Library 2 dataset,
   using only pad coordinates, orbit type, mission name and rocket name.

   Pure math — no API calls, no DOM, runs equally well in browser or Node.
   ===================================================================== */

(function (root) {
  "use strict";

  const R_E   = 6371.0;            // Earth mean radius (km)
  const OMEGA = 7.292115e-5;       // Earth angular velocity (rad/s)
  const V_ORB = 7.78;              // default orbital inertial horizontal speed (km/s)

  /* -------- southward-launch pad keywords --------
     Pads where high-inclination / SSO / south trajectories are forced
     to head south to avoid flying over land / neighbouring airspace. */
  const SOUTHWARD_PADS = [
    "Vandenberg", "Taiyuan", "Jiuquan", "Xichang",
    "Mahia", "Sriharikota", "Andøya", "Andoya", "Kodiak",
  ];

  /* -------- kinematic keyframe templates -------- */
  // (t_s, range_km, alt_km, vh_kms, vv_kms, event_label | null)
  const KF_REUSABLE_2STAGE = [
    [0.0,   0.0,    0.1,   0.00, 0.00, "Liftoff"],
    [70.0,  15.0,   14.0,  0.42, 0.35, "Max-Q"],
    [152.0, 95.0,   68.0,  1.95, 0.65, "MECO & Stage 1 Sep"],
    [195.0, 210.0,  108.0, 2.50, 0.45, "Fairing Deploy"],
    [360.0, 880.0,  180.0, 4.60, 0.20, null],
    [510.0, 1950.0, 210.0, 7.50, 0.02, "SECO-1 / Orbit Insertion"],
    [580.0, 2475.0, 212.0, 7.50, 0.00, null],
    [900.0, 4875.0, 220.0, 7.50, 0.00, null],
  ];
  // (stage_name, sep_time_s, drag/return eta)
  const DROP_REUSABLE = [
    ["Stage 1 Booster (ASDS)", 152.0, 0.38],
    ["Fairing Halves",         195.0, 0.72],
  ];

  const KF_EXPENDABLE = [
    [0.0,   0.0,    0.5,   0.00, 0.00, "Liftoff"],
    [120.0, 45.0,   42.0,  0.85, 0.55, "Tower/Early Sep"],
    [155.0, 115.0,  62.0,  1.65, 0.58, "Booster Sep"],
    [165.0, 135.0,  70.0,  1.85, 0.60, "Core Stage 1 Sep"],
    [205.0, 250.0,  110.0, 2.48, 0.45, "Fairing Sep"],
    [350.0, 780.0,  172.0, 4.20, 0.25, null],
    [460.0, 1420.0, 195.0, 6.30, 0.08, "Stage 2 Main Cutoff"],
    [580.0, 2250.0, 200.0, 7.45, 0.00, "Orbit Insertion"],
    [900.0, 4630.0, 210.0, 7.45, 0.00, null],
  ];
  const DROP_EXPENDABLE = [
    ["Side Boosters",     155.0, 0.58],
    ["Core Stage 1",      165.0, 0.85],
    ["Payload Fairing",   205.0, 0.72],
  ];

  const KF_LIGHT_2STAGE = KF_EXPENDABLE;          // small 2-stage (Electron etc.)
  const DROP_LIGHT      = [["Stage 1", 165.0, 0.95]];

  /* -------- Long March 6A (CZ-6A) — 两级半固液捆绑 --------
     Event times are the published flight sequence:
       t=0     起飞                Liftoff
       t=10    垂直起飞结束         Vertical ascent ends
       t=114.5 助推器燃尽           Booster burnout
       t=117.5 助推器分离           Booster separation
       t=179   整流罩分离           Fairing separation
       t=238.5 一二级分离           Stage 1 separation
       t=240   二级点火             Stage 2 ignition
       t=786   二级关机             Stage 2 cutoff  (SSO insertion)
       t=813   末修关机             Final trim cutoff
       t=886   主星分离             Payload separation
     Payload to SSO >= 6.5 t at 500 km. */
  const KF_CZ6A = [
    [  0.0,     0.0,   0.5, 0.00, 0.00, "Liftoff"],
    [ 10.0,     0.3,   0.3, 0.05, 1.45, "Pitch Over"],
    [114.5,    70.8,  46.0, 1.30, 0.52, "Booster Burnout"],
    [117.5,    74.7,  50.0, 1.34, 0.50, "Booster Sep"],
    [179.0,   180.5,  95.0, 2.10, 0.62, "Fairing Sep"],
    [238.5,   315.9, 120.0, 2.45, 0.42, "Stage 1 Sep"],
    [240.0,   321.0, 121.5, 2.46, 0.30, "Stage 2 Ignition"],
    [450.0,  1029.7, 280.0, 4.30, 0.18, null],
    [620.0,  1930.7, 410.0, 6.30, 0.08, null],
    [786.0,  3080.3, 495.0, 7.55, 0.02, "SECO / Orbit Insertion"],
    [813.0,  3284.2, 498.0, 7.55, 0.00, "Final Trim Cutoff"],
    [886.0,  3835.4, 500.0, 7.55, 0.00, "Payload Separation"],
  ];
  const DROP_CZ6A = [
    ["Solid Boosters",    117.5, 2.6],
    ["Payload Fairing",   179.0, 3.8],
  ];

  /* Full flight duration per profile — the engine extends the requested
     window to at least this so no keyframe (SECO, payload sep) is cut off. */
  const T_FLIGHT = {
    REUSABLE_2STAGE:    900,
    EXPENDABLE_BOOSTER: 900,
    LIGHT_2STAGE:       900,
    CZ6A:               886,
  };

  /* ============= helpers ============= */
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const normDeg = (d) => ((d % 360) + 360) % 360;

  /* Subtract Earth rotation from an inertial longitude to get the
     sub-satellite (ground-fixed) longitude at time t seconds after launch.
     Without this correction the track drifts ~2-4° east of true. */
  function _subEarthRot(lonInertialDeg, tSec) {
    const rotDeg = toDeg(OMEGA) * tSec;
    return ((lonInertialDeg - rotDeg + 540) % 360 + 360) % 360 - 180;
  }

  /* ============= 1.  parse LL2 JSON ============= */
  function parseLL2Launch(ll2) {
    const pad       = ll2.pad || {};
    const location  = pad.location || {};
    const mission   = ll2.mission || {};
    const orbit     = mission.orbit || {};
    const rocketCfg = (ll2.rocket || {}).configuration || {};

    const lat0        = parseFloat(pad.latitude)  || 28.562;
    const lon0        = parseFloat(pad.longitude) || -80.577;
    const padName     = `${pad.name || ""} ${location.name || ""}`.trim();
    const rocketName  = rocketCfg.full_name || rocketCfg.name || "Generic Rocket";
    const orbitAbr    = (orbit.abbrev || "LEO").toUpperCase();

    const incRaw = orbit.inclination;
    const incDeg = incRaw != null
      ? parseFloat(incRaw)
      : inferInclination(lat0, lon0, padName, orbitAbr, mission.name || "");

    const southward = determineSouthward(lat0, incDeg, padName, orbitAbr);
    const profile   = classifyRocketProfile(rocketName);

    return {
      launch_id:         ll2.id || "unknown",
      launch_name:       ll2.name || "Unknown Launch",
      pad_name:          padName,
      rocket_name:       rocketName,
      orbit_abbrev:      orbitAbr,
      lat0_deg:          lat0,
      lon0_deg:          lon0,
      inclination_deg:   incDeg,
      launch_southward:  southward,
      profile_type:      profile,
    };
  }

  /* ============= 2.  infer inclination ============= */
  function inferInclination(lat0, lon0, padName, orbitAbr, missionName) {
    const absLat   = Math.abs(lat0);
    const mUpper   = (missionName || "").toUpperCase();
    const padUpper = (padName || "").toUpperCase();

    // Palmachim (Israel) — retrograde over the Mediterranean
    if (padUpper.includes("PALMACHIM") ||
        (lat0 > 31.5 && lat0 < 32.5 && lon0 > 34.0 && lon0 < 35.0)) {
      return 142.0;
    }

    if (orbitAbr === "ISS" || /ISS|DRAGON|CYGNUS|PROGRESS|SOYUZ MS/.test(mUpper))
      return Math.max(51.64, absLat);
    if (/SHENZHOU|TIANZHOU|TIANGONG|CSS/.test(mUpper) || orbitAbr === "CSS")
      return 41.47;
    if (orbitAbr === "SSO" || orbitAbr === "SUN-SYNCHRONOUS")
      return 97.6;
    if (orbitAbr === "PO"  || orbitAbr === "POLAR")
      return 90.0;
    if (orbitAbr === "GTO" || orbitAbr === "GEO" || orbitAbr === "GSO")
      return Math.max(absLat, 5.2);
    if (orbitAbr === "MEO" || orbitAbr === "HEO")
      return Math.max(absLat, 50.0);
    if (orbitAbr === "MARS" || orbitAbr === "LUNAR" || orbitAbr === "ESCAPE" || orbitAbr === "INTERPLANETARY")
      return 0.0;
    if (mUpper.includes("STARLINK"))
      return absLat < 53.0 ? 53.0 : 70.0;

    // Yaogan (遥感) — China's retrograde high-inclination reconnaissance
    // series. Yaogan 50-01/02/03 all inserted at ~142° retrograde, launched
    // south-west from Taiyuan. Checked before the generic LEO default because
    // LL2 reports these as plain "LEO" with no inclination.
    if (/YAOGAN|ZHANTUIXING|遥感/i.test(mUpper))
      return 142.0;

    // Default LEO: a bit above pad latitude, never below 28.5°
    // Taiyuan LC-9A (38.85°N) with unknown orbit → almost certainly SSO (~97.6°),
    // never a low-inclination LEO, so override the lat+1.5 default.
    if (absLat > 35 && padUpper.includes("TAIYUAN") && orbitAbr === "N/A")
      return 97.6;
    return Math.min(90.0, Math.max(absLat + 1.5, 28.5));
  }

  /* ============= 3.  determine southward ============= */
  function determineSouthward(lat0, incDeg, padName, orbitAbr) {
    const padUpper = (padName || "").toUpperCase();

    for (const kw of SOUTHWARD_PADS)
      if (padUpper.includes(kw.toUpperCase())) return true;

    /* Retrograde orbits (i > 90°) launched from the northern hemisphere can
       only be reached by flying southward — the required heading is > 180°
       from north, i.e. south of the pad. Yaogan / Yaogan-50 reconnaissance
       series at ~142° falls in this class. */
    if (incDeg > 90 && lat0 > 0) return true;

    if (orbitAbr === "SSO" && lat0 < 50.0) return true;
    if (lat0 > 0 && Math.abs(incDeg - Math.abs(lat0)) < 1.0) return true;

    return false;
  }

  /* ============= 4.  classify rocket profile ============= */
  function classifyRocketProfile(rocketName) {
    const r = (rocketName || "").toUpperCase();
    /* CZ-6A first — the generic LONG MARCH rule below would swallow it */
    if (/LONG MARCH 6A|CZ-6A|CHANG ZHENG 6A|LM-6A/.test(r))
      return "CZ6A";
    if (/FALCON 9|FALCON HEAVY|NEW GLENN|ZHUQUE-3|LONG MARCH 10|LONG MARCH 9|STARSHIP/.test(r))
      return "REUSABLE_2STAGE";
    if (/LONG MARCH|SOYUZ|ARIANE|VULCAN|ATLAS|H-IIA|H3|GSLV|PSLV|PROTON|ANGARA|VEGA|TITAN|DELTA|EPSILON/.test(r))
      return "EXPENDABLE_BOOSTER";
    if (/ELECTRON|ALPHA|CERES|KUAIZHOU|IRIS|JILIN|ZHUQUE-2|ZHUQUE-1|T-MINUS|SKYROCKET/.test(r))
      return "LIGHT_2STAGE";
    return "EXPENDABLE_BOOSTER";    // sensible default
  }

  /* ============= 5.  compute ground azimuth =============
     Returns: { azimuth_inertial_deg, azimuth_ground_eff_deg }
  */
  function computeGroundAzimuth(lat0Deg, incDeg, southward) {
    const lat0 = toRad(lat0Deg);
    const inc  = toRad(incDeg);

    const cosLat0    = Math.max(1e-6, Math.cos(lat0));
    const sinAIner   = clamp(Math.cos(inc) / cosLat0, -1, 1);
    const AInerNorth = Math.asin(sinAIner);

    let AIner;
    if (!southward) {
      AIner = ((AInerNorth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    } else {
      AIner = ((Math.PI - AInerNorth) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    }

    // Earth rotation velocity at this latitude (km/s, east positive)
    const vRot   = OMEGA * R_E * Math.cos(lat0);
    const vnRel  = V_ORB * Math.cos(AIner);
    const veRel  = V_ORB * Math.sin(AIner) - vRot;
    const AGround = Math.atan2(veRel, vnRel);
    const AGroundDeg = ((toDeg(AGround) % 360) + 360) % 360;

    // Coriolis curvature compensation — eastward flights bow toward equator
    const meanSigmaActive = 1100.0 / R_E;             // ~0.17 rad
    const coriolisCurve   = toDeg(meanSigmaActive * Math.sin(lat0) * Math.sin(AIner));
    const AGroundEffDeg   = normDeg(AGroundDeg + coriolisCurve);

    return {
      azimuth_inertial_deg:  round2(toDeg(AIner)),
      azimuth_ground_eff_deg: round2(AGroundEffDeg),
    };
  }

  /* ============= 6.  main: generate prediction =============
     opts.inclination_deg — override the inferred orbit inclination
     opts.azimuth_deg     — override the ground-effective launch bearing
                             (wins over inclination; this is the knob a
                             NOTAM-derived drop-zone bearing plugs into)
     opts.profile        — force a kinematic profile (e.g. "CZ6A")
  */
  function generatePrediction(ll2, maxTimeS = 600, stepS = 30, opts = {}) {
    const meta = parseLL2Launch(ll2);

    if (opts.inclination_deg != null && Number.isFinite(opts.inclination_deg)) {
      meta.inclination_deg = opts.inclination_deg;
      meta.inclination_source = "manual";
    } else {
      meta.inclination_source = meta.inclination_source || "inferred";
    }

    const az = computeGroundAzimuth(
      meta.lat0_deg, meta.inclination_deg, meta.launch_southward
    );
    meta.azimuth_inertial_deg   = az.azimuth_inertial_deg;
    meta.azimuth_ground_eff_deg = az.azimuth_ground_eff_deg;

    /* An explicit bearing bypasses the inclination -> azimuth derivation
       entirely. Useful when the true direction is known from a NOTAM drop
       zone but the target inclination is not published. */
    if (opts.azimuth_deg != null && Number.isFinite(opts.azimuth_deg)) {
      meta.azimuth_ground_eff_deg = normDeg(opts.azimuth_deg);
      meta.azimuth_source = "manual";
    } else {
      meta.azimuth_source = meta.azimuth_source || "computed";
    }

    const { lat0_deg, lon0_deg, launch_southward } = meta;
    const inclination_deg = meta.inclination_deg;
    const profile_type = opts.profile || meta.profile_type;

    const { keyframes, dropConfigs } = getKinematicTemplate(profile_type);
    /* Engine cutoff = the keyframe that carries the insertion/SECO label, so
       the ACTIVE -> ORBIT transition follows each profile's real timeline
       (CZ-6A inserts at 786 s, not the 580 s of the generic templates). */
    let tMeco = 0;
    for (const kf of keyframes) {
      if (kf[5] && /SECO|ORBIT INSERTION/i.test(kf[5])) { tMeco = kf[0]; break; }
    }
    if (!tMeco) tMeco = keyframes[keyframes.length - 1][0];
    /* Always show the whole profile — never truncate before SECO / payload sep,
       even when the caller asks for a shorter window (e.g. the UI's 600 s). */
    const endT    = getProfileFlightTime(profile_type);
    const effMaxT = Math.max(maxTimeS, endT);
    const keyEnd  = keyframes[keyframes.length - 1][0];
    meta.flight_time_s = Math.max(effMaxT, keyEnd);
    meta.profile_end_s = keyEnd;
    meta.seco_time_s   = tMeco;

    const lat0Rad = toRad(lat0_deg);
    const lon0Rad = toRad(lon0_deg);
    /* read the bearing back off meta, not off the local `az`, so a manual
       azimuth override actually reaches rangeToECEF */
    const AGdeg   = round2(meta.azimuth_ground_eff_deg);
    meta.azimuth_ground_eff_deg = AGdeg;
    const AGRad   = toRad(AGdeg);

    /* range-to-ECEF — spherical ground projection
       Maintains ground track <-> ascent range consistency so drop
       zones land exactly on the flight path. */
    function rangeToECEF(rangeKm) {
      const sigma   = rangeKm / R_E;
      const sinLat  = Math.sin(lat0Rad) * Math.cos(sigma) +
                      Math.cos(lat0Rad) * Math.sin(sigma) * Math.cos(AGRad);
      const latR    = Math.asin(clamp(sinLat, -1, 1));
      const y       = Math.sin(sigma) * Math.sin(AGRad);
      const x       = Math.cos(lat0Rad) * Math.cos(sigma) -
                      Math.sin(lat0Rad) * Math.sin(sigma) * Math.cos(AGRad);
      let lonR      = lon0Rad + Math.atan2(y, x);
      let lonDeg    = ((toDeg(lonR) + 180) % 360 + 360) % 360 - 180;
      return [round4(toDeg(latR)), round4(lonDeg)];
    }

    function interpKF(t) {
      for (let i = 0; i < keyframes.length - 1; i++) {
        const [t0, s0, h0, vh0, vv0] = keyframes[i];
        const [t1, s1, h1, vh1, vv1] = keyframes[i + 1];
        if (t0 <= t && t <= t1) {
          const r = (t - t0) / Math.max(1e-6, t1 - t0);
          const s  = s0 + r * (s1 - s0);
          const h  = h0 + r * (h1 - h0);
          const vh = vh0 + r * (vh1 - vh0);
          const vv = vv0 + r * (vv1 - vv0);
          const [lat, lonInertial] = rangeToECEF(s);
          return {
            t, range_km: round1(s), alt_km: round1(h),
            vh_kms: round2(vh), vv_kms: round2(vv),
            lat, lon: _subEarthRot(lonInertial, t), phase: t <= tMeco ? "ACTIVE" : "ORBIT",
          };
        }
      }
      const kf = keyframes[keyframes.length - 1];
      const [lat, lonInertial] = rangeToECEF(kf[1]);
      return {
        t, range_km: kf[1], alt_km: kf[2], vh_kms: kf[3], vv_kms: kf[4],
        lat, lon: _subEarthRot(lonInertial, t), phase: "ORBIT",
      };
    }

    /* 1. trajectory time series */
    const trajectory = [];
    for (let t = 0; t <= meta.flight_time_s; t += stepS) trajectory.push(interpKF(t));
    /* append the exact profile end so SECO / payload-separation are sampled */
    if (trajectory[trajectory.length - 1].t < meta.profile_end_s)
      trajectory.push(interpKF(meta.profile_end_s));

    /* 2. flight events at keyframes that have labels */
    const events = [];
    for (const kf of keyframes) {
      if (kf[5]) {
        const st = interpKF(kf[0]);
        events.push({ event: kf[5], ...st });
      }
    }

    /* 3. drop zones for stages and fairings */
    const drop_zones = [];
    for (const [stageName, tSep, dragEta] of dropConfigs) {
      const sep = interpKF(tSep);
      let dropRange;
      if (dragEta < 0) {
        dropRange = 0.0;        // RTLS — land back at pad
      } else {
        const gEff   = 9.5;
        const hM     = sep.alt_km * 1000.0;
        const vvMs   = sep.vv_kms * 1000.0;
        const tFall  = (vvMs + Math.sqrt(vvMs * vvMs + 2 * gEff * hM)) / gEff;
        dropRange    = sep.range_km + dragEta * sep.vh_kms * tFall;
      }
      const [dLat, dLon] = rangeToECEF(dropRange);
      drop_zones.push({
        stage:         stageName,
        sep_time_s:    tSep,
        sep_lat:       sep.lat,
        sep_lon:       sep.lon,
        drop_range_km: round1(dropRange),
        drop_lat:      dLat,
        drop_lon:      dLon,
      });
    }

    return { metadata: meta, events, drop_zones, trajectory };
  }

  /* ============= 7.  kinematic template lookup ============= */
  function getKinematicTemplate(profile) {
    if (profile === "REUSABLE_2STAGE")    return { keyframes: KF_REUSABLE_2STAGE, dropConfigs: DROP_REUSABLE };
    if (profile === "EXPENDABLE_BOOSTER") return { keyframes: KF_EXPENDABLE,      dropConfigs: DROP_EXPENDABLE };
    if (profile === "LIGHT_2STAGE")       return { keyframes: KF_LIGHT_2STAGE,    dropConfigs: DROP_LIGHT };
    if (profile === "CZ6A")               return { keyframes: KF_CZ6A,            dropConfigs: DROP_CZ6A };
    return { keyframes: KF_EXPENDABLE, dropConfigs: DROP_EXPENDABLE };
  }
  function getProfileFlightTime(profile) {
    return T_FLIGHT[profile] || 900;
  }

  /* ============= utilities exposed ============= */
  function round1(v) { return Math.round(v * 10)  / 10;  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function round4(v) { return Math.round(v * 10000) / 10000; }

  /* ============= exports ============= */
  const api = {
    R_E, OMEGA, V_ORB,
    parseLL2Launch,
    inferInclination,
    determineSouthward,
    classifyRocketProfile,
    computeGroundAzimuth,
    generatePrediction,
    getKinematicTemplate,
    getProfileFlightTime,
    round1, round2, round4,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GlobalLaunchTrajectoryEngine = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
