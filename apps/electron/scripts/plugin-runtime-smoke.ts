import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildModuleRuntimePlugin } from '@dutydeck/plugin-kit'
import { build } from 'esbuild'

/** 运行真实 Electron runtime smoke，不打开窗口或访问用户数据。 */
async function main(): Promise<void> {
  const fixture = join(process.cwd(), '../../examples/plugins/runtime-fixture')
  const runtimeBundle = join(process.cwd(), 'dist/plugin-runtime.cjs')
  const temp = mkdtempSync(join(tmpdir(), 'dutydeck-plugin-runtime-smoke-'))
  copyFileSync(runtimeBundle, join(temp, 'plugin-runtime.cjs'))
  const dataRoot = join(temp, 'data')
  mkdirSync(dataRoot, { recursive: true })
  buildModuleRuntimePlugin(fixture)
  const childEntry = join(process.cwd(), 'scripts/plugin-runtime-smoke-child.ts')
  const childBundle = join(temp, 'child.cjs')
  await build({
    entryPoints: [childEntry],
    outfile: childBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent',
  })
  const packagePath = join(temp, 'runtime-fixture.ddplugin')
  const { createPluginPackage } = await import('@dutydeck/plugin-kit/package')
  const { collectPluginSource } = await import('@dutydeck/plugin-kit/filesystem')
  const packageBytes = createPluginPackage(collectPluginSource(fixture))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(packagePath, packageBytes)
  const electron = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules', '.bin', 'electron')
  const child = spawn(electron, [childBundle, packagePath, dataRoot], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: 'inherit',
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('PLUGIN_SMOKE_TIMEOUT'))
    }, 90_000)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`PLUGIN_SMOKE_EXIT:${code}`))
    })
  })
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
