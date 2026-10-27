/**
 * 系统代理检测工具
 *
 * 支持 macOS、Windows、Linux 三个平台的系统代理自动检测。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SystemProxyDetectResult } from '@dutydeck/shared'

const execFileAsync = promisify(execFile)
const SYSTEM_PROXY_COMMAND_TIMEOUT_MS = 3_000

/**
 * 在不阻塞 Electron 主进程的前提下执行系统代理查询命令。
 * `execFile` 不经 shell 解析参数，且 timeout 会终止卡住的系统命令。
 */
async function runSystemProxyCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf-8',
    timeout: SYSTEM_PROXY_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  })
  return stdout
}

/**
 * 检测系统代理配置
 *
 * @returns 检测结果，包含代理地址（如果有）
 */
export async function detectSystemProxy(): Promise<SystemProxyDetectResult> {
  const platform = process.platform

  try {
    switch (platform) {
      case 'darwin':
        return await detectMacOSProxy()
      case 'win32':
        return await detectWindowsProxy()
      case 'linux':
        return detectLinuxProxy()
      default:
        return {
          success: false,
          detectionState: 'error',
          message: `不支持的平台: ${platform}`,
        }
    }
  } catch {
    console.error('[系统代理检测] 检测失败')
    return {
      success: false,
      detectionState: 'error',
      message: '系统代理检测失败',
    }
  }
}

/**
 * 检测 macOS 系统代理
 *
 * 使用 networksetup 命令读取网络偏好设置中的 HTTPS/HTTP 代理配置。
 * 优先使用 HTTPS 代理（Secure Web Proxy），回退到 HTTP 代理。
 * 解决用户仅配置 HTTPS 代理而未配置 HTTP 代理时检测失败的问题。
 */
async function detectMacOSProxy(): Promise<SystemProxyDetectResult> {
  try {
    // 尝试获取当前活动的网络服务
    let networkService = 'Wi-Fi'
    try {
      const services = await runSystemProxyCommand('networksetup', ['-listallnetworkservices'])
      const serviceList = services.split('\n').filter((s) => s && !s.startsWith('*'))

      // 优先使用 Wi-Fi，其次是以太网
      if (serviceList.includes('Wi-Fi')) {
        networkService = 'Wi-Fi'
      } else if (serviceList.includes('Ethernet')) {
        networkService = 'Ethernet'
      } else if (serviceList.length > 0) {
        networkService = serviceList[0]!
      }
    } catch {
      // 如果获取服务列表失败，使用默认的 Wi-Fi
    }

    /** 解析 networksetup 输出的代理配置行 */
    function parseProxyOutput(output: string): { enabled: boolean; server: string; port: string } {
      const lines = output.split('\n')
      let enabled: boolean | undefined
      let server = ''
      let port = ''

      for (const line of lines) {
        if (line.includes('Enabled: Yes')) {
          enabled = true
        } else if (line.includes('Enabled: No')) {
          enabled = false
        } else if (line.includes('Server:')) {
          server = line.slice(line.indexOf(':') + 1).trim()
        } else if (line.includes('Port:')) {
          port = line.split(':')[1]?.trim() || ''
        }
      }

      if (enabled === undefined || (enabled && (!server || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))) {
        throw new Error('系统代理输出格式无效')
      }
      if (enabled) {
        const address = new URL(`http://${server}:${port}`)
        if (!address.hostname) throw new Error('系统代理地址无效')
      }
      return { enabled, server, port }
    }

    /** HTTPS未确认时，即使HTTP关闭也不能断言直连。 */
    let httpsDetectionFailed = false
    // 优先检查 HTTPS 代理（Secure Web Proxy）
    try {
      const httpsOutput = await runSystemProxyCommand('networksetup', ['-getsecurewebproxy', networkService])
      const httpsProxy = parseProxyOutput(httpsOutput)
      if (httpsProxy.enabled && httpsProxy.server && httpsProxy.port) {
        const proxyUrl = `http://${httpsProxy.server}:${httpsProxy.port}`
        return {
          success: true,
          detectionState: 'proxy',
          proxyUrl,
          message: `检测到系统 HTTPS 代理: ${proxyUrl}`,
        }
      }
    } catch {
      // HTTPS 失败仍允许HTTP找到可用代理，但不允许回落直连。
      httpsDetectionFailed = true
    }

    // 回退：检查 HTTP 代理（Web Proxy）
    const httpOutput = await runSystemProxyCommand('networksetup', ['-getwebproxy', networkService])
    const httpProxy = parseProxyOutput(httpOutput)
    if (httpProxy.enabled && httpProxy.server && httpProxy.port) {
      const proxyUrl = `http://${httpProxy.server}:${httpProxy.port}`
      // 代理启用但地址损坏时必须保留error，不能发出可用代理通知。
      if (!new URL(proxyUrl).hostname) throw new Error('系统代理地址无效')
      return {
        success: true,
        detectionState: 'proxy',
        proxyUrl,
        message: `检测到系统 HTTP 代理: ${proxyUrl}`,
      }
    }

    if (httpsDetectionFailed) throw new Error('HTTPS代理状态无法确认')
    return {
      success: false,
      detectionState: 'direct',
      message: '系统未配置代理',
    }
  } catch {
    console.error('[macOS 代理检测] 失败')
    return {
      success: false,
      detectionState: 'error',
      message: 'macOS 代理检测失败',
    }
  }
}

/**
 * 检测 Windows 系统代理
 *
 * 读取注册表中的 Internet Settings 代理配置。
 */
async function detectWindowsProxy(): Promise<SystemProxyDetectResult> {
  try {
    // 读取注册表中的代理设置
    const regOutput = await runSystemProxyCommand('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyEnable',
    ])

    /** 只接受明确的注册表开关值，命令输出损坏不能当成禁用。 */
    const enabledMatch = regOutput.match(/ProxyEnable\s+REG_DWORD\s+0x([01])(?:\s|$)/)
    if (!enabledMatch) throw new Error('系统代理开关格式无效')
    const proxyEnabled = enabledMatch[1] === '1'

    if (!proxyEnabled) {
      return {
        success: false,
        detectionState: 'direct',
        message: '系统未启用代理',
      }
    }

    // 读取代理服务器地址
    const serverOutput = await runSystemProxyCommand('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v',
      'ProxyServer',
    ])

    // 解析代理服务器地址（格式通常是 "http=host:port;https=host:port" 或直接 "host:port"）
    const match = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/)
    if (match?.[1]) {
      let proxyUrl = match[1].trim()

      // 如果包含协议分隔符，提取 http 或 https 代理
      if (proxyUrl.includes('=')) {
        const httpMatch = proxyUrl.match(/https?=([^;]+)/)
        if (!httpMatch?.[1]) throw new Error('系统HTTP代理地址缺失')
        proxyUrl = httpMatch[1]
      }

      // 确保有协议前缀
      if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
        proxyUrl = `http://${proxyUrl}`
      }

      // 代理启用但地址损坏时必须保留error，不能发出可用代理通知。
      if (!new URL(proxyUrl).hostname) throw new Error('系统代理地址无效')
      return {
        success: true,
        detectionState: 'proxy',
        proxyUrl,
        message: `检测到系统代理: ${proxyUrl}`,
      }
    }

    return {
      success: false,
      detectionState: 'error',
      message: '无法读取代理服务器地址',
    }
  } catch {
    console.error('[Windows 代理检测] 失败')
    return {
      success: false,
      detectionState: 'error',
      message: 'Windows 代理检测失败',
    }
  }
}

/**
 * 检测 Linux 系统代理
 *
 * 读取环境变量 HTTP_PROXY / HTTPS_PROXY / http_proxy / https_proxy。
 */
function detectLinuxProxy(): SystemProxyDetectResult {
  const httpProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy

  if (httpProxy) {
    /** 环境变量存在但格式错误属于检测失败，不能当成有效路由。 */
    const address = new URL(httpProxy)
    if (!address.hostname || !['http:', 'https:'].includes(address.protocol)) throw new Error('系统代理环境变量格式无效')
    return {
      success: true,
      detectionState: 'proxy',
      proxyUrl: httpProxy,
      message: `检测到系统代理: ${httpProxy}`,
    }
  }

  return {
    success: false,
    detectionState: 'direct',
    message: '系统未配置代理环境变量',
  }
}
