import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MediaGenerationPreview } from '@dutydeck/shared'
import { ToolResultRenderer } from './index'
import { MediaGenerationResultRenderer, MediaPreviewContent, MediaPreviewOwner, parseMediaGenerationResult } from './MediaGenerationResultRenderer'

/** 工具回执样本包含恶意 URL，但展示不得消费该字段。 */
const result = JSON.stringify({ id: 'run', phase: 'succeeded', mediaKind: 'image', outputs: [{ outputKey: 'image', asset: { mediaKind: 'image' }, url: 'https://evil.invalid/track' }] })
/** 主进程返回的受管预览样本。 */
const preview: MediaGenerationPreview = { leaseId: 'lease', mediaUrl: 'proma-file://token', mediaKind: 'image', filename: 'result.png' }

describe('Agent 统一媒体结果', () => {
  test('Given 统一生成工具 When 通过真实分发器渲染 Then 显示专属卡片而非原始JSON', () => {
    for (const toolName of ['media_prepare_generation', 'media_execute_generation', 'media_get_generation', 'media_wait_generation', 'media_cancel_generation']) {
      const html = renderToStaticMarkup(<ToolResultRenderer toolName={toolName} input={{}} result={result} isError={false} sessionId="owner" />)
      expect(html).toContain('生成完成')
      expect(html).toContain('预览产物')
      expect(html).not.toContain('evil.invalid')
    }
  })

  test('Given 工具回执含本地路径或远端 URL When 解析展示 Then 仅使用任务ID和产物键且没有网络图片', () => {
    expect(parseMediaGenerationResult(result)).toEqual({ runId: 'run', phase: 'succeeded', mediaKind: 'image', outputKeys: ['image'] })
    const html = renderToStaticMarkup(<MediaGenerationResultRenderer result={result} isError={false} sessionId="owner" />)
    expect(html).toContain('预览产物')
    expect(html).not.toContain('evil.invalid')
    expect(html).not.toContain('<img')
  })
  test('Given 准备、运行、失败、未知状态 When 展示 Then 使用中文且错误结果不提供预览', () => {
    for (const [phase, label] of [['prepared', '已准备'], ['running', '生成中'], ['failed', '生成失败'], ['unknown', '结果未知']]) {
      const html = renderToStaticMarkup(<MediaGenerationResultRenderer result={JSON.stringify({ id: 'run', phase, mediaKind: 'image', outputs: [] })} isError={false} sessionId="owner" />)
      expect(html).toContain(label!)
    }
    expect(renderToStaticMarkup(<MediaGenerationResultRenderer result={result} isError sessionId="owner" />)).not.toContain('预览产物')
    expect(renderToStaticMarkup(<MediaGenerationResultRenderer result={result} isError={false} />)).toContain('缺少消息会话')
  })
  test('Given 安全错误码 When 渲染真实结果卡 Then 显示中文原因且不回显错误中的URL和密钥', () => {
    for (const [code, label] of [
      ['MEDIA_ADAPTER_AUTH_FAILED', '鉴权失败'], ['MEDIA_ADAPTER_QUOTA_EXCEEDED', '额度不足'],
      ['MEDIA_GENERATION_PARAMETER_UNSUPPORTED', '参数不支持'], ['MEDIA_MODEL_UNAVAILABLE', '模型不可用'],
      ['MEDIA_GENERATION_OUTCOME_UNKNOWN', '提交结果未知'],
    ]) {
      for (const errorResult of [code!, JSON.stringify({ id: 'run', phase: 'failed', mediaKind: 'image', outputs: [], error: code })]) {
        const html = renderToStaticMarkup(<ToolResultRenderer toolName="media_get_generation" input={{}} result={errorResult} isError sessionId="owner" />)
        expect(html).toContain(label!)
      }
    }
    const html = renderToStaticMarkup(<MediaGenerationResultRenderer result={JSON.stringify({ error: 'MEDIA_ADAPTER_AUTH_FAILED: https://secret.invalid/?key=sk-secret' })} isError sessionId="owner" />)
    expect(html).toContain('鉴权失败')
    expect(html).not.toContain('secret.invalid')
    expect(html).not.toContain('sk-secret')
    expect(renderToStaticMarkup(<MediaGenerationResultRenderer result="https://evil.invalid?key=secret" isError sessionId="owner" />)).not.toContain('evil.invalid')
  })

  test('Given 主进程核验图片、音频、视频 When 展示 Then 分别采用图片与有controls播放器', () => {
    for (const kind of ['image', 'audio', 'video'] as const) {
      const html = renderToStaticMarkup(<MediaPreviewContent preview={{ ...preview, mediaKind: kind }} />)
      expect(html).toContain(kind === 'image' ? '<img' : `<${kind}`)
      if (kind !== 'image') { expect(html).toContain('controls'); expect(html).toContain('preload="metadata"') }
    }
  })
  test('Given 会话切换时预览仍在请求 When 旧请求返回 Then 立即撤销且不显示跨会话结果', async () => {
    let resolve: ((value: MediaGenerationPreview) => void) | undefined
    const releases: string[] = []
    const shown: MediaGenerationPreview[] = []
    const owner = new MediaPreviewOwner({
      mediaGenerationReadPreview: () => new Promise((callback) => { resolve = callback }),
      mediaGenerationReleasePreview: async ({ sessionId, leaseId }) => { releases.push(`${sessionId}:${leaseId}`) },
    }, { sessionId: 'old-session', runId: 'run', outputKey: 'image' }, (value) => { shown.push(value) })
    const pending = owner.open()
    owner.dispose()
    resolve!(preview)
    await pending
    expect(releases).toEqual(['old-session:lease'])
    expect(shown).toEqual([])
  })
  test('Given 已展示产物 When 组件卸载 Then 释放该消息会话的授权且只释放一次', async () => {
    const releases: string[] = []
    const owner = new MediaPreviewOwner({ mediaGenerationReadPreview: async () => preview, mediaGenerationReleasePreview: async ({ leaseId }) => { releases.push(leaseId) } }, { sessionId: 'owner', runId: 'run', outputKey: 'image' }, () => {})
    await owner.open()
    owner.dispose()
    owner.dispose()
    expect(releases).toEqual(['lease'])
  })
})
