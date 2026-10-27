import { describe, expect, test } from 'bun:test'
import { PROVIDER_DEFAULT_URLS } from '@dutydeck/shared'
import { buildModel } from './pi-model-registry'

describe('Pi 升级后的 Kimi 渠道协议兼容', () => {
  // 隔离运行时首次加载完整 SDK 和目录较慢，给高负载 CI 留出 30 秒初始化预算。
  test.each([
    ['官方地址', PROVIDER_DEFAULT_URLS['kimi-coding'], 'https://api.kimi.com/coding'],
    ['自定义代理地址', 'https://kimi-gateway.example/proxy/v1/', 'https://kimi-gateway.example/proxy'],
  ])('Given Kimi 使用%s When 通过真实 Pi runtime 注册 Then 保留 Anthropic 协议与 Bearer 鉴权', async (_label, baseUrl, expectedBaseUrl) => {
    /** 使用已安装的真实 SDK，模型注册全程离线且不读取真实账户。 */
    const sdk = await import('@earendil-works/pi-coding-agent')
    /** 使用内存凭据存储隔离测试，仍由真实 runtime 完成注册和鉴权解析。 */
    const isolatedRuntime = await sdk.ModelRuntime.create({
      allowModelNetwork: false,
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async (_providerId, update) => update(undefined),
        delete: async () => {},
      },
    })
    /** 仅替换创建入口，避免生产默认凭据路径在测试中被访问。 */
    const isolatedSdk = { ModelRuntime: { create: async () => isolatedRuntime } } as unknown as Parameters<typeof buildModel>[0]
    /** catalog 协议变更不能覆盖 DutyDeck 既有渠道的请求合同。 */
    const { model, modelRuntime } = await buildModel(isolatedSdk, {
      sessionId: 'kimi-upgrade-compat',
      provider: 'kimi-coding',
      model: 'kimi-for-coding',
      apiKey: 'fixture-kimi-key',
      baseUrl,
    })
    expect(model.api).toBe('anthropic-messages')
    expect(model.baseUrl).toBe(expectedBaseUrl)
    /** 从真实 runtime 解析请求鉴权，确保注册头不会在版本升级后丢失。 */
    const auth = await modelRuntime.getAuth(model)
    expect(auth?.auth.headers?.Authorization).toBe('Bearer fixture-kimi-key')
    expect(auth?.auth.headers?.['User-Agent']).toBeTruthy()
  }, 30_000)
})
