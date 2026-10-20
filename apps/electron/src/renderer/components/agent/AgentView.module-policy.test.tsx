import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentSendInput } from '@dutydeck/shared'

interface MinimalEventTarget {
  addEventListener: () => void
  removeEventListener: () => void
}

/** 创建只承载返回 null 的 Hook Probe 的最小 DOM 宿主。 */
function createHookRoot(): {
  render: (node: React.ReactElement) => void
  unmount: () => void
  restore: () => void
} {
  const eventTarget: MinimalEventTarget = { addEventListener: () => undefined, removeEventListener: () => undefined }
  class FakeHtmlIFrameElement {}
  const fakeWindow = { ...eventTarget, event: undefined, HTMLIFrameElement: FakeHtmlIFrameElement }
  const fakeDocument = {
    ...eventTarget,
    nodeType: 9,
    defaultView: fakeWindow,
    activeElement: null,
    body: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  }
  const container = {
    ...eventTarget,
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument,
  }
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT
  globals.window = fakeWindow
  globals.document = fakeDocument
  globals.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(container as unknown as Element)
  return {
    render: (node) => { root.render(node) },
    unmount: () => { root.unmount() },
    restore: () => {
      globals.window = previousWindow
      globals.document = previousDocument
      globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    },
  }
}



/** 提取完整真实 useCallback（含依赖数组），只隔离编辑器、文件和 IPC 边界。 */
function extractSendCallback(): { expression: string; dependencies: string[] } {
  /** 保留真实发送函数和依赖数组，测试不重写被测行为。 */
  const source = ts.createSourceFile('AgentView.tsx', readFileSync(new URL('./AgentView.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression = ''
  let dependencies: string[] = []
  /** 遍历 AST 定位发送回调定义。 */
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSend' && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.getText(source)
      const array = node.initializer.arguments[1]
      if (array && ts.isArrayLiteralExpression(array)) dependencies = array.elements.map(item => item.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('未找到真实发送回调')
  return { expression: ts.transpileModule(expression, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, dependencies }
}

for (const streaming of [false, true]) {
  test(`Given 模块策略独立更新 When ${streaming ? '排队' : '普通'}发送 Then IPC 使用更新后的 revision`, async () => {
    /** 同一 React 根重渲染，其他依赖保持身份稳定。 */
    const host = createHookRoot()
    const extracted = extractSendCallback()
    const requests: AgentSendInput[] = []
    const noOp = (): void => {}
    const emptyMentions = { cleanedText: 'hello', mentionedSkills: [], moduleIds: [], mentionedMcpServers: [], mentionedSessionIds: [], mentionedServerOpsReferences: [], mentionedTodoIds: [], mentionedCalendarEventIds: [], mentionedMediaModelRefs: [] }
    /** 未执行的 React setter 作为边界桩；实际 payload 仍由真实 handleSend 构造。 */
    const bindings: Record<string, unknown> = Object.fromEntries(extracted.dependencies.map(name => [name, noOp]))
    Object.assign(bindings, {
      React, sessionId: 'session', streaming, backgroundWaiting: false, suggestion: '',
      messagesLoaded: true, hasAvailableModel: true, isStopping: false, isLegacyTranscript: false,
      agentChannelId: 'channel', agentModelId: 'model', currentWorkspaceId: 'workspace',
      agentChannelProvider: 'openai', permissionMode: 'default',
      pendingFilesRef: { current: [] }, messagesRefreshingRef: { current: false },
      agentSessionDraftsAtom: 'drafts', agentSessionsAtom: 'sessions', stoppedByUserSessionsAtom: 'stopped',
      agentCanvasNodeReferencesAtomFamily: () => 'refs', visualProductionReferencesAtomFamily: () => 'refs',
      store: { get: (key: string) => key === 'drafts' ? new Map() : [], set: noOp },
      synchronizeCanvasBeforeSend: async () => {}, createBaseAdditionalDirectories: () => new Set(),
      consumeQuotedSelection: () => undefined, getMediaAttachments: () => undefined,
      expandAgentHistoryQuoteMentions: (text: string) => text, parseQueuedMessageMentions: () => emptyMentions,
      resolveAgentSendToolMode: () => 'default', appendOptimisticPersistedMessage: noOp,
      setDraftSessionIds: noOp, setAgentSessions: noOp,
      createAgentQueuedMessage: () => ({ id: 'queued' }),
      buildQueuedMessageSendPayload: () => ({ sdkText: 'hello', rawText: 'hello', mentions: emptyMentions }),
      window: { electronAPI: {
        sendAgentMessage: async (input: AgentSendInput) => { requests.push(input) },
        submitOrEnqueueAgentMessage: async (input: AgentSendInput) => { requests.push(input) },
      } },
    })
    /** 每次 render 独立捕获策略对象；真实 React 决定是否复用旧闭包。 */
    let send: (text: string) => Promise<void> = async () => {}
    function Probe({ revision }: { revision: number }): null {
      const scope = { ...bindings, modulePolicy: { revision } }
      send = new Function(...Object.keys(scope), `return ${extracted.expression}`)(...Object.values(scope)) as typeof send
      return null
    }
    try {
      await act(async () => { host.render(<Probe revision={1} />) })
      await act(async () => { host.render(<Probe revision={2} />) })
      await send('hello')
      expect(requests).toHaveLength(1)
      expect(requests[0]?.modulePolicyRevision).toBe(2)
    } finally {
      await act(async () => { host.unmount() })
      host.restore()
    }
  })
}
