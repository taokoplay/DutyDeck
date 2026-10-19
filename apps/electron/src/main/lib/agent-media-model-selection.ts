import { parseMediaModelRef } from '@dutydeck/shared'

/**
 * 统一校验用户显式选择的媒体模型，供工具装配、提示、排队和恢复共同使用。
 * @param value 发送入口或已持久化检查点中的模型引用；不能信任其运行时形状。
 * @returns 去重后的合法稳定引用；空值和畸形引用不激活媒体能力，模型可用性仍由生成服务校验。
 */
export function getReferencedMediaModelRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((ref: unknown): ref is string => {
    try {
      parseMediaModelRef(ref)
      return true
    } catch {
      return false
    }
  }))]
}
