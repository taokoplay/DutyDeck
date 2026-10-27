/**
 * 构造 Agent 全局历史语义搜索提示词。
 *
 * @param query 用户输入的历史内容描述。
 * @param activeRoot 主进程已解析的活动数据根，不能使用写死的旧目录。
 * @returns 指向当前 Chat 与 Agent 会话文件的搜索提示词。
 */
export function buildAgentHistorySearchPrompt(query: string, activeRoot: string): string {
  /** 去掉数据根末尾分隔符，再按该路径自身的格式补齐子目录。 */
  const normalizedRoot = activeRoot.replace(/[\\/]+$/, '')
  /** Windows 自定义根通常使用反斜杠，其余平台使用正斜杠。 */
  const separator = normalizedRoot.includes('\\') ? '\\' : '/'
  const conversationsDir = `${normalizedRoot}${separator}conversations${separator}`
  const agentSessionsDir = `${normalizedRoot}${separator}agent-sessions${separator}`

  return `请帮我在 DutyDeck 的全部会话历史中搜索与以下描述相关的内容：

"${query}"

搜索范围：
- Chat 会话消息文件：${conversationsDir} 目录下所有 .jsonl 文件
- Agent 会话消息文件：${agentSessionsDir} 目录下所有 .jsonl 文件

要求：
1. 理解用户描述的语义，不要求关键词完全匹配，根据内容相关性判断
2. 找到相关会话后，给出会话标题、相关内容摘要，以及文件路径
3. 按相关性排序，最相关的结果排在最前面`
}
