/** Surface 仅通过宿主注入的 MessagePort 通信，不直接访问 window.electronAPI。 */
const status = document.querySelector<HTMLParagraphElement>('#status')

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'dutydeck.plugin.surface.connected' || !event.ports[0]) return
  event.ports[0].postMessage({ type: 'surface.ready' })
  if (status) status.textContent = '宿主 bridge 已连接。'
})
