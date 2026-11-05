import { describe, expect, test } from 'bun:test'
import {
  type LiveMarkdownTable,
  updateLiveMarkdownTableCell,
} from './live-markdown-table'

describe('实时 Markdown 表格编辑', () => {
  test('Given 两列表格 When 正常更新正文单元格 Then 返回新表格且不变异原表', () => {
    /** 更新前的两列表格。 */
    const table: LiveMarkdownTable = {
      header: ['名称', '状态'],
      alignments: [null, null],
      rows: [['任务', '完成']],
    }
    /** 正常更新正文后的新表格。 */
    const updated = updateLiveMarkdownTableCell(table, 1, 1, '进行中')

    expect(updated).not.toBe(table)
    expect(updated.rows).toEqual([['任务', '进行中']])
    expect(table.rows).toEqual([['任务', '完成']])
    expect(updated.rows).not.toBe(table.rows)
    expect(updated.rows[0]).not.toBe(table.rows[0])
  })

  test('Given 两列表格 When 更新表头或正文第三列 Then 都忽略越界写入且不扩展表格', () => {
    /** 用于验证表头和正文列上界一致的两列表格。 */
    const table: LiveMarkdownTable = {
      header: ['名称', '状态'],
      alignments: [null, null],
      rows: [['任务', '完成']],
    }
    /** 尝试越界更新表头后的结果。 */
    const headerUpdated = updateLiveMarkdownTableCell(table, 0, 2, '越界表头')
    /** 尝试越界更新正文后的结果。 */
    const rowUpdated = updateLiveMarkdownTableCell(table, 1, 2, '越界正文')

    expect(headerUpdated).toBe(table)
    expect(rowUpdated).toBe(table)
    expect(table.header).toEqual(['名称', '状态'])
    expect(table.rows).toEqual([['任务', '完成']])
  })

  test('Given 两列表格 When 行或列索引为负数 Then 拒绝更新', () => {
    /** 用于验证负索引保护的两列表格。 */
    const table: LiveMarkdownTable = {
      header: ['名称', '状态'],
      alignments: [null, null],
      rows: [['任务', '完成']],
    }

    expect(updateLiveMarkdownTableCell(table, -1, 0, '非法行')).toBe(table)
    expect(updateLiveMarkdownTableCell(table, 0, -1, '非法列')).toBe(table)
  })
})

import * as model from './live-markdown-table'

describe('表格结构编辑', () => {
  const table: LiveMarkdownTable = { header: ['名称', '状态'], alignments: ['left', 'right'], rows: [['任务', '完成']] }
  test('Given 表格 When 插入和删除正文行 Then 保留表头且不变异原表', () => {
    const inserted = model.insertLiveMarkdownTableRow(table, 0)
    expect(inserted.rows).toEqual([['', ''], ['任务', '完成']])
    expect(model.deleteLiveMarkdownTableRow(inserted, 1).rows).toEqual([['', '']])
    expect(model.deleteLiveMarkdownTableRow(table, 0).rows).toEqual([])
    expect(table.rows).toEqual([['任务', '完成']])
  })
  test('Given 已有草稿和 alignment When 增删列 Then 内容与对齐同步且至少保留两列', () => {
    const draft = updateLiveMarkdownTableCell(table, 1, 1, '草稿\n第二行')
    const inserted = model.insertLiveMarkdownTableColumn(draft, 1)
    expect(inserted.header).toEqual(['名称', '', '状态'])
    expect(inserted.rows).toEqual([['任务', '', '草稿\n第二行']])
    expect(inserted.alignments).toEqual(['left', null, 'right'])
    expect(model.deleteLiveMarkdownTableColumn(inserted, 1)).toEqual(draft)
    expect(model.deleteLiveMarkdownTableColumn(table, 1)).toBe(table)
    expect(model.parseLiveMarkdownTable(model.serializeLiveMarkdownTable(inserted))?.rows).toEqual([['任务', '', '草稿<br>第二行']])
  })
  test('Given 非整数和越界索引 When 结构编辑 Then 不变异也不创建稀疏单元格', () => {
    for (const index of [-1, 100, 0.5, NaN]) {
      expect(model.insertLiveMarkdownTableRow(table, index)).toBe(table)
      expect(model.deleteLiveMarkdownTableRow(table, index)).toBe(table)
      expect(model.insertLiveMarkdownTableColumn(table, index)).toBe(table)
      expect(model.deleteLiveMarkdownTableColumn(table, index)).toBe(table)
    }
  })
  test('Given 输入法和快捷键 When 决定行为 Then 不提前提交中文且保留换行与前后导航', () => {
    expect(model.liveMarkdownTableCellKeyAction('Enter', false, true, 13)).toBeNull()
    expect(model.liveMarkdownTableCellKeyAction('Enter', false, false, 229)).toBeNull()
    expect(model.liveMarkdownTableCellKeyAction('Enter', true, false, 13)).toBe('newline')
    expect(model.liveMarkdownTableCellKeyAction('Tab', true, false, 9)).toBe('previous')
    expect(model.nextLiveMarkdownTableCell(table, { row: 1, column: 1 }, false)).toEqual({ row: 0, column: 0 })
  })
})
