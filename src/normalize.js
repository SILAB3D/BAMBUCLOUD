/**
 * Traduce el objeto crudo "print" del report MQTT a algo comodo para el dashboard.
 * Los nombres de campo son los que usa el firmware de Bambu Lab y que
 * PrintSphere parsea en bambu_status.cpp / status_resolver.cpp.
 */

const GCODE_STATES = {
  IDLE: 'Inactiva',
  PREPARE: 'Preparando',
  RUNNING: 'Imprimiendo',
  PAUSE: 'En pausa',
  FINISH: 'Terminada',
  FAILED: 'Fallida',
  SLICING: 'Rebanando',
};

// Etapas de impresion (stg_cur). Subconjunto util; el resto cae en "Trabajando".
const STAGES = {
  '-1': 'Inactiva',
  0: 'Imprimiendo',
  1: 'Calibrando cama',
  2: 'Calibrando resonancia',
  3: 'Calibrando extrusor',
  4: 'Escaneando cama',
  5: 'Calibrando flujo',
  6: 'Calibrando offset',
  7: 'Identificando cama',
  8: 'Calibrando',
  9: 'Limpiando boquilla',
  10: 'Comprobando extrusor',
  11: 'Escaneando superficie',
  12: 'Inspeccion primera capa',
  13: 'Identificando bobina',
  14: 'Calibrando ruido',
  15: 'Calentando cama',
  16: 'Calibrando extrusion',
  17: 'Escaneando cama',
  18: 'Primera capa',
  19: 'Calibrando',
  20: 'Calentando camara',
  21: 'Enfriando camara',
  22: 'Cambiando filamento',
  23: 'Pausa por AMS',
  24: 'Pausa manual',
  25: 'Filamento agotado',
  26: 'Cargando filamento',
  27: 'Motor ruidoso',
  28: 'Fallo AMS',
  29: 'Atasco de filamento',
  30: 'Cambio de herramienta',
  31: 'Pausa de usuario',
  32: 'Fallo de nivelacion',
};

const AMS_STATUS_IDLE = 0;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function minutesToText(minutes) {
  if (minutes == null || minutes < 0) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** Convierte el hex "RRGGBBAA" del AMS a "#RRGGBB". */
function amsColor(hex) {
  if (typeof hex !== 'string' || hex.length < 6) return null;
  return `#${hex.slice(0, 6).toUpperCase()}`;
}

export function normalize(state = {}) {
  const p = state.print || {};

  const gcodeState = p.gcode_state || null;
  const stage = p.stg_cur != null ? STAGES[String(p.stg_cur)] : null;
  const printing = gcodeState === 'RUNNING' || gcodeState === 'PREPARE';

  const remaining = num(p.mc_remaining_time);
  const layer = num(p.layer_num);
  const totalLayers = num(p.total_layer_num);
  const percent = num(p.mc_percent);

  // Bandejas del AMS
  const amsUnits = (p.ams?.ams || []).map((unit) => ({
    id: num(unit.id),
    humidity: num(unit.humidity),
    temp: num(unit.temp),
    trays: (unit.tray || []).map((t) => ({
      id: num(t.id),
      type: t.tray_type || null,
      subBrand: t.tray_sub_brands || null,
      color: amsColor(t.tray_color),
      remain: num(t.remain),
      nozzleTempMin: num(t.nozzle_temp_min),
      nozzleTempMax: num(t.nozzle_temp_max),
      empty: !t.tray_type,
    })),
  }));

  // Bobina externa (la A1 la usa mucho: tray_now = 254 significa externa)
  const externalTray = p.vt_tray
    ? {
        type: p.vt_tray.tray_type || null,
        color: amsColor(p.vt_tray.tray_color),
        remain: num(p.vt_tray.remain),
      }
    : null;

  const trayNow = num(p.ams?.tray_now);

  // Errores HMS activos
  const hms = (p.hms || []).map((h) => {
    const attr = Number(h.attr) >>> 0;
    const code = Number(h.code) >>> 0;
    return {
      attr,
      code,
      // Formato canonico que usa el buscador de errores de Bambu
      id: `${((attr >>> 16) & 0xffff).toString(16).padStart(4, '0')}_${(attr & 0xffff)
        .toString(16)
        .padStart(4, '0')}_${((code >>> 16) & 0xffff)
        .toString(16)
        .padStart(4, '0')}_${(code & 0xffff).toString(16).padStart(4, '0')}`.toUpperCase(),
      severity: (code >>> 16) & 0xffff,
    };
  });

  return {
    // Estado general
    state: gcodeState,
    stateText: GCODE_STATES[gcodeState] || gcodeState || 'Desconocido',
    stage,
    stageCode: num(p.stg_cur),
    printing,
    jobName: p.subtask_name || p.gcode_file || null,
    taskId: p.subtask_id || null,

    // Progreso
    percent,
    layer,
    totalLayers,
    remainingMinutes: remaining,
    remainingText: minutesToText(remaining),
    // ETA en epoch ms, para que el cliente lo pinte en su zona horaria
    etaEpochMs: remaining != null && printing ? Date.now() + remaining * 60_000 : null,

    // Temperaturas
    temps: {
      nozzle: num(p.nozzle_temper),
      nozzleTarget: num(p.nozzle_target_temper),
      bed: num(p.bed_temper),
      bedTarget: num(p.bed_target_temper),
      chamber: num(p.chamber_temper),
    },

    // Ventiladores (0-15 en el protocolo -> porcentaje)
    fans: {
      part: p.cooling_fan_speed != null ? Math.round((num(p.cooling_fan_speed) / 15) * 100) : null,
      aux: p.big_fan1_speed != null ? Math.round((num(p.big_fan1_speed) / 15) * 100) : null,
      chamber: p.big_fan2_speed != null ? Math.round((num(p.big_fan2_speed) / 15) * 100) : null,
    },

    // Velocidad
    speedLevel: num(p.spd_lvl),
    speedPercent: num(p.spd_mag),

    // Filamento
    ams: amsUnits,
    externalTray,
    activeTray: trayNow,
    usingExternalSpool: trayNow === 254 || trayNow === 255,
    amsBusy: p.ams?.ams_status != null && num(p.ams.ams_status) !== AMS_STATUS_IDLE,

    // Errores
    printError: num(p.print_error) || 0,
    hms,
    hasErrors: hms.length > 0 || (num(p.print_error) || 0) !== 0,

    // Luz de camara
    chamberLight: (() => {
      const lights = p.lights_report || [];
      const l = lights.find((x) => x.node === 'chamber_light');
      return l ? l.mode === 'on' : null;
    })(),

    // Metadatos
    wifiSignal: p.wifi_signal || null,
    sdcard: p.sdcard ?? null,
    // La version de firmware llega en la respuesta a "get_version",
    // en state.info.module, no dentro de "print".
    firmware:
      (state.info?.module || []).find((m) => m.name === 'ota' || m.name === 'esp32')?.sw_ver ||
      null,
    updatedAt: Date.now(),
  };
}

export { GCODE_STATES, STAGES };
