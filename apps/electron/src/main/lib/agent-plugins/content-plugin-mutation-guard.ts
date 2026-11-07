import { getDefaultDataRootInstanceLeaseRegistry } from '../data-root-instance-lease'
export type ContentPluginMutationLeases = Pick<ReturnType<typeof getDefaultDataRootInstanceLeaseRegistry>, 'acquireMigrationGuard' | 'hasOtherActiveLease'>
/** 所有内容插件变更共享实例与运行门禁；仅包裹同步提交，不占用网络等待。 */
export function createContentPluginMutationGuard(isBusy: () => boolean, leases?: ContentPluginMutationLeases): <T>(operation: () => T) => Promise<T> {
  return async <T>(operation: () => T): Promise<T> => {
    const authority = leases ?? getDefaultDataRootInstanceLeaseRegistry()
    const guard = await authority.acquireMigrationGuard()
    try {
      if (await authority.hasOtherActiveLease()) throw new Error('请关闭共享此数据目录的其他 DutyDeck 窗口后，再修改插件')
      if (isBusy()) throw new Error('Agent 正在运行或排队，请等待结束后再修改插件')
      return operation()
    } finally { guard.release() }
  }
}
