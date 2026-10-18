import { join } from 'node:path'

/** 解析应用图标资源路径；旧变体统一回退到 DutyDeck 默认图标。 */
export function resolveDutyDeckAppIconPath(resourcesDir: string, variantId: string): string {
  void variantId
  return join(resourcesDir, 'icon.png')
}
