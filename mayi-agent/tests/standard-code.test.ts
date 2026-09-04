import { describe, expect, it } from 'vitest'
import { normalizeIsoDate, normalizeStandardCode } from '../src/main/knowledge/standard-code'

describe('工程标准编号正规化', () => {
  it('统一空格、大小写、全角字符和破折号', () => {
    expect(normalizeStandardCode(' gb 55003—2021 ')).toBe('GB55003-2021')
    expect(normalizeStandardCode('ＧＢ／Ｔ 1234－2020')).toBe('GB/T1234-2020')
  })

  it('保留推荐性标准语义并拒绝未知格式', () => {
    expect(normalizeStandardCode('GB/T 1234-2020')).not.toBe(normalizeStandardCode('GB 1234-2020'))
    expect(() => normalizeStandardCode('UNKNOWN 1-2020')).toThrow('暂不支持')
    expect(() => normalizeStandardCode('GB\u0000 1-2020')).toThrow('无效')
  })

  it('严格校验 ISO 日期', () => {
    expect(normalizeIsoDate('2026-09-04')).toBe('2026-09-04')
    expect(() => normalizeIsoDate('2026-02-30')).toThrow('无效')
    expect(() => normalizeIsoDate('2026/09/04')).toThrow('YYYY-MM-DD')
  })
})
