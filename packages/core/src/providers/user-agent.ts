const DUTYDECK_REPO_URL = 'https://github.com/taokoplay/DutyDeck'

let _dutydeckVersion = '0.0.0'

/** 设置 DutyDeck 对外请求使用的应用版本。 */
export function setDutyDeckVersion(version: string): void {
  _dutydeckVersion = version
}

/** 读取 DutyDeck 对外请求使用的应用版本。 */
export function getDutyDeckVersion(): string {
  return _dutydeckVersion
}

/** 生成带版本与项目地址的 Provider User-Agent。 */
export function getDutyDeckUserAgent(version?: string): string {
  const v = version ?? _dutydeckVersion
  return `DutyDeck/${v} (+${DUTYDECK_REPO_URL})`
}

/** 旧 API 别名，避免外部 Provider 扩展升级时立即失效。 */
export const setPromaVersion = setDutyDeckVersion
/** 旧 API 别名，避免外部 Provider 扩展升级时立即失效。 */
export const getPromaVersion = getDutyDeckVersion
/** 旧 API 别名，避免外部 Provider 扩展升级时立即失效。 */
export const getPromaUserAgent = getDutyDeckUserAgent
