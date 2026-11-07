import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { composePiCustomTools } from './pi-tool-registry'

function tool(name: string): ToolDefinition {
  return { name, label: name, description: '自有聚合fixture', parameters: { type: 'object', properties: {} }, async execute() { throw new Error('聚合不得执行工具') } }
}

describe('Given 内置、产品与插件共享 Pi 工具表', () => {
  test('When 插件或其它来源与既有工具同名 Then 拒绝整个聚合，不静默覆盖', () => {
    const builtin = tool('read')
    expect(() => composePiCustomTools([builtin], [tool('read')])).toThrow('PI_TOOL_NAME_CONFLICT:read')
    expect(() => composePiCustomTools([tool('plugin_fixed_calc')], [tool('plugin_fixed_calc')])).toThrow('PI_TOOL_NAME_CONFLICT:plugin_fixed_calc')
    expect(() => composePiCustomTools([builtin, builtin])).toThrow('PI_TOOL_NAME_CONFLICT:read')
  })
  test('When 工具名互异 Then 保持原顺序和执行权限包装，不变更输入集合', () => {
    const builtin = tool('read'); const plugin = tool('plugin_fixed_calc')
    const source = Object.freeze([builtin])
    const result = composePiCustomTools(source, [plugin])
    expect(result).toEqual([builtin, plugin])
    expect(result[0]).toBe(builtin)
    expect(result[1]).toBe(plugin)
    expect(source).toEqual([builtin])
  })
})
