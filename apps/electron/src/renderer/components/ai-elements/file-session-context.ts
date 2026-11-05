import { createContext, useContext } from 'react'
import { useAtomValue } from 'jotai'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'

/** undefined 沿用外层/当前会话，null 明确表示没有所属会话。 */
export const FileSessionContext = createContext<string | null | undefined>(undefined)

export function useFileSessionId(explicitSessionId?: string | null): string | null {
  const contextSessionId = useContext(FileSessionContext)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  if (explicitSessionId !== undefined) return explicitSessionId
  if (contextSessionId !== undefined) return contextSessionId
  return currentSessionId
}
