import * as React from 'react'
import type { InstalledModuleRuntimePluginView, PluginValidationAssessment } from '@dutydeck/shared'

const labels = { unassessed: '待验证', validated: '隔离样本已验证（限定范围）', stale: '证据已失效，待重新验证', failed: '验证失败' }
const reasons: Record<string, string> = {
  HOST_BUILD_UNVERIFIED: '历史样本结果仅供追溯：未绑定当前宿主构建指纹，当前构建待验证。', HOST_BUILD_CHANGED: '当前宿主构建与验证记录不同，不能继承历史结果。',
  NO_HOST_VALIDATION: '没有宿主维护的执行验证记录。', PACKAGE_IDENTITY_CHANGED: '版本或包哈希与验证记录不同。',
  VALIDATION_ENVIRONMENT_CHANGED: '当前宿主、Electron、平台或适配器不在该验证环境内。',
  EVIDENCE_EXPIRED: '已超过宿主设定的重验期限。', EVIDENCE_TIME_INVALID: '测试时间不适用于当前时钟。',
}

/** 只展示宿主证据，不把历史试点变为安装/执行许可。 */
export function PluginValidationSummary({ assessment }: { assessment: PluginValidationAssessment }): React.ReactElement {
  const record = assessment.record
  return <section aria-label="兼容验证证据" className="space-y-2 rounded-lg border border-border/60 p-3 text-sm">
    <h4 className="font-medium">兼容证据：{labels[assessment.status]}</h4>
    {assessment.reasons.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{assessment.reasons.map(reason => <li key={reason}>{reasons[reason] ?? reason}</li>)}</ul>}
    {record && <>
      <p className="break-words text-xs">{record.source.name}@{record.source.version} → {record.pluginId}@{record.pluginVersion}</p>
      <p className="text-xs text-muted-foreground">原始 DSH 包的依赖闭包未获验证；这里只记录工具限定转换产物。签名、授权与健康状态另行判断。</p>
      <details className="text-xs"><summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">查看来源、版本和验证范围</summary>
        <dl className="mt-2 space-y-2 break-all">
          <div><dt>上游来源 / 许可证</dt><dd>{record.source.url} · {record.source.license}</dd></div>
          <div><dt>上游归档 SHA-256</dt><dd>{record.source.archiveSha256}</dd></div>
          <div><dt>转换产物 SHA-256</dt><dd>{record.packageHash}</dd></div>
          <div><dt>适配器版本 / SHA-256</dt><dd>{record.environment.adapterVersion} / {record.environment.adapterSha256}</dd></div>
          <div><dt>验证环境</dt><dd>DutyDeck {record.environment.hostVersion} · Electron {record.environment.electron} · {record.environment.platform}/{record.environment.arch}</dd></div>
          <div><dt>宿主构建指纹</dt><dd>{record.environment.hostBuildSha256 ?? '历史记录未绑定，当前构建待验证'}</dd></div>
          <div><dt>测试时间 / 重验截止（UTC）</dt><dd>{record.testedAt} / {record.expiresAt}</dd></div>
          <div><dt>结果 / 构建证据 SHA-256</dt><dd>{record.resultSha256}<br />{record.buildEvidenceSha256}</dd></div>
        </dl>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">{record.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
      </details>
    </>}
  </section>
}

export function runtimeAuthorizationLabel(plugin: InstalledModuleRuntimePluginView): string {
  if (plugin.executionBlock) return '需要迁移'
  const authorization = plugin.management?.authorization
  if (authorization === 'revoked') return '已撤权'
  if (authorization === 'required' || (!authorization && (!plugin.grant || plugin.grant.revoked || plugin.grant.packageHash !== plugin.packageHash))) return '待授权'
  return plugin.enabled ? '已启用' : '已停用'
}

/** 只读实时快照，不为了健康检查启动插件或发送业务请求。 */
export function PluginRuntimeManagementSummary({ plugin }: { plugin: InstalledModuleRuntimePluginView }): React.ReactElement {
  const management = plugin.management
  const healthLabels = { idle: '未启动（按需加载）', starting: '启动中', running: '运行中', draining: '停止中', stopped: '未运行', failed: '运行失败' }
  return <div className="space-y-3">
    <section aria-label="授权与运行健康" className="rounded-lg border border-border/60 p-3 text-xs space-y-2">
      <p>授权与启停：{runtimeAuthorizationLabel(plugin)}</p>
      <p>运行健康：{management ? healthLabels[management.health.state] : '尚未读取'}{management?.health.errorCode ? ` · ${management.health.errorCode}` : ''}</p>
      <p>发布者指纹：<span className="break-all">{plugin.keyId ?? '开发包 · 未签名'}</span></p>
      <p className="text-muted-foreground">刷新读取当前快照，不启动进程。签名仅证明来源与完整性；utilityProcess 不是 OS 沙箱，受信 Node 代码仍可能访问系统资源。</p>
    </section>
    <PluginValidationSummary assessment={management?.validation ?? { status: 'unassessed', reasons: ['NO_HOST_VALIDATION'] }} />
  </div>
}
