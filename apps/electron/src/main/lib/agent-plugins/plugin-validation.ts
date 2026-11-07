import type { PluginValidationAssessment, PluginValidationEnvironment, PluginValidationIdentity, PluginValidationRecord } from '@dutydeck/shared'

/** 静态包与限定转换记录的来源必须精确相同。 */
export function assessSourceConversions(source: Pick<PluginValidationRecord['source'], 'name' | 'version' | 'url' | 'archiveSha256'>, environment: PluginValidationEnvironment, records: readonly PluginValidationRecord[], now = new Date()): PluginValidationAssessment[] {
  const matching = records.filter(record => valid(record) && record.source.name === source.name && record.source.version === source.version
    && record.source.url === source.url && record.source.archiveSha256 === source.archiveSha256)
  const identities = new Map(matching.map(record => [JSON.stringify([record.pluginId, record.pluginVersion, record.packageHash]), record]))
  return [...identities.values()].map(record => assessPluginValidation(record, environment, matching, now))
}

const hash = (value: string): boolean => /^[a-f0-9]{64}$/.test(value)
const environmentKeys: Array<keyof PluginValidationEnvironment> = ['hostVersion', 'platform', 'arch', 'electron', 'adapterVersion', 'adapterSha256']

/** 只接受完整宿主记录；包自报、目录标签和签名都不能生成验证结果。 */
function environmentMatches(record: PluginValidationEnvironment, current: PluginValidationEnvironment): boolean {
  return environmentKeys.every(key => record[key] === current[key])
    && Boolean(current.hostBuildSha256 && hash(current.hostBuildSha256) && record.hostBuildSha256 === current.hostBuildSha256)
}

function valid(record: PluginValidationRecord): boolean {
  return record.formatVersion === 1 && record.scope === 'isolated-developer-smoke'
    && ['passed', 'failed'].includes(record.result)
    && Boolean(record.pluginId && record.pluginVersion && record.source?.name && record.source.version && record.source.license)
    && /^https:\/\//.test(record.source.url)
    && [record.packageHash, record.source.archiveSha256, record.resultSha256, record.buildEvidenceSha256, record.environment?.adapterSha256].every(hash)
    && environmentKeys.every(key => typeof record.environment?.[key] === 'string' && record.environment[key].length > 0)
    && Number.isFinite(Date.parse(record.testedAt)) && Date.parse(record.expiresAt) > Date.parse(record.testedAt)
    && Array.isArray(record.limitations) && record.limitations.length > 0
}

/** 精确匹配验证身份及环境。最新记录优先，不能回退选择旧成功；输出不授予执行权限。 */
export function assessPluginValidation(identity: PluginValidationIdentity, environment: PluginValidationEnvironment, records: readonly PluginValidationRecord[], now = new Date()): PluginValidationAssessment {
  const candidates = records.filter(record => record.pluginId === identity.pluginId && valid(record))
  const exact = candidates.filter(record => record.pluginVersion === identity.pluginVersion && record.packageHash === identity.packageHash)
  const matchingEnvironment = exact.filter(record => environmentMatches(record.environment, environment))
  const selected = (matchingEnvironment.length ? matchingEnvironment : exact.length ? exact : candidates)
    .sort((a, b) => Date.parse(b.testedAt) - Date.parse(a.testedAt) || (a.result === 'failed' ? -1 : 1))[0]
  if (!selected) return { status: 'unassessed', reasons: ['NO_HOST_VALIDATION'] }
  const record = structuredClone(selected)
  const reasons: string[] = []
  if (record.pluginVersion !== identity.pluginVersion || record.packageHash !== identity.packageHash) reasons.push('PACKAGE_IDENTITY_CHANGED')
  if (!environment.hostBuildSha256 || !hash(environment.hostBuildSha256) || !record.environment.hostBuildSha256 || !hash(record.environment.hostBuildSha256)) reasons.push('HOST_BUILD_UNVERIFIED')
  else if (environment.hostBuildSha256 !== record.environment.hostBuildSha256) reasons.push('HOST_BUILD_CHANGED')
  if (!environmentKeys.every(key => record.environment[key] === environment[key])) reasons.push('VALIDATION_ENVIRONMENT_CHANGED')
  if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(record.testedAt)) reasons.push('EVIDENCE_TIME_INVALID')
  if (now.getTime() >= Date.parse(record.expiresAt)) reasons.push('EVIDENCE_EXPIRED')
  return { status: reasons.length ? 'stale' : record.result === 'passed' ? 'validated' : 'failed', reasons, record }
}
