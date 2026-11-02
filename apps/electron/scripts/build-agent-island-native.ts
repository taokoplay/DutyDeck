#!/usr/bin/env bun
/** Build the macOS-native Agent Island helper for the current host architecture. */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { skipIfUpToDate, writeNativeBuildStamp, type NativeBuildStampInput } from './native-build-stamp'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const source = resolve(appDir, 'native/agent-island/macos-agent-island-helper.swift')
const output = resolve(appDir, 'resources/agent-island/macos-agent-island-helper')

/** 增量构建判定输入；Swift 源码或脚本变化才重新编译。 */
const stampInput: NativeBuildStampInput = {
  name: 'agent-island-native',
  outputPath: output,
  inputs: [
    source,
    resolve(scriptDir, 'build-agent-island-native.ts'),
    resolve(scriptDir, 'native-build-stamp.ts'),
  ],
  factors: ['compiler=xcrun swiftc', 'flags=-O -parse-as-library'],
}
skipIfUpToDate(stampInput)

if (process.platform !== 'darwin') {
  console.log('[agent-island-native] skipped (macOS only)')
  process.exit(0)
}

if (!existsSync(source)) throw new Error(`Agent Island helper source not found: ${source}`)
mkdirSync(dirname(output), { recursive: true })
rmSync(output, { force: true })
execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', source, '-o', output], { stdio: 'inherit' })
chmodSync(output, 0o755)
console.log(`[agent-island-native] built ${output}`)
writeNativeBuildStamp(stampInput)
