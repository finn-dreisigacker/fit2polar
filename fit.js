// Minimal FIT decoder: only what we need for HR + session metadata.
const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z in unix seconds

function parseFit(buf) {
  const dv = new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  const hdr = dv.getUint8(0);
  if (String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11)) !== '.FIT')
    throw new Error('Keine gültige FIT-Datei');
  const end = hdr + dv.getUint32(4, true);
  const defs = {}, msgs = [];
  let p = hdr, lastTs = 0;

  const readVal = (pos, size, bt, le) => {
    const t = bt & 0x1f;
    if (t === 7) { // string
      let s = '';
      for (let i = 0; i < size; i++) { const c = dv.getUint8(pos + i); if (!c) break; s += String.fromCharCode(c); }
      return s ? decodeURIComponent(escape(s)) : null;
    }
    let v, inv;
    switch (size) {
      case 1: v = (t === 1) ? dv.getInt8(pos) : dv.getUint8(pos); inv = t === 1 ? 0x7f : 0xff; break;
      case 2: v = (t === 3) ? dv.getInt16(pos, le) : dv.getUint16(pos, le); inv = t === 3 ? 0x7fff : 0xffff; break;
      case 4:
        if (t === 8) return dv.getFloat32(pos, le);
        v = (t === 5) ? dv.getInt32(pos, le) : dv.getUint32(pos, le); inv = t === 5 ? 0x7fffffff : 0xffffffff; break;
      default: return null; // arrays / 64-bit: not needed
    }
    if (v === inv || ((t === 0x0a || t === 0x0b || t === 0x0c) && v === 0)) return null;
    return v;
  };

  while (p < end) {
    const h = dv.getUint8(p++);
    if (h & 0x40 && !(h & 0x80)) { // definition message
      const le = dv.getUint8(p + 1) === 0;
      const global = dv.getUint16(p + 2, le), n = dv.getUint8(p + 4);
      p += 5;
      const fields = [];
      for (let i = 0; i < n; i++, p += 3) fields.push([dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2)]);
      let devSize = 0;
      if (h & 0x20) { const nd = dv.getUint8(p++); for (let i = 0; i < nd; i++, p += 3) devSize += dv.getUint8(p + 1); }
      defs[h & 0x0f] = { le, global, fields, devSize };
      continue;
    }
    const compressed = h & 0x80;
    const def = defs[compressed ? (h >> 5) & 3 : h & 0x0f];
    if (!def) throw new Error('Defekte FIT-Datei (unbekannte Definition)');
    const f = {};
    for (const [num, size, bt] of def.fields) { f[num] = readVal(p, size, bt, def.le); p += size; }
    p += def.devSize;
    if (compressed) {
      const off = h & 0x1f;
      lastTs = lastTs + ((off - lastTs) & 0x1f);
      f[253] = lastTs;
    } else if (f[253] != null) lastTs = f[253];
    msgs.push({ g: def.global, f });
  }
  return msgs;
}

const SPORTS = { 0: 'OTHER', 1: 'RUNNING', 2: 'CYCLING', 4: 'FITNESS_EQUIPMENT', 5: 'SWIMMING', 10: 'TRAINING', 11: 'WALKING', 17: 'HIKING', 19: 'ROWING' };

// Returns { meta, hr } where hr is HR per second (linear interpolation, rounded).
function extract(msgs) {
  const pts = msgs.filter(m => m.g === 20 && m.f[253] != null && m.f[3] != null).map(m => [m.f[253], m.f[3]]);
  if (pts.length < 2) throw new Error('Keine Herzfrequenzdaten in der Datei');
  pts.sort((a, b) => a[0] - b[0]);
  const t0 = pts[0][0], hr = [];
  for (let t = t0, i = 0; t <= pts[pts.length - 1][0]; t++) {
    while (pts[i + 1][0] < t) i++;
    const [ta, ha] = pts[i], [tb, hb] = pts[i + 1];
    hr.push(Math.round(tb === ta ? hb : ha + (hb - ha) * (t - ta) / (tb - ta)));
  }
  const ses = (msgs.find(m => m.g === 18) || { f: {} }).f;
  const user = (msgs.find(m => m.g === 3) || { f: {} }).f;
  return {
    hr,
    meta: {
      start: new Date((t0 + FIT_EPOCH) * 1000),
      sport: SPORTS[ses[5]] ?? 'OTHER',
      calories: ses[11] ?? '',
      name: user[0] ?? '',
      height: user[3] != null ? user[3].toFixed(1) : '',
      weight: user[4] != null ? (user[4] / 10).toFixed(1) : '',
      hrSit: user[8] || "",
      hrMax: user[11] ?? ses[17] ?? '',
    },
  };
}

const pad = n => String(n).padStart(2, '0');
const hms = s => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
// Polar's CSV has no quoting; strip separators/newlines from free text.
const clean = v => String(v ?? '').replace(/[,\r\n]/g, ' ');

function toPolarCsv(hr, m) {
  const d = m.start;
  const avg = Math.round(hr.reduce((a, b) => a + b, 0) / hr.length);
  const head = 'Name,Sport,Date,Start time,Duration,Total distance (km),Average heart rate (bpm),Average speed (km/h),Max speed (km/h),Average pace (min/km),Max pace (min/km),Calories,Fat percentage of calories(%),Carbohydrate percentage of calories(%),Protein percentage of calories(%),Average cadence (rpm),Average stride length (cm),Running index,Training load,Ascent (m),Descent (m),Average power (W),Max power (W),Notes,Height (cm),Weight (kg),HR max,HR sit,VO2max';
  const row = [clean(m.name), clean(m.sport), `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, hms(hr.length), '', avg, '', '', '', '',
    clean(m.calories), '', '', '', '', '', '', '', '', '', '', '', clean(m.notes), clean(m.height), clean(m.weight),
    clean(m.hrMax), clean(m.hrSit), clean(m.vo2max)].join(',');
  const lines = [head, row, 'Sample rate,Time,HR (bpm),Speed (km/h),Pace (min/km),Cadence,Altitude (m),Stride length (m),Distances (m),Temperatures (C),Power (W)'];
  hr.forEach((v, i) => lines.push(`${i ? '' : 1},${hms(i)},${v},,,,,,,,`));
  return lines.join('\r\n') + '\r\n';
}

if (typeof module !== 'undefined') module.exports = { parseFit, extract, toPolarCsv };
