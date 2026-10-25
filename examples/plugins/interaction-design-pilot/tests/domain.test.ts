import { describe, expect, test } from 'bun:test'
import {
  adoptCandidate,
  createPrototypeDocument,
  proposePageCandidate,
  summarizePrototype,
} from '../src/domain'

/** 固定时间和 ID，确保候选、版本断言与机器运行速度无关。 */
const clock = { now: () => 1_800_000_000_000, id: () => 'candidate-1' }

describe('Given 交互设计试点插件的原型文档', () => {
  test('When 创建首版 Then 包含稳定页面、入口和 revision 基线', () => {
    const document = createPrototypeDocument({
      name: '登录流程',
      platform: 'mobile',
      html: '<main><button data-prototype-element="login">登录</button></main>',
    }, clock)
    expect(document.schemaVersion).toBe(1)
    expect(document.name).toBe('登录流程')
    expect(document.entryPageId).toBe('home')
    expect(document.pages[0]).toMatchObject({ id: 'home', name: '首页' })
    expect(document.candidates).toEqual([])
    expect(summarizePrototype(document)).toMatchObject({
      name: '登录流程',
      platform: 'mobile',
      pageCount: 1,
    })
  })

  test('When 提交页面候选 Then 只新增候选而不修改正式页面', () => {
    const document = createPrototypeDocument({
      name: '登录流程',
      platform: 'mobile',
      html: '<main>旧页面</main>',
    }, clock)
    const result = proposePageCandidate(document, {
      baseRevision: 1,
      pageId: 'home',
      name: '首页',
      html: '<main>新页面</main>',
      summary: '调整登录入口',
    }, clock)
    expect(result.document.pages[0]?.html).toBe('<main>旧页面</main>')
    expect(result.candidate).toMatchObject({
      id: 'candidate-1',
      baseRevision: 1,
      status: 'ready',
      pageId: 'home',
    })
  })

  test('When 采纳当前候选 Then 更新正式页面并保留候选历史', () => {
    const document = createPrototypeDocument({
      name: '登录流程',
      platform: 'mobile',
      html: '<main>旧页面</main>',
    }, clock)
    const proposed = proposePageCandidate(document, {
      baseRevision: 1,
      pageId: 'home',
      name: '首页',
      html: '<main>新页面</main>',
      summary: '调整登录入口',
    }, clock)
    const adopted = adoptCandidate(proposed.document, {
      baseRevision: 2,
      candidateId: 'candidate-1',
    }, clock)
    expect(adopted.pages[0]?.html).toBe('<main>新页面</main>')
    expect(adopted.adoptedCandidateId).toBe('candidate-1')
    expect(adopted.candidates[0]?.status).toBe('adopted')
  })

  test('When 候选基于旧 revision Then 拒绝采纳', () => {
    const document = createPrototypeDocument({
      name: '登录流程',
      platform: 'mobile',
      html: '<main>旧页面</main>',
    }, clock)
    const proposed = proposePageCandidate(document, {
      baseRevision: 1,
      pageId: 'home',
      name: '首页',
      html: '<main>候选页面</main>',
      summary: '旧候选',
    }, clock)
    expect(() => adoptCandidate({
      ...structuredClone(proposed.document),
      revision: 3,
    }, {
      baseRevision: 3,
      candidateId: 'candidate-1',
    }, clock)).toThrow('候选已过期')
  })

  test('When 页面正文为空或名称超长 Then 拒绝创建候选', () => {
    const document = createPrototypeDocument({
      name: '登录流程',
      platform: 'mobile',
      html: '<main>旧页面</main>',
    }, clock)
    expect(() => proposePageCandidate(document, {
      baseRevision: 1,
      pageId: 'home',
      name: '首页',
      html: '   ',
      summary: '空页面',
    }, clock)).toThrow('页面正文不能为空')
    expect(() => proposePageCandidate(document, {
      baseRevision: 1,
      pageId: 'home',
      name: '页'.repeat(121),
      html: '<main>新页面</main>',
      summary: '名称过长',
    }, clock)).toThrow('页面名称长度无效')
  })
})
