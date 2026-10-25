import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildModuleRuntimePlugin } from '@dutydeck/plugin-kit'
import { collectPluginSource } from '@dutydeck/plugin-kit/filesystem'
import { createPluginPackage } from '@dutydeck/plugin-kit/package'
import { build } from 'esbuild'

/**
 * 构建并运行交互设计 V3 插件真实 Electron utility smoke。
 * 不打开窗口，也不读写用户正式项目。
 */
async function main(): Promise<void> {
  const fixture = join(process.cwd(), '../../examples/plugins/interaction-design-pilot')
  const runtimeBundle = join(process.cwd(), 'dist/plugin-runtime.cjs')
  const temp = mkdtempSync(join(tmpdir(), 'dutydeck-interaction-pilot-smoke-'))
  const dataRoot = join(temp, 'data')
  const projectRoot = join(temp, 'project')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(projectRoot, 'App.tsx'), 'export function App() { return <main /> }\n')
  copyFileSync(runtimeBundle, join(temp, 'plugin-runtime.cjs'))

  buildModuleRuntimePlugin(fixture)
  const packagePath = join(temp, 'interaction-design-pilot.ddplugin')
  writeFileSync(packagePath, createPluginPackage(collectPluginSource(fixture)))

  const childBundle = join(temp, 'child.cjs')
  await build({
    entryPoints: [join(process.cwd(), 'scripts/interaction-design-pilot-smoke-child.ts')],
    outfile: childBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent',
  })

  const electron = process.env.PROMA_ELECTRON_PATH ?? join(process.cwd(), 'node_modules', '.bin', 'electron')
  const child = spawn(electron, [childBundle, packagePath, dataRoot, projectRoot], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: 'inherit',
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('INTERACTION_DESIGN_PILOT_SMOKE_TIMEOUT'))
    }, 90_000)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`INTERACTION_DESIGN_PILOT_SMOKE_EXIT:${code}`))
    })
  })
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
