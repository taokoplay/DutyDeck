import { join, resolve } from 'node:path'
import { HostBuildIdentitySession, type HostBuildMaterial, type HostBuildStatus } from './host-build-identity'

export interface HostBuildExecutionTarget {
  packaged: boolean
  appPath: string
  resourcesPath: string
  entryFile: string
}

/** 只接受真实 packaged main 布局；开发/Vite/watch 与单独编译的验收 child 不可借用相邻产物身份。 */
export function createHostBuildProvider(target: HostBuildExecutionTarget, capture: () => HostBuildMaterial | Promise<HostBuildMaterial>): () => Promise<HostBuildStatus> {
  if (!target.packaged) return async () => ({ status: 'unavailable', reason: 'HOST_BUILD_MUTABLE_DEVELOPMENT' })
  if (resolve(target.appPath) !== resolve(target.resourcesPath, 'app.asar')
    || resolve(target.entryFile) !== resolve(join(target.appPath, 'dist/main.cjs'))) {
    return async () => ({ status: 'unavailable', reason: 'HOST_BUILD_EXECUTION_TARGET_UNVERIFIED' })
  }
  const session = new HostBuildIdentitySession(capture)
  return () => session.current()
}

let provider: (() => Promise<HostBuildStatus>) | undefined
/** 仅主进程组合根在启动时调用一次，不支持renderer、插件、环境变量或cwd覆盖。 */
export function initializeHostBuildIdentity(target: HostBuildExecutionTarget, capture: () => HostBuildMaterial | Promise<HostBuildMaterial>): void {
  if (provider) throw new Error('HOST_BUILD_ALREADY_INITIALIZED')
  provider = createHostBuildProvider(target, capture)
}

export async function getCurrentHostBuildIdentity(): Promise<HostBuildStatus> {
  return await provider?.() ?? { status: 'unavailable', reason: 'HOST_BUILD_NOT_INITIALIZED' }
}
