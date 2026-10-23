import { describe, expect, test } from 'bun:test'
import { buildEchoResult } from '../src/echo'

describe('Given runtime fixture', () => {
  test('When 调用 echo 业务函数 Then 返回稳定协议摘要', () => {
    expect(buildEchoResult({ message: 'hello' })).toEqual({
      pluginId: 'acme.runtime-fixture',
      message: 'hello',
      protocolVersion: 1,
    })
  })
})
