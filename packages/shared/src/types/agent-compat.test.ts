import { describe, expect, test } from 'bun:test'
import {
  DUTYDECK_DEFAULT_PERMISSION_MODE,
  DUTYDECK_PERMISSION_MODE_CONFIG,
  PROMA_DEFAULT_PERMISSION_MODE,
  PROMA_PERMISSION_MODE_CONFIG,
  type DutyDeckPermissionMode,
  type PromaPermissionMode,
} from './agent'

describe('DutyDeck 权限类型兼容', () => {
  test('新旧类型与配置别名保持相同值', () => {
    const mode: DutyDeckPermissionMode = 'plan'
    const legacyMode: PromaPermissionMode = mode
    expect(legacyMode).toBe(mode)
    expect(String(PROMA_DEFAULT_PERMISSION_MODE)).toBe(String(DUTYDECK_DEFAULT_PERMISSION_MODE))
    expect(PROMA_PERMISSION_MODE_CONFIG).toBe(DUTYDECK_PERMISSION_MODE_CONFIG)
  })
})
