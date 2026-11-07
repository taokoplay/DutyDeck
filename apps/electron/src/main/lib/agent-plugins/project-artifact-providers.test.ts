import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityBroker, type TrustedPluginCaller } from './capability-broker'
import { createProjectArtifactCapabilityProviders } from './project-artifact-providers'

/** 构造固定会话、项目和插件的可信调用者，测试不能绕过宿主身份。 */
function caller(overrides: Partial<TrustedPluginCaller> = {}): TrustedPluginCaller {
  return {
    pluginId: 'dutydeck.interaction-design-pilot',
    pluginVersion: '1.0.0',
    packageHash: 'a'.repeat(64),
    moduleId: 'dutydeck.interaction-design-pilot.workspace',
    sessionId: 'session-1',
    projectId: 'workspace-1',
    runId: 'run-1',
    invocationId: 'invoke-1',
    grants: ['artifact.read', 'artifact.write', 'artifact.migrate', 'project.files.read'],
    signal: new AbortController().signal, assertCurrent: () => undefined,
    ...overrides,
  }
}

describe('Given 宿主项目产物能力', () => {
  test('When 迁移备份提交后授权失效 Then 保留快照和旧主文件，重试可复用同一快照', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-artifact-migration-failure-'))
    try {
      const broker = new CapabilityBroker({ providers: createProjectArtifactCapabilityProviders({ resolveProject: () => ({ workspaceId: 'workspace-1', projectRoot: root }) }) })
      const path = join(root, '.dutydeck/plugin-artifacts/dutydeck.interaction-design-pilot/workspace.json')
      const backup = `${path}.schema-1-revision-1.bak`
      await broker.invoke(caller(), { capability: 'artifact.write', input: { artifactId: 'workspace', schemaVersion: 1, value: 'before' } })
      const before = readFileSync(path, 'utf8')
      const migration = { capability: 'artifact.migrate' as const, input: { artifactId: 'workspace', fromSchemaVersion: 1, toSchemaVersion: 2, expectedRevision: 1, value: 'after' } }
      await expect(broker.invoke(caller({ assertCurrent: () => { if (existsSync(backup)) throw new Error('PLUGIN_CAPABILITY_STALE') } }), migration)).rejects.toThrow('PLUGIN_CAPABILITY_STALE')
      const snapshot = readFileSync(backup, 'utf8')
      expect(JSON.parse(snapshot)).toEqual(JSON.parse(before))
      expect(readFileSync(path, 'utf8')).toBe(before)
      await expect(broker.invoke(caller(), migration)).resolves.toMatchObject({ revision: 2 })
      expect(readFileSync(backup, 'utf8')).toBe(snapshot)
      await broker.invoke(caller(), { capability: 'artifact.write', input: { artifactId: 'workspace', schemaVersion: 2, expectedRevision: 2, value: 'later' } })
      expect(readFileSync(backup, 'utf8')).toBe(snapshot)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('When 旧插件读取新schema且存在旧备份 Then 明确不匹配且不修改主文件/备份', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-artifact-schema-'))
    try {
      const broker = new CapabilityBroker({ providers: createProjectArtifactCapabilityProviders({ resolveProject: () => ({ workspaceId: 'workspace-1', projectRoot: root }) }) })
      const path = join(root, '.dutydeck/plugin-artifacts/dutydeck.interaction-design-pilot/workspace.json')
      await broker.invoke(caller(), { capability: 'artifact.write', input: { artifactId: 'workspace', schemaVersion: 1, value: 'old' } })
      const old = readFileSync(path, 'utf8')
      await broker.invoke(caller(), { capability: 'artifact.migrate', input: { artifactId: 'workspace', fromSchemaVersion: 1, toSchemaVersion: 2, expectedRevision: 1, value: 'new' } })
      const current = readFileSync(path, 'utf8')
      // 迁移备份与普通恢复候选分离，后续写入不能覆盖迁移前快照。
      expect(JSON.parse(readFileSync(`${path}.schema-1-revision-1.bak`, 'utf8'))).toMatchObject({ schemaVersion: 1, value: 'old', revision: 1 })
      writeFileSync(`${path}.bak`, old)
      await expect(broker.invoke(caller(), { capability: 'artifact.read', input: { artifactId: 'workspace', schemaVersion: 1 } })).rejects.toThrow('PLUGIN_ARTIFACT_SCHEMA_MISMATCH')
      expect(readFileSync(path, 'utf8')).toBe(current)
      expect(readFileSync(`${path}.bak`, 'utf8')).toBe(old)
      await expect(broker.invoke(caller(), { capability: 'artifact.read', input: { artifactId: 'workspace', schemaVersion: 2 } })).resolves.toMatchObject({ value: 'new', revision: 2 })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('When 未提供逆向迁移合同却要求schema降级 Then 拒绝且保留原始数据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-artifact-downgrade-'))
    try {
      const broker = new CapabilityBroker({ providers: createProjectArtifactCapabilityProviders({ resolveProject: () => ({ workspaceId: 'workspace-1', projectRoot: root }) }) })
      await broker.invoke(caller(), { capability: 'artifact.write', input: { artifactId: 'workspace', schemaVersion: 2, value: 'current' } })
      const path = join(root, '.dutydeck/plugin-artifacts/dutydeck.interaction-design-pilot/workspace.json')
      const before = readFileSync(path, 'utf8')
      await expect(broker.invoke(caller(), { capability: 'artifact.migrate', input: { artifactId: 'workspace', fromSchemaVersion: 2, toSchemaVersion: 1, expectedRevision: 1, value: 'lost' } })).rejects.toThrow('PLUGIN_ARTIFACT_DOWNGRADE_UNSUPPORTED')
      expect(readFileSync(path, 'utf8')).toBe(before)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('When 插件首次写入 Then 创建项目内隔离产物并返回 revision 1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-artifact-'))
    try {
      const broker = new CapabilityBroker({
        providers: createProjectArtifactCapabilityProviders({
          resolveProject: sessionId => sessionId === 'session-1' ? { workspaceId: 'workspace-1', projectRoot: root } : undefined,
        }),
      })
      await expect(broker.invoke(caller(), {
        capability: 'artifact.write',
        input: {
          artifactId: 'workspace',
          schemaVersion: 1,
          value: { name: '登录流程' },
        },
      })).resolves.toMatchObject({ revision: 1 })
      await expect(broker.invoke(caller(), {
        capability: 'artifact.read',
        input: { artifactId: 'workspace', schemaVersion: 1 },
      })).resolves.toMatchObject({
        schemaVersion: 1,
        revision: 1,
        value: { name: '登录流程' },
      })
      expect(readFileSync(
        join(root, '.dutydeck/plugin-artifacts/dutydeck.interaction-design-pilot/workspace.json'),
        'utf8',
      )).toContain('登录流程')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('When expectedRevision 过期 Then 拒绝覆盖新版本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-artifact-'))
    try {
      const broker = new CapabilityBroker({
        providers: createProjectArtifactCapabilityProviders({
          resolveProject: () => ({ workspaceId: 'workspace-1', projectRoot: root }),
        }),
      })
      await broker.invoke(caller(), {
        capability: 'artifact.write',
        input: { artifactId: 'workspace', schemaVersion: 1, value: { revision: 1 } },
      })
      await broker.invoke(caller(), {
        capability: 'artifact.write',
        input: { artifactId: 'workspace', schemaVersion: 1, value: { revision: 2 }, expectedRevision: 1 },
      })
      await expect(broker.invoke(caller(), {
        capability: 'artifact.write',
        input: { artifactId: 'workspace', schemaVersion: 1, value: { revision: 3 }, expectedRevision: 1 },
      })).rejects.toThrow('PLUGIN_ARTIFACT_REVISION_CONFLICT')
      await expect(broker.invoke(caller(), {
        capability: 'artifact.read',
        input: { artifactId: 'workspace', schemaVersion: 1 },
      })).resolves.toMatchObject({ revision: 2, value: { revision: 2 } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('When 另一个插件读取同名 artifact Then 看不到当前插件数据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-artifact-'))
    try {
      const broker = new CapabilityBroker({
        providers: createProjectArtifactCapabilityProviders({
          resolveProject: () => ({ workspaceId: 'workspace-1', projectRoot: root }),
        }),
      })
      await broker.invoke(caller(), {
        capability: 'artifact.write',
        input: { artifactId: 'workspace', schemaVersion: 1, value: { private: true } },
      })
      await expect(broker.invoke(caller({
        pluginId: 'vendor.other',
        moduleId: 'vendor.other.workspace',
      }), {
        capability: 'artifact.read',
        input: { artifactId: 'workspace', schemaVersion: 1 },
      })).resolves.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('When 插件按旧 schema 和 revision 迁移 Then 仅推进目标 schema 的新 revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-artifact-'))
    try {
      const broker = new CapabilityBroker({
        providers: createProjectArtifactCapabilityProviders({
          resolveProject: () => ({ workspaceId: 'workspace-1', projectRoot: root }),
        }),
      })
      await broker.invoke(caller(), {
        capability: 'artifact.write',
        input: { artifactId: 'workspace', schemaVersion: 1, value: { legacy: true } },
      })
      await expect(broker.invoke(caller(), {
        capability: 'artifact.migrate',
        input: {
          artifactId: 'workspace',
          fromSchemaVersion: 1,
          toSchemaVersion: 2,
          expectedRevision: 1,
          value: { migrated: true },
        },
      })).resolves.toMatchObject({ revision: 2 })
      await expect(broker.invoke(caller(), {
        capability: 'artifact.read',
        input: { artifactId: 'workspace', schemaVersion: 2 },
      })).resolves.toMatchObject({
        schemaVersion: 2,
        revision: 2,
        value: { migrated: true },
      })
      await expect(broker.invoke(caller(), {
        capability: 'artifact.migrate',
        input: {
          artifactId: 'workspace',
          fromSchemaVersion: 1,
          toSchemaVersion: 3,
          expectedRevision: 1,
          value: { stale: true },
        },
      })).rejects.toThrow('PLUGIN_ARTIFACT_REVISION_CONFLICT')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('When 插件读取项目源码 Then 返回有界 UTF-8 正文和内容 hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-artifact-'))
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src/App.tsx'), 'export function App() { return <main /> }\n')
      const broker = new CapabilityBroker({
        providers: createProjectArtifactCapabilityProviders({
          resolveProject: () => ({ workspaceId: 'workspace-1', projectRoot: root }),
        }),
      })
      await expect(broker.invoke(caller(), {
        capability: 'project.files.read',
        input: { path: 'src/App.tsx', maxBytes: 4096 },
      })).resolves.toMatchObject({
        path: 'src/App.tsx',
        content: 'export function App() { return <main /> }\n',
        byteSize: 42,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('When 项目源码路径越界或命中敏感目录 Then 拒绝读取', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-artifact-'))
    try {
      mkdirSync(join(root, '.git'))
      writeFileSync(join(root, '.git/config'), 'sensitive')
      const broker = new CapabilityBroker({
        providers: createProjectArtifactCapabilityProviders({
          resolveProject: () => ({ workspaceId: 'workspace-1', projectRoot: root }),
        }),
      })
      for (const path of ['../outside.ts', '/etc/passwd', '.git/config', 'src/..//secret.ts']) {
        await expect(broker.invoke(caller(), {
          capability: 'project.files.read',
          input: { path, maxBytes: 4096 },
        })).rejects.toThrow(/PLUGIN_PROJECT_SOURCE_(?:PATH_INVALID|FORBIDDEN)/)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Given 写入前授权再次复核', () => {
  for (const capability of ['artifact.write', 'artifact.migrate'] as const) {
    test(`When ${capability} 解析项目期间租约撤销 Then 不提交文件`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-revoke-'))
      try {
        let valid = true
        let revoke = false
        const broker = new CapabilityBroker({ providers: createProjectArtifactCapabilityProviders({
          resolveProject: () => {
            if (revoke) valid = false
            return { workspaceId: 'workspace-1', projectRoot: root }
          },
        }) })
        await broker.invoke(caller(), { capability: 'artifact.write', input: { artifactId: 'workspace', schemaVersion: 1, value: 'before' } })
        const path = join(root, '.dutydeck/plugin-artifacts/dutydeck.interaction-design-pilot/workspace.json')
        const before = readFileSync(path, 'utf8')
        revoke = true
        await expect(broker.invoke(caller({ assertCurrent: () => { if (!valid) throw new Error('PLUGIN_CAPABILITY_STALE') } }), {
          capability,
          input: capability === 'artifact.write'
            ? { artifactId: 'workspace', schemaVersion: 1, expectedRevision: 1, value: 'after' }
            : { artifactId: 'workspace', fromSchemaVersion: 1, toSchemaVersion: 2, expectedRevision: 1, value: 'after' },
        })).rejects.toThrow('PLUGIN_CAPABILITY_STALE')
        expect(readFileSync(path, 'utf8')).toBe(before)
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }
})
