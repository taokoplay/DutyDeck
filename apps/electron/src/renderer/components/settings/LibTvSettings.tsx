import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { LIBTV_MCP_SERVER_NAME, LIBTV_MCP_URL } from '@dutydeck/shared'
import type { WorkspaceMcpConfig } from '@dutydeck/shared'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom, workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { SettingsCard } from './primitives'
import { MediaSettingsPage } from './MediaSettingsPage'
import { connectLibTv, disableLibTv, getLibTvConnectionState, verifyLibTv } from './LibTvSettings.logic'

/** 显示当前工作区的 LibTV 连接；OAuth 凭据由主进程加密保存。 */
export function LibTvSettings({ navigation }: { navigation?: React.ReactNode }): React.ReactElement {
  /** 仅使用已选择工作区的稳定 slug，不能回退到其他项目。 */
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspace = workspaces.find(item => item.id === workspaceId)
  const slug = workspace?.slug ?? ''
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom)
  /** 快照绑定工作区，切换后的首帧也不能显示旧连接状态。 */
  const [snapshot, setSnapshot] = React.useState<{ slug: string; config: WorkspaceMcpConfig } | null>(null)
  const [operation, setOperation] = React.useState<{ slug: string; name: string } | null>(null)
  const [error, setError] = React.useState<{ slug: string; message: string } | null>(null)
  /** 单调版本阻止卸载、切换工作区和旧刷新覆盖当前页面。 */
  const revision = React.useRef(0)
  const currentSlug = React.useRef(slug)
  currentSlug.current = slug

  /** 读取真实配置；只有当前请求可以发布状态。 */
  const refresh = React.useCallback(async (): Promise<void> => {
    const request = ++revision.current
    if (!slug) return
    setOperation({ slug, name: 'refresh' })
    setError(null)
    try {
      const config = await window.electronAPI.getWorkspaceMcpConfig(slug)
      if (revision.current === request && currentSlug.current === slug) setSnapshot({ slug, config })
    } catch (cause) {
      if (revision.current === request && currentSlug.current === slug) setError({ slug, message: cause instanceof Error ? cause.message : '读取 LibTV 配置失败' })
    } finally {
      if (revision.current === request && currentSlug.current === slug) setOperation(null)
    }
  }, [slug])

  React.useEffect(() => {
    void refresh()
    return () => { revision.current += 1 }
  }, [refresh])

  /** 连接和停用共用作用域守卫；失败后重读配置，显示持久化的真实状态。 */
  const run = async (action: 'connect' | 'disable' | 'verify'): Promise<void> => {
    if (!slug || operation?.slug === slug) return
    const request = ++revision.current
    const isCurrent = (): boolean => revision.current === request && currentSlug.current === slug
    setOperation({ slug, name: action })
    setError(null)
    try {
      const config = await (action === 'connect' ? connectLibTv : action === 'verify' ? verifyLibTv : disableLibTv)(window.electronAPI, slug, isCurrent)
      if (config && isCurrent()) { setSnapshot({ slug, config }); bumpCapabilities(value => value + 1) }
    } catch (cause) {
      if (isCurrent()) {
        setError({ slug, message: cause instanceof Error ? cause.message : 'LibTV 操作失败，请重试' })
        try {
          const config = await window.electronAPI.getWorkspaceMcpConfig(slug)
          if (isCurrent()) setSnapshot({ slug, config })
        } catch { /* 保留原始操作错误，不把读取失败误报为连接成功。 */ }
      }
    } finally {
      if (isCurrent()) setOperation(null)
    }
  }

  /** 加载、冲突和未选择工作区都禁止发起写操作。 */
  const loaded = snapshot?.slug === slug
  const entry = loaded ? snapshot.config.servers[LIBTV_MCP_SERVER_NAME] : undefined
  const state = getLibTvConnectionState(entry)
  const busy = operation?.slug === slug
  const labels = { unconfigured: '尚未连接', conflict: '配置冲突', disabled: '已停用', pending: '已启用，待验证', connected: '已连接（上次验证成功）' }
  return <MediaSettingsPage title="LibTV">
    {navigation}
    <p className="text-sm text-muted-foreground">连接官方 LibTV 后，可在当前工作区通过 Agent 生成图片、视频，管理项目并导出作品。可用工具以服务端授权后的实际列表为准。</p>
    <SettingsCard divided={false} className="space-y-4 p-4">
      <p className="text-sm">工作区：{workspace?.name ?? '尚未选择'}</p>
      <p className="break-all text-xs text-muted-foreground">{LIBTV_MCP_URL}</p>
      <p role="status" className="text-sm">{!slug ? '请先选择工作区，再连接 LibTV。' : busy ? operation?.name === 'connect' ? '请在打开的页面完成 LibTV 授权，随后验证连接…' : '正在读取或更新连接…' : loaded ? labels[state] : '尚未读取配置'}</p>
      {loaded && state === 'conflict' && <p role="alert" className="text-sm text-destructive">存在同名非官方配置。请前往 Agent 技能 → MCP 管理处理，当前页面不会覆盖它。</p>}
      {error?.slug === slug && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!slug || !loaded || busy || state === 'conflict'} onClick={() => void run('connect')}>{state === 'connected' ? '重新授权并验证' : '连接并授权 LibTV'}</Button>
        <Button variant="outline" disabled={!slug || !loaded || busy || !entry || state === 'conflict'} onClick={() => void run('verify')}>{entry?.enabled ? '验证连接' : '验证并启用'}</Button>
        <Button variant="outline" disabled={!slug || !loaded || busy || !entry?.enabled || state === 'conflict'} onClick={() => void run('disable')}>停用</Button>
        <Button variant="ghost" disabled={!slug || busy} onClick={() => void refresh()}>刷新状态</Button>
      </div>
    </SettingsCard>
    <p className="text-sm text-muted-foreground">连接后，在当前工作区 Agent 的下一轮消息中输入 #libtv，选择 LibTV 并描述制作需求。</p>
    <p className="text-sm text-muted-foreground">生成可能消耗 LibTV 积分。此连接通过 Agent 的 MCP 权限管理调用，不受其他媒体分区的生成授权选项控制；也不会加入统一模型选择器。停用后保留授权凭据。</p>
  </MediaSettingsPage>
}
