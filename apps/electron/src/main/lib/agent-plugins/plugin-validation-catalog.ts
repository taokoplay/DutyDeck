import type { ModuleRuntimePluginPreviewView, PluginValidationEnvironment, PluginValidationRecord } from '@dutydeck/shared'
import { assessPluginValidation } from './plugin-validation'
import application from '../../../../package.json'
import { getCurrentHostBuildIdentity } from '../host-build-runtime'
import records from './validation/dsh-pilots.json'

/** 仅宿主随版本发布的审查记录；不接受 renderer / 目录 / 插件包上传记录。 */
export function getHostPluginValidationRecords(): PluginValidationRecord[] {
  return structuredClone(records) as PluginValidationRecord[]
}

/** 同步环境只供保守诊断，不能证明构建身份。未知 Electron 必须不匹配。 */
export function getPluginValidationEnvironment(): PluginValidationEnvironment {
  return {
    hostVersion: application.version, platform: process.platform, arch: process.arch,
    electron: process.versions.electron ?? 'unknown', adapterVersion: '0.1.0',
    adapterSha256: 'c9721dd5410f246c4cb68f197fa45c54b24737081a3748ab663e25a08e43ad37',
  }
}

/** 有效构建身份必须异步重读当前材料；同步诊断只返回未验证环境，绝不沿用缓存成功值。 */
export async function readPluginValidationEnvironment(): Promise<PluginValidationEnvironment> {
  const build = await getCurrentHostBuildIdentity()
  return { ...getPluginValidationEnvironment(), ...(build.hostBuildSha256 ? { hostBuildSha256: build.hostBuildSha256 } : {}) }
}

/** 只更新展示证据，不改变服务缓存token、签名、授权或安装基线。 */
export async function validatePluginPreview<T extends ModuleRuntimePluginPreviewView>(preview: T): Promise<T> {
  const environment = await readPluginValidationEnvironment()
  return { ...preview, validation: assessPluginValidation({ pluginId: preview.manifest.id, pluginVersion: preview.manifest.version, packageHash: preview.packageHash }, environment, getHostPluginValidationRecords()) }
}
