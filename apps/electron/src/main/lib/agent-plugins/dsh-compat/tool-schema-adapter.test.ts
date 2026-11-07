import { describe, expect, test } from 'bun:test'
import { adaptDshParameters, adaptDshValueSchema, validateDshValue } from './tool-schema-adapter'

describe('Given 固定审查配方的 DSH 静态 DSL', () => {
  test('When 转换必填、默认值和嵌套对象 Then 保留开放根、显式封闭对象且不注入默认值', () => {
    const schema = adaptDshParameters({ count: { type: 'integer', default: 3 }, unit: { type: 'string', required: true, enum: ['km', 'm'] }, detail: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', required: true } } } })
    expect(schema).toEqual({ type: 'object', properties: { count: { type: 'integer', default: 3 }, unit: { type: 'string', enum: ['km', 'm'] }, detail: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' } }, required: ['label'] } }, required: ['unit'] })
    const args = { unit: 'km', extra: { valid: true } }
    expect(validateDshValue(schema, args)).toEqual([])
    expect(args).toEqual({ unit: 'km', extra: { valid: true } })
    expect(validateDshValue(schema, {})).not.toEqual([])
    expect(validateDshValue(schema, { unit: 'km', count: 1.5 })).not.toEqual([])
    expect(validateDshValue(schema, { unit: 'km', detail: { label: 'x', unexpected: true } })).not.toEqual([])
  })
  test('When 数组、任意JSON和exact-one联合 Then 不把 oneOf 当 anyOf，输出同样校验', () => {
    const schema = adaptDshValueSchema({ type: 'object', additionalProperties: false, properties: { values: { type: 'array', required: true, items: { oneOf: [{ type: 'number' }, { type: 'integer' }] } }, payload: { type: 'json' } } })
    expect(validateDshValue(schema, { values: [1.5], payload: null })).toEqual([])
    expect(validateDshValue(schema, { values: [1] })).not.toEqual([])
    expect(validateDshValue(schema, { values: ['x'] })).not.toEqual([])
    expect(validateDshValue(adaptDshValueSchema({ type: 'array' }), [null, { n: 1 }])).toEqual([])
    expect(validateDshValue(adaptDshValueSchema({ type: 'null' }), null)).toEqual([])
  })
  test('When 未支持语义、未知键、畸形约束或动态数据 Then 明确拒绝，不静默丢失', () => {
    for (const spec of [{ type: 'string', pattern: '.*' }, { type: 'string', parse: () => 'x' }, { type: 'object' }, { type: 'string', required: false }, { type: 'number', enum: ['1'] }, { type: 'string', const: 'b', enum: ['a'] }, { oneOf: [{ type: 'string' }] }, { type: 'json', title: '暂不支持title' }, { type: 'json', examples: [] }, { type: 'number', default: Infinity }]) {
      expect(() => adaptDshParameters({ x: spec })).toThrow('DSH_SCHEMA_UNSUPPORTED')
    }
    expect(() => adaptDshValueSchema({ type: 'number', required: true })).toThrow('DSH_SCHEMA_UNSUPPORTED')
    const cycle: Record<string, unknown> = { type: 'array' }; cycle.items = cycle
    expect(() => adaptDshValueSchema(cycle)).toThrow('DSH_SCHEMA_UNSUPPORTED')
    let reads = 0
    const dynamic = Object.defineProperty({}, 'type', { enumerable: true, get() { reads++; return 'string' } })
    expect(() => adaptDshValueSchema(dynamic)).toThrow('DSH_SCHEMA_UNSUPPORTED')
    expect(reads).toBe(0)
  })
  test('When 有损JSON、深度或字节预算越界 Then 拒绝但不求值getter或toJSON', () => {
    const schema = adaptDshValueSchema({ type: 'json' }); let reads = 0
    const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { reads++; return 1 } })
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    for (const value of [undefined, NaN, Infinity, -0, 1n, new Date(), [, 1], { x: undefined }, { [Symbol('s')]: 1 }, { toJSON() { reads++; return {} } }, accessor, cycle, 'x'.repeat(256 * 1024)]) expect(validateDshValue(schema, value)).not.toEqual([])
    expect(reads).toBe(0)
    let deep: unknown = null; for (let i = 0; i < 70; i++) deep = [deep]
    expect(validateDshValue(schema, deep)).not.toEqual([])
    let deepSchema: unknown = { type: 'json' }; for (let i = 0; i < 14; i++) deepSchema = { type: 'array', items: deepSchema }
    expect(() => adaptDshValueSchema(deepSchema)).toThrow('DSH_SCHEMA_UNSUPPORTED')
  })
  test('When JSON属性名为__proto__ Then 当数据保留且不改变原型', () => {
    const schema = adaptDshParameters(JSON.parse('{"__proto__":{"type":"string","required":true}}'))
    expect(Object.hasOwn(schema.properties!, '__proto__')).toBe(true)
    expect(validateDshValue(schema, JSON.parse('{"__proto__":"safe"}'))).toEqual([])
    expect(validateDshValue(schema, {})).not.toEqual([])
  })
})
