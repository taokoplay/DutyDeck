import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** 分配独立回环端口，不连接或重启用户的开发实例。 */
async function reservePort(): Promise<number> {
  return new Promise((accept, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配烟测端口')); return }
      server.close(error => error ? reject(error) : accept(address.port))
    })
  })
}

/** 构建独立 main/preload 并执行真实 Electron；证据与夹具留在唯一临时根。 */
async function main(): Promise<void> {
  const repository = resolve(import.meta.dir, '..')
  const electronRoot = join(repository, 'apps/electron')
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-project-storage-smoke-'))
  await mkdir(join(root, 'home'))
  const port = await reservePort()
  const url = `http://127.0.0.1:${port}/@fs${join(electronRoot, 'scripts/project-storage-migration-smoke.html')}`
  console.log(`隔离烟测证据：${root}`)
  const build = await Bun.build({
    entrypoints: [join(electronRoot, 'scripts/project-storage-migration-smoke-main.ts'), join(electronRoot, 'scripts/project-storage-migration-smoke-preload.ts')],
    outdir: root, target: 'node', format: 'cjs', external: ['electron'],
  })
  if (!build.success) throw new Error(build.logs.join('\n'))
  const vite = spawn(process.execPath, [join(electronRoot, 'node_modules/vite/bin/vite.js'), '--config', join(electronRoot, 'vite.config.ts'), '--port', String(port), '--host', '127.0.0.1', '--strictPort'], { cwd: electronRoot, stdio: 'inherit' })
  try {
    let ready = false
    for (let count = 0; count < 150; count++) {
      try { if ((await fetch(url)).ok) { ready = true; break } } catch { /* 仅等待新启动的隔离 Vite。 */ }
      await new Promise(accept => setTimeout(accept, 100))
    }
    assert.ok(ready, '隔离 renderer 服务未就绪')
    const child = spawn(join(electronRoot, 'node_modules/.bin/electron'), [join(root, 'project-storage-migration-smoke-main.js')], {
      cwd: electronRoot, stdio: 'inherit',
      env: { ...process.env, PROJECT_STORAGE_SMOKE_ROOT: root, PROJECT_STORAGE_SMOKE_URL: url },
    })
    const code = await new Promise<number>((accept, reject) => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 90000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', (status, signal) => { clearTimeout(timeout); signal ? reject(new Error(`烟测子进程结束：${signal}`)) : accept(status ?? 1) })
    })
    assert.equal(code, 0, `迁移验收失败；证据保留：${root}`)
    console.log(`PASS：真实 Electron/组件/preload/IPC/迁移引擎；证据保留：${root}`)
  } finally { vite.kill('SIGTERM') }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
