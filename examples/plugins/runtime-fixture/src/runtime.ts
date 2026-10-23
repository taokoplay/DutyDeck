import { buildEchoResult } from './echo'

/** V3 runtime 定义；示例故意不访问真实文件、网络或凭据。 */
export default {
  activate(context: {
    tools: { handle(id: string, handler: (input: { message: string }) => unknown): void }
    surfaces: { handle(surfaceId: string, method: string, handler: () => unknown): void }
    services: { handle(id: string, implementation: { start(): void; stop(): void }): void }
  }) {
    context.tools.handle('echo', input => buildEchoResult(input))
    context.surfaces.handle('workspace', 'loadContext', () => ({
      pluginId: 'acme.runtime-fixture',
      title: '运行底座示例',
    }))
    context.services.handle('lifecycle', {
      start() {},
      stop() {},
    })
  },
}
