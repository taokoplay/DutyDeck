import { describe, expect, test } from 'bun:test'
import type { PluginCapabilityClient } from '@dutydeck/plugin-sdk'
import { createInteractionDesignPilotService } from '../src/runtime-service'

/** 内存 artifact 能力替身，只模拟宿主公开返回值与 CAS。 */
function capabilityClient(initial: unknown = null): PluginCapabilityClient & {
  value: unknown
  revision: number
  failNextWrite: boolean
} {
  const client = {
    value: initial,
    revision: initial === null ? 0 : 1,
    failNextWrite: false,
    async request<TResult>(capability: string, input: unknown): Promise<TResult> {
      if (capability === 'artifact.read') {
        return (client.value === null
          ? null
          : { schemaVersion: 1, revision: client.revision, value: client.value, updatedAt: 1 }) as TResult
      }
      if (capability === 'artifact.write') {
        if (client.failNextWrite) {
          client.failNextWrite = false
          throw new Error('PLUGIN_ARTIFACT_REVISION_CONFLICT')
        }
        const request = input as { value: unknown; expectedRevision?: number }
        if (request.expectedRevision !== client.revision) throw new Error('PLUGIN_ARTIFACT_REVISION_CONFLICT')
        client.value = structuredClone(request.value)
        client.revision += 1
        return { revision: client.revision, updatedAt: 2 } as TResult
      }
      if (capability === 'project.files.read') {
        return { path: 'src/App.tsx', content: '<main />', contentHash: 'a'.repeat(64), byteSize: 8 } as TResult
      }
      throw new Error('unexpected capability')
    },
  }
  return client
}

const clock = { now: () => 1_800_000_000_000, id: () => 'candidate-1' }

describe('Given 交互设计试点插件的运行时服务', () => {
  test('When 项目尚无原型 Then list 返回空状态且不创建 artifact', async () => {
    const client = capabilityClient()
    const service = createInteractionDesignPilotService(client, clock)
    await expect(service.list()).resolves.toEqual({ prototype: null, revision: 0 })
    expect(client.revision).toBe(0)
  })

  test('When 创建、提交并采纳单页候选 Then artifact revision 连续推进', async () => {
    const client = capabilityClient()
    const service = createInteractionDesignPilotService(client, clock)
    const created = await service.create({
      name: '登录流程',
      platform: 'mobile',
      html: '<main>旧页面</main>',
    })
    expect(created.artifactRevision).toBe(1)
    const proposed = await service.propose({
      baseRevision: 1,
      pageId: 'home',
      name: '首页',
      html: '<main>新页面</main>',
      summary: '更新登录入口',
    })
    expect(proposed.candidate.id).toBe('candidate-1')
    expect(proposed.revision).toBe(2)
    const adopted = await service.adopt({ baseRevision: 2, candidateId: 'candidate-1' })
    expect(adopted.artifactRevision).toBe(3)
    expect(adopted.prototype.pages[0]?.html).toBe('<main>新页面</main>')
  })

  test('When 宿主 CAS 报告版本冲突 Then 插件不伪造成功状态', async () => {
    const client = capabilityClient()
    const service = createInteractionDesignPilotService(client, clock)
    await service.create({
      name: '登录流程',
      platform: 'mobile',
      html: '<main>旧页面</main>',
    })
    client.failNextWrite = true
    await expect(service.propose({
      baseRevision: 1,
      pageId: 'home',
      name: '首页',
      html: '<main>新页面</main>',
      summary: '冲突候选',
    })).rejects.toThrow('PLUGIN_ARTIFACT_REVISION_CONFLICT')
  })

  test('When 读取项目源码 Then 透传宿主内容 hash 且有界', async () => {
    const service = createInteractionDesignPilotService(capabilityClient(), clock)
    await expect(service.readSource({ path: 'src/App.tsx', maxBytes: 4096 })).resolves.toMatchObject({
      path: 'src/App.tsx',
      content: '<main />',
    })
  })
})
