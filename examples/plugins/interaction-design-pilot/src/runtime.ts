import { randomUUID } from 'node:crypto'
import { definePlugin, type PluginCapabilityClient } from '@dutydeck/plugin-sdk'
import type { PrototypeClock } from './domain'
import { createInteractionDesignPilotService } from './runtime-service'

/** 生产时钟只提供当前时间和稳定候选 ID。 */
const clock: PrototypeClock = {
  now: () => Date.now(),
  id: () => randomUUID(),
}

/**
 * 为单次 Agent 工具或 Surface 调用绑定 capability 客户端。
 * @param capabilities runtime 注入的当前 invocation 能力。
 */
function serviceFor(capabilities: PluginCapabilityClient) {
  return createInteractionDesignPilotService(capabilities, clock)
}

/** V3 交互设计试点插件；业务状态保存在宿主项目 artifact 中。 */
export default definePlugin({
  activate(context) {
    context.tools.handle('list', (_input, call) => serviceFor(call.capabilities).list())
    context.tools.handle('read', (_input, call) => serviceFor(call.capabilities).read())
    context.tools.handle('create', (input, call) => serviceFor(call.capabilities).create(input))
    context.tools.handle('propose', (input, call) => serviceFor(call.capabilities).propose(input))
    context.tools.handle('adopt', (input, call) => serviceFor(call.capabilities).adopt(input))
    context.tools.handle('read-source', (input, call) => serviceFor(call.capabilities).readSource(input))

    /** Surface 与 Agent 工具共享同一业务服务，避免两套状态语义。 */
    context.surfaces.handle('workspace', 'load', async (_input, call) => {
      const service = serviceFor(call.capabilities)
      const list = await service.list()
      const current = list.prototype ? await service.read() : null
      return { list, current }
    })
    context.surfaces.handle('workspace', 'list', (_input, call) => serviceFor(call.capabilities).list())
    context.surfaces.handle('workspace', 'read', (_input, call) => serviceFor(call.capabilities).read())
    context.surfaces.handle('workspace', 'create', (input, call) => serviceFor(call.capabilities).create(input))
    context.surfaces.handle('workspace', 'propose', (input, call) => serviceFor(call.capabilities).propose(input))
    context.surfaces.handle('workspace', 'adopt', (input, call) => serviceFor(call.capabilities).adopt(input))
    context.surfaces.handle('workspace', 'readSource', (input, call) => serviceFor(call.capabilities).readSource(input))
  },

  deactivate() {
    // 试点插件不持有计时器或后台订阅，artifact 写入由单次调用完成。
  },
})
