import * as React from 'react'
import type { PluginCompatibilityReport } from '@dutydeck/shared'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PluginValidationSummary } from './PluginValidationSummary'

const BLOCKERS: Record<string, string> = {
  DYNAMIC_PATCH: '存在动态 patch 标签；不求值、不执行。',
  DEPENDENCY_CLOSURE_UNRESOLVED: '运行依赖闭包尚未锁定和审查。',
  INSTALL_SCRIPTS: '存在安装或 prepare 脚本；不会运行。',
  NATIVE_OR_BUNDLED_RUNTIME: '含原生或内嵌运行依赖；当前路线不支持。',
  LICENSE_UNKNOWN: '许可证声明缺失或无法解析。',
  INTEGRITY_MISSING: 'registry 未提供可校验的完整性声明。',
}

/** 证据缺失显式显示未知；仅展示文本，不加载第三方图标、链接或HTML。 */
export function PluginCompatibilityDetail({ report, onClose, onAnalyze, busy = false, error }: { report: PluginCompatibilityReport | null; onClose: () => void; onAnalyze?: (version: string) => void; busy?: boolean; error?: string | null }): React.ReactElement {
  const evidence = report?.packageEvidence
  return <Dialog open={report !== null} onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{report?.entry.title ?? '兼容诊断'}</DialogTitle><DialogDescription>目录与包静态证据，不代表已安装、已授权或已验证可运行。</DialogDescription></DialogHeader>
      {report && <div className="space-y-4 text-sm">
        <p className="break-all font-mono">{report.entry.name}</p>
        <p className="whitespace-pre-wrap break-words text-muted-foreground">{report.entry.description}</p>
        <dl className="space-y-2 break-all">
          <div><dt className="font-medium">兼容状态</dt><dd>{report.status === 'unsupported' ? '存在阻断项，当前不可接入' : '待审查，不自动判定兼容'}</dd></div>
          <div><dt className="font-medium">信任与运行</dt><dd>来源未审查；此目录页不执行安装或启用操作。</dd></div>
          <div><dt className="font-medium">目录来源</dt><dd>{report.sourceUrl}</dd></div>
          <div><dt className="font-medium">目录快照 SHA-256</dt><dd className="font-mono text-xs">{report.snapshotHash}</dd></div>
          <div><dt className="font-medium">插件包 SHA-256</dt><dd className="font-mono text-xs">{report.packageHash ?? '未知，尚未读取包字节'}</dd></div>
          <div><dt className="font-medium">许可证声明（未经法律审查）</dt><dd>{report.license ?? '未知'}</dd></div>
          {evidence && <>
            <div><dt className="font-medium">实际分析版本 / 时间</dt><dd>{evidence.version} · {new Date(evidence.analyzedAt).toLocaleString()}</dd></div>
            <div><dt className="font-medium">npm 元数据来源</dt><dd>{evidence.registryUrl}</dd></div>
            <div><dt className="font-medium">包来源</dt><dd>{evidence.tarballUrl}</dd></div>
            <div><dt className="font-medium">完整性</dt><dd>{evidence.integrity.status === 'matched' ? `${evidence.integrity.algorithm} 与registry声明匹配（不是安全认证）` : '缺失'}</dd></div>
            <div><dt className="font-medium">归档内容</dt><dd>{evidence.fileCount} 个文件 · {evidence.unpackedBytes} 字节正文 · 只读内存解析</dd></div>
            <div><dt className="font-medium">许可证文件</dt><dd>{evidence.licenseFiles.join('、') || '未发现常见文件名'}</dd></div>
            <div><dt className="font-medium">内容候选（仍需固定配方）</dt><dd>{evidence.contentCandidates.join('、') || '未发现常见 Skill / Prompt 路径'}</dd></div>
            <div><dt className="font-medium">运行依赖闭包</dt><dd>{evidence.dependencyClosure === 'none' ? '未声明运行依赖，仍需审查动态导入' : '未解析 / 未锁定，阻断执行与转换'}</dd></div>
          </>}
        </dl>
        {evidence && <section className="space-y-2" aria-label="包静态分析结果">
          {evidence.blockers.length > 0 && <ul className="list-disc space-y-1 pl-5 text-destructive">{evidence.blockers.map(code => <li key={code}>{BLOCKERS[code] ?? code}</li>)}</ul>}
          <details><summary className="cursor-pointer font-medium">依赖声明（不代表已解析依赖闭包）</summary><pre className="mt-2 whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(evidence.dependencyDeclarations, null, 2)}</pre></details>
        </section>}
        {report.conversions?.map(assessment => <PluginValidationSummary key={assessment.record?.packageHash} assessment={assessment} />)}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {busy && <p role="status">正在下载并静态分析；不会运行任何包入口。</p>}
        <ul className="list-disc space-y-2 pl-5 text-muted-foreground">{report.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        <h3 className="font-medium">索引声明的精确版本（不代表已验证）</h3>
        <p className="text-xs text-muted-foreground">仅点击下方分析按钮才访问公开 npm registry，下载所选版本；不发送项目、会话或凭据。包结果仅保留于当前详情，不安装、不执行、不解析 YAML 表达式。</p>
        <ul className="space-y-2">{report.entry.versions.map(version => <li key={version.version} className="rounded border border-border p-3 break-all">
          <span className="font-mono">{version.version}</span> · {version.sourceType}
          {version.sourceType === 'npm' && onAnalyze && <Button variant="outline" size="sm" className="ml-2 mt-2" disabled={busy} onClick={() => onAnalyze(version.version)}>静态分析 {version.version}（联网）</Button>}
          {Object.keys(version.engines).length > 0 && <p className="mt-1 text-xs text-muted-foreground">{Object.entries(version.engines).map(([key, value]) => `${key}: ${value}`).join(' · ')}</p>}
        </li>)}</ul>
      </div>}
    </DialogContent>
  </Dialog>
}
