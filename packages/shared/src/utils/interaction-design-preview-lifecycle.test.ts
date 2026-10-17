import { runInNewContext } from 'node:vm'
import { expect, test } from 'bun:test'
import { buildPrototypePreview } from './interaction-design-preview'

/** 测试使用的最小浏览器接口，不为共享包引入 DOM 类型依赖。 */
interface TestWindow extends EventTarget {
  setTimeout(callback: (...args: number[]) => void, delay?: number, ...args: number[]): number
  setInterval(callback: (...args: number[]) => void, delay?: number, ...args: number[]): number
  clearTimeout(id: number): void
  clearInterval(id: number): void
  requestAnimationFrame(callback: (time: number) => void): number
  cancelAnimationFrame(id: number): void
}

/** 运行实际桥的虚拟时钟；advance 输入毫秒并执行到期任务。 */
function fixture(active?: boolean) {
  /** 虚拟原生任务与时钟。 */
  let time = 0, next = 0
  const tasks = new Map<number, { at: number; callback: () => void }>()
  const window = new EventTarget() as EventTarget & Record<string, unknown>
  const parent = { postMessage() {} }
  const schedule = (callback: () => void, delay = 0) => { const id = ++next; tasks.set(id, { at: time + delay, callback }); return id }
  Object.assign(window, { setTimeout: schedule, clearTimeout: (id: number) => tasks.delete(id), requestAnimationFrame: (callback: (stamp: number) => void) => schedule(() => callback(time), 16), cancelAnimationFrame: (id: number) => tasks.delete(id), performance: { now: () => time } })
  /** 模拟文档中正在播放和用户主动暂停的视觉对象。 */
  const animation = { playState: 'running', pause() { this.playState = 'paused' }, play() { this.playState = 'running' } }
  const pausedAnimation = { playState: 'paused', pause() {}, play() { this.playState = 'running' } }
  const media = { paused: false, ended: false, isConnected: true, pause() { this.paused = true }, play() { this.paused = false; return Promise.resolve() } }
  /** 保存安装前引用，验证离线页面不会被替换调度 API。 */
  const originalTimeout = window.setTimeout as TestWindow['setTimeout']
  const originalFrame = window.requestAnimationFrame as TestWindow['requestAnimationFrame']
  const html = buildPrototypePreview({ name: '测试', platform: 'mobile', brief: '', groups: [{ id: 'g', name: '组' }], pages: [{ id: 'p', groupId: 'g', name: '页', html: '' }], entryPageId: 'p', flows: [] }, 'p', { active, mode: 'play', token: 'token', revision: 1, assets: {} })
  runInNewContext(html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>')), { window, parent, EventTarget, Event, Element: class { closest() {} getAttribute() {} }, document: { currentScript: { remove() {} }, querySelectorAll: () => [media], getAnimations: () => [animation, pausedAnimation] } })
  /** 只通过真实消息事件驱动可见性。 */
  const visible = (value: boolean, source = parent, token = 'token') => window.dispatchEvent(Object.assign(new Event('message'), { source, data: { type: 'prototype-visibility', token, active: value } }))
  /** 按到期时间执行任务，禁止把时间跳跃变成丢失回调。 */
  const advance = (duration: number) => { const end = time + duration; while (true) { const entry = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!entry) break; time = entry[1].at; tasks.delete(entry[0]); entry[1].callback() } time = end }
  return { window: window as unknown as TestWindow, visible, advance, tasks, animation, pausedAnimation, media, originalTimeout, originalFrame }
}

test('Given 定时器和动画帧 When 重复隐藏再恢复 Then 保留剩余时间且不补发历史帧', () => {
  const f = fixture(true); let timers = 0, frames = 0
  f.window.setTimeout(() => timers++, 100)
  f.window.requestAnimationFrame(() => frames++)
  f.advance(10); f.visible(false); f.advance(1000); f.visible(false); f.advance(1000)
  expect(timers).toBe(0); expect(frames).toBe(0)
  f.visible(true); f.advance(16); expect(frames).toBe(1)
  f.advance(73); expect(timers).toBe(0); f.advance(1); expect(timers).toBe(1)
})
test('Given 初始隐藏 When 注册和跨函数取消任务 Then 恢复不执行已取消任务且间隔不爆发', () => {
  const f = fixture(false); let count = 0
  const timeout = f.window.setTimeout(() => count++, 10); f.window.clearInterval(timeout)
  const interval = f.window.setInterval(() => count++, 20); f.window.clearTimeout(interval)
  f.window.setInterval(() => count++, 50)
  f.advance(1000); expect(count).toBe(0)
  f.visible(true); f.advance(50); expect(count).toBe(1)
  f.visible(false); f.advance(5000); f.visible(true); f.advance(49); expect(count).toBe(1); f.advance(1); expect(count).toBe(2)
})
test('Given 非宿主或错误令牌 When 隐藏消息 Then 保持运行；有效隐藏阻断点击和提交', () => {
  const f = fixture(true); let count = 0
  f.window.setTimeout(() => count++, 10)
  f.visible(false, { postMessage() {} }); f.visible(false, undefined, 'wrong'); f.advance(10); expect(count).toBe(1)
  f.visible(false)
  const click = new Event('click', { cancelable: true }); f.window.dispatchEvent(click); expect(click.defaultPrevented).toBe(true)
  const submit = new Event('submit', { cancelable: true }); f.window.dispatchEvent(submit); expect(submit.defaultPrevented).toBe(true)
})

test('Given 受管活动页和正在播放的媒体动画 When 隐藏恢复 Then 只恢复桥主动暂停的对象', () => {
  /** 显式受管活动页可随宿主暂停视觉对象。 */
  const f = fixture(true); let fired = false
  f.window.setTimeout(() => { fired = true }, 1); f.advance(1); expect(fired).toBe(true)
  f.visible(false); expect(f.animation.playState).toBe('paused'); expect(f.media.paused).toBe(true)
  f.visible(true); expect(f.animation.playState).toBe('running'); expect(f.media.paused).toBe(false)
  expect(f.pausedAnimation.playState).toBe('paused')
})
test('Given 初始隐藏与隐藏期间新增媒体 When 正文就绪或播放 Then 暂停直到宿主恢复', () => {
  const f = fixture(false)
  f.window.dispatchEvent(new Event('DOMContentLoaded'))
  expect(f.media.paused).toBe(true); expect(f.animation.playState).toBe('paused')
  f.media.paused = false; f.window.dispatchEvent(new Event('play')); expect(f.media.paused).toBe(true)
  f.visible(true); expect(f.media.paused).toBe(false)
})
test('Given 隐藏中的动画帧与自取消间隔 When 恢复 Then 取消语义和回调参数均保留', () => {
  const f = fixture(false); let count = 0
  const frame = f.window.requestAnimationFrame(() => count++); f.window.cancelAnimationFrame(frame)
  const interval = f.window.setInterval((amount: number) => { count += amount; f.window.clearInterval(interval) }, 5, 3)
  f.visible(true); f.advance(100); expect(count).toBe(3)
})

test('Given 未传 active 的离线页面 When 构建并收到可见性消息 Then 保持原生调度入口和原有运行', () => {
  const f = fixture()
  expect(f.window.setTimeout).toBe(f.originalTimeout)
  expect(f.window.requestAnimationFrame).toBe(f.originalFrame)
  f.visible(false); let count = 0
  f.window.setTimeout(() => count++, 1); f.advance(1); expect(count).toBe(1)
})
test('Given 不同种类任务 When 使用错误取消 API Then 不互相误删', () => {
  const f = fixture(false); let count = 0
  const timer = f.window.setTimeout(() => count++, 1)
  const frame = f.window.requestAnimationFrame(() => count++)
  f.window.cancelAnimationFrame(timer); f.window.clearTimeout(frame); f.window.clearInterval(frame)
  f.visible(true); f.advance(20); expect(count).toBe(2)
})
