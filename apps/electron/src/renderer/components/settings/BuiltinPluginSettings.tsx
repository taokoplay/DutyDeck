import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getBuiltinAgentModulePrompt, isAutomaticAgentModuleId } from '@dutydeck/shared'
import { agentModulesAtom, agentModulesLoadedAtom, agentModulesLoadingAtom, agentModulesErrorAtom } from '@/atoms/agent-module-atoms'
import { loadAgentModuleCatalog } from '@/components/agent/agent-module-loader'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsCard } from './primitives'
import { BUILTIN_PERMISSION_LABELS, getBuiltinModuleDocumentation, type BuiltinModuleDocumentation, type BuiltinModuleResourceDocumentation } from './builtin-module-documentation'

/** 将权限 ID 转成用户能理解的能力边界，未知权限仍保留诊断 ID。 */
function getPermissionLabel(permission: string): string {
  return BUILTIN_PERMISSION_LABELS[permission] ?? permission
}

/** 返回模块说明并为未来新增内置模块提供稳定的基础回退。 */
function getModuleDocumentation(moduleId: string, description: string): BuiltinModuleDocumentation {
  return getBuiltinModuleDocumentation(moduleId) ?? {
    markdown: `# ${description}\n\n${description}`,
    summary: description,
    useCases: ['根据模块描述提出与该能力相关的任务'],
    workflow: ['明确任务目标', '读取当前项目和会话上下文', '提交结果供用户检查'],
    requirements: ['当前消息明确选择该模块'],
    capabilities: [],
    artifacts: [],
    limitations: ['实际可用性以宿主目录、项目权限和连接状态为准'],
    promptDescriptions: {},
    skillDescriptions: {},
    examples: [],
  }
}

/** 将模块声明的 Skills 单独展示，内部引用只作为定位信息。 */
function SkillList({ refs, descriptions }: { refs: string[]; descriptions: Record<string, BuiltinModuleResourceDocumentation> }): React.ReactElement {
  return <section aria-label="Skills" className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-medium">Skills</h3>
      <span className="text-xs tabular-nums text-muted-foreground">{refs.length}</span>
    </div>
    {refs.length > 0 ? <ul className="space-y-3 text-sm text-muted-foreground">
      {refs.map(ref => {
        const documentation = descriptions[ref]
        return <li key={ref} className="rounded-md bg-background/50 px-3 py-2">
          <p className="font-medium text-foreground">{documentation?.title ?? '模块 Skill'}</p>
          <p className="mt-1 leading-6">{documentation?.description ?? '该资源会在依赖检查通过后参与当前消息。'}</p>
          <code className="mt-2 block break-all text-[11px] text-muted-foreground/80">{ref}</code>
        </li>
      })}
    </ul> : <p className="text-sm text-muted-foreground">该模块未声明 Skill。</p>}
    {refs.length > 0 && <p className="border-t border-border/50 pt-2 text-xs leading-5 text-muted-foreground">生效时机：当前消息明确选择模块，且当前项目已安装并启用对应 Skill。</p>}
  </section>
}

/** 将宿主实际提示词正文单独展示，避免把引用 ID 冒充成正文。 */
function PromptList({ refs, descriptions }: { refs: string[]; descriptions: Record<string, BuiltinModuleResourceDocumentation> }): React.ReactElement {
  return <section aria-label="提示词" className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-4">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-medium">提示词</h3>
      <span className="text-xs tabular-nums text-muted-foreground">{refs.length}</span>
    </div>
    {refs.length > 0 ? <ul className="space-y-3 text-sm">
      {refs.map(ref => {
        const documentation = descriptions[ref]
        const prompt = getBuiltinAgentModulePrompt(ref)
        return <li key={ref} className="rounded-md bg-background/50 px-3 py-2">
          <p className="font-medium text-foreground">{documentation?.title ?? '模块提示词'}</p>
          <code className="mt-1 block break-all text-[11px] text-muted-foreground/80">{ref}</code>
          {prompt ? <p className="mt-3 whitespace-pre-wrap leading-6 text-muted-foreground">{prompt}</p> : <p className="mt-3 text-xs leading-5 text-muted-foreground">提示词正文暂不可用；当前只保留宿主声明引用。</p>}
        </li>
      })}
    </ul> : <p className="text-sm text-muted-foreground">该模块未声明专用提示词。</p>}
    {refs.length > 0 && <p className="border-t border-border/50 pt-2 text-xs leading-5 text-muted-foreground">生效时机：当前消息明确选择模块，且提示词依赖检查通过后，才会注入本轮上下文。</p>}
  </section>
}

/** 显示一个内置模块的完整资料，供插件中心详情弹窗使用。 */
export function BuiltinPluginDetail({ moduleId }: { moduleId: string }): React.ReactElement {
  const store = useStore()
  const modules = useAtomValue(agentModulesAtom)
  const loaded = useAtomValue(agentModulesLoadedAtom)
  const loading = useAtomValue(agentModulesLoadingAtom)
  const error = useAtomValue(agentModulesErrorAtom)
  const module = modules.find(item => item.source === 'builtin' && !isAutomaticAgentModuleId(item.id) && item.id === moduleId)

  React.useEffect(() => { void loadAgentModuleCatalog(store, window.electronAPI) }, [store])

  if (!loaded && !error) return <p role="status" className="text-sm text-muted-foreground">正在读取内置模块…</p>
  if (error && !module) return <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 p-4 text-sm"><p className="break-words text-destructive">内置模块读取失败：{error}</p><Button variant="outline" size="sm" disabled={loading} onClick={() => { void loadAgentModuleCatalog(store, window.electronAPI, true) }}>重试读取内置模块</Button></div>
  if (!module) return <p className="text-sm text-muted-foreground">该模块已不存在或尚未加载。</p>

  /** 详情文案与运行时模块声明分离；提示词正文来自共享宿主定义。 */
  const documentation = getModuleDocumentation(module.id, module.description)

  return <section aria-label={`插件 ${module.displayName} 详情`} className="space-y-4">
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">内置模块</p>
        <span className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">随应用更新 · v{module.version}</span>
      </div>
      <p className="text-sm text-muted-foreground">查看模块说明、实际提示词、Skills 和权限边界。</p>
    </div>

    <Tabs key={module.id} defaultValue="overview" className="space-y-3">
      <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4" aria-label="插件详情内容">
        <TabsTrigger value="overview">说明</TabsTrigger>
        <TabsTrigger value="prompts">提示词</TabsTrigger>
        <TabsTrigger value="skills">Skills</TabsTrigger>
        <TabsTrigger value="permissions">权限与资源</TabsTrigger>
      </TabsList>

      {/* 保留只读内容以避免切换时重复解析 Markdown；强制挂载时需显式隐藏未选中的面板。 */}
      <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
        <section aria-label="模块说明.md" className="rounded-lg border border-border/60 bg-muted/20 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">模块说明.md</h3>
            <span className="rounded bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">Markdown</span>
          </div>
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm prose-p:my-2 prose-headings:my-3 prose-li:my-1 prose-pre:rounded-lg">
            <Markdown remarkPlugins={[remarkGfm]} skipHtml>{documentation.markdown}</Markdown>
          </div>
        </section>
      </TabsContent>

      <TabsContent value="prompts" forceMount className="data-[state=inactive]:hidden">
        <PromptList refs={module.promptRefs} descriptions={documentation.promptDescriptions} />
      </TabsContent>

      <TabsContent value="skills" forceMount className="data-[state=inactive]:hidden">
        <SkillList refs={module.skillRefs} descriptions={documentation.skillDescriptions} />
      </TabsContent>

      <TabsContent value="permissions" forceMount className="space-y-4 data-[state=inactive]:hidden">
        <section aria-label="模块权限" className="rounded-lg border border-border/60 p-4">
          <h3 className="text-sm font-medium">权限边界</h3>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm leading-6 text-muted-foreground">
            {module.requiredPermissions.map(permission => <li key={permission}>{getPermissionLabel(permission)}</li>)}
            <li>模块只有在当前消息被明确选择，且依赖检查通过后才接入本轮。</li>
          </ul>
        </section>

        <details className="rounded-lg border border-border/60 p-4 text-sm">
          <summary className="cursor-pointer rounded text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">查看模块资源和内部标识</summary>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">插件标识</dt><dd className="mt-1 break-all">{module.pluginId ?? '宿主内置'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">模块 ID</dt><dd className="mt-1 break-all">{module.id}</dd></div>
            <div><dt className="text-xs text-muted-foreground">提示词引用</dt><dd className="mt-1 break-all text-muted-foreground">{module.promptRefs.join('、') || '无'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Skill 引用</dt><dd className="mt-1 break-all text-muted-foreground">{module.skillRefs.join('、') || '无'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">工具声明</dt><dd className="mt-1 break-all text-muted-foreground">{module.toolRefs.join('、') || '无'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">界面入口</dt><dd className="mt-1 break-all text-muted-foreground">{module.surfaceIds.join('、') || '无'}</dd></div>
          </dl>
        </details>
      </TabsContent>
    </Tabs>
    <p className="text-xs leading-5 text-muted-foreground">插件中心展示模块声明和使用说明。模块资源会在当前消息明确选择该模块、且项目与授权依赖满足后接入本轮；基础能力仍由 Agent 按任务自动调用。</p>
  </section>
}

/**
 * 插件中心的内置模块目录；复用宿主目录缓存，只读展示资源归属。
 * 无需会话入参，不读取 Skill 正文，不改变模块选择或全局准入。
 */
export function BuiltinPluginSettings({ moduleFilter = null }: { moduleFilter?: string | null } = {}): React.ReactElement {
  /** 与消息模块菜单共享缓存和请求去重，避免重复读取目录。 */
  const store = useStore()
  const modules = useAtomValue(agentModulesAtom)
  const loaded = useAtomValue(agentModulesLoadedAtom)
  const loading = useAtomValue(agentModulesLoadingAtom)
  const error = useAtomValue(agentModulesErrorAtom)
  /** 侧栏选择只过滤目录展示，不改变 Agent 的模块准入。 */
  const normalizedFilter = moduleFilter?.trim().toLowerCase() ?? ''
  const builtinModules = modules.filter(module => {
    if (module.source !== 'builtin' || isAutomaticAgentModuleId(module.id)) return false
    if (!normalizedFilter) return true
    return module.id.toLowerCase().includes(normalizedFilter) || module.displayName.toLowerCase().includes(normalizedFilter) || module.description.toLowerCase().includes(normalizedFilter)
  })

  React.useEffect(() => { void loadAgentModuleCatalog(store, window.electronAPI) }, [store])

  return <section aria-labelledby="builtin-plugins-title" className="space-y-3">
    <div>
      <h2 id="builtin-plugins-title" className="text-sm font-semibold">内置模块{loaded ? `（${builtinModules.length}）` : ''}</h2>
      <p className="mt-1 text-xs text-muted-foreground">随应用提供，发送消息时明确选择后接入本轮。浏览器、终端继续由 Agent 自动按需调用。</p>
    </div>
    {error && <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm">
      <p className="break-words text-destructive">内置模块读取失败：{error}</p>
      {loaded && <p className="text-xs text-muted-foreground">显示上次读取的目录。</p>}
      <Button variant="outline" size="sm" disabled={loading} onClick={() => { void loadAgentModuleCatalog(store, window.electronAPI, true) }}>重试读取内置模块</Button>
    </div>}
    {!loaded && !error && <p role="status" className="text-sm text-muted-foreground">正在读取内置模块…</p>}
    {loaded && !error && builtinModules.length === 0 && <p className="text-sm text-muted-foreground">暂无内置专业模块。</p>}
    {loaded && builtinModules.length > 0 && <>
      <div className="grid gap-3 md:grid-cols-2">
        {builtinModules.map(module => {
          /** 列表卡片与详情弹窗共享同一份模块说明，避免摘要和详情语义漂移。 */
          const documentation = getModuleDocumentation(module.id, module.description)
          return <SettingsCard key={module.id} className="min-w-0">
            <article aria-label={module.displayName} className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="text-sm font-medium">{module.displayName}</h3>
                <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">内置 · 随应用更新</span>
              </div>
              <p className="text-sm text-muted-foreground">{documentation.summary}</p>
              <p className="text-xs text-muted-foreground">模块版本 v{module.version}</p>
              <details className="border-t border-border/50 pt-2 text-xs">
                <summary className="cursor-pointer rounded py-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">查看资源 · Skills {module.skillRefs.length} · 提示词 {module.promptRefs.length}</summary>
                <dl className="mt-2 space-y-2 break-words">
                  <div><dt className="font-medium">所属插件</dt><dd className="break-all text-muted-foreground">{module.pluginId}</dd></div>
                  <div><dt className="font-medium">模块 ID</dt><dd className="break-all text-muted-foreground">{module.id}</dd></div>
                  <div><dt className="font-medium">Skills</dt><dd className="break-all text-muted-foreground">{module.skillRefs.join('、') || '未声明 Skill'}</dd></div>
                  <div><dt className="font-medium">提示词</dt><dd className="break-all text-muted-foreground">{module.promptRefs.join('、') || '未声明模块提示词'}</dd></div>
                </dl>
              </details>
            </article>
          </SettingsCard>
        })}
      </div>
      <p className="text-xs text-muted-foreground">以上为模块声明的资源，不代表当前项目已加载；Skill 可用性以所选项目为准。</p>
    </>}
  </section>
}
