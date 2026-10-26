import { describe, expect, test } from 'bun:test'
import { isDutyDeckInternalKnowledgePath, shouldTrackAgentFileObservationPath, shouldTrackAgentRunFilePath } from './agent-run-file-change-path-policy'

describe('项目知识文件变更统计边界', () => {
  test('Given 当前与旧知识目录 When 统计工具或 watcher 改动 Then 均隐藏内部写入', () => {
    /** 兼容绝对、相对和 Windows 路径，只匹配完整相邻目录段。 */
    for (const path of ['.dutydeck/knowledge/index.json', '/project/.proma/knowledge/index.json', 'C:\\project\\.dutydeck\\knowledge\\index.json', '.proma\\knowledge']) {
      expect(isDutyDeckInternalKnowledgePath(path)).toBe(true)
      expect(shouldTrackAgentRunFilePath(path)).toBe(false)
      expect(shouldTrackAgentFileObservationPath(path)).toBe(false)
    }
  })

  test('Given 普通源码和相似目录名 When 统计改动 Then 保留用户文件', () => {
    /** 不扩大隐藏范围到其它模块或名字相近的用户目录。 */
    for (const path of ['.dutydeck/project-config/source.ts', '.proma/project-config/source.ts', '.dutydeck/knowledge-notes/index.md', '.dutydeck-notes/knowledge/index.md', '.proma/design/canvas.json', 'src/knowledge/index.ts']) {
      expect(isDutyDeckInternalKnowledgePath(path)).toBe(false)
      expect(shouldTrackAgentRunFilePath(path)).toBe(true)
      expect(shouldTrackAgentFileObservationPath(path)).toBe(true)
    }
  })
})
