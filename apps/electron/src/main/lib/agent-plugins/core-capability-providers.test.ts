import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityBroker, type TrustedPluginCaller } from './capability-broker'
import { createCoreCapabilityProviders } from './core-capability-providers'
import { PluginStateStore } from './plugin-state-store'

describe('Given core plugin capabilities', () => {
  test('When 已授权 session.read Then 返回当前会话摘要', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-core-cap-'))
    try {
      const broker = new CapabilityBroker({
        providers: createCoreCapabilityProviders({
          state: new PluginStateStore(root),
          getSession: id => ({ id, workspaceId: 'workspace-1', archived: false }),
        }),
      })
      const caller: TrustedPluginCaller = {
        pluginId: 'acme.echo', pluginVersion: '1.0.0', packageHash: 'a'.repeat(64),
        moduleId: 'acme.echo.assistant', sessionId: 'session-1', projectId: 'workspace-1',
        runId: 'run-1', invocationId: 'invoke-1', grants: ['session.read'], assertCurrent: () => undefined,
      }
      await expect(broker.invoke(caller, { capability: 'session.read', input: {} })).resolves.toEqual({
        id: 'session-1',
        workspaceId: 'workspace-1',
        archived: false,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('When 插件读写自己的状态 Then provider 使用宿主 caller 身份', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-core-cap-'))
    try {
      const broker = new CapabilityBroker({
        providers: createCoreCapabilityProviders({
          state: new PluginStateStore(root),
          getSession: id => ({ id, workspaceId: undefined, archived: false }),
        }),
      })
      const caller: TrustedPluginCaller = {
        pluginId: 'acme.echo', pluginVersion: '1.0.0', packageHash: 'a'.repeat(64),
        moduleId: 'acme.echo.assistant', sessionId: 'session-1', projectId: null,
        runId: 'run-1', invocationId: 'plugin-instance',
        grants: ['plugin.state.read', 'plugin.state.write'], assertCurrent: () => undefined,
      }
      await broker.invoke(caller, {
        capability: 'plugin.state.write',
        input: { key: 'settings', schemaVersion: 1, value: { enabled: true } },
      })
      await expect(broker.invoke(caller, {
        capability: 'plugin.state.read',
        input: { key: 'settings', schemaVersion: 1 },
      })).resolves.toEqual({ schemaVersion: 1, revision: 1, value: { enabled: true } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
