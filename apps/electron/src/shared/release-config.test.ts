import { expect, test } from 'bun:test'
import {
  DUTYDECK_DOWNLOAD_URL,
  DUTYDECK_RELEASE_REPOSITORY,
  PROMA_OFFICIAL_RELEASE_REPOSITORY,
} from './release-config'

test('独立 Release 来源统一指向 taokoplay/DutyDeck', () => {
  expect(DUTYDECK_RELEASE_REPOSITORY).toEqual({
    owner: 'taokoplay',
    repo: 'DutyDeck',
    webUrl: 'https://github.com/taokoplay/DutyDeck',
  })
})

test('更新下载入口统一指向独立仓库的最新 Release 页面', () => {
  expect(DUTYDECK_DOWNLOAD_URL).toBe(`${DUTYDECK_RELEASE_REPOSITORY.webUrl}/releases/latest`)
})

test('官方 Release 历史继续指向上游 proma-ai/Proma', () => {
  expect(PROMA_OFFICIAL_RELEASE_REPOSITORY).toEqual({
    owner: 'proma-ai',
    repo: 'Proma',
    webUrl: 'https://github.com/proma-ai/Proma',
  })
})
