import { describe, expect, it } from 'bun:test'
import type { ContentPluginPreview } from '@dutydeck/shared'
import { confirmedPluginKey, mergeContentPluginSnapshot } from './PluginSettings.logic'

describe('内容插件安装确认', () => {
  it('Given 有效签名，When 未确认来源，Then 不产生信任凭据', () => {
    const preview = { signatureVerified: true, signer: { keyId: 'fingerprint', publicKey: 'public' } } as ContentPluginPreview
    expect(confirmedPluginKey(preview, false)).toBeNull()
    expect(confirmedPluginKey(preview, true)).toBe('fingerprint')
  })
  it('Given 未签名或缺少签名者，When 勾选来源确认，Then 仍不能安装', () => {
    expect(confirmedPluginKey({ signatureVerified: false, signer: { keyId: 'fake' } } as ContentPluginPreview, true)).toBeNull()
    expect(confirmedPluginKey({ signatureVerified: true } as ContentPluginPreview, true)).toBeNull()
    expect(confirmedPluginKey(null, true)).toBeNull()
  })
  it('Given 已完成卸载，When 旧的刷新请求晚到，Then 不恢复旧目录', () => {
    const latest = { revision: 4, plugins: [] }
    expect(mergeContentPluginSnapshot(latest, { revision: 3, plugins: [] })).toBe(latest)
    expect(mergeContentPluginSnapshot(null, latest)).toBe(latest)
  })
})
