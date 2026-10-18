/**
 * Proma CLI 过渡入口：保留旧 bin，提醒用户迁移到 dutydeck 后复用同一实现。
 */

/** 输出一次旧命令弃用提示。 */
export function printLegacyCliWarning(write: (message: string) => void = (message) => process.stderr.write(message)): void {
  write('proma 命令已弃用，请改用 dutydeck；当前版本仍兼容旧命令。\n')
}

if (import.meta.main) {
  printLegacyCliWarning()
  await import('./index')
}
