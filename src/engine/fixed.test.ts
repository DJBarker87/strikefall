import { describe, expect, it } from 'vitest'
import {
  addUnsignedFixed,
  displayNumberToFixed,
  fixedToDisplayNumber,
  fixedToRoundedPoints,
  multiplyUnsignedFixed,
  probabilityNumberToFixed,
  subtractUnsignedFixed,
} from './fixed'

describe('audited display/fixed boundary', () => {
  it('rounds decimal display coordinates as text before BigInt assembly', () => {
    expect(displayNumberToFixed(50)).toBe('50000000000000')
    expect(displayNumberToFixed(50.1234567890123)).toBe('50123456789012')
    expect(displayNumberToFixed(0.055)).toBe('55000000000')
    expect(probabilityNumberToFixed(0.777464975998)).toBe('777464975998')
  })

  it('rejects invalid display inputs and non-canonical fixed outputs', () => {
    expect(() => displayNumberToFixed(Number.NaN)).toThrow(TypeError)
    expect(() => displayNumberToFixed(-1)).toThrow(RangeError)
    expect(() => probabilityNumberToFixed(1.01)).toThrow(RangeError)
    expect(() => fixedToDisplayNumber('01')).toThrow(TypeError)
    expect(() => fixedToRoundedPoints('-1')).toThrow(TypeError)
  })

  it('decodes signed fixed values and rounds terminal points once for display', () => {
    expect(fixedToDisplayNumber('-500000000000')).toBe(-0.5)
    expect(fixedToDisplayNumber('777464975998')).toBe(0.777464975998)
    expect(fixedToRoundedPoints('144535004474772')).toBe(145)
  })

  it('multiplies two fixed strings with SolMath truncation and no Number arithmetic', () => {
    expect(multiplyUnsignedFixed('320000000000000', '625000000000')).toBe(
      '200000000000000',
    )
    expect(multiplyUnsignedFixed('7', '999999999999')).toBe('6')
    expect(() => multiplyUnsignedFixed('01', '1')).toThrow(TypeError)
  })

  it('adds and subtracts canonical coordinates entirely as integers', () => {
    expect(addUnsignedFixed('50000000000000', '1250000000000')).toBe('51250000000000')
    expect(subtractUnsignedFixed('50000000000000', '1250000000000')).toBe('48750000000000')
    expect(() => subtractUnsignedFixed('1', '2')).toThrow(RangeError)
    expect(() => addUnsignedFixed('01', '2')).toThrow(TypeError)
  })
})
