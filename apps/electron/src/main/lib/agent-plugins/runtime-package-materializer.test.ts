import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModuleRuntimePluginFiles } from '@dutydeck/plugin-kit'
import { createPluginPackage, inspectPluginPackage } from '@dutydeck/plugin-kit/package'
import { materializeRuntimePluginPackage } from './runtime-package-materializer'

describe('Given verified V3 package', () => {
  test('When 展开到不可变目录 Then 只写包内文件并返回提示正文', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-runtime-plugin-'))
    try {
      const files = createModuleRuntimePluginFiles('acme.echo', 'Echo')
      files.set('runtime/main.mjs', new TextEncoder().encode('export default { activate() {} }'))
      files.set('surfaces/workspace/index.html', new TextEncoder().encode('<!doctype html><html></html>'))
      files.set('surfaces/workspace/main.js', new TextEncoder().encode('export {}'))
      const inspected = inspectPluginPackage(createPluginPackage(files))
      if (inspected.manifest.formatVersion !== 3) throw new Error('fixture must be V3')
      const materialized = materializeRuntimePluginPackage({
        root,
        manifest: inspected.manifest,
        packageHash: inspected.packageHash,
        files: inspected.files,
      })
      expect(readFileSync(join(materialized.packageRoot, 'runtime/main.mjs'), 'utf8')).toContain('activate')
      expect(materialized.prompts['acme.echo/prompts/workflow']).toContain('用途')
      expect(materialized.packageRoot).toContain('packages/acme.echo/1.0.0')
      expect(materializeRuntimePluginPackage({
        root,
        manifest: inspected.manifest,
        packageHash: inspected.packageHash,
        files: inspected.files,
      }).packageRoot).toBe(materialized.packageRoot)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
