import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectStorageMigrationStatus, WorkspacePathState } from '@dutydeck/shared'
import { ProjectStorageMigrationAction } from './ProjectStorageMigrationAction'

/** 服务端渲染仅检查显示与禁用状态，不提供可写 API。 */
function render(status: ProjectStorageMigrationStatus, overrides: Partial<WorkspacePathState> = {}): string {
  return renderToStaticMarkup(<ProjectStorageMigrationAction disabled={false} workspace={{
    workspaceId: 'project', name: '项目', sourceRoot: '/project', kind: 'external', availability: 'available', relocation: null, projectStorageMigration: status, ...overrides,
  }} />)
}

describe('项目数据目录迁移行', () => {
  test('Given 旧、当前与冲突目录 When 渲染 Then 只允许旧目录执行且列出冲突模块', () => {
    const legacy = render({ state: 'legacy', directories: [{ directory: 'knowledge', state: 'legacy' }], retainedLegacyEntries: [] })
    expect(legacy).toContain('迁移项目数据')
    expect(legacy).not.toContain('disabled=""')
    expect(render({ state: 'current', directories: [], retainedLegacyEntries: [] })).toContain('disabled=""')
    const conflict = render({ state: 'conflict', directories: [{ directory: 'design', state: 'conflict' }], retainedLegacyEntries: [] })
    expect(conflict).toContain('目录冲突：design')
    expect(conflict).toContain('打开项目位置')
  })

  test('Given 恢复日志、混合目录或离线项目 When 渲染 Then 提供继续入口或明确禁用', () => {
    expect(render({ state: 'current', directories: [], retainedLegacyEntries: [], recoveryRequired: true })).toContain('继续完成项目迁移')
    expect(render({ state: 'mixed', directories: [{ directory: 'design', state: 'legacy' }], retainedLegacyEntries: [] })).toContain('剩余 1 个旧目录')
    expect(render({ state: 'legacy', directories: [{ directory: 'design', state: 'legacy' }], retainedLegacyEntries: [] }, { availability: 'missing' })).toContain('disabled=""')
    expect(render({ state: 'none', directories: [], retainedLegacyEntries: [] })).toBe('')
  })
})
