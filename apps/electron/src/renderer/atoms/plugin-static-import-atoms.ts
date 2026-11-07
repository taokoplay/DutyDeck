import { atom } from 'jotai'
import type { PluginStaticImportApi, StaticImportPlanSummary, StaticImportPreview } from '@dutydeck/shared'
export interface StaticImportState {
  workspaceId: string | null
  plans: StaticImportPlanSummary[] | null
  preview: StaticImportPreview | null
  busy: boolean
  error: string | null
}
export const pluginStaticImportAtom = atom<StaticImportState>({ workspaceId: null, plans: null, preview: null, busy: false, error: null })
export interface StaticImportAction { api: PluginStaticImportApi; kind: 'list' | 'preview' | 'apply' | 'undo'; planHash?: string; confirmed?: boolean; trustPublisher?: boolean }
export const runStaticImportActionAtom = atom(null, async (get, set, action: StaticImportAction): Promise<void> => {
  const initial = get(pluginStaticImportAtom)
  if (initial.busy) return
  if ((action.kind === 'apply' || action.kind === 'undo') && action.confirmed !== true) return
  set(pluginStaticImportAtom, { ...initial, busy: true, error: null })
  try {
    if (action.kind === 'list') {
      const plans = await action.api.list()
      set(pluginStaticImportAtom, state => ({ ...state, plans }))
    } else if (action.kind === 'preview') {
      if (!initial.workspaceId || !action.planHash) throw new Error('缺少工作区或配方')
      const preview = await action.api.preview({ planHash: action.planHash, workspaceId: initial.workspaceId })
      if (get(pluginStaticImportAtom).workspaceId === initial.workspaceId) set(pluginStaticImportAtom, state => ({ ...state, preview }))
    } else {
      if (!initial.preview || initial.preview.workspaceId !== initial.workspaceId) throw new Error('请重新预览')
      const receipt = action.kind === 'apply'
        ? await action.api.apply({ token: initial.preview.token, confirmed: true, ...(action.trustPublisher && initial.preview.content ? { trustedKeyId: initial.preview.content.keyId } : {}) })
        : await action.api.undo({ token: initial.preview.token, confirmed: true })
      if (get(pluginStaticImportAtom).workspaceId === initial.workspaceId && get(pluginStaticImportAtom).preview === initial.preview) {
        set(pluginStaticImportAtom, state => ({ ...state, preview: { ...initial.preview!, receipt } }))
      }
    }
  } catch {
    if (get(pluginStaticImportAtom).workspaceId === initial.workspaceId) set(pluginStaticImportAtom, state => ({ ...state,
      error: action.kind === 'list' || action.kind === 'preview'
        ? '读取失败，本次读取未导入或撤销资源。上次显示已保留，请重试；若仍失败，请在原管理界面核对配置。'
        : '操作未全部完成。原回执已保留；其他目录可能已有部分提交，请重新预览核对，勿按全部回滚处理。' }))
  } finally { set(pluginStaticImportAtom, state => ({ ...state, busy: false })) }
})
