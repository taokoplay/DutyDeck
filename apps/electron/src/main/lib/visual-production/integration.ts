import { realpathSync } from 'node:fs'
import type { VisualProductionChanged, MediaAssetRef, VisualEditingDocument, VisualEditingExportSettings, VisualMedia, VisualProductionMediaOption, VisualProductionMediaExecution, VisualProductionMediaExecutionSource, VisualProductionMediaKind } from '@dutydeck/shared'
import { isOrdinaryTopLevelAgentSession } from '@dutydeck/shared'
import { getAgentSessionMeta } from '../agent-session-manager'
import { isEligibleProjectAgent } from '../agent-session-visibility'
import { getAgentWorkspace, getProjectFilesPath } from '../agent-workspace-manager'
import { acquireWorkspaceWriteLease } from '../workspace-operation-lock'
import { runStableDirectoryNative } from '../stable-directory-native-host'
import { createVisualProductionAccess } from './access'
import type { VisualProductionExecutor } from './access'
import { VisualProductionService } from './store'
import { createVisualTaskContextRuntime } from './task-context'
import type { VisualTaskContextRuntime } from './task-context'
import { createVisualContextEvidenceStore } from './context-evidence-store'
import type { MediaDeliveryInspectionResult } from '../media/media-delivery-inspection-service'

/** 主进程注册可信图片读取与失效通知，Agent 与 IPC 使用同一宿主。 */
interface VisualProductionHost {
  /** 仅检查 access 已读取并核对 hash 的素材；抽帧字节不持久化。 */
  inspectMedia?(workspaceId: string, input: { sessionId: string; productionId: string; media: VisualMedia; bytes: Uint8Array }, signal?: AbortSignal): Promise<MediaDeliveryInspectionResult>
  /** 只投影公开模型和服务，不枚举工作流、不探测网络或返回凭据。 */
  listMediaOptions?(workspaceId: string): Promise<VisualProductionMediaOption[]>
  /** 解析 Agent 选择的精确工作流；校验项目、服务归属及实际输入约束。 */
  resolveMediaWorkflow?(workspaceId: string, source: Extract<VisualProductionMediaExecutionSource, { type: 'workflow' }>, kind: VisualProductionMediaKind): Promise<VisualProductionMediaOption>
  /** 从可信运行冻结请求提取制作事实，核验工作区与会话归属。 */
  readMediaExecution?(workspaceId: string, sessionId: string, runId: string, engine: 'model' | 'workflow'): Promise<VisualProductionMediaExecution>
  /** 在受管项目写租约内登记已验证的正式参考副本。 */
  registerReference?(workspaceId: string, input: { sessionId: string; productionId: string; media: VisualMedia; bytes: Uint8Array }): Promise<MediaAssetRef>
  /** 使用主进程已配置的编码器生成真实 MP4，并返回已登记媒体身份。 */
  renderExport?(workspaceId: string, input: { productionId: string; episodeId: string; timeline: VisualEditingDocument; settings: VisualEditingExportSettings; sourceMedia: VisualMedia[]; readMedia: (mediaId: string) => { bytes: Uint8Array; mime: string } }): Promise<{ encoderId: string; artifactMedia: VisualMedia; artifactBytes: Uint8Array }>
  readMediaAsset(workspaceId: string, reference: MediaAssetRef): Promise<Uint8Array>
  onChanged(event: VisualProductionChanged): void
}
/** 随主进程生命周期注册；不持有项目正文或任何模型凭据。 */
let host: VisualProductionHost | undefined

/** 在媒体服务就绪后注册影像作品宿主。 */
export function setVisualProductionHost(value: VisualProductionHost): void { host = value }

/** 用会话反查项目；不信任 renderer 或模型提供的路径。 */
function resolveSession(sessionId: string): { workspaceId: string; projectRoot: string } {
  /** 当前权威会话及项目。 */
  const session = getAgentSessionMeta(sessionId)
  const workspace = session?.workspaceId ? getAgentWorkspace(session.workspaceId) : undefined
  if (!isOrdinaryTopLevelAgentSession(session) || !workspace || !isEligibleProjectAgent(session, workspace.id) || (session.toolMode ?? 'standard') !== 'standard') {
    throw new Error('VISUAL_PRODUCTION_ACCESS_DENIED: 影像创作仅支持当前项目的普通会话')
  }
  return { workspaceId: workspace.id, projectRoot: getProjectFilesPath(workspace.slug) }
}

/**
 * 为一次 IPC 请求或 Agent 运行建立固定归属的能力。
 * @param sessionId 入口绑定的会话。
 * @param options 调用者存活与实时写入权限检查。
 * @returns 无路径选择权的模块执行器。
 */
export function createProductionVisualProductionAccess(
  sessionId: string,
  options: { assertCaller?: () => void; canWrite?: () => boolean } = {},
): VisualProductionExecutor {
  return createVisualProductionAccess(sessionId, {
    resolveSession, ...options, acquireWriteLease: acquireWorkspaceWriteLease,
    createService: ({ workspaceId, projectRoot, assertCurrent }) => new VisualProductionService({
      workspaceId, projectRoot, assertCurrent,
      listMediaOptions: async () => {
        assertCurrent()
        if (!host?.listMediaOptions) throw new Error('制作配置目录尚未就绪')
        const options = await host.listMediaOptions(workspaceId)
        assertCurrent()
        return options
      },
      resolveMediaWorkflow: async (source, kind) => {
        assertCurrent()
        if (!host?.resolveMediaWorkflow) throw new Error('工作流解析服务尚未就绪')
        const option = await host.resolveMediaWorkflow(workspaceId, source, kind)
        assertCurrent()
        return option
      },
      readMediaExecution: async (sessionId, runId, engine) => {
        assertCurrent()
        if (!host?.readMediaExecution) throw new Error('制作记录服务尚未就绪')
        const receipt = await host.readMediaExecution(workspaceId, sessionId, runId, engine)
        assertCurrent()
        return receipt
      },
      readSourceFile: async (relativePath, maxBytes) => {
        assertCurrent()
        /** 稳定目录 helper 用句柄相对读取，避免父目录链接替换造成越界。 */
        const canonicalRoot = realpathSync(projectRoot)
        const result = await runStableDirectoryNative({
          mode: 'preview-resource-read', roots: [projectRoot], resourcePath: relativePath, maxFileBytes: maxBytes,
        }, (roots) => {
          assertCurrent()
          return roots.length === 1 && roots[0]?.isDirectory === true && roots[0].canonicalPath === canonicalRoot
        })
        assertCurrent()
        if (result.resourceReadOutcome?.status !== 'ok') throw new Error('VISUAL_PRODUCTION_SOURCE_UNAVAILABLE: 来源缺失或不能安全读取')
        return Buffer.from(result.resourceReadOutcome.contentBase64, 'base64')
      },
      registerReference: async (input) => {
        assertCurrent()
        if (!host?.registerReference) throw new Error('VISUAL_PRODUCTION_MEDIA_UNAVAILABLE: 参考媒体服务尚未就绪')
        const reference = await host.registerReference(workspaceId, input)
        assertCurrent()
        return reference
      },
      readMediaAsset: async (reference) => {
        assertCurrent()
        if (!host) throw new Error('VISUAL_PRODUCTION_MEDIA_UNAVAILABLE: 媒体服务尚未就绪')
        const bytes = await host.readMediaAsset(workspaceId, reference)
        assertCurrent()
        return bytes
      },
      renderExport: async (input) => {
        assertCurrent()
        if (!host?.renderExport) throw new Error('成片编码器尚未配置')
        const result = await host.renderExport(workspaceId, input)
        assertCurrent()
        return result
      },
    }),
    onChanged: (event) => {
      try { host?.onChanged(event) } catch { /* 写入已成功，窗口关闭不改变提交结果。 */ }
    },
  })
}

/**
 * 将视觉结论存储与真实媒体检查绑定当前会话和项目。
 * @param sessionId 宿主会话身份。
 * @param options 本轮身份、访问能力及实时写入复验。
 * @returns 不可恢复授权的任务视觉运行时。
 */
export function createProductionVisualTaskContextRuntime(sessionId: string, options: {
  runId: string
  access: VisualProductionExecutor
  assertWrite?: () => void | Promise<void>
  assertCaller?: () => void
}): VisualTaskContextRuntime {
  /** 固定根；所有异步检查返回后仍由 access 复验归属。 */
  const initial = resolveSession(sessionId)
  if (initial.workspaceId !== options.access.workspaceId) throw new Error('VISUAL_CONTEXT_ACCESS_CHANGED')
  const assertCurrent = (): void => { options.assertCaller?.(); options.access.assertCurrent() }
  const store = createVisualContextEvidenceStore(initial.projectRoot, assertCurrent)
  return createVisualTaskContextRuntime({
    runId: options.runId, sessionId, access: options.access, assertWrite: options.assertWrite,
    evidenceStore: {
      list: (productionId, scopeKey, runId) => store.list(productionId, scopeKey, runId),
      append: observation => {
        assertCurrent()
        const release = acquireWorkspaceWriteLease(initial.workspaceId)
        try { store.append(observation) } finally { release() }
      },
    },
    inspectMedia: async (input, signal) => {
      assertCurrent(); signal?.throwIfAborted()
      if (!host?.inspectMedia) throw new Error('VISUAL_CONTEXT_INSPECTION_UNAVAILABLE: 媒体检查宿主尚未就绪')
      const result = await host.inspectMedia(initial.workspaceId, { sessionId, ...input }, signal)
      assertCurrent(); signal?.throwIfAborted()
      return result
    },
  })
}
