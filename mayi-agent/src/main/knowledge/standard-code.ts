const MAX_STANDARD_CODE_LENGTH = 80
const SUPPORTED_PREFIX = /^(GB(?:\/T)?|CJJ(?:\/T)?|JGJ(?:\/T)?|DB34(?:\/T)?|DB3401(?:\/T)?)/

/** 将常见标准编号写法归一为稳定查询键，同时避免合并不同标准类型。 */
export function normalizeStandardCode(value: string): string {
  if (typeof value !== 'string') throw new Error('标准编号无效')
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[‐‑‒–—―−﹘﹣－]/g, '-')
    .replace(/\s+/g, '')
  if (!normalized || normalized.length > MAX_STANDARD_CODE_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('标准编号无效')
  }
  if (!SUPPORTED_PREFIX.test(normalized)) throw new Error('暂不支持该标准编号格式')
  if (!/^[A-Z0-9/.-]+$/.test(normalized)) throw new Error('标准编号包含非法字符')
  return normalized
}

/** 严格校验无时区歧义的 ISO 日期。 */
export function normalizeIsoDate(value: string, fieldName = '日期'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName}必须使用 YYYY-MM-DD 格式`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName}无效`)
  }
  return value
}

/** 生成去重、排序且有长度限制的字符串集合。 */
export function normalizeStringList(values: string[], fieldName: string): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 50) {
    throw new Error(`${fieldName}无效`)
  }
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
  if (normalized.length === 0 || normalized.some((value) => value.length > 100)) {
    throw new Error(`${fieldName}无效`)
  }
  return normalized
}
