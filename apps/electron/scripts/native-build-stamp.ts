#!/usr/bin/env bun
/**
 * 原生件增量构建标记
 *
 * dev 启动链每次都会无条件执行 build:native-helpers，实测约 14 秒，
 * 其中 eventkit 还会清理扩展属性并重新 ad-hoc 签名 Electron.app，
 * 只改 renderer 也要等整条 C++/Swift 编译链。
 *
 * 这里按「输入指纹 + 编译器/工具链身份」写入标记文件：
 * - 输入：源码、相关 plist、构建脚本本身；
 * - 工具链：编译器与工具链路径、平台、架构、脚本声明的额外环境因子。
 * 指纹一致且产物存在时直接跳过；源码或工具链变化才重编译。
 * 发布产物构建可用 DUTYDECK_FORCE_NATIVE_BUILD=1 强制重编译。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 单个原生构建产物的增量判定输入。 */
export interface NativeBuildStampInput {
  /** 标记文件名，写入产物同目录的 `.build-stamp-<name>.json`。 */
  name: string
  /** 必须存在的产物路径；缺失时必然重建。 */
  outputPath: string
  /** 参与指纹的源码、资源与构建脚本。 */
  inputs: string[]
  /** 脚本自身额外的指纹因子，例如编译器路径与编译参数。 */
  factors?: string[]
}

interface NativeBuildStampFile {
  fingerprint: string
}

/** 读取文件内容摘要；缺失文件以固定标记参与指纹，保证“消失”也会触发重建。 */
function digestPath(path: string): string {
  if (!existsSync(path)) return 'missing'
  const stat = statSync(path)
  if (!stat.isFile()) return 'not-a-file'
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 计算当前构建输入指纹。 */
function computeFingerprint(input: NativeBuildStampInput): string {
  const parts = [
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    ...(input.factors ?? []),
    ...input.inputs.map((path) => `${resolve(path)}=${digestPath(path)}`),
  ]
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

function stampPath(input: NativeBuildStampInput): string {
  return resolve(dirname(input.outputPath), `.build-stamp-${input.name}.json`)
}

/**
 * 判断是否可跳过构建。
 * @returns true 表示产物已是最新，调用方应直接退出且不触碰产物。
 */
export function isNativeBuildUpToDate(input: NativeBuildStampInput): boolean {
  if (process.env['DUTYDECK_FORCE_NATIVE_BUILD'] === '1') return false
  if (!existsSync(input.outputPath)) return false
  const path = stampPath(input)
  if (!existsSync(path)) return false
  try {
    const stamp = JSON.parse(readFileSync(path, 'utf8')) as NativeBuildStampFile
    return stamp.fingerprint === computeFingerprint(input)
  } catch {
    return false
  }
}

/** 构建成功后记录本次输入指纹。 */
export function writeNativeBuildStamp(input: NativeBuildStampInput): void {
  const path = stampPath(input)
  mkdirSync(dirname(path), { recursive: true })
  const stamp: NativeBuildStampFile = { fingerprint: computeFingerprint(input) }
  writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')
}

/**
 * 未变化时打印跳过日志并结束进程；否则返回继续构建。
 * 仅供顶层构建脚本调用。
 */
export function skipIfUpToDate(input: NativeBuildStampInput): void {
  if (!isNativeBuildUpToDate(input)) return
  console.log(`[${input.name}] skipped (inputs unchanged): ${input.outputPath}`)
  process.exit(0)
}
