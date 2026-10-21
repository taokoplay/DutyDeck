import { Type } from 'typebox'
import type { CanvasToolRun, CanvasToolRunContext } from '../design/canvas-tool-provider'

/** 各模块共用的宿主媒体入口；工厂只装配工具，不读取凭据或提交生成。 */
export interface MediaToolProviderRuntime {
  createRun: (context: CanvasToolRunContext) => CanvasToolRun
}

/** 当前注册代次随清理函数校验，防止旧窗口清理新服务。 */
let registration: { owner: symbol; runtime: MediaToolProviderRuntime } | undefined

/** 注册主进程媒体工厂，返回只清理当前代次的函数。 */
export function registerMediaToolProviderRuntime(runtime: MediaToolProviderRuntime): () => void {
  const owner = Symbol('media-runtime')
  registration = { owner, runtime }
  return () => { if (registration?.owner === owner) registration = undefined }
}

/** 取得已注册的宿主服务；未初始化时由调用方提供明确诊断。 */
export function getMediaToolProviderRuntime(): MediaToolProviderRuntime | undefined {
  return registration?.runtime
}

/** 未绑定项目或服务未就绪时返回只读诊断工具，不扩大运行权限。 */
export function createUnavailableMediaToolRun(code: 'MEDIA_PROJECT_REQUIRED' | 'MEDIA_SERVICE_UNAVAILABLE'): CanvasToolRun {
  const message = code === 'MEDIA_PROJECT_REQUIRED'
    ? '请先为当前 Agent 对话选择项目，生成素材将保存到该项目媒体库。'
    : '媒体生成服务尚未就绪，请稍后重试。'
  return {
    systemPromptAppend: `图片、音频和视频应调用宿主媒体生成工具。${message}不要读取渠道配置、解密凭据或编写绕过宿主的请求脚本；入口不可用不能说明密钥无效。`,
    piCustomTools: [{
      name: 'media_list_models', label: '检查媒体生成入口', description: message,
      parameters: Type.Object({}),
      execute: async () => {
        const details = { models: [], nextOffset: null, error: { code, message } }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      },
    }],
    allowedToolNames: ['media_list_models'], allowedToolNamesMode: 'extend',
    readOnlyToolNames: ['media_list_models'], singleApprovalToolNames: [],
  }
}
