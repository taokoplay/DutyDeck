import { expect, test } from 'bun:test'
import { downloadDriverInstaller, runDriverInstallerProcess } from './installer'

test('Given 官方安装脚本 When 下载 Then 拒绝 HTML 错误页与超限响应', async () => {
  /** 模拟 CDN 异常响应，不联网。 */
  const html = (async () => new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }))
  await expect(downloadDriverInstaller(html, 'install.sh', new AbortController().signal)).rejects.toThrow('安装器')
  /** 没有 Content-Length 的流同样必须硬限读。 */
  const large = (async () => new Response('#!/bin/bash\n' + 'x'.repeat(1024 * 1024)))
  await expect(downloadDriverInstaller(large, 'install.sh', new AbortController().signal)).rejects.toThrow('过大')
  /** 任意替换脚本即使以 shell 开头也必须校验失败。 */
  const forged = (async () => new Response('#!/bin/bash\necho forged'))
  await expect(downloadDriverInstaller(forged, 'install.sh', new AbortController().signal)).rejects.toThrow('校验失败')
})

test('Given 安装子进程失败或超时 When 等待 Then 有界失败且不暴露原始输出', async () => {
  /** 真正运行无副作用子进程，验证退出码和超时语义。 */
  await expect(runDriverInstallerProcess(process.execPath, ['-e', 'console.error("private token");process.exit(2)'], process.env, 2000)).rejects.toThrow('退出码 2')
  await expect(runDriverInstallerProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.env, 30)).rejects.toThrow('超时')
})

test('Given 已启动安装进程 When 应用发送取消 Then 等待实际退出后返回取消', async () => {
  /** 真正运行不访问桌面的空闲进程，取消不得留存后台任务。 */
  const controller = new AbortController()
  const result = runDriverInstallerProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.env, 2000, controller.signal)
  controller.abort()
  await expect(result).rejects.toThrow('取消')
})

test('Given 安装开始前已经取消 When 准备执行 Then 不尝试启动安装器', async () => {
  /** 无效可执行文件若被启动会产生不同错误，验证取消在 spawn 前生效。 */
  const controller = new AbortController()
  controller.abort()
  await expect(runDriverInstallerProcess('/missing/installer', [], process.env, 2000, controller.signal)).rejects.toThrow('取消')
})
