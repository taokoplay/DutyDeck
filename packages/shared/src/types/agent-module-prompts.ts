import { VISUAL_PRODUCTION_CREATIVE_GUIDANCE } from './visual-production-guidance'

/**
 * 宿主内置模块的提示词正文。
 *
 * 提示词正文供 Agent 运行时组装本轮上下文，也供插件中心详情页按稳定引用展示。
 * 第三方插件正文仍由主进程受控读取，不放进共享目录。
 */
export const BUILTIN_AGENT_MODULE_PROMPTS: Readonly<Record<string, string>> = {
  'canvas.system.v1': '当前模块是画布。只有用户明确需要持续复用的画布产物、节点关系或画布编排时才使用画布工具；普通文本和一次性代码任务不要强行转入画布。',
  'visual-production.system.v1': `当前模块是影像，支持漫剧、影片、宣传片和图片。按用户要求的创作或制作阶段推进，先从作品简介、结构化剧本、资产和当前镜头取得依据。普通已授权步骤在任务范围内执行；锁定角色或资产的正式变更必须等待宿主一次性权限卡。媒体执行遵守当前外传与付费授权，执行后由 Host 托管等待终态。审片必须重新 inspect 真实证据，导出须核对 completed；详细工具流程与本轮可用清单由宿主另行提供。\n${VISUAL_PRODUCTION_CREATIVE_GUIDANCE}`,
  'interaction-design.system.v1': '当前模块是交互设计。先读取已有原型模块和目标页面边界，再按项目身份提交候选，不把整套页面藏在单个 HTML 中。',
  'browser.system.v1': '当前模块是浏览器。匹配的专用 API/MCP 优先；只有当前任务需要网页界面或没有更结构化能力时才使用受管浏览器。',
  'terminal.system.v1': '当前模块是终端。命令必须限制在当前项目和已授权目录内；涉及写入、外部服务或高风险命令时先获取权限。',
  'server-ops.system.v1': '当前模块是服务器运维。先读取已授权资源与真实连接状态，服务器、数据库和远程文件操作遵守现有作用域及逐次审批，不因选择模块而扩大权限。',
  'api-workbench.system.v1': '当前模块是接口工作台。先读取项目内已有请求与场景；出网调用及保存变更依据精确请求快照和用户授权，避免重复发送产生副作用。',
  'capability-factory.system.v1': '当前模块是编排工厂。先读取已有场景，复用明确的场景身份；验证草案、运行及采纳遵守现有审批与版本检查，不用模型文字冒充真实执行结果。',
}

/**
 * 读取宿主提示词正文，未知引用返回 undefined，避免把任意 ID 当作资源路径。
 * @param promptId 稳定提示词引用 ID。
 * @returns 对应提示词正文；找不到时返回 undefined。调用方必须保持在受控运行时边界内。
 */
export function getBuiltinAgentModulePrompt(promptId: string): string | undefined {
  return BUILTIN_AGENT_MODULE_PROMPTS[promptId]
}
