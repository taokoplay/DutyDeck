import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VisualProductionSnapshot, VisualShot } from '@dutydeck/shared'
import { VisualScriptWorkspace } from './VisualScriptWorkspace'

/** 最小两镜作品用于验证脚本页在服务端静态渲染。 */
function snapshot(): VisualProductionSnapshot {
  const shots: VisualShot[] = ['shot-1', 'shot-2'].map(id => ({
    id, episodeId: 'episode', title: id, duration: 4, scene: '人物执行动作。', motion: '动作从起点到终点。',
    dialogue: '一句话。', soundDesign: { effects: '环境声。', music: '低频。' },
    continuityPlan: { entryState: '动作起点。', exitState: '动作终点。', anchors: [], audioTransition: 'hard-cut', rationale: '保持连续。' },
    videoPlan: { mode: 'image-to-video', firstFrameAssetId: null, lastFrameAssetId: null, transitionIn: 'hard-cut', rationale: '保持连续。' },
    assetIds: [], mediaId: null,
  }))
  return {
    document: {
      schemaVersion: 1, id: 'production', revision: 1, createdAt: 1, updatedAt: 1,
      title: '测试影片', kind: 'film', brief: '作品目标。', ratio: '9:16', fps: 24, voice: '', music: '',
      episodes: [{ id: 'episode', title: '第一集' }],
      assets: [], shots,
    },
    media: [], assetVersions: {}, shotStates: {}, candidates: [], jobs: [],
  }
}

describe('脚本工作区', () => {
  it('Given 尚无结构化剧本 When 渲染 Then 显示从现有镜头整理入口', () => {
    const value = snapshot()
    const html = renderToStaticMarkup(<VisualScriptWorkspace document={value.document} snapshot={value} episodeId="episode" active busy={false}
      onEpisodeChange={() => undefined} onOpenShot={() => undefined} onGenerate={() => undefined} onReference={() => undefined} onSave={() => undefined} />)
    expect(html).toContain('先把整集拍摄逻辑写成剧本')
    expect(html).toContain('现有镜头稿')
    expect(html).toContain('从现有作品整理剧本')
  })

  it('Given 完整剧本 When 渲染 Then 同时展示节拍、镜头映射和拍摄流程', () => {
    const value = snapshot()
    value.document.episodes[0]!.script = {
      logline: '刑警借证物疑点争取重查。', audiencePromise: '证据逻辑推翻草率判断。', hook: '刑场醒来。',
      turningPoint: '证物无法吻合。', payoff: '暂停行刑。', targetDurationSeconds: 8, productionNotes: '人物与空间保持连续。',
      beats: [
        { id: 'beat-1', title: '醒来', purpose: 'hook', dramaticQuestion: '这是哪里？', synopsis: '主角醒来。', visualAction: '眼部下摇。', dialogue: '内心声。', sound: '木击。', continuity: '双腕绑于身前。', shotIds: ['shot-1'] },
        { id: 'beat-2', title: '转折', purpose: 'turn', dramaticQuestion: '证物真的匹配吗？', synopsis: '断口不吻合。', visualAction: '微距展示。', dialogue: '请求重查。', sound: '金属声。', continuity: '断口不变。', shotIds: ['shot-2'] },
      ],
    }
    const html = renderToStaticMarkup(<VisualScriptWorkspace document={value.document} snapshot={value} episodeId="episode" active busy={false}
      onEpisodeChange={() => undefined} onOpenShot={() => undefined} onGenerate={() => undefined} onReference={() => undefined} onSave={() => undefined} />)
    expect(html).toContain('叙事节拍')
    expect(html).toContain('映射分镜')
    expect(html).toContain('拍摄流程')
    expect(html).toContain('刑警借证物疑点争取重查')
  })
})
