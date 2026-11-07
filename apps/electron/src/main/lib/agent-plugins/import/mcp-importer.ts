import { createHash, randomUUID } from 'node:crypto'
import type { ContentPluginService } from '../content-plugin-service'
import { configureWorkspaceMcp, getWorkspaceMcpImportState, removeWorkspaceMcpIfUnchanged, type WorkspaceMcpConfigurationOptions } from '../../mcp-configuration-service'
import { createStaticImportPlan, type StaticImportPlan } from './import-plan'
import type { PluginImportReceipt, PluginImportReceiptStore, PluginImportStepReceipt } from './import-receipt-store'

export interface StaticImportWorkspace { id: string; slug: string }
import type { StaticImportPlanSummary, StaticImportPreview } from '@dutydeck/shared'
import { inspectPluginPackage } from '@dutydeck/plugin-kit'
export type { StaticImportPreview } from '@dutydeck/shared'
export interface StaticImportServiceOptions {
  /** 生产必须经ContentPluginManager适配，保持全局目录冲突校验和changed发布。 */
  content: Pick<ContentPluginService, 'snapshot' | 'previewBytes' | 'install' | 'uninstall'>
  /** 生产注入与原内容IPC相同的实例/运行busy守卫；只覆盖同步内容提交，不长期占网络锁。 */
  runContentMutation: <T>(effect: () => T) => Promise<T>
  assertWorkspaceCurrent: (workspace: StaticImportWorkspace) => void
  receipts: PluginImportReceiptStore
  plans: readonly StaticImportPlan[]
  mcpOptions: WorkspaceMcpConfigurationOptions
}
interface PendingImport { plan: StaticImportPlan; workspace: StaticImportWorkspace; receiptId: string; expiresAt: number }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 固定配方的分阶段导入。外部只传预览token和明确确认，不提交任意连接或包字节。 */
export class StaticPluginImportService {
  private readonly plans = new Map<string, StaticImportPlan>()
  private readonly previews = new Map<string, PendingImport>()
  constructor(private readonly options: StaticImportServiceOptions) {
    if (options.plans.length > 64) throw new Error('PLUGIN_IMPORT_PLAN_LIMIT')
    for (const source of options.plans) {
      const plan = createStaticImportPlan({ recipeId: source.recipeId, recipeVersion: source.recipeVersion, source: source.source,
        ...(source.content ? { contentBytes: source.content.bytes } : {}), ...(source.mcp ? { mcp: source.mcp } : {}) })
      if (plan.hash !== source.hash || this.plans.has(plan.hash)) throw new Error('PLUGIN_IMPORT_PLAN_INVALID')
      this.plans.set(plan.hash, plan)
    }
  }
  /** 清单只含用户预览所需元数据，不泄露包字节、凭据或本地路径。 */
  list(): StaticImportPlanSummary[] {
    return [...this.plans.values()].map(plan => ({ hash: plan.hash, recipeId: plan.recipeId, recipeVersion: plan.recipeVersion, source: structuredClone(plan.source),
      ...(plan.content ? { content: { pluginId: plan.content.pluginId, packageHash: plan.content.packageHash, keyId: plan.content.keyId,
        resources: inspectPluginPackage(plan.content.bytes).resources.resources.map(resource => ({ id: resource.id, path: resource.path, kind: resource.kind, byteLength: resource.byteLength })) } } : {}),
      ...(plan.mcp ? { mcp: { name: plan.mcp.name, url: plan.mcp.url, type: plan.mcp.type, requiresOAuth: Boolean(plan.mcp.oauth) } } : {}),
    }))
  }
  preview(planHash: string, workspace: StaticImportWorkspace): StaticImportPreview {
    const plan = this.plans.get(planHash)
    if (!plan) throw new Error('PLUGIN_IMPORT_PLAN_NOT_FOUND')
    if (![workspace.id, workspace.slug].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value))) throw new Error('PLUGIN_IMPORT_WORKSPACE_INVALID')
    for (const [token, item] of this.previews) if (item.expiresAt < Date.now()) this.previews.delete(token)
    this.options.assertWorkspaceCurrent(workspace)
    const receiptId = hash([workspace.id, workspace.slug, plan.hash])
    const pending: PendingImport = { plan, workspace: { ...workspace }, receiptId, expiresAt: Date.now() + 10 * 60 * 1000 }
    const receipt = this.options.receipts.get(receiptId)
    const conflicts = this.conflicts(pending, receipt)
    // 重新核对同一目标替换旧token；读取失败不占预算，也不签发不完整预览。
    for (const [token, item] of this.previews) if (item.receiptId === receiptId) this.previews.delete(token)
    if (this.previews.size >= 8) throw new Error('PLUGIN_IMPORT_PREVIEW_LIMIT')
    const token = randomUUID()
    this.previews.set(token, pending)
    return { token, planHash, workspaceId: workspace.id, conflicts, receipt,
      ...(plan.content ? { content: { pluginId: plan.content.pluginId, packageHash: plan.content.packageHash, keyId: plan.content.keyId } } : {}),
      ...(plan.mcp ? { mcp: { name: plan.mcp.name, url: plan.mcp.url, type: plan.mcp.type } } : {}) }
  }
  async apply(token: string, confirmation: { confirmed: boolean; trustedKeyId?: string }): Promise<PluginImportReceipt> {
    if (confirmation.confirmed !== true) throw new Error('PLUGIN_IMPORT_CONFIRMATION_REQUIRED')
    const pending = this.pending(token)
    return this.options.receipts.withOperation(pending.receiptId, async () => {
      this.pending(token)
      let receipt = this.options.receipts.get(pending.receiptId)
      const conflicts = this.conflicts(pending, receipt)
      if (conflicts.length) throw new Error(conflicts[0])
      if (receipt?.steps.some(step => step.status === 'removed')) throw new Error('PLUGIN_IMPORT_ALREADY_REMOVED')
      const { plan, workspace } = pending
      const installed = plan.content ? this.contentState(plan.content.pluginId) : null
      if (plan.content && !installed && confirmation.trustedKeyId !== plan.content.keyId) throw new Error('PLUGIN_IMPORT_PUBLISHER_CONFIRMATION_REQUIRED')
      if (!receipt) receipt = this.options.receipts.put({ formatVersion: 1, id: pending.receiptId, planHash: plan.hash, workspaceId: workspace.id,
        steps: [...(plan.content ? [{ id: 'content' as const, status: 'pending' as const }] : []), ...(plan.mcp ? [{ id: 'mcp' as const, status: 'pending' as const }] : [])] }, 0)
      const save = (id: PluginImportStepReceipt['id'], update: Omit<PluginImportStepReceipt, 'id'>): void => {
        // 每次使用内存中已确认提交的revision；回执写失败直接中断，不猜测其他目录是否回滚。
        this.options.assertWorkspaceCurrent(workspace)
        receipt = this.options.receipts.put({ formatVersion: 1, id: receipt!.id, planHash: receipt!.planHash, workspaceId: receipt!.workspaceId,
          steps: receipt!.steps.map(step => step.id === id ? { id, ...update, ...(id === 'content' && plan.content ? { resourceKey: hash([plan.content.pluginId, plan.content.packageHash]) } : {}) } : step) }, receipt!.revision)
      }
      if (plan.content) {
        const step = receipt.steps.find(item => item.id === 'content')!
        if (!['created', 'reused'].includes(step.status)) {
          const current = this.contentState(plan.content.pluginId)
          if (current) save('content', { status: 'reused', fingerprint: current.fingerprint })
          else {
            const preview = this.options.content.previewBytes(plan.content.bytes)
            if (preview.operation !== 'install') throw new Error('PLUGIN_IMPORT_CONTENT_CONFLICT')
            save('content', { status: 'applying' })
            // install沿用签名信任、registry revision及busy检查；不自动信任新转换者。
            await this.options.runContentMutation(() => {
              this.options.assertWorkspaceCurrent(workspace)
              this.options.content.install(preview.token, confirmation.trustedKeyId)
              const created = this.contentState(plan.content!.pluginId)
              if (!created || created.packageHash !== plan.content!.packageHash) throw new Error('PLUGIN_IMPORT_EFFECT_UNCERTAIN')
              save('content', { status: 'created', fingerprint: created.fingerprint })
            })
          }
        }
      }
      if (plan.mcp) {
        const step = receipt.steps.find(item => item.id === 'mcp')!
        if (!(step.status === 'created' && !step.error)) {
          const expected = step.fingerprint ?? null
          save('mcp', { status: 'applying', ...(step.fingerprint ? { fingerprint: step.fingerprint } : {}) })
          let callbackError: unknown
          try {
            const result = await configureWorkspaceMcp(workspace.slug, { ...plan.mcp, enabled: true }, {
              ...this.mcpOptions(workspace), expectedEntryFingerprint: expected,
              onEntrySaved: state => {
                try { save('mcp', { status: 'created', fingerprint: state.fingerprint, ...(!state.enabled || !state.verified ? { error: 'PLUGIN_IMPORT_MCP_NOT_READY' } : {}) }) }
                catch (error) { callbackError = error; throw error }
              },
            })
            const latest = getWorkspaceMcpImportState(workspace.slug, plan.mcp.name)
            const saved = receipt.steps.find(item => item.id === 'mcp')!
            if (!latest || latest.fingerprint !== saved.fingerprint) save('mcp', { ...saved, status: 'blocked', error: 'PLUGIN_IMPORT_RESOURCE_CHANGED' })
            else if (!result.availableNextRun) save('mcp', { ...saved, error: 'PLUGIN_IMPORT_MCP_NOT_READY' })
          } catch (error) {
            if (callbackError) throw callbackError
            const saved = receipt.steps.find(item => item.id === 'mcp')!
            const current = getWorkspaceMcpImportState(workspace.slug, plan.mcp.name)
            const owned = Boolean(saved.fingerprint && current?.fingerprint === saved.fingerprint)
            save('mcp', { ...saved, status: owned ? 'created' : 'blocked', error: owned ? 'PLUGIN_IMPORT_MCP_NOT_READY' : 'PLUGIN_IMPORT_EFFECT_UNCERTAIN' })
          }
        }
      }
      return receipt
    })
  }
  async undo(token: string, confirmed: boolean): Promise<PluginImportReceipt> {
    if (confirmed !== true) throw new Error('PLUGIN_IMPORT_CONFIRMATION_REQUIRED')
    const pending = this.pending(token)
    return this.options.receipts.withOperation(pending.receiptId, async () => {
      this.pending(token)
      let receipt = this.options.receipts.get(pending.receiptId)
      if (!receipt) throw new Error('PLUGIN_IMPORT_RECEIPT_MISSING')
      for (const step of [...receipt.steps].reverse()) {
        if (['pending', 'removed'].includes(step.status)) continue
        if (step.status === 'reused') {
          // 只释放本次引用，不卸载共享内容；原创建方可在所有引用释放后单独重试撤销。
          receipt = this.options.receipts.put({ formatVersion: 1, id: receipt.id, planHash: receipt.planHash, workspaceId: receipt.workspaceId,
            steps: receipt.steps.map(item => item.id === step.id ? { ...step, status: 'removed', error: undefined } : item) }, receipt.revision)
          continue
        }
        let error: string | undefined
        if (!step.fingerprint) error = 'PLUGIN_IMPORT_EFFECT_UNCERTAIN'
        else if (step.id === 'mcp' && pending.plan.mcp) {
          const current = getWorkspaceMcpImportState(pending.workspace.slug, pending.plan.mcp.name)
          if (current && current.fingerprint !== step.fingerprint) error = 'PLUGIN_IMPORT_RESOURCE_CHANGED'
          else if (current) {
            try { await removeWorkspaceMcpIfUnchanged(pending.workspace.slug, pending.plan.mcp.name, step.fingerprint, this.mcpOptions(pending.workspace)) }
            catch { error = 'PLUGIN_IMPORT_RESOURCE_CHANGED' }
          }
        } else if (step.id === 'content' && pending.plan.content) {
          const current = this.contentState(pending.plan.content.pluginId)
          if (current && current.fingerprint !== step.fingerprint) error = 'PLUGIN_IMPORT_RESOURCE_CHANGED'
          else if (current && !step.resourceKey) error = 'PLUGIN_IMPORT_EFFECT_UNCERTAIN'
          else if (current && this.options.receipts.hasOtherReference(receipt.id, 'content', step.resourceKey!)) error = 'PLUGIN_IMPORT_RESOURCE_SHARED'
          else if (current) {
            try {
              await this.options.runContentMutation(() => {
                this.options.assertWorkspaceCurrent(pending.workspace)
                const latest = this.contentState(pending.plan.content!.pluginId)
                if (!latest || latest.fingerprint !== step.fingerprint) throw new Error('PLUGIN_IMPORT_RESOURCE_CHANGED')
                this.options.content.uninstall(pending.plan.content!.pluginId, latest.revision)
              })
            } catch { error = 'PLUGIN_IMPORT_RESOURCE_CHANGED' }
          }
        }
        this.options.assertWorkspaceCurrent(pending.workspace)
        receipt = this.options.receipts.put({ formatVersion: 1, id: receipt.id, planHash: receipt.planHash, workspaceId: receipt.workspaceId,
          steps: receipt.steps.map(item => item.id === step.id ? { ...step, status: error ? 'blocked' : 'removed', ...(error ? { error } : { error: undefined }) } : item) }, receipt.revision)
      }
      return receipt
    })
  }
  private pending(token: string): PendingImport {
    const pending = this.previews.get(token)
    if (!pending || pending.expiresAt < Date.now()) throw new Error('PLUGIN_IMPORT_PREVIEW_EXPIRED')
    this.options.assertWorkspaceCurrent(pending.workspace)
    return pending
  }
  private mcpOptions(workspace: StaticImportWorkspace): WorkspaceMcpConfigurationOptions {
    return { ...this.options.mcpOptions, runWorkspaceSlugWrite: (slug, effect) => {
      this.options.assertWorkspaceCurrent(workspace)
      if (slug !== workspace.slug) throw new Error('PLUGIN_IMPORT_WORKSPACE_CHANGED')
      const guarded = (): ReturnType<typeof effect> => { this.options.assertWorkspaceCurrent(workspace); return effect() }
      return this.options.mcpOptions.runWorkspaceSlugWrite ? this.options.mcpOptions.runWorkspaceSlugWrite(slug, guarded) : guarded()
    } }
  }
  private contentState(pluginId: string): { revision: number; packageHash: string; fingerprint: string } | null {
    const snapshot = this.options.content.snapshot()
    const entry = snapshot.plugins.find(plugin => plugin.manifest.id === pluginId)
    return entry ? { revision: snapshot.revision, packageHash: entry.packageHash, fingerprint: hash(entry) } : null
  }
  private conflicts(pending: PendingImport, receipt: PluginImportReceipt | null): string[] {
    const conflicts: string[] = []
    if (receipt && (receipt.planHash !== pending.plan.hash || receipt.workspaceId !== pending.workspace.id)) throw new Error('PLUGIN_IMPORT_RECEIPT_IDENTITY')
    if (pending.plan.content) {
      const current = this.contentState(pending.plan.content.pluginId)
      const step = receipt?.steps.find(item => item.id === 'content')
      if (current && current.packageHash !== pending.plan.content.packageHash
        || step?.fingerprint && current?.fingerprint !== step.fingerprint && step.status !== 'removed') conflicts.push('PLUGIN_IMPORT_CONTENT_CONFLICT')
    }
    if (pending.plan.mcp) {
      const current = getWorkspaceMcpImportState(pending.workspace.slug, pending.plan.mcp.name)
      const step = receipt?.steps.find(item => item.id === 'mcp')
      if (current && current.fingerprint !== step?.fingerprint
        || step?.fingerprint && current?.fingerprint !== step.fingerprint && step.status !== 'removed') conflicts.push('PLUGIN_IMPORT_MCP_CONFLICT')
    }
    return conflicts
  }
}
