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
  const files = collectPluginSource(fixture)
  const manifest = JSON.parse(Buffer.from(files.get('plugin.json')!).toString())
  manifest.surfaces[0].methods.push('writeState', 'writeArtifact')
  manifest.capabilities.push('artifact.read', 'artifact.write')
  files.set('plugin.json', Buffer.from(JSON.stringify(manifest)))
  // 只改临时打包内容：验证 activate 等待状态 RPC，以及工具级状态使用独立 invocation。
  files.set('runtime/fixture-base.mjs', files.get('runtime/main.mjs')!)
  files.set('runtime/main.mjs', new TextEncoder().encode(`
    import base from './fixture-base.mjs'
    export default {
      async activate(context) {
        const before = await context.state.readRecord('smoke-counter')
        if (before !== null && before.value !== 1) throw new Error('fixture state must be empty or the previous smoke value')
        await base.activate({ ...context, tools: { handle(id, handler) {
          context.tools.handle(id, async (input, call) => {
            const record = await call.state.readRecord('smoke-counter')
            await call.state.write('smoke-counter', (record?.value ?? 0) + 1, { schemaVersion: 1, expectedRevision: record?.revision })
            return await handler(input, call)
          })
        } } })
        context.surfaces.handle('workspace', 'writeState', async (input, call) => {
          return call.state.write(input.key, { committed: true }, { schemaVersion: 1 })
        })
        context.surfaces.handle('workspace', 'writeArtifact', async (input, call) => {
          return call.capabilities.request('artifact.write', { artifactId: input.key, schemaVersion: 1, value: { committed: true } })
        })
      }
    }
  `))
  const packageBytes = createPluginPackage(files)
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
