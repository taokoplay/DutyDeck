import type { BuiltinAgentPluginAdapter } from '../agent-modules/builtin-plugin-adapters'
import { VISUAL_PRODUCTION_HOST_CAPABILITIES, VISUAL_PRODUCTION_PLUGIN_ID, VISUAL_PRODUCTION_SURFACE_ID, visualProductionModuleManifest } from '@dutydeck/shared'

/** 独立插件迁移时可注入的生命周期端口；业务服务仍由宿主提供。 */
export interface VisualProductionPluginLifecyclePorts {
  initialize?: () => void | Promise<void>
  shutdown?: () => void | Promise<void>
  dispose?: () => void | Promise<void>
}

/**
 * 构造影像模块的内置 Plugin Host 适配器。
 * 当前只验证稳定合同并预留生命周期；把目录迁出主程序时实现同一端口即可。
 * @param ports 宿主注入的初始化、停止和释放操作。
 * @returns 只通过宿主端口工作的插件生命周期。
 */
export function createVisualProductionBuiltinPluginAdapter(
  ports: VisualProductionPluginLifecyclePorts = {},
): BuiltinAgentPluginAdapter {
  return {
    start: async () => {
      assertVisualProductionPluginContract()
      await ports.initialize?.()
    },
    stop: async () => {
      await ports.shutdown?.()
    },
    dispose: async () => {
      await ports.dispose?.()
    },
  }
}

/**
 * 验证模块 ID、surface 和宿主能力声明没有漂移。
 * @returns 无返回值；合同无效时抛出稳定错误码。
 */
export function assertVisualProductionPluginContract(): void {
  const module = visualProductionModuleManifest()
  if (module.id !== 'visual-production' || module.surfaceIds.length !== 1 || module.surfaceIds[0] !== VISUAL_PRODUCTION_SURFACE_ID) {
    throw new Error('VISUAL_PRODUCTION_PLUGIN_CONTRACT_INVALID')
  }
  /** 后续可以追加宿主能力，但不得删掉影像模块已经依赖的必需能力。 */
  const requiredCapabilities = ['project-session', 'project-storage-lease', 'media-execution-context', 'video-export'] as const
  if (VISUAL_PRODUCTION_PLUGIN_ID !== 'builtin.visual-production'
    || requiredCapabilities.some(capability => !VISUAL_PRODUCTION_HOST_CAPABILITIES.includes(capability))) {
    throw new Error('VISUAL_PRODUCTION_PLUGIN_HOST_CONTRACT_INVALID')
  }
}
