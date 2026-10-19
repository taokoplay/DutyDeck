import canvasMarkdown from './module-documents/canvas.md?raw'
import visualProductionMarkdown from './module-documents/visual-production.md?raw'
import interactionDesignMarkdown from './module-documents/interaction-design.md?raw'
import serverOpsMarkdown from './module-documents/server-ops.md?raw'
import apiWorkbenchMarkdown from './module-documents/api-workbench.md?raw'
import capabilityFactoryMarkdown from './module-documents/capability-factory.md?raw'

/**
 * 内置专业模块的用户说明。
 *
 * 说明正文使用独立 Markdown 文件维护；提示词运行时正文由共享宿主定义提供，
 * 详情页单独展示真实受控正文，同时保留用途说明和稳定引用，避免混淆资源身份。
 */
export interface BuiltinModuleResourceDocumentation {
  title: string
  description: string
}

export interface BuiltinModuleExample {
  title: string
  prompt: string
}

export interface BuiltinModuleDocumentation {
  /** 面向用户的完整说明文档；详情页直接渲染该 Markdown。 */
  markdown: string
  summary: string
  useCases: string[]
  workflow: string[]
  requirements: string[]
  capabilities: string[]
  artifacts: string[]
  limitations: string[]
  promptDescriptions: Record<string, BuiltinModuleResourceDocumentation>
  skillDescriptions: Record<string, BuiltinModuleResourceDocumentation>
  examples: BuiltinModuleExample[]
}

/** 统一展示权限的中文含义；未知权限仍会在详情中保留原始 ID。 */
export const BUILTIN_PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'project.files.read': '读取当前项目文件',
  'project.files.write': '写入当前项目文件',
  'media.execute': '执行媒体生成或处理任务',
  'network.request': '访问已授权的网络或远程资源',
  'process.spawn': '在受管项目边界内启动命令',
}

/** 六个内置专业模块的可读说明；键必须与宿主模块 ID 保持稳定一致。 */
export const BUILTIN_MODULE_DOCUMENTATION: Readonly<Record<string, BuiltinModuleDocumentation>> = {
  canvas: {
    markdown: canvasMarkdown,
    summary: '把需要持续迭代的页面、素材、文档和流程整理成可复用的画布，并保留节点关系与版本线索。',
    useCases: ['整理需要长期维护的素材、文档或页面关系', '把多个产物组织成节点、连接和可复用的工作流', '检查画布版本、节点来源或提交一组结构化变更'],
    workflow: ['确认目标项目和画布边界', '读取现有节点、关系、版本和来源', '按用户意图新增或修改节点，保留可追溯关系', '提交变更供用户检查和采纳'],
    requirements: ['当前消息明确选择「画布」', '已选择项目，且项目文件读写权限可用', '任务确实需要持续复用的画布产物；一次性文本不必启用'],
    capabilities: ['读取和检查画布结构', '创建或更新画布节点及节点关系', '保留来源、版本和变更边界，便于后续复用'],
    artifacts: ['画布文档', '画布节点', '节点关系与版本记录'],
    limitations: ['不会因选择画布而自动启用影像或其他专业模块', '不会把模型文字描述当成已经写入画布的真实结果', '覆盖、删除或改变既有关系的操作仍需用户确认'],
    promptDescriptions: {
      'canvas.system.v1': { title: '只在确需持续复用时使用画布', description: '普通问答、一次性代码和短文本任务留在消息中；只有需要节点关系、持续迭代或画布编排时才使用画布工具。' },
    },
    skillDescriptions: {
      'canvas-production': { title: '画布生产', description: '负责画布上下文、节点关系、版本和审查流程，确保画布变更能被复用和追踪。' },
      'media-models': { title: '媒体模型目录', description: '供画布媒体任务发现可用模型并执行生成流程；执行仍遵守媒体授权策略，无需另选影像创作模块。' },
    },
    examples: [{ title: '整理素材关系', prompt: '把这组图片、文档和说明整理成一个可持续维护的项目画布，并保留来源关系。' }, { title: '维护节点流程', prompt: '读取当前画布，检查节点关系是否完整，提出需要我确认的结构调整。' }],
  },
  'visual-production': {
    markdown: visualProductionMarkdown,
    summary: '根据当前真实可用的模型和配置生成、评审并交付图片、视频或音频等媒体产物。',
    useCases: ['生成或编辑图片、视频、语音和音频', '比较不同模型或配置的媒体结果', '对已有媒体做评审、变体和交付整理'],
    workflow: ['读取当前媒体模型和连接配置', '确认输入素材、任务归属和输出要求', '执行生成或编辑，并记录真实来源', '展示结果供用户评审、重做或交付'],
    requirements: ['已选择项目，并在当前消息明确选择「影像创作」', '已配置至少一个可执行的媒体模型或服务', '使用参考素材时需有素材访问权限；生成任务需满足媒体执行授权'],
    capabilities: ['发现真实可用的图片、视频和音频模型', '提交媒体生成、编辑和评审任务', '记录任务来源、输入和输出，支持后续复核'],
    artifacts: ['图片', '视频', '音频或语音', '生成任务与评审记录'],
    limitations: ['不会猜测模型名称、供应商或未配置的能力', '没有可执行模型时会明确报告原因，不会用占位结果冒充生成成功', '媒体任务可能产生外部调用或资源消耗，执行前需满足当前授权'],
    promptDescriptions: {
      'visual-production.system.v1': { title: '先发现真实模型和配置', description: '执行媒体任务前先读取当前可用模型、配置和来源，避免使用过期模型名或猜测服务能力。' },
    },
    skillDescriptions: {
      'media-models': { title: '媒体模型与生成流程', description: '根据当前配置选择图片、视频、语音和音频能力，并按受管输入、输出和评审合同执行。' },
    },
    examples: [{ title: '生成一组产品图', prompt: '使用当前可用的图片模型，为这个产品生成三种构图方向，并保留每张图的模型和参数来源。' }, { title: '把图片做成短视频', prompt: '检查当前可用的视频模型，把这张图片生成一段 6 秒产品展示视频，先告诉我可用配置再执行。' }],
  },
  'interaction-design': {
    markdown: interactionDesignMarkdown,
    summary: '生成、还原和迭代可点击的 App/Web 原型，帮助验证页面结构、交互路径和视觉方向。',
    useCases: ['从需求快速建立可点击的 App 或 Web 原型', '读取已有原型并针对页面或交互路径迭代', '在真实设备尺寸和页面边界内验证设计方案'],
    workflow: ['确认项目、原型和目标页面边界', '读取已有页面、组件和交互上下文', '提出或生成候选变更，保留页面级身份', '检查候选差异并按当前授权采纳；采纳前校验版本，避免覆盖人工修改'],
    requirements: ['当前消息明确选择「交互设计」', '已选择项目；新建或修改已有原型需要项目文件权限', '明确目标平台、页面范围和需要验证的交互路径'],
    capabilities: ['读取原型、页面和可交互元素', '生成页面候选、交互路径和视觉调整建议', '在手机、桌面和浏览器视口中预览原型'],
    artifacts: ['交互原型', '原型页面', '交互候选和页面变更记录'],
    limitations: ['生成候选与采纳是两个步骤；Agent 可按授权自动采纳，正式原型是否更新以采纳结果为准', '每个页面保留独立身份，便于查看和继续修改', '原型验证不能替代真实工程源码、可访问性和跨浏览器验收'],
    promptDescriptions: {
      'interaction-design.system.v1': { title: '先读取原型和页面边界', description: '先确认已有原型、目标页面和项目身份，再提交候选变更；页面级上下文必须可追踪。' },
    },
    skillDescriptions: {
      'interaction-design': { title: '交互设计与原型', description: '负责原型结构、页面边界、设备预览和候选采纳流程，避免把设计结果和正式源码混为一谈。' },
    },
    examples: [{ title: '创建登录原型', prompt: '为这个产品创建一个包含登录、注册和找回密码流程的 Web 原型，先给我可点击候选。' }, { title: '迭代现有页面', prompt: '读取当前原型的首页，保持现有导航结构，优化首屏信息层级并给出可预览候选。' }],
  },
  'server-ops': {
    markdown: serverOpsMarkdown,
    summary: '在已经授权的资源和真实连接范围内检查服务器、服务日志和数据连接，辅助定位运维问题。',
    useCases: ['查看已授权服务器的状态和关键指标', '检查服务日志、进程和连接情况', '根据真实连接状态整理故障线索和下一步操作'],
    workflow: ['读取已授权资源清单和连接状态', '执行范围内的只读检查并记录来源', '整理异常、影响范围和可验证的处理建议', '涉及写入、重启或高风险操作时单独请求确认'],
    requirements: ['当前消息明确选择「服务器运维」', '已配置并授权目标服务器、数据库或远程资源', '连接凭据和资源范围由宿主管理，不能仅靠文字描述补齐'],
    capabilities: ['列出可用运维资源', '查看服务器概览、服务状态和日志', '基于真实连接结果输出诊断线索'],
    artifacts: ['运维检查任务', '服务器或服务查询结果', '带来源的诊断记录'],
    limitations: ['选择模块不会扩大服务器、数据库或远程文件权限', '未连接或未授权的资源不会被猜测或模拟', '写入、删除、重启和变更配置需要现有审批流程'],
    promptDescriptions: {
      'server-ops.system.v1': { title: '只使用已授权资源和真实状态', description: '先读取授权资源与连接状态，再执行范围内检查；模块选择不会扩大权限，也不会用模型文字冒充服务器结果。' },
    },
    skillDescriptions: {},
    examples: [{ title: '检查服务状态', prompt: '查看已授权的生产 API 服务状态和最近 100 行错误日志，只读检查并标出需要我确认的风险。' }, { title: '定位连接异常', prompt: '检查当前已授权资源的数据库连接情况，按真实返回结果整理可能的故障范围。' }],
  },
  'api-workbench': {
    markdown: apiWorkbenchMarkdown,
    summary: '准备、调试和保存项目接口请求与测试流程，帮助把一次调用整理成可复用场景。',
    useCases: ['从已有接口文档或请求样例准备调用', '调试请求参数、认证和响应结构', '把验证过的请求保存为可复用的测试场景'],
    workflow: ['读取项目内已有请求、变量和场景', '生成精确的请求快照并检查风险', '在获得授权后发送请求并记录响应', '按用户确认保存或更新接口场景'],
    requirements: ['当前消息明确选择「接口工作台」', '已选择项目；可复用已有请求，也可提供接口文档或请求样例建立新请求', '出网调用、写入场景和敏感数据处理均需当前授权'],
    capabilities: ['读取和整理项目接口请求', '准备请求、检查参数和认证配置', '发送已授权请求并保存可复用场景'],
    artifacts: ['接口请求', '请求运行记录', '接口测试场景'],
    limitations: ['不会重复发送可能产生副作用的请求', '没有精确请求快照和授权时只提供准备建议', '敏感凭据不会因为模块选择而暴露给模型或写入普通说明'],
    promptDescriptions: {
      'api-workbench.system.v1': { title: '先读取请求，再按快照执行', description: '先读取已有请求与场景；出网调用和保存变更依据精确请求快照与用户授权，避免重复发送副作用请求。' },
    },
    skillDescriptions: {},
    examples: [{ title: '准备接口调试', prompt: '读取项目里已有的登录接口请求，检查参数和认证配置，先生成一份待确认的请求快照。' }, { title: '保存测试场景', prompt: '用当前已授权请求验证订单查询接口，记录响应并在我确认后保存为测试场景。' }],
  },
  'capability-factory': {
    markdown: capabilityFactoryMarkdown,
    summary: '设计、验证和迭代可复用的能力场景与编排草案，把复杂任务拆成可检查的步骤。',
    useCases: ['把重复任务整理成可复用场景', '检查已有编排的输入、步骤和审批点', '为团队协作准备可审查的能力草案'],
    workflow: ['读取已有场景和版本身份', '明确输入、步骤、输出和审批边界', '生成或修改草案并运行结构校验', '经用户采纳和版本检查后进入正式场景'],
    requirements: ['当前消息明确选择「编排工厂」', '已选择项目，并且已有场景或明确的编排目标', '涉及真实运行、外部调用或发布时需满足对应模块和审批条件'],
    capabilities: ['读取和比较已有能力场景', '准备可审查的编排草案', '检查版本、输入输出和审批关系'],
    artifacts: ['能力场景', '编排草案', '场景验证与版本记录'],
    limitations: ['不会把模型生成的文字当成真实运行结果', '草案、运行和采纳是不同阶段，不能跳过审批与版本检查', '不会因为选择编排工厂而自动获得其他模块的工具权限'],
    promptDescriptions: {
      'capability-factory.system.v1': { title: '复用场景身份并遵守审批', description: '先读取已有场景，复用明确的场景身份；验证、运行和采纳遵守审批与版本检查。' },
    },
    skillDescriptions: {
      'capability-factory-scene-design': { title: '场景设计与编排', description: '帮助定义场景输入、步骤、输出和审批点，保证草案可以被检查、复用和版本化。' },
    },
    examples: [{ title: '整理周报流程', prompt: '把每周收集数据、生成摘要和发送报告整理成一个可审查的能力场景草案。' }, { title: '检查现有编排', prompt: '读取当前场景，检查输入输出和审批边界，列出需要我确认的版本变更。' }],
  },
}

/** 根据模块 ID 读取用户说明；未知模块由调用方回退到 manifest 原始描述。 */
export function getBuiltinModuleDocumentation(moduleId: string): BuiltinModuleDocumentation | undefined {
  return BUILTIN_MODULE_DOCUMENTATION[moduleId]
}
