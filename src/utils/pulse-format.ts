export function formatBeijingTime(value?: string | number | Date | null) {
  if (value === null || value === undefined || value === '') return '-';
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});

  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function toDate(value: string | number | Date) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  const trimmed = value.trim();
  if (/^\d{10}$/.test(trimmed)) return new Date(Number(trimmed) * 1000);
  if (/^\d{13}$/.test(trimmed)) return new Date(Number(trimmed));
  return new Date(trimmed);
}

export function formatBytes(value?: number | null) {
  const number = Number(value) || 0;
  if (number >= 1024 ** 4) return `${(number / 1024 ** 4).toFixed(2)} TB`;
  if (number >= 1024 ** 3) return `${(number / 1024 ** 3).toFixed(2)} GB`;
  if (number >= 1024 ** 2) return `${(number / 1024 ** 2).toFixed(2)} MB`;
  if (number >= 1024) return `${(number / 1024).toFixed(2)} KB`;
  return `${number} B`;
}

export function formatRate(value?: number | null) {
  return `${formatBytes(value)}/s`;
}

const regionNameToCode: Record<string, string> = {
  'hong kong': 'HK',
  hongkong: 'HK',
  香港: 'HK',
  singapore: 'SG',
  新加坡: 'SG',
  japan: 'JP',
  tokyo: 'JP',
  osaka: 'JP',
  日本: 'JP',
  东京: 'JP',
  大阪: 'JP',
  'united states': 'US',
  usa: 'US',
  california: 'US',
  'los angeles': 'US',
  美国: 'US',
  洛杉矶: 'US',
  taiwan: 'TW',
  taipei: 'TW',
  台湾: 'TW',
  台北: 'TW',
  korea: 'KR',
  'south korea': 'KR',
  seoul: 'KR',
  韩国: 'KR',
  首尔: 'KR',
  germany: 'DE',
  frankfurt: 'DE',
  德国: 'DE',
  法兰克福: 'DE',
  'united kingdom': 'GB',
  uk: 'GB',
  london: 'GB',
  英国: 'GB',
  伦敦: 'GB',
  france: 'FR',
  paris: 'FR',
  法国: 'FR',
  巴黎: 'FR',
  netherlands: 'NL',
  amsterdam: 'NL',
  荷兰: 'NL',
  canada: 'CA',
  加拿大: 'CA',
  australia: 'AU',
  sydney: 'AU',
  澳大利亚: 'AU',
  russia: 'RU',
  俄罗斯: 'RU',
  india: 'IN',
  印度: 'IN',
  thailand: 'TH',
  bangkok: 'TH',
  泰国: 'TH',
  vietnam: 'VN',
  越南: 'VN',
  malaysia: 'MY',
  马来西亚: 'MY',
  indonesia: 'ID',
  印度尼西亚: 'ID',
  philippines: 'PH',
  菲律宾: 'PH'
};

export function regionCode(value?: string | null) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = /(?:^|\b)([A-Z]{2})(?:\b|$)/.exec(raw.toUpperCase());
  if (match) return match[1];
  const normalized = raw.toLowerCase().replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return regionNameToCode[normalized] || '';
}

export function regionFlag(code?: string | null) {
  const normalized = regionCode(code) || String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return '🌐';
  return [...normalized].map(char => String.fromCodePoint(char.charCodeAt(0) + 127397)).join('');
}

export function compactRegion(value?: string | null) {
  const code = regionCode(value);
  if (code) return code;
  return String(value || '').split(/\s*·\s*/).map(item => item.trim()).filter(Boolean)[0] || 'AUTO';
}

export function regionBadge(value?: string | null, icon?: string | null) {
  const code = compactRegion(value);
  const flag = icon && icon !== 'AUTO' ? icon : regionFlag(code);
  return `${flag} ${code}`;
}
