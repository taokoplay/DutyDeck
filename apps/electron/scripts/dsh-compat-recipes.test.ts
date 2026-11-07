import { describe, expect, test } from 'bun:test'
import { pluginAgentToolName } from '@dutydeck/plugin-sdk'
import { hashPluginBytes } from '../../../packages/plugin-kit/src/package'
import { getDshPilotRecipes } from './dsh-compat-recipes'
import { buildDshPilotAdapter } from './dsh-compat-adapter'

describe('Given 开发侧两个固定工具限定配方', () => {
  test('When 构建当前自主adapter Then 与配方固定hash匹配，不能随源更新静默批准', async () => {
    const adapter = await buildDshPilotAdapter()
    for (const recipe of getDshPilotRecipes()) expect(hashPluginBytes(adapter)).toBe(recipe.adapter.sha256)
  })
  test('When 读取配方 Then 精确版本/逐依赖声明/最终工具名互不混淆且不暴露共享可变对象', () => {
    const recipes = getDshPilotRecipes()
    expect(recipes.map(recipe => `${recipe.source.name}@${recipe.source.version}`)).toEqual(['dsh-pace-calc@0.1.1', 'dsh-unitverse@1.1.4'])
    expect(recipes.map(recipe => recipe.dependencyDispositions.length)).toEqual([2, 8])
    const names = recipes.map(recipe => pluginAgentToolName(recipe.plugin.id, recipe.tool.upstreamName.replaceAll('_', '-')))
    expect(new Set(names).size).toBe(2)
    expect(recipes[1]!.imports['lib/client.js']).toBeUndefined()
    recipes[0]!.adapter.sha256 = 'changed'
    expect(getDshPilotRecipes()[0]!.adapter.sha256).not.toBe('changed')
  })
})
