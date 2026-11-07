import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPluginPackage, createStandardPluginFiles } from '@dutydeck/plugin-kit'
import type { McpServerEntry, WorkspaceMcpConfig } from '@dutydeck/shared'
import { ContentPluginService } from '../content-plugin-service'
import { createStaticImportPlan } from './import-plan'
import { PluginImportReceiptStore } from './import-receipt-store'

const configs = new Map<string, WorkspaceMcpConfig>()
let valid = false; let handshakes = 0
mock.module('../../agent-workspace-manager', () => ({
  getWorkspaceMcpConfig: (slug: string): WorkspaceMcpConfig => structuredClone(configs.get(slug) ?? { servers: {} }),
  saveWorkspaceMcpConfig: (slug: string, config: WorkspaceMcpConfig): void => { configs.set(slug, structuredClone(config)) },
}))
mock.module('../../mcp-validator', () => ({ validateMcpServer: async (name: string, _entry: McpServerEntry) => { handshakes++; return { name, valid, reason: valid ? undefined : 'fixture handshake failed' } } }))
const { StaticPluginImportService } = await import('./mcp-importer')
beforeEach(() => { configs.clear(); valid = false; handshakes = 0 })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-staged-import-')))
  const bytes = createPluginPackage(createStandardPluginFiles('convert.combined', '组合导入'), generateKeyPairSync('ed25519').privateKey)
  const plan = createStaticImportPlan({ recipeId: 'fixture.combined', recipeVersion: '1.0.0', source: { name: 'dsh-combined', version: '1.0.0', sha256: 'a'.repeat(64), url: 'https://registry.npmjs.org/dsh-combined/-/dsh-combined-1.0.0.tgz', license: 'MIT' }, contentBytes: bytes, mcp: { name: 'docs', type: 'http', url: 'https://mcp.example.com/mcp' } })
  const content = new ContentPluginService(join(root, 'content'))
  const receipts = new PluginImportReceiptStore(join(root, 'receipts'))
  const options = { content, receipts, plans: [plan],
    runContentMutation: async <T>(effect: () => T): Promise<T> => effect(),
    assertWorkspaceCurrent: (_workspace: { id: string; slug: string }): void => {},
    mcpOptions: { runWorkspaceSlugWrite: <T>(_slug: string, effect: () => T): T => effect() } }
  const service = new StaticPluginImportService(options)
  const workspace = { id: 'workspace-id', slug: 'project-a' }
  return { root, plan, content, receipts, options, service, workspace, dispose: () => rmSync(root, { recursive: true, force: true }) }
}
describe('Given 内容加MCP的分阶段导入', () => {
  test('When 连续重新预览同一目标 Then 释放旧token且不耗尽预览预算', async () => {
    const f = fixture()
    try {
      const old = f.service.preview(f.plan.hash, f.workspace)
      let latest = old
      for (let count = 0; count < 10; count++) latest = f.service.preview(f.plan.hash, f.workspace)
      expect(latest.token).not.toBe(old.token)
      await expect(f.service.apply(old.token, { confirmed: true })).rejects.toThrow('PLUGIN_IMPORT_PREVIEW_EXPIRED')
      expect(latest.conflicts).toEqual([])
    } finally { f.dispose() }
  })
  test('When 预览、拒绝确认、首次握手失败、重启重试 Then 准确记录部分成功且不重复安装', async () => {
    const f = fixture()
    try {
      const preview = f.service.preview(f.plan.hash, f.workspace)
      expect(preview.conflicts).toEqual([]); expect(configs.size).toBe(0); expect(handshakes).toBe(0)
      await expect(f.service.apply(preview.token, { confirmed: false })).rejects.toThrow('PLUGIN_IMPORT_CONFIRMATION_REQUIRED')
      const partial = await f.service.apply(preview.token, { confirmed: true, trustedKeyId: preview.content!.keyId })
      expect(partial.steps).toEqual([expect.objectContaining({ id: 'content', status: 'created' }), expect.objectContaining({ id: 'mcp', status: 'created', error: 'PLUGIN_IMPORT_MCP_NOT_READY' })])
      expect(f.content.snapshot().plugins).toHaveLength(1); expect(handshakes).toBe(1)
      const revision = f.content.snapshot().revision
      valid = true
      const restarted = new StaticPluginImportService(f.options)
      const next = restarted.preview(f.plan.hash, f.workspace)
      const done = await restarted.apply(next.token, { confirmed: true })
      expect(done.steps.every(step => step.status === 'created' && !step.error)).toBe(true)
      expect(f.content.snapshot().revision).toBe(revision); expect(handshakes).toBe(2)
      await restarted.apply(next.token, { confirmed: true })
      expect(handshakes).toBe(2); expect(f.content.snapshot().revision).toBe(revision)
      const undoPreview = restarted.preview(f.plan.hash, f.workspace)
      const undone = await restarted.undo(undoPreview.token, true)
      expect(undone.steps.every(step => step.status === 'removed')).toBe(true)
      expect(f.content.snapshot().plugins).toHaveLength(0)
      expect(configs.get('project-a')?.servers.docs).toBeUndefined()
    } finally { f.dispose() }
  })
  test('When 同名连接在预览前或预览后出现 Then 拒绝且不覆盖；相同已有内容仅复用不取得删除权', async () => {
    const f = fixture()
    try {
      configs.set('project-a', { servers: { docs: { type: 'http', url: 'https://user.example.com', enabled: true } } })
      const preview = f.service.preview(f.plan.hash, f.workspace)
      expect(preview.conflicts).toContain('PLUGIN_IMPORT_MCP_CONFLICT')
      await expect(f.service.apply(preview.token, { confirmed: true, trustedKeyId: preview.content!.keyId })).rejects.toThrow('PLUGIN_IMPORT_MCP_CONFLICT')
      expect(f.content.snapshot().plugins).toHaveLength(0)
      configs.clear()
      const own = f.content.previewBytes(f.plan.content!.bytes); f.content.install(own.token, own.signer!.keyId)
      const fresh = f.service.preview(f.plan.hash, f.workspace)
      configs.set('project-a', { servers: { docs: { type: 'http', url: 'https://new.example.com', enabled: true } } })
      await expect(f.service.apply(fresh.token, { confirmed: true })).rejects.toThrow('PLUGIN_IMPORT_MCP_CONFLICT')
      configs.clear(); valid = true
      const next = f.service.preview(f.plan.hash, f.workspace)
      const result = await f.service.apply(next.token, { confirmed: true })
      expect(result.steps[0]?.status).toBe('reused')
      await f.service.undo(next.token, true)
      expect(f.content.snapshot().plugins).toHaveLength(1)
    } finally { f.dispose() }
  })
  test('When 安装前工作区失效或内容变更守卫拒绝 Then 不写注册表也不配置MCP', async () => {
    const f = fixture(); let available = true; let guards = 0
    const guarded = new StaticPluginImportService({ ...f.options,
      assertWorkspaceCurrent: () => { if (!available) throw new Error('PLUGIN_IMPORT_WORKSPACE_CHANGED') },
      runContentMutation: async () => { guards++; throw new Error('PLUGIN_IMPORT_CONTENT_BUSY') },
    })
    try {
      const preview = guarded.preview(f.plan.hash, f.workspace)
      available = false
      await expect(guarded.apply(preview.token, { confirmed: true, trustedKeyId: preview.content!.keyId })).rejects.toThrow('PLUGIN_IMPORT_WORKSPACE_CHANGED')
      expect(guards).toBe(0)
      available = true
      await expect(guarded.apply(preview.token, { confirmed: true, trustedKeyId: preview.content!.keyId })).rejects.toThrow('PLUGIN_IMPORT_CONTENT_BUSY')
      expect(guards).toBe(1)
      expect(f.content.snapshot().plugins).toHaveLength(0)
      expect(configs.size).toBe(0)
    } finally { f.dispose() }
  })
  test('When 已安装内容后的回执写失败 Then 重试只复用现有内容不取得删除权，也不误报跨目录回滚', async () => {
    const f = fixture()
    const original = f.receipts.put.bind(f.receipts)
    const failure = spyOn(f.receipts, 'put').mockImplementation((input, revision) => {
      if (input.steps.some(step => step.id === 'content' && step.status === 'created')) throw new Error('fixture receipt write failure')
      return original(input, revision)
    })
    try {
      const preview = f.service.preview(f.plan.hash, f.workspace)
      await expect(f.service.apply(preview.token, { confirmed: true, trustedKeyId: preview.content!.keyId })).rejects.toThrow('fixture receipt write failure')
      expect(f.content.snapshot().plugins).toHaveLength(1)
      expect(configs.size).toBe(0)
      failure.mockRestore(); valid = true
      const next = f.service.preview(f.plan.hash, f.workspace)
      const result = await f.service.apply(next.token, { confirmed: true })
      expect(result.steps[0]?.status).toBe('reused')
      await f.service.undo(next.token, true)
      expect(f.content.snapshot().plugins).toHaveLength(1)
    } finally { failure.mockRestore(); f.dispose() }
  })
  test('When MCP已经保存但回执未提交 Then 重试及撤销均不得认领或删除未知所有权的连接', async () => {
    const f = fixture()
    const original = f.receipts.put.bind(f.receipts)
    const failure = spyOn(f.receipts, 'put').mockImplementation((input, revision) => {
      if (input.steps.some(step => step.id === 'mcp' && step.status === 'created')) throw new Error('fixture receipt write failure')
      return original(input, revision)
    })
    try {
      const preview = f.service.preview(f.plan.hash, f.workspace)
      await expect(f.service.apply(preview.token, { confirmed: true, trustedKeyId: preview.content!.keyId })).rejects.toThrow('fixture receipt write failure')
      expect(configs.get('project-a')?.servers.docs?.enabled).toBe(false)
      expect(handshakes).toBe(0)
      failure.mockRestore()
      const next = f.service.preview(f.plan.hash, f.workspace)
      expect(next.conflicts).toContain('PLUGIN_IMPORT_MCP_CONFLICT')
      await expect(f.service.apply(next.token, { confirmed: true })).rejects.toThrow('PLUGIN_IMPORT_MCP_CONFLICT')
      const undone = await f.service.undo(next.token, true)
      expect(undone.steps.find(step => step.id === 'mcp')?.error).toBe('PLUGIN_IMPORT_EFFECT_UNCERTAIN')
      expect(configs.get('project-a')?.servers.docs).toBeDefined()
    } finally { failure.mockRestore(); f.dispose() }
  })
  test('When 另一工作区复用本次内容 Then 原导入撤销不能删除仍被复用的全局资源', async () => {
    const f = fixture()
    try {
      valid = true
      const original = f.service.preview(f.plan.hash, f.workspace)
      await f.service.apply(original.token, { confirmed: true, trustedKeyId: original.content!.keyId })
      const shared = f.service.preview(f.plan.hash, { id: 'workspace-b', slug: 'project-b' })
      const reused = await f.service.apply(shared.token, { confirmed: true })
      expect(reused.steps[0]?.status).toBe('reused')
      const undone = await f.service.undo(original.token, true)
      expect(undone.steps[0]?.error).toBe('PLUGIN_IMPORT_RESOURCE_SHARED')
      expect(f.content.snapshot().plugins).toHaveLength(1)
      expect(configs.get('project-b')?.servers.docs?.enabled).toBe(true)
      const released = await f.service.undo(shared.token, true)
      expect(released.steps[0]?.status).toBe('removed')
      expect(f.content.snapshot().plugins).toHaveLength(1)
      const retried = await f.service.undo(original.token, true)
      expect(retried.steps[0]?.status).toBe('removed')
      expect(f.content.snapshot().plugins).toHaveLength(0)
    } finally { f.dispose() }
  })
  test('When 关闭内容后被另一工作区复用再开启 Then 仍按稳定包身份识别共享引用', async () => {
    const f = fixture()
    try {
      valid = true
      const original = f.service.preview(f.plan.hash, f.workspace)
      await f.service.apply(original.token, { confirmed: true, trustedKeyId: original.content!.keyId })
      f.content.setEnabled('convert.combined', false, f.content.snapshot().revision)
      const shared = f.service.preview(f.plan.hash, { id: 'workspace-b', slug: 'project-b' })
      await f.service.apply(shared.token, { confirmed: true })
      f.content.setEnabled('convert.combined', true, f.content.snapshot().revision)
      const undone = await f.service.undo(original.token, true)
      expect(undone.steps[0]?.error).toBe('PLUGIN_IMPORT_RESOURCE_SHARED')
      expect(f.content.snapshot().plugins).toHaveLength(1)
      await f.service.undo(shared.token, true)
      const retried = await f.service.undo(original.token, true)
      expect(retried.steps[0]?.status).toBe('removed')
      expect(f.content.snapshot().plugins).toHaveLength(0)
    } finally { f.dispose() }
  })
  test('When 用户后续修改了内容开关和连接 Then 撤销保留两者并报告冲突', async () => {
    const f = fixture()
    try {
      valid = true
      const preview = f.service.preview(f.plan.hash, f.workspace)
      await f.service.apply(preview.token, { confirmed: true, trustedKeyId: preview.content!.keyId })
      const snapshot = f.content.snapshot(); f.content.setEnabled('convert.combined', false, snapshot.revision)
      configs.get('project-a')!.servers.docs!.url = 'https://changed.example.com'
      const result = await f.service.undo(f.service.preview(f.plan.hash, f.workspace).token, true)
      expect(result.steps.every(step => step.error === 'PLUGIN_IMPORT_RESOURCE_CHANGED')).toBe(true)
      expect(f.content.snapshot().plugins).toHaveLength(1)
      expect(configs.get('project-a')!.servers.docs!.url).toBe('https://changed.example.com')
    } finally { f.dispose() }
  })
})
