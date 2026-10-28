import * as React from 'react'
import { CheckCircle2, Download, ExternalLink, FolderOpen, Loader2, Monitor, RefreshCw, ShieldCheck } from 'lucide-react'
import { COMPUTER_USE_DRIVER_RELEASE_URL, COMPUTER_USE_DRIVER_VERSION } from '@dutydeck/shared'
import { useComputerUse } from '../../atoms/computer-use'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { SettingsSection, SettingsCard, SettingsRow } from './primitives'
import { ComputerUseOperation } from '../computer-use/ComputerUseOperation'

/** 电脑控制配置入口；安装和桌面预检均由用户主动点击触发。 */
export function ComputerUseSettings(): React.ReactElement {
  /** 订阅宿主状态，错误不抹掉仍然有效的活动操作。 */
  const state = useComputerUse()
  /** 共享宿主快照；不在页面保存桌面副本。 */
  const snapshot = state.snapshot
  /** 最近一次安装检测。 */
  const installation = snapshot?.installation
  /** 宿主安装状态在页面切换后仍有效，避免重新打开时重复安装。 */
  const setup = snapshot?.driverSetup
  /** 仅安装按钮展示安装阶段，其他操作保持稳定名称。 */
  const installing = !!setup && ['downloading', 'installing', 'verifying'].includes(setup.status)
  /** 长安装任务独立于页面请求生命周期，统一禁用相互冲突的配置操作。 */
  const busy = state.busy || installing
  /** 已满足协议门槛时允许修复安装，过旧与缺失则明确显示更新或安装。 */
  const installLabel = setup?.status === 'failed' ? '重试安装' : installation?.status === 'installed' ? '重新安装 Driver' : installation?.version ? '更新 Driver' : '安装 Driver'
  /** 官方说明打开失败时显示本地提示，不产生未处理 Promise。 */
  const [linkError, setLinkError] = React.useState<string | null>(null)
  /** Windows 使用 UI Automation/屏幕捕获术语，避免显示 macOS 权限名称。 */
  const isWindows = installation?.platform === 'windows'
  /** 安装状态来自宿主实测，未检测时不伪造权限状态。 */
  const installationLabel = !installation ? '尚未检测' : ({ installed: '已安装', not_installed: '未找到 Driver', needs_attention: '需要处理', unsupported: '当前平台暂不支持' } as const)[installation.status]
  /** 权限标签只代表最近一次可用性预检，不承诺系统授权永久有效。 */
  const permissionLabel = (value: 'unknown' | 'granted' | 'needs_attention' | undefined): string => ({ unknown: '未验证', granted: '本次通过', needs_attention: '需要处理' } as const)[value ?? 'unknown']
  /** 窄窗口将操作移到下一行，避免长路径挤出卡片。 */
  const responsiveRow = 'max-sm:flex-col max-sm:items-stretch max-sm:gap-3'
  return (
    <div className="space-y-6">
      <SettingsSection title="电脑控制" description="让当前会话通过受控工具观察并操作本机应用窗口。">
        {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        {!snapshot && <p role="status" className="text-sm text-muted-foreground">正在读取电脑控制状态…</p>}
        <SettingsCard>
          <SettingsRow label="启用电脑控制" description="观察和操作需逐次批准，关闭后停止当前控制。">
            <Switch id="computer-use-enabled" aria-label="启用电脑控制" checked={snapshot?.config.enabled ?? false}
              disabled={!snapshot || busy || (installation?.status === 'unsupported' && !snapshot.config.enabled)}
              onCheckedChange={enabled => { void state.request?.(api => api.setEnabled(enabled)) }} />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Cua Driver" description="用于读取窗口和执行操作的本地组件。">
        <SettingsCard>
          <SettingsRow label="安装状态" description={installation?.version ? `当前版本 ${installation.version}` : '检测本机是否已安装兼容版本'} className={responsiveRow}>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary" className="gap-1.5 font-normal">
                {installation?.status === 'installed' && <CheckCircle2 aria-hidden="true" className="size-3" />}
                {installationLabel}
              </Badge>
              <Button size="sm" variant="outline" disabled={!state.request || busy} onClick={() => { void state.request?.(api => api.checkInstallation()) }}>
                <RefreshCw aria-hidden="true" />检测安装
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow label="安装与更新" description={`官方版本 ${COMPUTER_USE_DRIVER_VERSION} · 安装到默认目录`} className={responsiveRow}>
            <Button size="sm" disabled={!state.request || busy || installation?.status === 'unsupported'} onClick={() => { void state.request?.(api => api.installDriver()) }}>
              {installing ? <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Download aria-hidden="true" />}
              {installing ? setup?.status === 'downloading' ? '正在下载…' : setup?.status === 'verifying' ? '正在核验…' : '正在安装…' : installLabel}
            </Button>
          </SettingsRow>
          {setup && <div role={setup.status === 'failed' ? 'alert' : 'status'} aria-live="polite" className={`bg-muted/30 px-4 py-3 text-sm leading-relaxed ${setup.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
            {setup.message}
          </div>}
          <SettingsRow label="Driver 路径" description={<span className="block break-all text-xs leading-relaxed">{installation?.driverPath ?? snapshot?.config.driverPath ?? '自动检查标准安装位置'}</span>} className={responsiveRow}>
            <Button size="sm" variant="outline" disabled={!state.request || busy} onClick={() => { void state.request?.(api => api.chooseDriver()) }}>
              <FolderOpen aria-hidden="true" />选择 Driver
            </Button>
          </SettingsRow>
        </SettingsCard>
        {installation?.message && <p className="text-sm text-muted-foreground">{installation.message}</p>}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-1 text-xs text-muted-foreground">
          <p className="min-w-0 flex-1 leading-relaxed">更新会停止当前控制。安装成功不代表系统授权，请继续验证。</p>
          <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-sm text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => { setLinkError(null); void window.electronAPI.openExternal(COMPUTER_USE_DRIVER_RELEASE_URL).catch(() => setLinkError('无法打开浏览器，请稍后重试。')) }}>
            官方安装说明<ExternalLink aria-hidden="true" className="size-3" />
          </button>
        </div>
        {isWindows && <p className="px-1 text-xs leading-relaxed text-muted-foreground">Windows 安装器后续下载使用系统网络设置；如需代理，请确认系统代理可访问 GitHub。</p>}
        {linkError && <p role="alert" className="text-xs text-destructive">{linkError}</p>}
      </SettingsSection>

      <SettingsSection title="系统权限" description="安装 Driver 后，验证窗口控件与屏幕捕获是否可用。">
        <SettingsCard>
          <SettingsRow label={isWindows ? 'UI Automation' : '辅助功能'} description="读取窗口控件并执行操作">
            <Badge variant="secondary" className="font-normal">{permissionLabel(snapshot?.permissions?.accessibility)}</Badge>
          </SettingsRow>
          <SettingsRow label={isWindows ? '屏幕捕获' : '屏幕录制'} description="获取目标窗口画面">
            <Badge variant="secondary" className="font-normal">{permissionLabel(snapshot?.permissions?.screenRecording)}</Badge>
          </SettingsRow>
          <SettingsRow label="权限预检" description={snapshot?.permissions ? `最近预检：${new Date(snapshot.permissions.checkedAt).toLocaleString()}` : '仅在点击验证时检查，不自动申请权限'} className={responsiveRow}>
            <Button size="sm" variant="outline" disabled={!state.request || busy || installation?.status !== 'installed'} onClick={() => { void state.request?.(api => api.checkPermissions()) }}>
              <ShieldCheck aria-hidden="true" />验证系统权限
            </Button>
          </SettingsRow>
        </SettingsCard>
        {snapshot?.permissions?.message && <p className="px-1 text-sm text-muted-foreground">{snapshot.permissions.message}</p>}
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">预检只读取一个窗口，临时截图用后删除，不发送给模型。结果仅代表本次检查。</p>
      </SettingsSection>

      <SettingsSection title="当前操作">
        {snapshot?.operation ? <ComputerUseOperation operation={snapshot.operation} stopping={state.stoppingOperationId === snapshot.operation.id} onStop={id => { void state.stop?.(id) }} /> : (
          <SettingsCard>
            <SettingsRow label="暂无操作" description="会话开始控制电脑后，可在这里查看状态并停止。" icon={<Monitor aria-hidden="true" className="size-4 text-muted-foreground" />} />
          </SettingsCard>
        )}
      </SettingsSection>
    </div>
  )
}
