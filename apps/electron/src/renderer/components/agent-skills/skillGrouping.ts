import type { SkillMeta } from '@proma/shared'

export interface SkillGroup {
  id: string
  title: string
  skills: SkillMeta[]
}

const UNGROUPED_TITLE = '未分组'

function normalizeGroup(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

/** 接收原始分类名并返回显示标题，将旧品牌分类显示为“应用能力”。 */
export function getSkillGroupDisplayTitle(group: string): string {
  return normalizeGroup(group).toLowerCase() === 'proma' ? '应用能力' : group
}

export function getSkillGroupTitle(skill: SkillMeta): string {
  if (skill.group) {
    const group = normalizeGroup(skill.group)
    if (group) return group
  }

  return UNGROUPED_TITLE
}

export function groupSkills(skills: SkillMeta[]): SkillGroup[] {
  const groups = new Map<string, SkillMeta[]>()

  for (const skill of skills) {
    const title = getSkillGroupTitle(skill)
    const group = groups.get(title) ?? []
    group.push(skill)
    groups.set(title, group)
  }

  return [...groups.entries()]
    .map(([title, groupSkills]) => ({
      id: title.toLowerCase(),
      title: getSkillGroupDisplayTitle(title),
      skills: groupSkills,
    }))
    .sort((a, b) => compareGroupTitle(a.title, b.title))
}

function compareGroupTitle(a: string, b: string): number {
  if (a === UNGROUPED_TITLE && b !== UNGROUPED_TITLE) return 1
  if (b === UNGROUPED_TITLE && a !== UNGROUPED_TITLE) return -1
  return a.localeCompare(b, 'zh-CN')
}
