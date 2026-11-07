import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, version as esbuildVersion } from 'esbuild'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'

/** 显式指定已复核的两份开发包；脚本不下载、不构建第三方、不触及真实HOME，不是任意包执行器。 */
async function main(): Promise<void> {
  const packageDirectory = process.argv[2]
  if (!packageDirectory) throw new Error('用法：bun scripts/dsh-compat-smoke.ts <精确试点包目录> [--prepare-only]')
  const appRoot = fileURLToPath(new URL('../', import.meta.url))
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dutydeck-dsh-smoke-')))
  const buildRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dutydeck-dsh-smoke-build-')))
  try {
    // 使用最新仓库runtime，不沿用dist里的旧副本；只编译宿主和自有验收脚本。
    await build({ entryPoints: [join(appRoot, 'src/utility/plugin-runtime.ts')], outfile: join(buildRoot, 'plugin-runtime.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    const childBundle = join(buildRoot, 'child.cjs')
    // Pi依赖包含原生ESM的import.meta，不将其强行转写成CJS；只引用现有工程依赖。
    symlinkSync(join(appRoot, 'node_modules'), join(buildRoot, 'node_modules'), 'dir')
    await build({
      entryPoints: [join(appRoot, 'scripts/dsh-compat-smoke-child.ts')], outfile: childBundle,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning',
      plugins: [{ name: 'external-existing-dependencies', setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, async args => {
          if (args.pluginData || args.path.startsWith('@dutydeck/')) return undefined
          if (args.path === 'electron' || args.path.startsWith('node:')) return { path: args.path, external: true }
          const result = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolved: true } })
          return { path: result.path, external: true, errors: result.errors }
        })
      } }],
    })
    const sources = [
      'scripts/dsh-compat-smoke.ts', 'scripts/dsh-compat-smoke-child.ts', 'scripts/dsh-compat-lifecycle-smoke.ts',
      'src/main/lib/agent-plugins/runtime-supervisor.ts', 'src/main/lib/agent-plugins/module-runtime-manager.ts',
      'src/main/lib/agent-plugins/module-runtime-plugin-service.ts', 'src/utility/plugin-runtime.ts',
      'src/main/lib/adapters/pi-agent-adapter.ts', 'src/main/lib/adapters/pi-tool-registry.ts',
    ]
    const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
    writeJsonFileAtomic(join(root, 'build-evidence.json'), {
      at: new Date().toISOString(), esbuildVersion,
      sourceHashes: Object.fromEntries(sources.map(path => [path, sha256(join(appRoot, path))])),
      bundleHashes: { child: sha256(childBundle), utility: sha256(join(buildRoot, 'plugin-runtime.cjs')) },
      productionTrust: false,
    })
    const bootstrap = join(buildRoot, 'bootstrap.cjs')
    await Bun.write(bootstrap, `const { app } = require('electron'); process.on('uncaughtException', error => { console.error(error); app.exit(1) }); try { require('./child.cjs') } catch (error) { console.error(error); app.exit(1) }`)
    if (process.argv.includes('--prepare-only')) { console.log('[DSH compatibility smoke] 仅宿主fixture编译通过；未启动Electron或执行候选'); return }
    // 不把父进程的渠道、代理或凭据环境传入第三方runtime。
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: tmpdir(), HOME: root, DUTYDECK_DSH_SMOKE_ROOT: root, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
    await new Promise<void>((resolveExit, reject) => {
      const child = spawn(process.env.PROMA_ELECTRON_PATH ?? join(appRoot, 'node_modules/.bin/electron'), [bootstrap, resolve(packageDirectory), root], { cwd: appRoot, env, stdio: 'inherit' })
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error(`DSH_SMOKE_EXIT:${code}`)) })
    })
    console.log(`[DSH compatibility smoke] 证据目录：${root}`)
  } finally { rmSync(buildRoot, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
