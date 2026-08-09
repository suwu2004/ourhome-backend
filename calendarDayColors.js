'use strict';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_DAY_COLORS = 500;

function normalizeCalendarDayColors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '心情日历颜色格式不正确' };
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_DAY_COLORS) {
    return { ok: false, error: `心情日历最多保存 ${MAX_DAY_COLORS} 天的颜色` };
  }
  const colors = {};
  for (const [date, color] of entries) {
    if (!DATE_KEY.test(date) || !HEX_COLOR.test(String(color || ''))) {
      return { ok: false, error: '心情日历日期或颜色格式不正确' };
    }
    colors[date] = String(color).toUpperCase();
  }
  return { ok: true, value: colors };
}

module.exports = { MAX_DAY_COLORS, normalizeCalendarDayColors };
