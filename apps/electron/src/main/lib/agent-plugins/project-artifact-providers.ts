import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { PluginCapabilityId } from '@dutydeck/plugin-sdk'
import { containsKnowledgeSecret } from '../project-knowledge/sensitive-text'
import { acquireMediaFileLock } from '../media/media-file-lock'
import {
  ensureDirectoryDurable,
  readAtomicFileState,
  readJsonFileSafe,
  writeJsonFileAtomicSecure,
} from '../safe-file'
import type { HostCapabilityProvider, TrustedPluginCaller } from './capability-broker'

/** 宿主解析出的固定项目身份；插件不能自行提交项目根或工作区 ID。 */
export interface PluginProjectIdentity {
  workspaceId: string
  projectRoot: string
}

/** 项目产物能力所需的宿主依赖。 */
export interface ProjectArtifactCapabilityProviderOptions {
  resolveProject: (sessionId: string) => PluginProjectIdentity | undefined
  maxArtifactBytes?: number
  maxSourceBytes?: number
}

/** 磁盘上的插件项目产物，只有宿主可读取其真实路径。 */
interface StoredProjectArtifact {
  schemaVersion: number
  revision: number
  pluginId: string
  artifactId: string
  workspaceId: string
  updatedAt: number
  value: unknown
}

/** artifact.read 的公开返回，不暴露项目路径。 */
interface ProjectArtifactReadResult {
  schemaVersion: number
  revision: number
  updatedAt: number
  value: unknown
}

/** artifact.write 的公开结果。 */
interface ProjectArtifactWriteResult {
  revision: number
  updatedAt: number
}

/** artifact.migrate 的严格业务输入。 */
interface ProjectArtifactMigrationInput {
  artifactId: string
  fromSchemaVersion: number
  toSchemaVersion: number
  expectedRevision: number
  value: unknown
}

/** project.files.read 的公开结果。 */
interface ProjectSourceReadResult {
  path: string
  content: string
  contentHash: string
  byteSize: number
}

/** 通用插件和产物身份只允许稳定的小写片段。 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** 源码读取始终排除版本库、依赖、构建结果、模块数据和常见秘密文件。 */
const EXCLUDED_SOURCE = /^(?:\.|node_modules$|dist$|out$|build$|vendor$)|(?:secret|credential|password|private[-_]?key)|\.(?:pem|key|p12|pfx)$/i

/** 判断值是否为当前模块认可的安全普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 校验固定对象字段，拒绝调用方夹带宿主身份或路径。 */
function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error('PLUGIN_PROJECT_INPUT_INVALID')
}

/** 读取宿主可信项目；会话、工作区和根目录必须在同一次调用中保持一致。 */
function resolveCallerProject(
  caller: TrustedPluginCaller,
  resolver: ProjectArtifactCapabilityProviderOptions['resolveProject'],
): PluginProjectIdentity {
  const project = resolver(caller.sessionId)
  if (!project || !isAbsolute(project.projectRoot)) throw new Error('PLUGIN_PROJECT_UNAVAILABLE')
  if (caller.projectId !== null && caller.projectId !== project.workspaceId) throw new Error('PLUGIN_PROJECT_MISMATCH')
  /** 项目根先取真实路径，后续所有相对路径只在该 canonical root 下解析。 */
  const canonicalRoot = realpathSync(project.projectRoot)
  if (!isAbsolute(canonicalRoot)) throw new Error('PLUGIN_PROJECT_UNAVAILABLE')
  return { workspaceId: project.workspaceId, projectRoot: canonicalRoot }
}

/**
 * 逐级创建并复核目录，拒绝任何已存在的符号链接或普通文件占位。
 * @param root 宿主可信项目根。
 * @param parts 已经由调用方限定语义的目录片段。
 * @param create 缺失目录是否允许创建。
 * @returns 完整目录；只读模式下缺失时返回 null。
 */
function safeDirectory(root: string, parts: readonly string[], create: boolean): string | null {
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      const state = lstatSync(current)
      if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('PLUGIN_PROJECT_DIRECTORY_UNSAFE')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return null
      ensureDirectoryDurable(current)
    }
  }
  return current
}

/** 校验插件身份后返回该插件独占的项目产物目录。 */
function artifactDirectory(caller: TrustedPluginCaller, projectRoot: string, create: boolean): string | null {
  if (!PLUGIN_ID_PATTERN.test(caller.pluginId)) throw new Error('PLUGIN_ID_INVALID')
  return safeDirectory(projectRoot, ['.dutydeck', 'plugin-artifacts', caller.pluginId], create)
}

/** 从绝对目录和插件产物身份构造固定 JSON 路径。 */
function artifactPath(directory: string, artifactId: string): string {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new Error('PLUGIN_ARTIFACT_ID_INVALID')
  return join(directory, `${artifactId}.json`)
}

/** 严格判断磁盘产物属于当前插件、项目和 artifact。 */
function isStoredProjectArtifact(
  value: unknown,
  caller: TrustedPluginCaller,
  project: PluginProjectIdentity,
  artifactId: string,
  schemaVersion: number,
): value is StoredProjectArtifact {
  if (!isRecord(value)) return false
  return value.schemaVersion === schemaVersion
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 1
    && value.pluginId === caller.pluginId
    && value.artifactId === artifactId
    && value.workspaceId === project.workspaceId
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && Object.hasOwn(value, 'value')
}

/** 解析 artifact.read 的严格输入。 */
function readArtifactInput(value: unknown): { artifactId: string; schemaVersion: number } {
  if (!isRecord(value)) throw new Error('PLUGIN_ARTIFACT_INPUT_INVALID')
  assertExactKeys(value, ['artifactId', 'schemaVersion'])
  if (typeof value.artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(value.artifactId)
    || !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) {
    throw new Error('PLUGIN_ARTIFACT_INPUT_INVALID')
  }
  return { artifactId: value.artifactId, schemaVersion: Number(value.schemaVersion) }
}

/** 解析 artifact.write 的严格输入，更新必须显式携带旧 revision。 */
function writeArtifactInput(value: unknown): {
  artifactId: string
  schemaVersion: number
  expectedRevision?: number
  value: unknown
} {
  if (!isRecord(value)) throw new Error('PLUGIN_ARTIFACT_INPUT_INVALID')
  assertExactKeys(value, ['artifactId', 'schemaVersion', 'expectedRevision', 'value'])
  if (typeof value.artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(value.artifactId)
    || !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1
    || !Object.hasOwn(value, 'value')
    || (value.expectedRevision !== undefined
      && (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0))) {
    throw new Error('PLUGIN_ARTIFACT_INPUT_INVALID')
  }
  return {
    artifactId: value.artifactId,
    schemaVersion: Number(value.schemaVersion),
    value: value.value,
    ...(value.expectedRevision === undefined ? {} : { expectedRevision: Number(value.expectedRevision) }),
  }
}

/** 解析显式 schema 迁移输入，禁止省略旧版本或旧 revision。 */
function migrateArtifactInput(value: unknown): ProjectArtifactMigrationInput {
  if (!isRecord(value)) throw new Error('PLUGIN_ARTIFACT_INPUT_INVALID')
  assertExactKeys(value, ['artifactId', 'fromSchemaVersion', 'toSchemaVersion', 'expectedRevision', 'value'])
  if (typeof value.artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(value.artifactId)
    || !Number.isSafeInteger(value.fromSchemaVersion) || Number(value.fromSchemaVersion) < 1
    || !Number.isSafeInteger(value.toSchemaVersion) || Number(value.toSchemaVersion) < 1
    || value.fromSchemaVersion === value.toSchemaVersion
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1
    || !Object.hasOwn(value, 'value')) {
    throw new Error('PLUGIN_ARTIFACT_MIGRATION_INPUT_INVALID')
  }
  return {
    artifactId: value.artifactId,
    fromSchemaVersion: Number(value.fromSchemaVersion),
    toSchemaVersion: Number(value.toSchemaVersion),
    expectedRevision: Number(value.expectedRevision),
    value: value.value,
  }
}

/** 读取 artifact 当前值；文件缺失返回 null，损坏则明确失败。 */
function readArtifact(
  caller: TrustedPluginCaller,
  project: PluginProjectIdentity,
  artifactId: string,
  schemaVersion: number,
  maxBytes: number,
): ProjectArtifactReadResult | null {
  const directory = artifactDirectory(caller, project.projectRoot, false)
  if (!directory) return null
  const path = artifactPath(directory, artifactId)
  const stored = readJsonFileSafe(path, {
    validate: (value): value is StoredProjectArtifact => isStoredProjectArtifact(value, caller, project, artifactId, schemaVersion),
    maxBytes,
    secureRecovery: true,
  })
  if (!stored) return null
  return {
    schemaVersion: stored.schemaVersion,
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    value: stored.value,
  }
}

/** 通过同目录文件锁串行化单个 artifact 的读取与 CAS 提交。 */
function withArtifactLock<T>(directory: string, artifactId: string, effect: () => T): T {
  const release = acquireMediaFileLock(join(directory, `.${artifactId}.lock`))
  try {
    return effect()
  } finally {
    release()
  }
}

/** 读取项目内一个 UTF-8 普通文件，所有父路径必须保持真实目录。 */
function readProjectSource(projectRoot: string, relativePath: string, maxBytes: number): ProjectSourceReadResult {
  const normalized = relativePath.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (!normalized || isAbsolute(normalized)
    || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0') || part.includes(':'))) {
    throw new Error('PLUGIN_PROJECT_SOURCE_PATH_INVALID')
  }
  if (parts.some(part => EXCLUDED_SOURCE.test(part))) throw new Error('PLUGIN_PROJECT_SOURCE_FORBIDDEN')
  let current = projectRoot
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    const state = lstatSync(current)
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('PLUGIN_PROJECT_SOURCE_UNSAFE')
  }
  const path = resolve(projectRoot, ...parts)
  if (!path.startsWith(`${projectRoot}${sep}`)) throw new Error('PLUGIN_PROJECT_SOURCE_PATH_INVALID')
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error('PLUGIN_PROJECT_SOURCE_UNSAFE')
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(descriptor)
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('PLUGIN_PROJECT_SOURCE_CHANGED')
    const bytes = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(descriptor)
    if (length > maxBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('PLUGIN_PROJECT_SOURCE_CHANGED')
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    if (content.includes('\0') || containsKnowledgeSecret(content)) throw new Error('PLUGIN_PROJECT_SOURCE_FORBIDDEN')
    return {
      path: parts.join('/'),
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      byteSize: length,
    }
  } finally {
    closeSync(descriptor)
  }
}

/**
 * 构造通用项目产物与只读源码能力。
 * 所有路径、项目身份和写入目录均由宿主根据会话解析。
 */
export function createProjectArtifactCapabilityProviders(
  options: ProjectArtifactCapabilityProviderOptions,
): ReadonlyMap<PluginCapabilityId, HostCapabilityProvider['invoke']> {
  const maxArtifactBytes = Math.min(8 * 1024 * 1024, Math.max(1024, options.maxArtifactBytes ?? 4 * 1024 * 1024))
  const maxSourceBytes = Math.min(4 * 1024 * 1024, Math.max(1024, options.maxSourceBytes ?? 1024 * 1024))
  return new Map<PluginCapabilityId, HostCapabilityProvider['invoke']>([
    ['artifact.read', async ({ caller, request }) => {
      const input = readArtifactInput(request)
      const project = resolveCallerProject(caller, options.resolveProject)
      return readArtifact(caller, project, input.artifactId, input.schemaVersion, maxArtifactBytes)
    }],
    ['artifact.write', async ({ caller, request }) => {
      const input = writeArtifactInput(request)
      const project = resolveCallerProject(caller, options.resolveProject)
      const directory = artifactDirectory(caller, project.projectRoot, true)
      if (!directory) throw new Error('PLUGIN_ARTIFACT_DIRECTORY_UNAVAILABLE')
      const path = artifactPath(directory, input.artifactId)
      return withArtifactLock(directory, input.artifactId, (): ProjectArtifactWriteResult => {
        const state = readAtomicFileState(path)
        const current = readArtifact(caller, project, input.artifactId, input.schemaVersion, maxArtifactBytes)
        if (state === null && input.expectedRevision !== undefined && input.expectedRevision !== 0) {
          throw new Error('PLUGIN_ARTIFACT_REVISION_CONFLICT')
        }
        if (state !== null && (input.expectedRevision === undefined || input.expectedRevision !== current?.revision)) {
          throw new Error('PLUGIN_ARTIFACT_REVISION_CONFLICT')
        }
        const revision = (current?.revision ?? 0) + 1
        const updatedAt = Date.now()
        writeJsonFileAtomicSecure(path, {
          schemaVersion: input.schemaVersion,
          revision,
          pluginId: caller.pluginId,
          artifactId: input.artifactId,
          workspaceId: project.workspaceId,
          updatedAt,
          value: input.value,
        } satisfies StoredProjectArtifact, {
          expectedDestination: state ? { kind: 'state', state } : { kind: 'missing' },
        })
        return { revision, updatedAt }
      })
    }],
    ['artifact.migrate', async ({ caller, request }) => {
      const input = migrateArtifactInput(request)
      const project = resolveCallerProject(caller, options.resolveProject)
      const directory = artifactDirectory(caller, project.projectRoot, false)
      if (!directory) throw new Error('PLUGIN_ARTIFACT_NOT_FOUND')
      const path = artifactPath(directory, input.artifactId)
      return withArtifactLock(directory, input.artifactId, (): ProjectArtifactWriteResult => {
        const state = readAtomicFileState(path)
        const current = readArtifact(
          caller,
          project,
          input.artifactId,
          input.fromSchemaVersion,
          maxArtifactBytes,
        )
        if (!state || !current || current.revision !== input.expectedRevision) {
          throw new Error('PLUGIN_ARTIFACT_REVISION_CONFLICT')
        }
        const revision = current.revision + 1
        const updatedAt = Date.now()
        writeJsonFileAtomicSecure(path, {
          schemaVersion: input.toSchemaVersion,
          revision,
          pluginId: caller.pluginId,
          artifactId: input.artifactId,
          workspaceId: project.workspaceId,
          updatedAt,
          value: input.value,
        } satisfies StoredProjectArtifact, {
          expectedDestination: { kind: 'state', state },
        })
        return { revision, updatedAt }
      })
    }],
    ['project.files.read', async ({ caller, request }) => {
      if (!isRecord(request)) throw new Error('PLUGIN_PROJECT_SOURCE_INPUT_INVALID')
      assertExactKeys(request, ['path', 'maxBytes'])
      if (typeof request.path !== 'string'
        || !Number.isSafeInteger(request.maxBytes)
        || Number(request.maxBytes) < 1
        || Number(request.maxBytes) > maxSourceBytes) {
        throw new Error('PLUGIN_PROJECT_SOURCE_INPUT_INVALID')
      }
      const project = resolveCallerProject(caller, options.resolveProject)
      return readProjectSource(project.projectRoot, request.path, Number(request.maxBytes))
    }],
  ])
}
