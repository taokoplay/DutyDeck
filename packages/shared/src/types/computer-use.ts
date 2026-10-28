/** 本应用已核验的安装版本与官方手动安装入口。 */
export const COMPUTER_USE_DRIVER_VERSION = '0.38.0'
export const COMPUTER_USE_DRIVER_RELEASE_URL = `https://github.com/trycua/cua/releases/tag/cua-driver-rs-v${COMPUTER_USE_DRIVER_VERSION}`

/** 用户显式启用的桌面控制配置；运行目标与截图不持久化。 */
export interface ComputerUseConfig {
  /** 默认关闭；仅设置页可修改。 */
  enabled: boolean
  /** 主进程文件选择器确认的 Driver 绝对路径；缺省时检查标准位置。 */
  driverPath?: string
}

/** 当前本机桌面能力；已安装不代表系统授权或输入验证通过。 */
export interface ComputerUseInstallation {
  /** 当前平台；当前开放 macOS 和 Windows，Linux 保留为不支持状态。 */
  platform: 'macos' | 'windows' | 'linux' | 'unsupported'
  /** Driver 检测结果，不将未验证权限显示为已授权。 */
  status: 'not_installed' | 'installed' | 'needs_attention' | 'unsupported'
  /** 实际解析出的可执行路径。 */
  driverPath?: string
  /** 可验证的 Driver 版本。 */
  version?: string
  /** 有界错误说明。 */
  message?: string
}

/** 用户主动触发的桌面能力预检结果；unknown 表示没有足够证据，不等于已授权。 */
export interface ComputerUsePermissions {
  /** macOS 为辅助功能，Windows 为 UI Automation；决定是否能读取控件树并发送语义输入。 */
  accessibility: 'unknown' | 'granted' | 'needs_attention'
  /** macOS 屏幕录制或 Windows 屏幕捕获能力，决定是否能取得有效 PNG 画面。 */
  screenRecording: 'unknown' | 'granted' | 'needs_attention'
  /** 最近一次预检时间。 */
  checkedAt: number
  /** 面向用户的有界说明。 */
  message?: string
}

/** 一个经 Driver 确认的目标窗口。 */
export interface ComputerUseWindow {
  /** 本次发现的真实进程号。 */
  pid: number
  /** 窗口标识，按字符串保留，避免平台标识精度损失。 */
  windowId: string
  /** 供用户核对的窗口标题。 */
  title: string
}

/** 主进程持有的唯一控制租约；id 同时作为 UI 停止的身份凭证。 */
export interface ComputerUseOperation extends ComputerUseWindow {
  /** 本次操作唯一身份，旧 UI 不能停止新操作。 */
  id: string
  /** 所属用户会话。 */
  sessionId: string
  /** 真实开始时间。 */
  startedAt: number
  /** 停止期间保留租约，直到在途调用已退出。 */
  status: 'active' | 'stopping'
  /** 最近一次观察时间；不代表实时视频。 */
  observedAt?: number
  /** 最近观察的有界 PNG，仅在内存中保存。 */
  image?: string
}

/** 用户主动安装的阶段状态；只在当前主进程保留。 */
export interface ComputerUseDriverSetup {
  /** 只在用户点击时启动；不使用推算的百分比。 */
  status: 'downloading' | 'installing' | 'verifying' | 'succeeded' | 'failed'
  /** 固定的用户说明，不传递含本机路径或凭据的子进程日志。 */
  message: string
}

/** 设置页与会话状态条共享的内存快照。 */
export interface ComputerUseSnapshot {
  /** 用户配置。 */
  config: ComputerUseConfig
  /** 已完成的安装检测；未检测时不伪造状态。 */
  installation: ComputerUseInstallation | null
  /** 最近一次用户主动权限预检；启动时不自动读取桌面。 */
  permissions?: ComputerUsePermissions
  /** 本次主进程内安装任务，页面重新打开仍可查看进度。 */
  driverSetup?: ComputerUseDriverSetup
  /** 当前进程唯一的控制目标。 */
  operation: ComputerUseOperation | null
}

/** 电脑控制的四层 IPC 合同，不向 renderer 暴露桌面动作或任意命令。 */
export interface ComputerUseApi {
  /** 读取当前快照，不采集桌面。 */
  getSnapshot(): Promise<ComputerUseSnapshot>
  /** 按需检查安装与版本，不执行真实鼠标键盘输入。 */
  checkInstallation(): Promise<ComputerUseSnapshot>
  /** 用户点击运行官方安装器；不接收 URL、命令或安装参数。 */
  installDriver(): Promise<ComputerUseSnapshot>
  /** 用户主动执行一次控件树与屏幕捕获预检。 */
  checkPermissions(): Promise<ComputerUseSnapshot>
  /** 显式启用/关闭，关闭会先撤销活动控制。 */
  setEnabled(enabled: boolean): Promise<ComputerUseSnapshot>
  /** 主进程打开文件选择器；取消时保留旧配置。 */
  chooseDriver(): Promise<ComputerUseSnapshot>
  /** 仅停止 id 匹配的活动控制；不停止共享 Driver daemon。 */
  stop(operationId: string): Promise<ComputerUseSnapshot>
  /** 状态变化推送；返回取消订阅函数。 */
  onChanged(listener: (snapshot: ComputerUseSnapshot) => void): () => void
}

/** 固定通道，动作仅通过受控 Agent 工具执行。 */
export const COMPUTER_USE_IPC_CHANNELS = {
  GET_SNAPSHOT: 'computer-use:get-snapshot',
  CHECK_INSTALLATION: 'computer-use:check-installation',
  INSTALL_DRIVER: 'computer-use:install-driver',
  CHECK_PERMISSIONS: 'computer-use:check-permissions',
  SET_ENABLED: 'computer-use:set-enabled',
  CHOOSE_DRIVER: 'computer-use:choose-driver',
  STOP: 'computer-use:stop',
  CHANGED: 'computer-use:changed',
} as const
