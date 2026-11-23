import { describe, expect, test } from 'bun:test'
import { collectSuccessfulSkillReadActivations, createSkillActivationFromPath } from './skill-usage'

describe('Skill 激活来源归因', () => {
  test('Given 全局或内置 Skill 被当前 query 加载 When 记录激活 Then 不写入 workspace locator', () => {
    const globalActivation = createSkillActivationFromPath(
      '/Users/test/.DutyDeck/skills/notes/SKILL.md',
      'explicit',
      'notes',
      'project-a',
      ['/Users/test/.DutyDeck/agent-workspaces/project-a/skills'],
    )
    const workspaceActivation = createSkillActivationFromPath(
      '/Users/test/.DutyDeck/agent-workspaces/project-a/skills/notes/SKILL.md',
      'explicit',
      'notes',
      'project-a',
      ['/Users/test/.DutyDeck/agent-workspaces/project-a/skills'],
    )

    expect(globalActivation).not.toHaveProperty('workspaceSlug')
    expect(workspaceActivation).toEqual(expect.objectContaining({
      workspaceSlug: 'project-a',
      workspaceSkillPath: 'notes/SKILL.md',
    }))
  })
})


describe('Skill Read 回退激活归因', () => {
  test('Given 当前 query 的目录快照 When Read 成功加载项目或全局 Skill Then 只给真实工作区目录写 locator', () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'project-read', name: 'Read', input: { file_path: '/Users/demo/project/.dutydeck/skills/notes/SKILL.md' } },
            { type: 'tool_use', id: 'global-read', name: 'Read', input: { file_path: '/Users/demo/.DutyDeck/skills/research/SKILL.md' } },
            { type: 'tool_use', id: 'workspace-read', name: 'Read', input: { file_path: '/Users/demo/.DutyDeck/agent-workspaces/project-a/skills/canvas/SKILL.md' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'project-read', is_error: false },
            { type: 'tool_result', tool_use_id: 'global-read', is_error: false },
            { type: 'tool_result', tool_use_id: 'workspace-read', is_error: false },
          ],
        },
      },
    ] as never[]

    const activations = collectSuccessfulSkillReadActivations(messages, {
      workspaceSlug: 'project-a',
      workspaceSkillDirectories: ['/Users/demo/.DutyDeck/agent-workspaces/project-a/skills/canvas'],
    })

    expect(activations).toEqual([
      expect.objectContaining({ slug: 'notes', sources: ['read'] }),
      expect.objectContaining({ slug: 'research', sources: ['read'] }),
      expect.objectContaining({
        slug: 'canvas',
        workspaceSlug: 'project-a',
        workspaceSkillPath: 'canvas/SKILL.md',
        sources: ['read'],
      }),
    ])
    expect(activations[0]).not.toHaveProperty('workspaceSlug')
    expect(activations[1]).not.toHaveProperty('workspaceSlug')
  })

  test('Given Read 失败 When 收集 Skill 激活 Then 不产生激活记录', () => {
    const activations = collectSuccessfulSkillReadActivations([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'failed-read', name: 'Read', input: { file_path: '/Users/demo/.DutyDeck/agent-workspaces/project-a/skills/canvas/SKILL.md' } }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'failed-read', is_error: true }] },
      },
    ] as never[], {
      workspaceSlug: 'project-a',
      workspaceSkillDirectories: ['/Users/demo/.DutyDeck/agent-workspaces/project-a/skills/canvas'],
    })

    expect(activations).toEqual([])
  })
})
