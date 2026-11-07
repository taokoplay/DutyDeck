/** 受控的工作区 MCP 配置服务。 */

import type { McpServerEntry, McpTransportType, WorkspaceMcpConfig } from '@dutydeck/shared'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { getWorkspaceMcpConfig, saveWorkspaceMcpConfig } from './agent-workspace-manager'
import {
  buildWorkspaceMcpEntry,
  hasSensitiveConnectionBindingConflict,
  hasWorkspaceMcpTransportChanged,
  preserveSensitiveConnectionFields,
  requireWorkspaceMcpServerName,
  type ConfigureWorkspaceMcpInput,
} from './mcp-configuration-policy'
import { validateMcpServer } from './mcp-validator'

export type { ConfigureWorkspaceMcpInput } from './mcp-configuration-policy'

/** 每个工作区的 MCP 配置变更队列，避免并发读改写互相覆盖。 */
const workspaceMcpConfigMutationQueues = new Map<string, Promise<void>>()

/** 在指定工作区的串行写入区间内执行一次配置变更。 */
async function withWorkspaceMcpConfigMutation<T>(workspaceSlug: string, action: () => Promise<T>): Promise<T> {
  const previous = workspaceMcpConfigMutationQueues.get(workspaceSlug) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.catch(() => undefined).then(() => current)
  workspaceMcpConfigMutationQueues.set(workspaceSlug, queued)
  await previous.catch(() => undefined)
  try {
    return await action()
  } finally {
    release?.()
    if (workspaceMcpConfigMutationQueues.get(workspaceSlug) === queued) {
      workspaceMcpConfigMutationQueues.delete(workspaceSlug)
    }
  }
}

/** Agent 可读取的 MCP 脱敏摘要。 */
export interface WorkspaceMcpServerSummary {
  name: string
  type: McpTransportType
  enabled: boolean
  verified: boolean
}

/** MCP 配置写入后的脱敏结果。 */
export interface ConfigureWorkspaceMcpResult extends WorkspaceMcpServerSummary {
  /** 本次调用是否更新同名条目。 */
  updatedExisting: boolean
  /** Pi 工具在运行开始时构建，因此成功配置从下一轮可用。 */
  availableNextRun: boolean
}

/** 由主进程注入的工作区写守卫，统一承接迁移阻断与写入租约。 */
export interface WorkspaceMcpConfigurationOptions {
  runWorkspaceSlugWrite?: <T>(workspaceSlug: string, effect: () => T) => T | Promise<T>
  /** 仅宿主分阶段导入使用：null要求不存在，字符串要求精确未变；不暴露给Agent配置工具。 */
  expectedEntryFingerprint?: string | null
  /** 每个已保存阶段立即记回执；失败向上传播，不把已提交误报为无副作用。 */
  onEntrySaved?: (state: WorkspaceMcpImportState) => void
}

/** 仅供宿主回执使用，不包含配置地址、OAuth字段或凭据原文。 */
export interface WorkspaceMcpImportState extends WorkspaceMcpServerSummary { fingerprint: string }
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalValue(item)]))
  return value
}
function entryFingerprint(entry: McpServerEntry): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(entry))).digest('hex')
}
function importState(name: string, entry: McpServerEntry): WorkspaceMcpImportState {
  return { ...summarize(name, entry), fingerprint: entryFingerprint(entry) }
}
function assertExpectedEntry(entry: McpServerEntry | undefined, expected: string | null | undefined): void {
  if (expected === undefined) return
  if (expected === null ? entry !== undefined : !entry || !/^[a-f0-9]{64}$/.test(expected) || entryFingerprint(entry) !== expected) {
    throw new Error('PLUGIN_IMPORT_MCP_CONFLICT')
  }
}
/** 回执只比较摘要，不将真实headers/env等读出配置服务。 */
export function getWorkspaceMcpImportState(workspaceSlug: string, name: string): WorkspaceMcpImportState | null {
  const validName = requireWorkspaceMcpServerName(name)
  const entry = getWorkspaceMcpConfig(workspaceSlug, { strictImport: true }).servers[validName]
  return entry ? importState(validName, entry) : null
}
/** 撤销必须由导入回执证明本次创建；这里再在共享写队列/守卫内执行精确CAS删除。 */
export async function removeWorkspaceMcpIfUnchanged(
  workspaceSlug: string, name: string, expectedFingerprint: string, options: WorkspaceMcpConfigurationOptions = {},
): Promise<void> {
  const validName = requireWorkspaceMcpServerName(name)
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error('PLUGIN_IMPORT_MCP_CONFLICT')
  await withWorkspaceMcpConfigMutation(workspaceSlug, () => runWorkspaceConfigWrite(workspaceSlug, options, () => {
    const current = getWorkspaceMcpConfig(workspaceSlug, { strictImport: true })
    assertExpectedEntry(current.servers[validName], expectedFingerprint)
    const servers = { ...current.servers }
    delete servers[validName]
    saveWorkspaceMcpConfig(workspaceSlug, { servers }, { strictImport: true })
  }))
}

/** 仅在同步读改写阶段持有主进程守卫，不把网络验证纳入写锁。 */
async function runWorkspaceConfigWrite<T>(
  workspaceSlug: string,
  options: WorkspaceMcpConfigurationOptions,
  effect: () => T,
): Promise<T> {
  return options.runWorkspaceSlugWrite
    ? await options.runWorkspaceSlugWrite(workspaceSlug, effect)
    : effect()
}

/** 去除诊断结果后比较待验证条目，避免旧握手覆盖用户的新编辑。 */
function isSamePendingEntry(current: McpServerEntry | undefined, pending: McpServerEntry): boolean {
  if (!current) return false
  const currentWithoutResult = { ...current }
  delete currentWithoutResult.lastTestResult
  return isDeepStrictEqual(currentWithoutResult, pending)
}

/** 将完整条目收敛为不包含地址、header 或环境变量的摘要。 */
function summarize(name: string, entry: McpServerEntry): WorkspaceMcpServerSummary {
  return {
    name,
    type: entry.type,
    enabled: entry.enabled,
    verified: entry.lastTestResult?.success === true,
  }
}

/** 列出工作区 MCP 的脱敏状态。 */
export function listWorkspaceMcpServers(workspaceSlug: string): WorkspaceMcpServerSummary[] {
  const config = getWorkspaceMcpConfig(workspaceSlug)
  return Object.entries(config.servers).map(([name, entry]) => summarize(name, entry))
}

/**
 * 写入无凭据 transport 配置。启用请求先持久化为 disabled，真实握手和工具发现
 * 成功后才切换为 enabled，防止无效配置进入下一轮 Agent。
 */
export async function configureWorkspaceMcp(
  workspaceSlug: string,
  input: ConfigureWorkspaceMcpInput,
  options: WorkspaceMcpConfigurationOptions = {},
): Promise<ConfigureWorkspaceMcpResult> {
  return withWorkspaceMcpConfigMutation(workspaceSlug, async () => {
    const name = requireWorkspaceMcpServerName(input.name)
    let existing: McpServerEntry | undefined
    let entry: McpServerEntry
    let pendingEntry: McpServerEntry
    const readOptions = { strictImport: options.expectedEntryFingerprint !== undefined }
    await runWorkspaceConfigWrite(workspaceSlug, options, () => {
      const current = getWorkspaceMcpConfig(workspaceSlug, readOptions)
      existing = current.servers[name]
      assertExpectedEntry(existing, options.expectedEntryFingerprint)
      const requestedEntry: McpServerEntry = {
        ...buildWorkspaceMcpEntry(input),
        ...(input.oauth === undefined && existing?.oauth ? { oauth: existing.oauth } : {}),
        // Agent 省略未暴露的预设超时字段时保留原值，避免普通更新丢失长任务调用上限。
        ...(input.toolTimeout === undefined && existing?.toolTimeout !== undefined ? { toolTimeout: existing.toolTimeout } : {}),
      }
      if (existing && hasWorkspaceMcpTransportChanged(existing, requestedEntry) && input.replaceExisting !== true) {
        throw new Error(`MCP「${name}」已存在且连接配置不同；请先向用户说明影响并在确认后以 replaceExisting=true 重试`)
      }
      if (existing && hasSensitiveConnectionBindingConflict(existing, requestedEntry)) {
        throw new Error(`MCP「${name}」的连接目标绑定了敏感 headers 或 env；请在 MCP 管理界面移除或重新配置凭据后再修改目标`)
      }

      entry = preserveSensitiveConnectionFields(existing, requestedEntry)
      pendingEntry = { ...entry, enabled: false }
      const pendingConfig: WorkspaceMcpConfig = {
        servers: { ...current.servers, [name]: pendingEntry },
      }
      saveWorkspaceMcpConfig(workspaceSlug, pendingConfig, readOptions)
      options.onEntrySaved?.(importState(name, pendingEntry))
    })

    if (!entry!.enabled) {
      return { ...summarize(name, pendingEntry!), updatedExisting: Boolean(existing), availableNextRun: false }
    }

    const validation = await validateMcpServer(name, entry!, workspaceSlug)
    const resolvedEntry: McpServerEntry = {
      ...entry!,
      enabled: validation.valid,
      lastTestResult: {
        success: validation.valid,
        message: validation.valid ? (validation.message ?? 'MCP 连接成功') : (validation.reason ?? 'MCP 连接失败'),
        timestamp: Date.now(),
      },
    }
    const persistedEntry = await runWorkspaceConfigWrite(workspaceSlug, options, () => {
      const latest = getWorkspaceMcpConfig(workspaceSlug, readOptions)
      if (!isSamePendingEntry(latest.servers[name], pendingEntry!)) return latest.servers[name]
      // 导入不能继承验证期间用户更新的任何字段（包括诊断结果）的删除所有权。
      if (options.expectedEntryFingerprint !== undefined && (!latest.servers[name] || entryFingerprint(latest.servers[name]!) !== entryFingerprint(pendingEntry!))) return latest.servers[name]
      saveWorkspaceMcpConfig(workspaceSlug, {
        servers: { ...latest.servers, [name]: resolvedEntry },
      }, readOptions)
      options.onEntrySaved?.(importState(name, resolvedEntry))
      return resolvedEntry
    })

    if (!persistedEntry || persistedEntry !== resolvedEntry) {
      return {
        ...(persistedEntry ? summarize(name, persistedEntry) : { name, type: entry!.type, enabled: false, verified: false }),
        updatedExisting: Boolean(existing),
        availableNextRun: false,
      }
    }

    return {
      ...summarize(name, resolvedEntry),
      updatedExisting: Boolean(existing),
      availableNextRun: validation.valid,
    }
  })
}
