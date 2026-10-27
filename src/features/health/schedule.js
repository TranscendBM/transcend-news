// 排程的「下一次預計執行時間」（只給人看的估算，不參與任何判斷；時區一律台北）。
// 規格跟 functions/main.py 的排程同步維護：
//   { every: 15 }                    每 15 分鐘
//   { daily: [[17, 30]] }            每天 17:30
//   { daily: [[13, 40], [17, 40]], weekdays: true }   平日 13:40、17:40
//   { window: [[9, 0], [13, 35]], weekdays: true }    平日 09:00–13:35 每分鐘

const TZ = 'Asia/Taipei';

// 台北時間的各欄位（用 Intl 取，不依賴執行環境的時區）
function taipeiParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, dow };
}

// 台北時間的 y/m/d h:mi → 對應的 Date（台北固定 UTC+8、沒有日光節約）
const fromTaipei = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h - 8, mi));

export function nextRun(spec, now = new Date()) {
  const t = taipeiParts(now);
  const isWeekday = dow => dow >= 1 && dow <= 5;
  if (spec.every) {
    const mins = t.h * 60 + t.mi;
    const next = (Math.floor(mins / spec.every) + 1) * spec.every;
    return new Date(fromTaipei(t.y, t.mo, t.d, 0, 0).getTime() + next * 60000);
  }
  // 每日固定時間／時段起點：往後找最近的一個
  const times = spec.daily || [spec.window[0]];
  for (let addDays = 0; addDays <= 8; addDays += 1) {
    const base = fromTaipei(t.y, t.mo, t.d, 0, 0).getTime() + addDays * 86400000;
    const dow = (t.dow + addDays) % 7;
    if (spec.weekdays && !isWeekday(dow)) continue;
    for (const [h, mi] of times) {
      const cand = new Date(base + (h * 60 + mi) * 60000);
      if (cand.getTime() > now.getTime()) {
        // 交易時段內：下一分鐘就會執行
        if (spec.window && addDays === 0) {
          const [[sh, sm], [eh, em]] = spec.window;
          const cur = t.h * 60 + t.mi;
          if (cur >= sh * 60 + sm && cur <= eh * 60 + em) return new Date(now.getTime() + 60000);
        }
        return cand;
      }
    }
    if (spec.window && addDays === 0) {
      const [[sh, sm], [eh, em]] = spec.window;
      const cur = t.h * 60 + t.mi;
      if (cur >= sh * 60 + sm && cur <= eh * 60 + em) return new Date(now.getTime() + 60000);
    }
  }
  return null;
}

/** 「今天 17:30」「明天 02:30」「週一 09:00」「約 1 分鐘內」。 */
export function fmtNextRun(date, now = new Date()) {
  if (!date) return '未知';
  const diffMin = Math.round((date.getTime() - now.getTime()) / 60000);
  if (diffMin <= 1) return '約 1 分鐘內';
  if (diffMin < 60) return `約 ${diffMin} 分鐘後`;
  const a = taipeiParts(date);
  const b = taipeiParts(now);
  const hm = `${String(a.h).padStart(2, '0')}:${String(a.mi).padStart(2, '0')}`;
  const dayDiff = Math.round((fromTaipei(a.y, a.mo, a.d, 0, 0) - fromTaipei(b.y, b.mo, b.d, 0, 0)) / 86400000);
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `明天 ${hm}`;
  return `週${'日一二三四五六'[a.dow]} ${hm}`;
}
