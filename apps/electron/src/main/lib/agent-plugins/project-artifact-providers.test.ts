import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    assertCurrent: () => undefined,
    ...overrides,
  }
}

describe('Given 宿主项目产物能力', () => {
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
