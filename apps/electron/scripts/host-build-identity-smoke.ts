import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'

/** 仅自有ASAR fixture，不启动产品main、不运行第三方插件或读取业务配置。 */
async function main(): Promise<void> {
  const appRoot = fileURLToPath(new URL('../', import.meta.url))
  const require = createRequire(join(appRoot, 'package.json'))
  // 使用现有builder的确定依赖链，不通过Bun临时下载、不从用户HOME寻找包。
  const builder = createRequire(require.resolve('electron-builder'))
  const builderLib = createRequire(builder.resolve('app-builder-lib'))
  const asar = builderLib('@electron/asar') as { createPackageWithOptions(source: string, destination: string, options: { unpack: string }): Promise<void> }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dutydeck-build-identity-smoke-')))
  const source = join(root, 'source'); const resources = join(root, 'resources')
  mkdirSync(source); mkdirSync(resources)
  writeJsonFileAtomic(join(source, 'package.json'), { name: 'dutydeck-identity-fixture', version: '1.0.0', main: 'fixture.cjs' })
  writeFileSync(join(source, 'fixture.cjs'), 'module.exports = "own fixture"')
  writeFileSync(join(source, 'native.fixture'), 'unpacked fixture A')
  await asar.createPackageWithOptions(source, join(resources, 'app.asar'), { unpack: '*.fixture' })
  writeFileSync(join(resources, 'helper.fixture'), 'extra resource A')
  const entry = join(root, 'child.ts')
  writeFileSync(entry, `
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app } from 'electron';
import { capturePackagedPayloadAsync, HostBuildIdentitySession } from ${JSON.stringify(join(appRoot, 'src/main/lib/host-build-identity.ts'))};
import { createHostBuildProvider } from ${JSON.stringify(join(appRoot, 'src/main/lib/host-build-runtime.ts'))};
import { getHostPluginValidationRecords, getPluginValidationEnvironment } from ${JSON.stringify(join(appRoot, 'src/main/lib/agent-plugins/plugin-validation-catalog.ts'))};
import { assessPluginValidation } from ${JSON.stringify(join(appRoot, 'src/main/lib/agent-plugins/plugin-validation.ts'))};
import { writeJsonFileAtomic } from ${JSON.stringify(join(appRoot, 'src/main/lib/safe-file.ts'))};
async function run() {
  const root = process.argv[2]; const resources = join(root, 'resources');
  app.setPath('userData', join(root, 'userData')); await app.whenReady();
  const raw = createRequire(__filename)('original-fs');
  assert.equal(fs.statSync(join(resources, 'app.asar')).isDirectory(), true);
  assert.equal(raw.statSync(join(resources, 'app.asar')).isFile(), true);
  assert.equal(fs.readFileSync(join(resources, 'app.asar/native.fixture'), 'utf8'), 'unpacked fixture A');
  const runtime = { hostVersion: 'fixture-1', electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, platform: process.platform, arch: process.arch };
  const capture = () => capturePackagedPayloadAsync(resources, runtime, { fs: raw });
  const baseline = await capture(); const session = new HostBuildIdentitySession(capture);
  assert.equal((await session.current()).hostBuildSha256, baseline.sha256);
  fs.writeFileSync(join(resources, 'app.asar.unpacked/native.fixture'), 'unpacked fixture B');
  assert.equal((await session.current()).status, 'changed');
  fs.writeFileSync(join(resources, 'app.asar.unpacked/native.fixture'), 'unpacked fixture A');
  assert.equal((await session.current()).hostBuildSha256, undefined);
  const helperSession = new HostBuildIdentitySession(capture); await helperSession.current();
  fs.writeFileSync(join(resources, 'helper.fixture'), 'extra resource B');
  assert.equal((await helperSession.current()).status, 'changed');
  const provider = createHostBuildProvider({ packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, entryFile: __filename }, capture);
  assert.equal((await provider()).hostBuildSha256, undefined);
  const old = getHostPluginValidationRecords();
  assert.equal(old.length, 2);
  for (const record of old) assert.equal(assessPluginValidation(record, { ...getPluginValidationEnvironment(), hostBuildSha256: baseline.sha256 }, old).status, 'stale');
  writeJsonFileAtomic(join(root, 'result.json'), { scope: 'own-asar-fixture', runtime, baseline, originalFsVerified: true, unpackedChangeRejected: true, helperChangeRejected: true, restoredStillInvalid: true, smokeCannotBorrowProductionIdentity: true, historicalRecordsStillStale: true, productionMainExecuted: false, productionTrust: false });
  app.exit(0);
}
void run().catch(error => { console.error(error); app.exit(1) });
`)
  const bundle = join(root, 'child.cjs')
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG, HOME: root, TMPDIR: tmpdir(), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(join(appRoot, 'node_modules/.bin/electron'), [bundle, root], { cwd: root, env, stdio: 'inherit' })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`HOST_BUILD_SMOKE_EXIT:${code}`)) })
  })
  const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as { originalFsVerified?: boolean }
  assert.equal(result.originalFsVerified, true)
  writeJsonFileAtomic(join(root, 'provenance.json'), { at: new Date().toISOString(), script: 'host-build-identity-smoke', productionMainExecuted: false })
  console.log(`[host-build smoke] 自有ASAR/实际Electron验证通过；证据目录：${root}`)
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
