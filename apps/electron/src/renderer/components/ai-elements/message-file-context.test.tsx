import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import * as fileUtils from './file-path-chip-utils'

// 只替换文件解析 IPC 边界，保留 Markdown 与消息上下文的真实渲染链。
interface ProbeProps { filePath: string; basePaths?: string[]; sessionId?: string | null }
function ChipProbe(props: ProbeProps): React.ReactElement {
  return <span data-file={props.filePath} data-session={props.sessionId === null ? 'none' : props.sessionId} data-bases={props.basePaths?.join(',')} />
}
mock.module('./file-path-chip', () => ({ ...fileUtils, FilePathChip: ChipProbe, ResolvableFilePathChip: ChipProbe }))
const { BasePathsProvider, MessageResponse, remarkMentions } = await import('./message')

describe('消息文件引用上下文', () => {
  test('Given 全局会话 A 与嵌入消息 B When 渲染链接、行内路径和图片引用 Then 全部使用 B 与其候选根', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'A')
    const html = renderToStaticMarkup(<Provider store={store}>
      <BasePathsProvider sessionId="B" basePaths={['/project-B', '/extra-B']}>
        <MessageResponse remarkPlugins={[remarkMentions]}>{'[文档](docs/readme.md)\n\n`src/main.ts`\n\n@file:picture.png'}</MessageResponse>
      </BasePathsProvider>
    </Provider>)
    expect((html.match(/data-session="B"/g) ?? []).length).toBe(3)
    expect((html.match(/data-bases="\/project-B,\/extra-B"/g) ?? []).length).toBe(3)
  })
  test('Given 明确无所属会话 When 渲染文件 Then 显式传 null 而非退回 A', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'A')
    const html = renderToStaticMarkup(<Provider store={store}><BasePathsProvider sessionId={null}>
      <MessageResponse>{'[文档](/docs/readme.md)'}</MessageResponse>
    </BasePathsProvider></Provider>)
    expect(html).toContain('data-session="none"')
  })
  test('Given MessageResponse 自带 cwd When 渲染相对链接 Then 与上下文目录合并', () => {
    const html = renderToStaticMarkup(<BasePathsProvider sessionId="B" basePaths={['/extra-B']}>
      <MessageResponse basePath="/cwd-B">{'[文档](docs/readme.md)'}</MessageResponse>
    </BasePathsProvider>)
    expect(html).toContain('data-bases="/cwd-B,/extra-B"')
  })
})
