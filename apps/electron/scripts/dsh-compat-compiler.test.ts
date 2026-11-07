import { describe, expect, test } from 'bun:test'
import { compileDshGraph } from './dsh-compat-compiler'
import type { DshBuildGraph } from '../../../packages/plugin-kit/src/dsh-compat/build'
const encode = (value: string): Uint8Array => Buffer.from(value)
function graph(body: string): DshBuildGraph { return { entry: '@dsh/runtime', modules: new Map([['@dsh/runtime', encode(body)], ['local.js', encode('export const value = 1')]]), imports: { '@dsh/runtime': { './local.js': 'local.js' }, 'local.js': {} } } }
describe('Given 开发侧仅内存模块的DSH构建器', () => {
  test('When 已登记静态依赖 Then 仅生成自包含ESM，不执行模块或落回文件解析', async () => {
    const output = await compileDshGraph(graph('import { value } from "./local.js"; throw new Error("must not execute"); export default value'))
    expect(output.imports).toEqual([])
    expect([...output.inputs].sort()).toEqual(['@dsh/runtime', 'local.js'])
    expect(Buffer.from(output.code).toString()).toContain('must not execute')
  })
  test('When Node模块、图外文件或动态加载 Then 拒绝而非保留external供运行时解析', async () => {
    for (const body of ['import "node:fs";', 'import "./unknown.js";', 'const p = "node:fs"; export const x = import(p);', 'export const x = require("node:fs");']) {
      await expect(compileDshGraph(graph(body))).rejects.toThrow('DSH_BUILD_IMPORT_UNSUPPORTED')
    }
  })
})
