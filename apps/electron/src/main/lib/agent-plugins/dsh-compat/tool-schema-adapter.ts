import type { PluginJsonSchema } from '@dutydeck/plugin-sdk'

const SCHEMA_ERROR = 'DSH_SCHEMA_UNSUPPORTED'
const MAX_VALUE_BYTES = 256 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 在序列化前检查普通数据描述符，不调用 getter/toJSON；不是不受信任 JS 的沙箱。 */
function assertJson(value: unknown, maxBytes: number): void {
  const active = new Set<object>()
  let nodes = 0
  function visit(entry: unknown, depth: number): void {
    if (++nodes > 10000 || depth > 64) throw new Error('DSH_JSON_BUDGET')
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return
    if (typeof entry === 'number' && Number.isFinite(entry) && !Object.is(entry, -0)) return
    if (typeof entry !== 'object' || entry === null || active.has(entry)) throw new Error('DSH_JSON_INVALID')
    const array = Array.isArray(entry)
    if (Object.getPrototypeOf(entry) !== (array ? Array.prototype : Object.prototype)) throw new Error('DSH_JSON_INVALID')
    const descriptors = Object.getOwnPropertyDescriptors(entry)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some(key => typeof key !== 'string')) throw new Error('DSH_JSON_INVALID')
    if (array && (entry.length > 10000 || keys.length !== entry.length + 1)) throw new Error('DSH_JSON_INVALID')
    active.add(entry)
    for (const key of keys as string[]) {
      if (array && key === 'length') continue
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= entry.length))) throw new Error('DSH_JSON_INVALID')
      visit(descriptor.value, depth + 1)
    }
    active.delete(entry)
  }
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw new Error('DSH_JSON_BUDGET')
}

function unsupported(): never { throw new Error(SCHEMA_ERROR) }
function keysOnly(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) unsupported()
}
function scalarMatches(type: string, value: unknown): boolean {
  if (type === 'null') return value === null
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  return typeof value === type
}

/** 只投影宿主可无损表达的 DSL 子集；title/examples 等未支持字段明确拒绝。 */
function compile(value: unknown, parameters: boolean): PluginJsonSchema {
  try { assertJson(value, 64 * 1024) } catch { unsupported() }
  let nodes = 0
  function propertyMap(input: unknown, depth: number): Pick<PluginJsonSchema, 'properties' | 'required'> {
    if (!record(input) || Object.keys(input).length > 128) unsupported()
    const properties: Record<string, PluginJsonSchema> = {}
    const required: string[] = []
    for (const [key, property] of Object.entries(input)) {
      if (key.length > 256 || !record(property)) unsupported()
      if (Object.hasOwn(property, 'required')) {
        if (property.required !== true) unsupported()
        required.push(key)
      }
      Object.defineProperty(properties, key, { value: node(property, depth, true), enumerable: true, configurable: true, writable: true })
    }
    return { properties, ...(required.length ? { required } : {}) }
  }
  function node(input: unknown, depth: number, allowRequired: boolean): PluginJsonSchema {
    if (++nodes > 256 || depth > 12 || !record(input)) unsupported()
    const annotations = ['description', 'default', ...(allowRequired ? ['required'] : [])]
    const output: PluginJsonSchema = {}
    if (Object.hasOwn(input, 'description')) {
      if (typeof input.description !== 'string') unsupported()
      output.description = input.description
    }
    // 上游 default 是非校验注解：不要求匹配 type，也不注入缺失参数。
    if (Object.hasOwn(input, 'default')) output.default = input.default
    if (Object.hasOwn(input, 'oneOf')) {
      keysOnly(input, [...annotations, 'oneOf'])
      if (!Array.isArray(input.oneOf) || input.oneOf.length < 2 || input.oneOf.length > 16) unsupported()
      output.oneOf = input.oneOf.map(branch => node(branch, depth + 1, false))
      return output
    }
    switch (input.type) {
      case 'json': keysOnly(input, [...annotations, 'type']); return output
      case 'object': {
        keysOnly(input, [...annotations, 'type', 'properties', 'additionalProperties'])
        if (typeof input.additionalProperties !== 'boolean') unsupported()
        output.type = 'object'; output.additionalProperties = input.additionalProperties
        if (Object.hasOwn(input, 'properties')) Object.assign(output, propertyMap(input.properties, depth + 1))
        return output
      }
      case 'array':
        keysOnly(input, [...annotations, 'type', 'items'])
        output.type = 'array'
        if (Object.hasOwn(input, 'items')) output.items = node(input.items, depth + 1, false)
        return output
      case 'string': case 'number': case 'integer': case 'boolean': case 'null': {
        keysOnly(input, [...annotations, 'type', 'enum', 'const'])
        output.type = input.type
        if (Object.hasOwn(input, 'enum')) {
          if (!Array.isArray(input.enum) || input.enum.length === 0 || input.enum.length > 128 || !input.enum.every(item => scalarMatches(input.type as string, item))) unsupported()
          output.enum = input.enum
        }
        if (Object.hasOwn(input, 'const')) {
          if (!scalarMatches(input.type, input.const) || (output.enum && !output.enum.includes(input.const))) unsupported()
          output.const = input.const
        }
        return output
      }
      default: return unsupported()
    }
  }
  const result = parameters ? { type: 'object' as const, ...propertyMap(value, 1) } : node(value, 0, false)
  // 与来源对象断开引用，避免后续修改 default/enum 改变已经核对的合同。
  return JSON.parse(JSON.stringify(result)) as PluginJsonSchema
}

/** DSH parameters 是隐式开放对象，不添加 additionalProperties:false。 */
export function adaptDshParameters(value: unknown): PluginJsonSchema { return compile(value, true) }
/** 输出与嵌套值必须显式声明 object 的开放性。 */
export function adaptDshValueSchema(value: unknown): PluginJsonSchema { return compile(value, false) }

/** 只接受本模块编译的静态 schema；不转换类型，不注入 default，不返回用户值。 */
export function validateDshValue(schema: PluginJsonSchema, value: unknown): string[] {
  try { assertJson(value, MAX_VALUE_BYTES) } catch { return ['DSH_VALUE_NOT_BOUNDED_JSON'] }
  function matches(node: PluginJsonSchema, current: unknown): boolean {
    if (node.oneOf) return node.oneOf.filter(branch => matches(branch, current)).length === 1
    if (node.enum && !node.enum.includes(current)) return false
    if (Object.hasOwn(node, 'const') && node.const !== current) return false
    if (node.type === 'object') {
      if (!record(current)) return false
      if (node.required?.some(key => !Object.hasOwn(current, key))) return false
      for (const [key, entry] of Object.entries(current)) {
        if (node.properties && Object.hasOwn(node.properties, key)) {
          if (!matches(node.properties[key]!, entry)) return false
        } else if (node.additionalProperties === false) return false
      }
      return true
    }
    if (node.type === 'array') return Array.isArray(current) && (!node.items || current.every(item => matches(node.items!, item)))
    return node.type === undefined || scalarMatches(node.type, current)
  }
  return matches(schema, value) ? [] : ['DSH_VALUE_SCHEMA_MISMATCH']
}
