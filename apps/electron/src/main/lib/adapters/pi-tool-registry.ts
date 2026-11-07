import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

/** 统一聚合交给 Pi 的内置、产品及外部工具，不允许后登记覆盖前一工具。 */
export function composePiCustomTools(...groups: ReadonlyArray<readonly ToolDefinition[]>): ToolDefinition[] {
  const names = new Set<string>()
  const result: ToolDefinition[] = []
  for (const group of groups) {
    for (const tool of group) {
      if (names.has(tool.name)) throw new Error(`PI_TOOL_NAME_CONFLICT:${tool.name}`)
      names.add(tool.name)
      result.push(tool)
    }
  }
  return result
}
