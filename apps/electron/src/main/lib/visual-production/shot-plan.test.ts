import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisualProductionDraft } from '@dutydeck/shared'
import { VisualProductionService } from './store'

/** 隔离每例作品目录，避免测试接触真实创作数据。 */
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 只投影作品可编辑字段，模拟现有正式镜头。 */
function editable(document: VisualProductionDraft): VisualProductionDraft {
  const { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots } = document
  return { title, kind, brief, ratio, fps, voice, music, episodes, assets, shots }
}

describe('Given 单镜头缺少视频生成计划', () => {
  test('When Agent 直接设置首尾帧计划 Then 只推进目标镜头并自动登记已导入末帧', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'visual-shot-plan-')); roots.push(projectRoot)
    const service = new VisualProductionService({ workspaceId: 'workspace', projectRoot })
    const created = await service.invoke('create', { sessionId: 'session', title: '镜头计划', kind: 'film' })
    const target = { sessionId: 'session', productionId: created.document.id }
    writeFileSync(join(projectRoot, 'first.png'), Buffer.from('89504e470d0a1a0a00000000', 'hex'))
    writeFileSync(join(projectRoot, 'last.png'), Buffer.from('89504e470d0a1a0a00000001', 'hex'))
    const first = await service.invoke('importFile', { ...target, relativePath: 'first.png' })
    const last = await service.invoke('importFile', { ...target, relativePath: 'last.png' })
    const shot = {
      id: 'shot', episodeId: created.document.episodes[0]!.id, title: '目标镜头', duration: 6,
      scene: '人物触碰镜面。', motion: '从静止到白光吞没。', dialogue: '', assetIds: [], mediaId: first.id,
    }
    const saved = await service.invoke('save', { ...target, baseRevision: 1, draft: { ...editable(created.document), shots: [shot] } })

    const updated = await service.invoke('updateShotPlan', {
      ...target,
      baseRevision: saved.document.revision,
      shotId: shot.id,
      videoPlan: {
        mode: 'first-last-frame',
        firstFrameAssetId: null,
        lastFrameAssetId: 'shot-tail',
        transitionIn: 'hard-cut',
        rationale: '首帧采用当前画面，尾帧约束为全白过渡。',
      },
      continuityPlan: {
        entryState: '人物手掌贴在镜面上。',
        exitState: '画面均匀过曝为纯白。',
        anchors: [],
        audioTransition: 'carry-over',
        rationale: '白光吞没画面后由下一镜的白场承接。',
      },
      references: [{
        assetId: 'shot-tail',
        mediaId: last.id,
        name: '镜01全白尾帧',
        type: '场景',
        description: '用于约束镜01最终过曝状态。',
      }],
    })

    const currentShot = updated.document.shots.find(item => item.id === shot.id)!
    expect(updated.document.revision).toBe(saved.document.revision + 1)
    expect(currentShot.videoPlan).toMatchObject({ mode: 'first-last-frame', lastFrameAssetId: 'shot-tail' })
    expect(currentShot.continuityPlan).toMatchObject({ audioTransition: 'carry-over' })
    expect(currentShot.assetIds).toContain('shot-tail')
    expect(updated.document.assets.find(asset => asset.id === 'shot-tail')).toMatchObject({ mediaId: last.id, locked: false })
    expect(updated.document.shots).toHaveLength(1)
  })
})
