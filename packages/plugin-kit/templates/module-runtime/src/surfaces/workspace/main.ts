import {
  PLUGIN_SURFACE_CONNECTED_MESSAGE,
  PLUGIN_SURFACE_READY_MESSAGE,
  applyPluginSurfaceTheme,
  installPluginSurfaceComponentStyles,
  isPluginSurfaceThemeMessage,
} from '@dutydeck/plugin-sdk'

/** 注入与 DutyDeck 一致的弹窗、表单和按钮规范。 */
installPluginSurfaceComponentStyles()

/** Surface 仅通过宿主注入的 MessagePort 通信，不直接访问 window.electronAPI。 */
const status = document.querySelector<HTMLParagraphElement>('#status')
const demoDialog = document.querySelector<HTMLDialogElement>('#demo-dialog')

document.querySelector<HTMLButtonElement>('#open-demo')?.addEventListener('click', () => {
  demoDialog?.showModal()
})

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog')?.close())
}

window.addEventListener('message', (event) => {
  /** 主题只接受父窗口下发，避免 Surface 内嵌文档伪造宿主样式。 */
  if (event.source === window.parent && isPluginSurfaceThemeMessage(event.data)) {
    applyPluginSurfaceTheme(event.data.theme)
    return
  }
  if (event.source !== window.parent
    || event.data?.type !== PLUGIN_SURFACE_CONNECTED_MESSAGE
    || !event.ports[0]) return
  event.ports[0].postMessage({ type: 'surface.ready' })
  if (status) status.textContent = '宿主 bridge 已连接。'
})

/** 脚本注册完成后主动握手，避免 custom protocol 快速加载时错过宿主 onLoad。 */
if (window.parent !== window) {
  window.parent.postMessage({ type: PLUGIN_SURFACE_READY_MESSAGE }, '*')
}
