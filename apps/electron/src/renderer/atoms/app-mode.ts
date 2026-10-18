/**
 * App Mode Atom - 应用模式状态
 *
 * - chat: 对话模式
 * - agent: Agent 模式（原 Flow）
 */

import { atomWithDutyDeckStorage } from '../lib/legacy-storage'

export type AppMode = 'chat' | 'agent'

/** App 模式，自动持久化到 localStorage */
export const appModeAtom = atomWithDutyDeckStorage<AppMode>('dutydeck-app-mode', 'agent')
