import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentModuleRunAudit } from '@dutydeck/shared'
import { AgentModuleRunAuditDetails } from './AgentModuleRunAuditView'

/** 固定审计快照验证真实组件，不把模块声明当成工具执行。 */
const audit: AgentModuleRunAudit = {
  sessionId: 'session', runId: 'run-1', policyMode: 'pinned', policyRevision: 3, startedAt: 1,
  modules: [{ moduleId: 'canvas', displayName: '画布', moduleVersion: '1.0.0', mode: 'pinned', sessionId: 'session', policyRevision: 3, activatedAt: 1,
    skillRefs: ['canvas-skill'], promptRefs: ['canvas.system.v1'], declaredCapabilities: ['canvas.document'] }],
  activatedSkills: [{ slug: 'canvas-skill', moduleId: 'canvas', moduleVersion: '1.0.0', activationMode: 'pinned' }],
  unavailable: [], tools: [{ toolUseId: 'call', toolName: 'read', status: 'completed' }], status: 'completed', truncated: false,
}

/** 提取可读文本，避免断言依赖主题类名或 SVG 图标实现。 */
function textContent(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

/** 只读取工具聚合行，验证计数不会受折叠的逐次明细干扰。 */
function toolRows(html: string): string[] {
  return [...html.matchAll(/<div[^>]*data-testid="audit-tool-summary"[^>]*>(.*?)<\/div>/g)].map(match => textContent(match[1]!))
}

describe('模块运行记录展示', () => {
  test('Given 包内上下文资源，When 无 Pi Skill 加载事件，Then 显示包来源并区分两种事实', () => {
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, activatedSkills: [], modules: [{ ...audit.modules[0]!, pluginId: 'acme.demo', packageHash: 'exact-package-hash', packageResources: [{ id: 'acme.demo/skills/assist', kind: 'skill', version: '1.2.0', byteLength: 1234 }] }] }} />)
    const text = textContent(html)
    expect(text).toContain('包内上下文资源（1）')
    expect(text).toContain('acme.demo/skills/assist @1.2.0')
    expect(text).toContain('包 SHA-256：exact-package-hash')
    expect(text).toContain('Pi Skill 加载记录 0 条')
    expect(text).not.toContain('Skills 已加载 1/1')
  })

  test('Given 模块和加载事实 When 展示 Then 模块卡片保留 Skill 来源且工具单独汇总', () => {
    /** 渲染真实运行卡片，检查用户可读的分区与声明边界。 */
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={audit} />)
    const text = textContent(html)
    expect(html).toContain('aria-label="模块 画布"')
    expect(text).toContain('Skills 已加载 1/1')
    expect(text).toContain('提示词 1 条')
    expect(text).toContain('canvas.system.v1')
    expect(text).toContain('声明能力：canvas.document（不代表实际执行）')
    expect(text).toContain('整轮工具调用')
    expect(text).toContain('记录未区分具体模块归属')
    expect(text).toContain('历史固定策略')
    expect(text).not.toContain('本消息选择')
  })

  test('Given 同名工具有成功失败和未返回 When 汇总 Then 精确计数并优先展示异常', () => {
    /** 同名调用的三种状态必须独立计数，未返回结果不能显示全部完成。 */
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, tools: [
      { toolUseId: 'read-1', toolName: 'read', status: 'completed' },
      { toolUseId: 'read-2', toolName: 'read', status: 'completed' },
      { toolUseId: 'bash-1', toolName: 'Bash', status: 'failed' },
      { toolUseId: 'bash-2', toolName: 'Bash', status: 'completed' },
      { toolUseId: 'bash-3', toolName: 'Bash', status: 'started' },
    ] }} />)
    expect(toolRows(html)).toEqual(['Bash3 次完成 1失败 1未收到结果 1', 'read2 次完成 2'])
    expect(textContent(html)).toContain('只看失败')
    expect(textContent(html)).toContain('查看调用明细')
    expect(textContent(html)).not.toContain('全部完成')
  })

  test('Given 旧记录和更新后的模块目录 When 展示 Then 历史名称优先且缺失名称回退到目录', () => {
    /** 目录可以为旧快照补充中文标签，但不能覆盖已记录的名称和版本。 */
    const moduleNames = new Map([['canvas', '新画布名称']])
    expect(renderToStaticMarkup(<AgentModuleRunAuditDetails audit={audit} moduleNames={moduleNames} />)).toContain('aria-label="模块 画布"')
    expect(renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, modules: [{ ...audit.modules[0]!, displayName: undefined }] }} moduleNames={moduleNames} />)).toContain('aria-label="模块 新画布名称"')
    expect(renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, modules: [{ ...audit.modules[0]!, displayName: undefined }] }} />)).toContain('aria-label="模块 canvas"')
  })

  test('Given Skill 只有声明或来自其他版本 When 展示 Then 不冒认成功加载或判定失败', () => {
    /** 错版 Skill 不能充当本轮模块的加载证据。 */
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, activatedSkills: [{ ...audit.activatedSkills[0]!, moduleVersion: '0.9.0' }] }} />)
    expect(textContent(html)).toContain('Skills 已加载 0/1')
    expect(textContent(html)).toContain('尚无 Skill 成功加载记录')
    expect(textContent(html)).not.toContain('本轮未成功加载')
  })

  test('Given 同名 Skill 被不同模块共享 When 展示 Then 仅匹配各模块自己的激活事实', () => {
    /** 共享 slug 不足以把成功加载归到另一个未记录激活的模块。 */
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, modules: [audit.modules[0]!, { ...audit.modules[0]!, moduleId: 'second', displayName: '第二模块' }] }} />)
    expect(textContent(html)).toContain('Skills 已加载 1/1')
    expect(textContent(html)).toContain('Skills 已加载 0/1')
  })

  test('Given 无模块无工具 When 展示 Then 显示普通运行空状态而非模块失败', () => {
    /** 空模块运行仍是当前会话正常的可查询记录。 */
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, modules: [], activatedSkills: [], tools: [] }} />)
    expect(textContent(html)).toContain('本轮未选择模块')
    expect(textContent(html)).toContain('本轮无工具调用记录')
    expect(textContent(html)).not.toContain('模块未能接入')
  })

  test('Given 不可用模块及截断 When 展示 Then 提供可读原因并说明计数只包含部分记录', () => {
    /** 失败原因显示中文，原错误码保留在诊断区便于排查。 */
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, modules: [], activatedSkills: [], tools: [], truncated: true,
      unavailable: [{ moduleId: 'canvas', reason: 'AGENT_MODULE_DISABLED' }] }} />)
    expect(textContent(html)).toContain('模块已禁用')
    expect(textContent(html)).toContain('AGENT_MODULE_DISABLED')
    expect(textContent(html)).toContain('记录已达到展示上限')
    expect(textContent(html)).toContain('数量仅统计已展示部分')
  })

  test('Given 多选模块中部分不可用 When 展示 Then 不把已解析的模块冒充已接入模型', () => {
    /** 编排层先保存解析快照再拒绝整轮，必须保留解析与执行的区别。 */
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, status: 'failed', activatedSkills: [], tools: [],
      unavailable: [{ moduleId: 'missing', reason: 'AGENT_MODULE_NOT_FOUND' }] }} />)
    expect(html).toContain('aria-label="本轮解析模块"')
    expect(textContent(html)).toContain('以下模块已解析，但本轮仍有模块不可用，接入未完成。')
    expect(textContent(html)).toContain('声明提示词 1 条')
  })

  test('Given 没有终态且时间非法 When 展示 Then 不宣称运行仍活跃也不崩溃', () => {
    /** 有限但超出 Date 上限的数字同样需要安全回退。 */
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, status: 'running', startedAt: 1e20 }} />)
    expect(textContent(html)).toContain('时间未知')
    expect(textContent(html)).toContain('尚无结束记录')
    expect(textContent(html)).not.toContain('运行中')
  })

  test('Given 历史运行默认收起 When 渲染 Then 保留摘要但不挂载模块和工具长明细', () => {
    /** 旧轮次不一次性渲染所有明细，降低长会话 DOM 体积。 */
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={audit} defaultExpanded={false} />)
    expect(html).toContain('aria-expanded="false"')
    expect(textContent(html)).toContain('画布 · 工具 1 次')
    expect(html).not.toContain('aria-label="模块 画布"')
    expect(html).not.toContain('audit-tool-summary')
  })
})
