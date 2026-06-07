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
