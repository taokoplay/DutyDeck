import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgentPluginManifests } from './plugin-manifest-loader'

function writePlugin(root: string, id: string, value: unknown): void {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify(value), 'utf8')
}

describe('Agent 插件 Manifest loader', () => {
  test('只加载受管目录的有效 manifest，并保留坏插件诊断', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-agent-plugin-'))
    writePlugin(root, 'valid.plugin', {
      id: 'valid.plugin', version: '1.0.0', apiVersion: 1, displayName: 'Valid', description: '有效',
      modules: [{ id: 'valid', version: '1.0.0', apiVersion: 1, displayName: '有效', description: '模块', icon: 'box', scope: 'project', contributions: ['skill'], skillRefs: ['valid'], promptRefs: [], toolRefs: [], artifactTypes: [], surfaceIds: [], requiredPermissions: [] }],
      entry: { kind: 'manifest-only' },
    })
    writePlugin(root, 'broken', { id: 'broken', version: '1.0.0', apiVersion: 1, modules: [], entry: { kind: 'native' } })
    const result = loadAgentPluginManifests(root)
    expect(result.plugins.map((plugin) => plugin.id)).toEqual(['valid.plugin'])
    expect(result.diagnostics.find((diagnostic) => diagnostic.pluginId === 'broken')?.status).toBe('rejected')
    expect(result.diagnostics.find((diagnostic) => diagnostic.pluginId === 'broken')?.errorCode).toBe('AGENT_PLUGIN_LEGACY_EXECUTABLE_ENTRY_UNSUPPORTED')
  })
})


test('Given 符号链接或损坏清单附带旧备份 When 加载 Then 拒绝且不改写原始证据', () => {
  /** 仅用于 no-follow 和禁止备份恢复的隔离文件夹具。 */
  const root = mkdtempSync(join(tmpdir(), 'plugin-read-boundary-'))
  try {
    mkdirSync(join(root, 'linked'))
    const outside = join(root, 'outside.json')
    writeFileSync(outside, '{}')
    symlinkSync(outside, join(root, 'linked', 'plugin.json'))
    mkdirSync(join(root, 'broken'))
    const broken = join(root, 'broken', 'plugin.json')
    writeFileSync(broken, '{broken')
    writeFileSync(`${broken}.bak`, '{}')
    const result = loadAgentPluginManifests(root)
    expect(result.plugins).toEqual([])
    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics.every((item) => item.errorCode === 'AGENT_PLUGIN_MANIFEST_UNREADABLE')).toBe(true)
    expect(readFileSync(broken, 'utf8')).toBe('{broken')
    expect(readFileSync(`${broken}.bak`, 'utf8')).toBe('{}')
    expect(readFileSync(outside, 'utf8')).toBe('{}')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given 插件根不是目录或插件数量超限 When 加载 Then 返回诊断而不抛出阻断宿主', () => {
  // 文件型根与超限目录都只影响安装插件，保留内置模块启动能力。
  const root = mkdtempSync(join(tmpdir(), 'plugin-root-boundary-'))
  try {
    const fileRoot = join(root, 'not-directory')
    writeFileSync(fileRoot, 'preserve')
    expect(loadAgentPluginManifests(fileRoot).diagnostics[0]?.errorCode).toBe('AGENT_PLUGIN_ROOT_UNREADABLE')
    for (let index = 0; index < 65; index += 1) mkdirSync(join(root, `plugin-${index}`))
    const result = loadAgentPluginManifests(root)
    expect(result.plugins).toEqual([])
    expect(result.diagnostics[0]?.errorCode).toBe('AGENT_PLUGIN_ROOT_LIMIT_EXCEEDED')
    expect(readFileSync(fileRoot, 'utf8')).toBe('preserve')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
