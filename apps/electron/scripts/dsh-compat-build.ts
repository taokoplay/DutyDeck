import { hashPluginBytes } from '../../../packages/plugin-kit/src/package'
import { buildDshToolPackage, type DshBundleCompiler } from '../../../packages/plugin-kit/src/dsh-compat/build'
import type { DshBuildRecipe } from '../../../packages/plugin-kit/src/dsh-compat/recipe'
import { readNpmTarball } from '../src/main/lib/agent-plugins/catalog/npm-package-analysis'
import { verifyDshToolClosure } from '../src/main/lib/agent-plugins/dsh-compat/dependency-check'

/**
 * 开发侧归档准入：真实归档hash → 有界内存解包 → 精确依赖/文件检查 → 同快照构建。
 * 配方必须由宿主开发侧审查登记；不提供renderer/市场入口，不签名、安装或信任。
 * 底层plugin-kit仅负责固定图打包，不代替这里的归档与依赖准入。
 */
export async function buildDshArchive(recipe: DshBuildRecipe, archive: Uint8Array, adapter: Uint8Array, compile: DshBundleCompiler) {
  if (archive.byteLength > 16 * 1024 * 1024) throw new Error('DSH_BUILD_SOURCE_CHANGED')
  const serialized = JSON.stringify(recipe)
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error('DSH_BUILD_RECIPE_INVALID')
  const snapshot = JSON.parse(serialized) as DshBuildRecipe
  const bytes = Buffer.from(archive)
  const archiveHash = hashPluginBytes(bytes)
  if (archiveHash !== snapshot.source.archiveSha256) throw new Error('DSH_BUILD_SOURCE_CHANGED')
  const files = readNpmTarball(bytes)
  verifyDshToolClosure({
    name: snapshot.source.name, version: snapshot.source.version, packageHash: snapshot.source.archiveSha256,
    license: snapshot.source.license, entry: snapshot.entry, files: snapshot.source.files,
    runtimeFiles: Object.keys(snapshot.imports), dependencies: snapshot.dependencyDispositions,
  }, archiveHash, files)
  // 两个校验器消费同一私有字节；后续编译只得到已核验且再次复制的白名单图。
  return buildDshToolPackage(snapshot, archiveHash, files, new Uint8Array(adapter), compile)
}
