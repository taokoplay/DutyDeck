import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentModuleRunAudit } from '@dutydeck/shared'
import { AgentModuleRunAuditDetails } from './AgentModuleRunAuditView'

/** 固定审计快照用于验证真实组件的用户可见语义。 */
const audit: AgentModuleRunAudit = {
  sessionId: 'session', runId: 'run-1', policyMode: 'pinned', policyRevision: 3, startedAt: 1,
  modules: [{ moduleId: 'canvas', moduleVersion: '1.0.0', mode: 'pinned', sessionId: 'session', policyRevision: 3, activatedAt: 1,
    skillRefs: ['canvas-skill'], promptRefs: ['canvas.system.v1'], declaredCapabilities: ['canvas.document'] }],
  activatedSkills: [], unavailable: [], tools: [{ toolUseId: 'call', toolName: 'read', status: 'completed' }], status: 'completed', truncated: false,
}

describe('模块审计展示', () => {
  test('Given 模块声明和真实工具 When 渲染 Then 展示独立来源且不把提供 Skill 冒充已加载', () => {
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={audit} />)
    expect(html).toContain('run-1')
    expect(html).toContain('策略 v3')
    expect(html).toContain('canvas.system.v1')
    expect(html).toContain('声明能力：canvas.document')
    expect(html).toContain('本轮实际工具：read（完成）')
    expect(html).toContain('无成功加载记录')
  })
  test('Given 不可用和截断 When 渲染 Then 明确显示阻断原因和预算限制', () => {
    const html = renderToStaticMarkup(<AgentModuleRunAuditDetails audit={{ ...audit, modules: [], tools: [], truncated: true,
      unavailable: [{ moduleId: 'canvas', reason: 'AGENT_MODULE_DISABLED' }] }} />)
    expect(html).toContain('AGENT_MODULE_DISABLED')
    expect(html).toContain('无工具调用记录')
    expect(html).toContain('已达到条数上限')
  })
})
