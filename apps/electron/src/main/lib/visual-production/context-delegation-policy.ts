import type { AgentRunExtensions } from '../agent-run-extensions'

/**
 * 受限检查来源必须跨进程/重启保存，普通继续入口不能重新获得通用工具。
 * @param session 已持久化的会话来源，仅宿主能签发。
 * @param extensions 当前真实运行的内部合同，不能由renderer提交。
 * @returns 校验通过不返回内容；恢复或扩权时明确拒绝。
 */
export function assertVisualReviewRun(session: { sourceVisualReviewRunId?: string }, extensions: AgentRunExtensions): void {
  if (!session.sourceVisualReviewRunId) return
  const names = extensions.allowedToolNames
  if (extensions.visualTaskContextPolicy?.runId !== session.sourceVisualReviewRunId || extensions.skillsMode !== 'disabled'
    || extensions.allowedToolNamesMode !== 'replace' || !extensions.beforeToolCall || !names || names.length !== 2
    || !names.includes('visual_production_inspect_media') || !names.includes('visual_production_record_observation')) {
    throw new Error('VISUAL_REVIEW_RESUME_DENIED: 此会话是固定范围的影像检查记录，请从主会话重新打开目标并发起新的检查，不可用普通续跑恢复授权。')
  }
}
