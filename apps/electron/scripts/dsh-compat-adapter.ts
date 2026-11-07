import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/** 只构建本仓自主适配器；候选源码绝不进入此默认文件解析器。 */
export async function buildDshPilotAdapter(): Promise<Uint8Array> {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const result = await build({ absWorkingDir: root, entryPoints: ['apps/electron/src/main/lib/agent-plugins/dsh-compat/supported-contract.ts'], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent' })
  if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output => output.imports.length)) throw new Error('DSH_BUILD_ADAPTER_CHANGED')
  return result.outputFiles[0]!.contents
}
