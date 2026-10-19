import type * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@dutydeck/ui'
import { copyTextToClipboard } from '@/lib/clipboard'
import { SettingsCard } from './primitives'
// 将创建说明随应用打包，离线可读；不依赖插件目录或在线文档服务。
import creationGuide from './plugin-creation-guide.md?raw'

/** 无入参；返回插件作者指南，复用代码块的复制功能，不执行展示的命令。 */
export function PluginCreationGuide(): React.ReactElement {
  return <section aria-label="创建插件指南" className="min-w-0">
    <SettingsCard divided={false}>
      <div className="min-w-0 p-5 sm:p-6">
        <div className="prose prose-sm dark:prose-invert max-w-none break-words text-sm prose-headings:font-semibold prose-h2:mt-8 prose-h2:text-base prose-h3:text-sm prose-p:leading-7 prose-li:leading-7 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              // 代码块只复制正文，沿用宿主剪贴板回退与错误反馈。
              pre: ({ children }) => <CodeBlock onCopy={copyTextToClipboard}>{children}</CodeBlock>,
            }}
          >
            {creationGuide}
          </Markdown>
        </div>
      </div>
    </SettingsCard>
  </section>
}
