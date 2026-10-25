import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentModuleManifest, AgentSessionModulePolicy, SkillMeta } from '@dutydeck/shared'
import { getInactiveModuleSkillSlugs, resolveActiveModuleContext, selectBlockingModuleUnavailability, setAgentModuleRuntimeCatalog } from './module-skill-resolver'
import { listBuiltinAgentModules } from './module-registry'
import { AgentPluginRegistry } from './plugin-registry'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFileAtomic } from '../safe-file'

const policy = (override: Partial<AgentSessionModulePolicy> = {}): AgentSessionModulePolicy => ({
  mode: 'pinned',
  enabledModuleIds: [],
  disabledModuleIds: [],
  pinnedModuleIds: [],
  revision: 3,
  updatedAt: 1,
  ...override,
})

const skills = (slugs: string[]): SkillMeta[] => slugs.map((slug) => ({ slug, name: slug, enabled: true }))

describe('Agent 模块 Skill 解析', () => {
  test('Given 用户显式选择 Canvas When 解析 Then 返回 Skill、提示摘要和工具绑定', () => {
    const result = resolveActiveModuleContext(
      { workspaceSlug: 'project', sessionId: 'session', policy: policy(), explicitModuleIds: ['canvas'], now: 10 },
      { listModules: listBuiltinAgentModules, getSkills: () => skills(['canvas-production', 'media-models']) },
    )
    expect(result.modules[0]).toMatchObject({ moduleId: 'canvas', mode: 'pinned', policyRevision: 3 })
    expect(result.skillMentions).toEqual(['canvas-production', 'media-models'])
    expect(result.allowedToolNames).toEqual([])
    expect(result.promptFragments[0]).toContain('当前模块是画布')
    expect(result.unavailable).toEqual([])
  })

  test('Given Session 已附着 Canvas When 没有显式模块 Then 注入 Canvas 模块上下文', () => {
    const result = resolveActiveModuleContext(
      { workspaceSlug: 'project', sessionId: 'session', policy: policy({ mode: 'pinned', enabledModuleIds: ['canvas'], pinnedModuleIds: ['canvas'] }), now: 10 },
      { listModules: listBuiltinAgentModules, getSkills: () => skills(['canvas-production', 'media-models', 'in-app-browser']) },
    )
    expect(result.modules[0]).toMatchObject({ moduleId: 'canvas', mode: 'pinned', policyRevision: 3 })
    expect(result.skillMentions).toEqual(['canvas-production', 'media-models'])
    expect(result.promptFragments[0]).toContain('当前模块是画布')
    expect(result.unavailable).toEqual([])
  })

  test('Given Session 未附着专业模块 When 没有显式模块 Then 不注入额外模块上下文', () => {
    const result = resolveActiveModuleContext(
      { workspaceSlug: 'project', sessionId: 'session', policy: policy({ enabledModuleIds: ['browser'], pinnedModuleIds: [] }), now: 10 },
      { listModules: listBuiltinAgentModules, getSkills: () => skills(['canvas-production', 'in-app-browser']) },
    )
    expect(result.modules).toEqual([])
    expect(result.skillMentions).toEqual([])
    expect(result.promptFragments).toEqual([])
  })

  test('Given Session 绑定的模块版本已变化 When 普通消息解析 Then fail closed 并记录身份变化', () => {
    const result = resolveActiveModuleContext(
      {
        workspaceSlug: 'project', sessionId: 'session',
        policy: policy({ enabledModuleIds: ['canvas'], pinnedModuleIds: ['canvas'], moduleBindings: [{ moduleId: 'canvas', moduleVersion: '0.9.0' }] }),
        now: 10,
      },
      { listModules: listBuiltinAgentModules, getSkills: () => skills(['canvas-production', 'media-models']) },
    )
    expect(result.modules).toEqual([])
    expect(result.unavailable).toEqual([{ moduleId: 'canvas', reason: 'AGENT_MODULE_IDENTITY_CHANGED' }])
  })

  test('Given 模块绑定 Skill 未启用 When 解析 Then 返回缺失原因且不允许降级调用', () => {
    const result = resolveActiveModuleContext(
      { workspaceSlug: 'project', sessionId: 'session', policy: policy(), explicitModuleIds: ['canvas'], now: 10 },
      { listModules: listBuiltinAgentModules, getSkills: () => skills([]) },
    )
    expect(result.modules).toEqual([])
    expect(result.unavailable).toEqual([{ moduleId: 'canvas', reason: 'AGENT_MODULE_SKILL_UNAVAILABLE' }])
  })

  test('Given 显式模块调用 When 解析 Then 记录 invoke 模式', () => {
    const result = resolveActiveModuleContext(
      { workspaceSlug: 'project', sessionId: 'session', policy: policy({ mode: 'auto' }), explicitModuleIds: ['interaction-design'], invocationMode: 'invoke', now: 10 },
      { listModules: listBuiltinAgentModules, getSkills: () => skills(['interaction-design']) },
    )
    expect(result.modules[0]).toMatchObject({ moduleId: 'interaction-design', invocationMode: 'invoke', mode: 'auto' })
  })
})

describe('Agent 模块不可用时的运行准入', () => {
  test('Given 会话残留模块身份变化但本轮已有可用模块 When 检查阻断 Then 跳过残留模块', () => {
    const blocking = selectBlockingModuleUnavailability(
      [{ moduleId: 'stale-plugin', reason: 'AGENT_MODULE_IDENTITY_CHANGED' }],
      ['visual-production'],
      policy({ enabledModuleIds: ['visual-production', 'stale-plugin'], pinnedModuleIds: ['visual-production', 'stale-plugin'] }),
      [],
    )
    expect(blocking).toEqual([])
  })

  test('Given 用户本轮显式选择失效模块 When 检查阻断 Then 保留明确失败', () => {
    const blocking = selectBlockingModuleUnavailability(
      [{ moduleId: 'stale-plugin', reason: 'AGENT_MODULE_IDENTITY_CHANGED' }],
      ['visual-production'],
      policy({ enabledModuleIds: ['visual-production'], pinnedModuleIds: ['visual-production'] }),
      ['stale-plugin'],
    )
    expect(blocking).toEqual([{ moduleId: 'stale-plugin', reason: 'AGENT_MODULE_IDENTITY_CHANGED' }])
  })

  test('Given 会话只有失效的固定模块 When 检查阻断 Then 不回退为无模块普通回复', () => {
    const blocking = selectBlockingModuleUnavailability(
      [{ moduleId: 'stale-plugin', reason: 'AGENT_MODULE_IDENTITY_CHANGED' }],
      [],
      policy({ enabledModuleIds: ['stale-plugin'], pinnedModuleIds: ['stale-plugin'] }),
      [],
    )
    expect(blocking).toEqual([{ moduleId: 'stale-plugin', reason: 'AGENT_MODULE_IDENTITY_CHANGED' }])
  })
})

/** 每个测试恢复宿主目录，避免污染独立 resolver 用例。 */
afterEach(() => setAgentModuleRuntimeCatalog(null))

describe('宿主模块目录与权限边界', () => {
  test('Given 已安装 Skill 模块快照 When 显式选择 Then 通过受管工作区解析且不扩大工具权限', () => {
    const installed: AgentModuleManifest = { ...listBuiltinAgentModules()[0]!, id: 'installed-notes', source: 'installed', skillRefs: ['notes'], promptRefs: [], toolRefs: [] }
    setAgentModuleRuntimeCatalog([...listBuiltinAgentModules(), installed])
    installed.skillRefs.push('mutated-after-registration')
    const result = resolveActiveModuleContext({ workspaceSlug: 'project', sessionId: 'session', policy: policy({ mode: 'auto' }), explicitModuleIds: ['installed-notes'] }, {
      getSkills: (slug) => { expect(slug).toBe('project'); return skills(['notes']) },
    })
    expect(result.skillMentions).toEqual(['notes'])
    expect(result.modules[0]?.moduleId).toBe('installed-notes')
    expect(result.allowedToolNames).toEqual([])
  })

  test('Given 显式禁用模块 When 调用 Then 不静默普通执行', () => {
    const result = resolveActiveModuleContext({ workspaceSlug: 'project', sessionId: 'session', policy: policy({ disabledModuleIds: ['canvas'] }), explicitModuleIds: ['canvas'] }, { getSkills: () => { throw new Error('不得读目录') } })
    expect(result.unavailable).toEqual([{ moduleId: 'canvas', reason: 'AGENT_MODULE_DISABLED' }])
  })

  test('Given 未知 promptRef When 选择 Then 不根据模块名冒用提示或读取任意路径', () => {
    const result = resolveActiveModuleContext({ workspaceSlug: 'project', sessionId: 'session', explicitModuleIds: ['canvas'], policy: policy() }, {
      listModules: () => [{ ...listBuiltinAgentModules()[0]!, promptRefs: ['/private/secret.md'] }], getSkills: () => skills(['canvas-production', 'media-models']),
    })
    expect(result.unavailable).toEqual([{ moduleId: 'canvas', reason: 'AGENT_MODULE_PROMPT_UNAVAILABLE' }])
    expect(result.promptFragments).toEqual([])
  })

  test('Given auto 无显式选择 When 解析 Then 连目录及 Skills 依赖都不访问', () => {
    const result = resolveActiveModuleContext({ sessionId: 'session', policy: policy({ mode: 'auto', enabledModuleIds: [], pinnedModuleIds: [] }) }, {
      listModules: () => { throw new Error('不得读目录') }, getSkills: () => { throw new Error('不得读 Skills') },
    })
    expect(result.unavailable).toEqual([])
  })

  test('Given available 或 pinned 已选 When 缺工作区或 Skills 被运行期禁用 Then 返回不可用且不访问磁盘', () => {
    for (const mode of ['available', 'pinned'] as const) {
      for (const workspaceSlug of [undefined, 'project']) {
        const result = resolveActiveModuleContext({ workspaceSlug, skillsEnabled: false, sessionId: 'session', explicitModuleIds: ['canvas'], policy: policy({ mode, enabledModuleIds: ['canvas'] }) }, { getSkills: () => { throw new Error('不得读目录') } })
        expect(result.unavailable).toEqual([{ moduleId: 'canvas', reason: workspaceSlug ? 'AGENT_MODULE_SKILLS_DISABLED' : 'AGENT_MODULE_WORKSPACE_REQUIRED' }])
      }
    }
  })
})


test('Given 受管插件目录 When 注册并发布快照 Then 已安装模块能够加载工作区 Skill', () => {
  /** 独立插件根只包含声明，不执行插件 JavaScript。 */
  const root = mkdtempSync(join(tmpdir(), 'module-runtime-catalog-'))
  try {
    mkdirSync(join(root, 'notes.plugin'))
    writeJsonFileAtomic(join(root, 'notes.plugin', 'plugin.json'), {
      id: 'notes.plugin', version: '1.0.0', apiVersion: 1, displayName: '笔记', description: '笔记插件', entry: { kind: 'manifest-only' },
      modules: [{ ...listBuiltinAgentModules()[0]!, id: 'notes', contributions: ['skill'], skillRefs: ['notes'], promptRefs: [], toolRefs: [], surfaceIds: [] }],
    })
    const registry = new AgentPluginRegistry()
    registry.registerBuiltinModules(listBuiltinAgentModules())
    registry.loadInstalledPlugins(root)
    expect(registry.getModule('notes')?.source).toBe('installed')
    setAgentModuleRuntimeCatalog(registry.listModules())
    // 删除磁盘目录后仍从已校验的快照解析，证明没有逐轮扫描。
    rmSync(root, { recursive: true, force: true })
    const result = resolveActiveModuleContext({ workspaceSlug: 'project', sessionId: 'session', explicitModuleIds: ['notes'], policy: policy({ mode: 'auto' }) }, { getSkills: () => skills(['notes']) })
    expect(result.skillMentions).toEqual(['notes'])
    expect(result.unavailable).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('Given 已安装插件自有提示 When manifest 注册到 resolver Then 注入声明正文而不执行代码', () => {
  /** 临时插件目录使用真实 loader 和 registry 完成端到端声明解析。 */
  const root = mkdtempSync(join(tmpdir(), 'module-own-prompts-'))
  try {
    mkdirSync(join(root, 'notes.plugin'))
    writeJsonFileAtomic(join(root, 'notes.plugin', 'plugin.json'), {
      id: 'notes.plugin', version: '1.0.0', apiVersion: 1, displayName: '笔记', description: '笔记插件', entry: { kind: 'manifest-only' },
      prompts: { 'notes.plugin.route': '先读取任务笔记，再总结未完成事项。' },
      modules: [{ ...listBuiltinAgentModules()[0]!, id: 'notes', contributions: ['prompt'], skillRefs: [], promptRefs: ['notes.plugin.route'], toolRefs: [], surfaceIds: [] }],
    })
    const registry = new AgentPluginRegistry()
    registry.registerBuiltinModules(listBuiltinAgentModules())
    registry.loadInstalledPlugins(root)
    setAgentModuleRuntimeCatalog(registry.listModules(), registry.getPromptCatalog())
    const result = resolveActiveModuleContext({ workspaceSlug: 'project', sessionId: 'session', explicitModuleIds: ['notes'], policy: policy({ mode: 'auto' }) }, { getSkills: () => { throw new Error('纯提示模块不扫描 Skills') } })
    expect(result.promptFragments).toEqual(['先读取任务笔记，再总结未完成事项。'])
    expect(result.modules[0]?.promptRefs).toEqual(['notes.plugin.route'])
    expect(result.allowedToolNames).toEqual([])
    expect(result.unavailable).toEqual([])
    const copy = registry.getPromptCatalog()
    copy['notes.plugin.route'] = '不可污染'
    expect(registry.getPromptCatalog()['notes.plugin.route']).toBe('先读取任务笔记，再总结未完成事项。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


describe('专业模块与基础能力的上下文边界', () => {
  test('Given 无Skill依赖的模块 When 工作区Skills关闭 Then 按模块真实作用域校验而不阻断运维', () => {
    for (const workspaceSlug of [undefined, 'project']) {
      const result = resolveActiveModuleContext({ workspaceSlug, skillsEnabled: false, sessionId: 'session', policy: policy(),
        explicitModuleIds: ['server-ops'] }, { getSkills: () => { throw new Error('不依赖Skills') } })
      expect(result.unavailable).toEqual([])
      expect(result.modules[0]?.moduleId).toBe('server-ops')
    }
    expect(resolveActiveModuleContext({ skillsEnabled: false, sessionId: 'session', policy: policy(),
      explicitModuleIds: ['api-workbench'] }).unavailable).toEqual([{ moduleId: 'api-workbench', reason: 'AGENT_MODULE_WORKSPACE_REQUIRED' }])
    expect(resolveActiveModuleContext({ workspaceSlug: 'project', skillsEnabled: false, sessionId: 'session', policy: policy(),
      explicitModuleIds: ['api-workbench'] }).unavailable).toEqual([])
  })

  test('Given 内部画布任务显式配置媒体Skill When 宿主签发精确slug Then 只保留配置项而不解禁其它模块', () => {
    const excluded = getInactiveModuleSkillSlugs([], undefined, ['canvas-production'])
    expect(excluded).not.toContain('canvas-production')
    expect(excluded).toContain('media-models')
    expect(excluded).toContain('interaction-design')
  })

  test('Given 旧草稿仍引用浏览器和终端 When 没有工作区且Skills关闭 Then 忽略旧选择而不阻断聊天', () => {
    const result = resolveActiveModuleContext({ sessionId: 'session', skillsEnabled: false,
      policy: policy({ disabledModuleIds: ['browser', 'terminal'] }), explicitModuleIds: ['browser', 'terminal'] }, {
      getSkills: () => { throw new Error('基础模块不应读取Skill') },
    })
    expect(result.modules).toEqual([])
    expect(result.unavailable).toEqual([])
    expect(result.promptFragments).toEqual([])
  })

  test('Given 新专业模块 When 用户显式选择 Then 注入真实提示与已声明Skill', () => {
    const result = resolveActiveModuleContext({ workspaceSlug: 'project', sessionId: 'session', policy: policy(),
      explicitModuleIds: ['server-ops', 'api-workbench', 'capability-factory'] }, { getSkills: () => skills(['capability-factory-scene-design']) })
    expect(result.unavailable).toEqual([])
    expect(result.modules.map(module => module.moduleId)).toEqual(['server-ops', 'api-workbench', 'capability-factory'])
    expect(result.promptFragments).toHaveLength(3)
  })

  test('Given 未选专业模块 When 构建自动Skill目录 Then 排除专用Skill而保留浏览器', () => {
    expect(getInactiveModuleSkillSlugs([])).toEqual(expect.arrayContaining(['canvas-production', 'media-models', 'interaction-design', 'capability-factory-scene-design']))
    expect(getInactiveModuleSkillSlugs([])).not.toContain('in-app-browser')
  })

  test('Given 选择影像或画布 When 两模块共用媒体Skill Then 已选模块的依赖不会被另一模块排除', () => {
    expect(getInactiveModuleSkillSlugs(['visual-production'])).not.toContain('media-models')
    expect(getInactiveModuleSkillSlugs(['visual-production'])).toContain('canvas-production')
    expect(getInactiveModuleSkillSlugs(['canvas'])).not.toContain('media-models')
    expect(getInactiveModuleSkillSlugs(['canvas'])).not.toContain('canvas-production')
  })
})
