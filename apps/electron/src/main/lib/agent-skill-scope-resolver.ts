/**
 * Agent Skill 作用域解析器。
 *
 * 只负责把多个受管 Skill 根按优先级解析为一组唯一的 Skill 目录，
 * 不负责启用/禁用、编辑或迁移。这样可以先接入多作用域读取，再逐步
 * 将现有工作区中的默认副本迁移为引用，避免一次改动破坏用户数据。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Skill 的来源作用域，顺序同时代表同名 Skill 的覆盖优先级。 */
export type AgentSkillScope = 'project' | 'workspace' | 'global' | 'builtin'

/** 一个受管 Skill 根目录及其作用域。 */
export interface AgentSkillScopeRoot {
  /** 作用域名称。 */
  scope: AgentSkillScope
  /** 该作用域的 Skills 根目录。 */
  path: string
}

/** 多作用域解析输入。 */
export interface AgentSkillScopeInput {
  /** 项目根目录；项目级 Skill 位于其下的 .dutydeck/skills。 */
  projectRoot: string
  /** DutyDeck 管理的当前工作区根目录。 */
  workspaceRoot: string
  /** 活动数据根下的用户全局 Skills 目录。 */
  globalSkillsRoot: string
  /** 活动数据根下的应用内置 Skills 目录。 */
  builtinSkillsRoot: string
}

/**
 * 按项目 > 工作区 > 用户全局 > 应用内置的顺序返回 Skill 根目录。
 *
 * 目录本身不在这里创建；不存在的根会被 Pi 资源加载器自然忽略，
 * 这样解析过程不会因为“查看能力”而产生额外写入。
 */
export function buildAgentSkillScopeRoots(input: AgentSkillScopeInput): AgentSkillScopeRoot[] {
  const candidates: AgentSkillScopeRoot[] = [
    { scope: 'project', path: join(input.projectRoot, '.dutydeck', 'skills') },
    { scope: 'workspace', path: join(input.workspaceRoot, 'skills') },
    { scope: 'global', path: input.globalSkillsRoot },
    { scope: 'builtin', path: input.builtinSkillsRoot },
  ]

  const seen = new Set<string>()
  return candidates.filter((root) => {
    const normalized = resolve(root.path)
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

/** 判断路径是否为可扫描的目录，软链接目录沿用 Pi 的可读语义。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 从各作用域中选出最终传给 Pi 的 Skill 目录。
 *
 * Pi 的显式 Skill 路径采用“先加载者获胜”规则。这里提前按 slug 去重，
 * 既保留作用域优先级，也避免旧工作区副本与 default-skills 同时加载时产生
 * 大量预期内 collision 诊断。
 */
export function resolveAgentSkillDirectories(roots: readonly AgentSkillScopeRoot[]): string[] {
  const selected = new Map<string, string>()

  for (const root of roots) {
    if (!isDirectory(root.path)) continue

    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const skillPath = join(root.path, entry.name)
      if (!isDirectory(skillPath) || !existsSync(join(skillPath, 'SKILL.md'))) continue
      if (!selected.has(entry.name)) selected.set(entry.name, skillPath)
    }
  }

  return [...selected.values()]
}
