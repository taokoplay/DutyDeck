import { describe, expect, test } from 'bun:test'
import type { MediaWorkflowDefinition } from '@dutydeck/shared'
import { createComfyUIOutputPreflightAdapter } from './comfyui-preflight'

function workflow(mediaType: 'image' | 'audio' | 'video'): MediaWorkflowDefinition {
  return { schemaVersion: 1, prompt: {}, bindings: [], outputs: [{ key: 'main', nodeId: '1', outputIndex: 0, mediaType }] }
}

describe('ComfyUI 输出预检适配器', () => {
  test('Given 图片工作流 When 预检 Then 不要求本机媒体探测器', async () => {
    const adapter = createComfyUIOutputPreflightAdapter({
      candidates: ['ffprobe'],
      exec: async () => { throw new Error('图片输出不应调用 ffprobe') },
    })

    await adapter.assertOutputSupport(workflow('image'))
  })

  test('Given 音视频工作流 When 本机探测器可用 Then 预检通过', async () => {
    let calls = 0
    const adapter = createComfyUIOutputPreflightAdapter({
      candidates: ['ffprobe'],
      exec: async () => { calls += 1; return { stdout: 'ffprobe version 7.1\n', stderr: '' } },
    })

    await adapter.assertOutputSupport(workflow('video'))
    expect(calls).toBe(1)
  })

  test('Given 音视频工作流 When 本机探测器不可用 Then 保留稳定错误码', async () => {
    const adapter = createComfyUIOutputPreflightAdapter({ candidates: [] })

    await expect(adapter.assertOutputSupport(workflow('audio'))).rejects.toThrow('MEDIA_PROBE_UNAVAILABLE')
  })
})
