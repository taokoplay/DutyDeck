import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 随应用发布的 LibTV 指引路径；不连接真实付费服务。 */
const skillPath = join(import.meta.dir, '../../../default-skills/libtv-media/SKILL.md')

test('Given LibTV 插件接入 When 读取指引 Then 使用动态工具与原任务查询而非猜测 CLI', () => {
  const skill = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : ''
  expect(skill).toMatch(/^name: libtv-media$/m)
  expect(skill).toMatch(/^version: "1\.0\.1"$/m)
  for (const rule of ['get_capabilities', 'mcp__libtv__', '同一个任务', '不重复提交', '设置 → 媒体 → LibTV', '实际工具 schema', '不得绕过', '不能声称已经入库']) expect(skill).toContain(rule)
})
