import { describe, expect, test } from 'bun:test'
import { SurfaceRegistry } from './surface-registry'

/** 注册一个最小 Surface 到测试注册表。 */
function createRegistry() {
  let id = 0
  const registry = new SurfaceRegistry({ uuid: () => `surface-${++id}` })
  registry.register({
    pluginId: 'acme.echo',
    pluginVersion: '1.0.0',
    packageHash: 'a'.repeat(64),
    packageRoot: '/private/tmp/acme.echo/1.0.0',
    epoch: 1,
    surfaces: [{
      id: 'workspace',
      ownerModuleId: 'acme.echo.assistant',
      title: 'Echo',
      entry: 'surfaces/workspace/index.html',
      apiVersion: 1,
      defaultPlacement: 'right-panel',
      methods: ['load'],
    }],
  })
  return registry
}

describe('Given plugin Surface registry', () => {
  test('When 打开已声明 Surface Then token 可解析入口并调用声明方法', () => {
    const registry = createRegistry()
    const opened = registry.open({
      surfaceId: 'workspace',
      moduleId: 'acme.echo.assistant',
      sessionId: 'session-1',
      projectId: 'project-1',
      readOnly: false,
    })
    expect(registry.authorize(opened.token, 'load')).toEqual(expect.objectContaining({
      pluginId: 'acme.echo',
      surfaceId: 'workspace',
      method: 'load',
    }))
    expect(registry.resolveEntry(opened.token)).toContain('/surfaces/workspace/index.html')
    expect(registry.openContext(opened.token)).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      readOnly: false,
    }))
  })

  test('When 未声明方法或旧 epoch Then 拒绝', () => {
    const registry = createRegistry()
    const opened = registry.open({
      surfaceId: 'workspace',
      moduleId: 'acme.echo.assistant',
      sessionId: 'session-1',
      projectId: null,
      readOnly: true,
    })
    expect(() => registry.authorize(opened.token, 'save')).toThrow('PLUGIN_SURFACE_METHOD_NOT_DECLARED')
    registry.rotateEpoch('acme.echo', 2)
    expect(() => registry.authorize(opened.token, 'load')).toThrow('PLUGIN_SURFACE_VERSION_CHANGED')
  })

  test('When 关闭 Surface Then token 立即失效', () => {
    const registry = createRegistry()
    const opened = registry.open({
      surfaceId: 'workspace', moduleId: 'acme.echo.assistant', sessionId: 'session-1', projectId: null, readOnly: true,
    })
    registry.close(opened.token)
    expect(() => registry.authorize(opened.token, 'load')).toThrow('PLUGIN_SURFACE_DISCONNECTED')
  })

  test('When 请求 Surface 子资源 Then 只解析 surfaces 目录', () => {
    const registry = createRegistry()
    const opened = registry.open({
      surfaceId: 'workspace', moduleId: 'acme.echo.assistant', sessionId: 'session-1', projectId: null, readOnly: true,
    })
    expect(registry.resolveResource(opened.token, 'surfaces/workspace/index.html'))
      .toContain('/surfaces/workspace/index.html')
    expect(() => registry.resolveResource(opened.token, 'runtime/main.mjs'))
      .toThrow('PLUGIN_SURFACE_RESOURCE_DENIED')
  })
})
