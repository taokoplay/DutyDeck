import { describe, expect, test } from 'bun:test'
import { createHostBuildProvider } from './host-build-runtime'
import type { HostBuildMaterial } from './host-build-identity'

const options = { packaged: true, appPath: '/app/resources/app.asar', resourcesPath: '/app/resources', entryFile: '/app/resources/app.asar/dist/main.cjs' }
const payload: HostBuildMaterial = { contract: 'dutydeck-packaged-resources-v1', target: 'packaged-main', files: [], sha256: 'a'.repeat(64) }
describe('Given 由main组合根绑定而非cwd或插件传入的实际执行目标', () => {
  test('When 开发/watch、未知ASAR路径或独立smoke Then 不扫描也不生成完整宿主指纹', async () => {
    for (const changed of [{ packaged: false }, { appPath: '/other/app.asar' }, { entryFile: '/app/resources/app.asar/dist/child.cjs' }]) {
      let scans = 0
      const provider = createHostBuildProvider({ ...options, ...changed }, () => { scans++; return payload })
      expect((await provider()).hostBuildSha256).toBeUndefined(); expect(scans).toBe(0)
    }
  })
  test('When 确切packaged main绑定后材料变化 Then 当前环境不返回新磁盘指纹', async () => {
    let value = payload
    const provider = createHostBuildProvider(options, () => value)
    expect((await provider()).hostBuildSha256).toBe(payload.sha256)
    value = { ...payload, sha256: 'b'.repeat(64) }
    expect((await provider()).status).toBe('changed')
    value = payload; expect((await provider()).hostBuildSha256).toBeUndefined()
  })
})
