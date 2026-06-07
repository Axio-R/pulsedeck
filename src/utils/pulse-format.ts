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

export function regionFlagUrl(value?: string | null) {
  const code = compactRegion(value);
  const svg = flagSvgByCode[code] || genericFlagSvg(code);
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const flagSvgByCode: Record<string, string> = {
  HK: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#de2910"/><g fill="#fff" transform="translate(18 12)"><ellipse rx="2.2" ry="5.2" transform="rotate(0) translate(0 -4)"/><ellipse rx="2.2" ry="5.2" transform="rotate(72) translate(0 -4)"/><ellipse rx="2.2" ry="5.2" transform="rotate(144) translate(0 -4)"/><ellipse rx="2.2" ry="5.2" transform="rotate(216) translate(0 -4)"/><ellipse rx="2.2" ry="5.2" transform="rotate(288) translate(0 -4)"/></g></svg>`,
  SG: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><path fill="#ef3340" d="M0 0h36v12H0z"/><path fill="#fff" d="M0 12h36v12H0z"/><circle cx="8" cy="6" r="4" fill="#fff"/><circle cx="9.6" cy="6" r="3.4" fill="#ef3340"/><g fill="#fff"><circle cx="14" cy="3.6" r=".7"/><circle cx="16" cy="5" r=".7"/><circle cx="15.2" cy="7.3" r=".7"/><circle cx="12.8" cy="7.3" r=".7"/><circle cx="12" cy="5" r=".7"/></g></svg>`,
  JP: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#fff"/><circle cx="18" cy="12" r="6.2" fill="#bc002d"/></svg>`,
  US: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#fff"/><g fill="#b22234"><rect width="36" height="2"/><rect y="4" width="36" height="2"/><rect y="8" width="36" height="2"/><rect y="12" width="36" height="2"/><rect y="16" width="36" height="2"/><rect y="20" width="36" height="2"/></g><rect width="15" height="11" fill="#3c3b6e"/><g fill="#fff"><circle cx="3" cy="2.5" r=".45"/><circle cx="6" cy="2.5" r=".45"/><circle cx="9" cy="2.5" r=".45"/><circle cx="12" cy="2.5" r=".45"/><circle cx="4.5" cy="5.5" r=".45"/><circle cx="7.5" cy="5.5" r=".45"/><circle cx="10.5" cy="5.5" r=".45"/><circle cx="3" cy="8.5" r=".45"/><circle cx="6" cy="8.5" r=".45"/><circle cx="9" cy="8.5" r=".45"/><circle cx="12" cy="8.5" r=".45"/></g></svg>`,
  TW: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#fe0000"/><rect width="18" height="12" fill="#000095"/><circle cx="9" cy="6" r="3" fill="#fff"/><circle cx="9" cy="6" r="1.6" fill="#000095"/></svg>`,
  KR: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#fff"/><path fill="#cd2e3a" d="M18 6a6 6 0 0 1 0 12 3 3 0 0 1 0-6 3 3 0 0 0 0-6z"/><path fill="#0047a0" d="M18 6a3 3 0 0 1 0 6 3 3 0 0 0 0 6 6 6 0 0 1 0-12z"/><g stroke="#111" stroke-width="1.2"><path d="M6 5l5 3M7 3.5l5 3M24 16.5l5 3M25 15l5 3M25 5l5-3M24 6.5l5-3M7 19.5l5-3M6 18l5-3"/></g></svg>`,
  GB: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#012169"/><path stroke="#fff" stroke-width="5" d="M0 0l36 24M36 0L0 24"/><path stroke="#c8102e" stroke-width="2.4" d="M0 0l36 24M36 0L0 24"/><path stroke="#fff" stroke-width="8" d="M18 0v24M0 12h36"/><path stroke="#c8102e" stroke-width="4.5" d="M18 0v24M0 12h36"/></svg>`,
  DE: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="8" fill="#000"/><rect y="8" width="36" height="8" fill="#dd0000"/><rect y="16" width="36" height="8" fill="#ffce00"/></svg>`,
  FR: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="12" height="24" fill="#0055a4"/><rect x="12" width="12" height="24" fill="#fff"/><rect x="24" width="12" height="24" fill="#ef4135"/></svg>`,
  NL: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="8" fill="#ae1c28"/><rect y="8" width="36" height="8" fill="#fff"/><rect y="16" width="36" height="8" fill="#21468b"/></svg>`,
  CA: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="8" height="24" fill="#d52b1e"/><rect x="8" width="20" height="24" fill="#fff"/><rect x="28" width="8" height="24" fill="#d52b1e"/><path fill="#d52b1e" d="M18 5l1.2 3 3-1.2-1.2 3 3 1.2-3 1.2 1.2 3-3-1.2L18 18l-1.2-4-3 1.2 1.2-3-3-1.2 3-1.2-1.2-3 3 1.2z"/></svg>`,
  AU: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#00008b"/><circle cx="27" cy="7" r="1.6" fill="#fff"/><circle cx="23" cy="14" r="1.2" fill="#fff"/><circle cx="30" cy="17" r="1.2" fill="#fff"/><rect width="16" height="10" fill="#012169"/><path stroke="#fff" stroke-width="2" d="M0 0l16 10M16 0L0 10M8 0v10M0 5h16"/><path stroke="#c8102e" stroke-width="1" d="M8 0v10M0 5h16"/></svg>`,
  RU: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="8" fill="#fff"/><rect y="8" width="36" height="8" fill="#0039a6"/><rect y="16" width="36" height="8" fill="#d52b1e"/></svg>`,
  IN: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="8" fill="#ff9933"/><rect y="8" width="36" height="8" fill="#fff"/><rect y="16" width="36" height="8" fill="#138808"/><circle cx="18" cy="12" r="2.1" fill="none" stroke="#000080" stroke-width=".8"/></svg>`,
  TH: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#a51931"/><rect y="4" width="36" height="16" fill="#fff"/><rect y="8" width="36" height="8" fill="#2d2a4a"/></svg>`,
  VN: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#da251d"/><path fill="#ff0" d="M18 5l1.8 5.1h5.4l-4.4 3.1 1.7 5.1-4.5-3.1-4.5 3.1 1.7-5.1-4.4-3.1h5.4z"/></svg>`,
  MY: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#fff"/><g fill="#cc0001"><rect width="36" height="2"/><rect y="4" width="36" height="2"/><rect y="8" width="36" height="2"/><rect y="12" width="36" height="2"/><rect y="16" width="36" height="2"/><rect y="20" width="36" height="2"/></g><rect width="16" height="12" fill="#010066"/><circle cx="7" cy="6" r="4" fill="#ffcc00"/><circle cx="8.6" cy="6" r="3.5" fill="#010066"/><path fill="#ffcc00" d="M12 3.5l.8 2 2-.8-.8 2 2 .8-2 .8.8 2-2-.8-.8 2-.8-2-2 .8.8-2-2-.8 2-.8-.8-2 2 .8z"/></svg>`,
  ID: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="12" fill="#ce1126"/><rect y="12" width="36" height="12" fill="#fff"/></svg>`,
  PH: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="12" fill="#0038a8"/><rect y="12" width="36" height="12" fill="#ce1126"/><path fill="#fff" d="M0 0l16 12L0 24z"/><circle cx="5.5" cy="12" r="2.2" fill="#fcd116"/></svg>`,
  BR: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" fill="#009b3a"/><path fill="#ffdf00" d="M18 3l14 9-14 9-14-9z"/><circle cx="18" cy="12" r="5" fill="#002776"/></svg>`
};

function genericFlagSvg(value: string) {
  const code = /^[A-Z]{2}$/.test(value) ? value : 'GL';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 24"><rect width="36" height="24" rx="3" fill="#e5e7eb"/><rect width="36" height="7" fill="#2563eb"/><rect y="17" width="36" height="7" fill="#059669"/><text x="18" y="15.5" text-anchor="middle" font-family="Arial, sans-serif" font-size="8" font-weight="700" fill="#111827">${code}</text></svg>`;
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
