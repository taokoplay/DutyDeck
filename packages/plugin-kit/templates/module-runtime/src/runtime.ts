import { definePlugin } from '@dutydeck/plugin-sdk'

/** 最小可执行插件的 runtime；宿主工具和 Surface handler 在此注册。 */
export default definePlugin({
  async activate() {
    // 实际工具处理函数由宿主 SDK 适配层绑定；模板只验证插件可被加载和激活。
  },

  async deactivate() {
    // 插件释放自身计时器、订阅和临时资源。
  },
})
