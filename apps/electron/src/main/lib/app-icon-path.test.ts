import { describe, expect, test } from 'bun:test'
import { resolveDutyDeckAppIconPath } from './app-icon-path'

describe('DutyDeck 应用图标路径', () => {
  test.each(['default', '', 'black', 'proma-gradient', 'unknown'])('旧变体 %s 均回退默认图标', (variantId) => {
    expect(resolveDutyDeckAppIconPath('/resources', variantId)).toBe('/resources/icon.png')
  })
})
