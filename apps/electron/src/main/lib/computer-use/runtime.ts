import { join } from 'node:path'
import type { ComputerUseConfig } from '@dutydeck/shared'
import { getConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { ComputerUseService } from './service'

/** 电脑控制配置只接受明确启用和字符串路径。 */
function validConfig(value: unknown): value is ComputerUseConfig {
  if (!value || typeof value !== 'object') return false
  return 'enabled' in value && typeof value.enabled === 'boolean' && (!('driverPath' in value) || typeof value.driverPath === 'string')
}
/** 延迟至已完成数据根初始化后的首次调用，避免 import 触碰用户配置。 */
let instance: ComputerUseService | undefined
/** 退出时不惰性创建服务；已存在时等待安装任务和桌面调用清理。 */
export function shutdownComputerUse(): Promise<void> | null { return instance?.shutdown() ?? null }
/** 返回主进程唯一服务；仅此函数读取中央数据根。 */
function getService(): ComputerUseService {
  instance ??= new ComputerUseService({
    loadConfig: () => readJsonFileSafe<ComputerUseConfig>(join(getConfigDir(), 'computer-use.json'), { validate: validConfig, maxBytes: 8192 }) ?? { enabled: false },
    saveConfig: config => writeJsonFileAtomic(join(getConfigDir(), 'computer-use.json'), config),
  })
  return instance
}
/** 惰性宿主门面，导入模块不会读取数据根或启动驱动。 */
export const computerUseService = {
  getSnapshot: () => getService().getSnapshot(),
  checkInstallation: () => getService().checkInstallation(),
  /** 用户设置页专用，Agent 工具无安装入口。 */
  installDriver: () => getService().installDriver(),
  checkPermissions: () => getService().checkPermissions(),
  setEnabled: (enabled: boolean) => getService().setEnabled(enabled),
  setDriverPath: (path: string) => getService().setDriverPath(path),
  stop: (operationId: string) => getService().stop(operationId),
  subscribe: (listener: Parameters<ComputerUseService['subscribe']>[0]) => getService().subscribe(listener),
  createRun: (context: Parameters<ComputerUseService['createRun']>[0]) => getService().createRun(context),
}
