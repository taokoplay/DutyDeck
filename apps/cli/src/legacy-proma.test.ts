import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { printLegacyCliWarning } from './legacy-proma'

describe('proma CLI 过渡入口', () => {
  test('输出一次中文弃用提示', () => {
    const messages: string[] = []
    printLegacyCliWarning((message) => messages.push(message))
    expect(messages).toEqual(['proma 命令已弃用，请改用 dutydeck；当前版本仍兼容旧命令。\n'])
  })

  test('package metadata 同时保留新旧 bin', () => {
    const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { bin: Record<string, string> }
    expect(packageJson.bin.dutydeck).toBe('./src/index.ts')
    expect(packageJson.bin.proma).toBe('./src/legacy-proma.ts')
  })
})
