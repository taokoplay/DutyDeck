/** 运行底座示例的纯业务结果，供 runtime 和测试共用。 */
export function buildEchoResult(input: { message: string }): {
  pluginId: 'acme.runtime-fixture'
  message: string
  protocolVersion: 1
} {
  return {
    pluginId: 'acme.runtime-fixture',
    message: input.message,
    protocolVersion: 1,
  }
}
