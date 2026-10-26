import { describe, expect, test } from 'bun:test'
import {
  PROJECT_STORAGE_DIRECTORY_NAME,
  LEGACY_PROJECT_STORAGE_DIRECTORY_NAME,
  PROJECT_STORAGE_OWNED_DIRECTORIES,
  PROJECT_STORAGE_MARKER_FILE_NAME,
} from './project-storage'

describe('DutyDeck 项目存储契约', () => {
  test('Given 新项目存储契约 When 读取常量 Then 使用 .dutydeck 并只迁移已知目录', () => {
    expect(PROJECT_STORAGE_DIRECTORY_NAME).toBe('.dutydeck')
    expect(LEGACY_PROJECT_STORAGE_DIRECTORY_NAME).toBe('.proma')
    expect(PROJECT_STORAGE_OWNED_DIRECTORIES).toEqual([
      'design',
      'knowledge',
      'interaction-design',
      'visual-production',
    ])
    expect(PROJECT_STORAGE_MARKER_FILE_NAME).toBe('project-storage.json')
  })
})
