import type { DshBuildRecipe } from '../../../packages/plugin-kit/src/dsh-compat/recipe'

/** 仅开发侧固定配方。来源来自2026-11-06逐文件入口审查；变动必须重新审查，不从包动态生成批准字段。 */
const adapter: DshBuildRecipe['adapter'] = {
  version: '0.1.0', sha256: 'c9721dd5410f246c4cb68f197fa45c54b24737081a3748ab663e25a08e43ad37', license: 'AGPL-3.0-only',
}
const toolsReason = '仅替换已审查入口使用的defineTool/tools.register及静态参数、输出校验、纯文本投影；参考dsh-tools@0.1.0-rc.6，不加载原实现或其依赖。'
const lifecycleReason = '已审查后端不import Cordis，仅以DutyDeck激活、登记、释放替代apply与tools注入；不实现原Cordis服务。'
const commonLimitations = [
  '仅工具限定转换；原运行/optional/peer依赖闭包仍unresolved，不代表原DSH包兼容。',
  '不执行patch或原包脚本，不公开client、helper exports、原Agent与Cordis服务；保留Pi与逐次审批。',
  '参数不强制转换、不注入schema默认值；非有限输出在render前拒绝，错误统一而不泄露原异常。',
  'utilityProcess是进程/故障隔离而非OS沙箱；只适用于本配方精确审查字节。',
  '构建默认未签名、不安装、不信任；转换方签名不代表上游作者认可。',
]
const pace: DshBuildRecipe = {
  formatVersion: 1, recipeId: 'dsh-pace-calc-tool-only', recipeVersion: '0.1.0',
  source: {
    name: 'dsh-pace-calc', version: '0.1.1', archiveSha256: '15cafc89709c7af5db4b88b387f22f229bc8d4888aed18e913b9536584347d81',
    url: 'https://registry.npmjs.org/dsh-pace-calc/-/dsh-pace-calc-0.1.1.tgz', license: 'MIT',
    files: {
      'package.json': 'c4afd7166e3977d135768d9497c65dc59032d4a59495798c90916d129bc5ca01',
      LICENSE: '5c5d5f7e2f45f50db80f1a306f5f9c0552f62a0bf1abddb3c6dfb078e5b0d6fe',
      'lib/index.js': '10ebc2b76747846148f43e53f2ac7c878a374864b09920e0ebf2fc31f80575ed',
    },
  },
  entry: 'lib/index.js', imports: { 'lib/index.js': { '@deepseek-ai/dsh-tools': '@dsh/define-tool' } }, adapter,
  plugin: { id: 'dutydeck-dsh.pace-calc', version: '0.1.0', title: '配速计算（工具限定试点）', description: '固定转换dsh-pace-calc 0.1.1的pace_calc，仅提供配速计算，不是训练指导或整包兼容。' },
  tool: { upstreamName: 'pace_calc', inputSchema: { type: 'object', properties: {
    dist: { type: 'number', description: '距离（公里），默认5' }, min: { type: 'number', description: '时间分，默认30' }, sec: { type: 'number', description: '时间秒，默认0' },
  } } },
  dependencyDispositions: [
    { group: 'peerDependencies', name: '@deepseek-ai/cordis', specifier: '^4.0.1', treatment: 'registration-lifecycle', reason: lifecycleReason },
    { group: 'peerDependencies', name: '@deepseek-ai/dsh-tools', specifier: '>=0.1.0-rc.6', treatment: 'limited-tool-adapter', reason: toolsReason },
  ],
  limitations: [...commonLimitations, '保持上游算法：dist/min的0会回退到5/30；秒舍入可能显示60且不进位；未限制负距离/负时间。非有限结果拒绝，不静默改成null。'],
}
const clientRange = '^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.2.0-rc.1 || ^0.2.1-alpha.1'
const unitverse: DshBuildRecipe = {
  formatVersion: 1, recipeId: 'dsh-unitverse-tool-only', recipeVersion: '0.1.0',
  source: {
    name: 'dsh-unitverse', version: '1.1.4', archiveSha256: '0468b9b1bd9ea2c62fb7846c06b276af777267356bfe33fa29e13e7b7b85ded7',
    url: 'https://registry.npmjs.org/dsh-unitverse/-/dsh-unitverse-1.1.4.tgz', license: 'MIT',
    files: {
      'package.json': 'ff3c7cbc2a7126ba094e9cd86e9de44a1f7a16f2cf8e6d8dce8d146f3d6a1af3',
      LICENSE: '7d354c1fe4e8c45ff26be7569a0c54dbb5f63ee4ddd48749de6bd931387daae5',
      'lib/index.js': '4cf126c963f6665d425159b18eee124ee1a6f57e7de8548d2be844f254f6a56f',
      'lib/chunk-TYC2FTN7.js': '83ddade26ba2473de0a4a1191277f01aff2e7ce86784e71f2683893a24603a6c',
    },
  },
  entry: 'lib/index.js', imports: {
    'lib/index.js': { '@deepseek-ai/dsh-tools': '@dsh/define-tool', './chunk-TYC2FTN7.js': 'lib/chunk-TYC2FTN7.js' },
    'lib/chunk-TYC2FTN7.js': {},
  }, adapter,
  plugin: { id: 'dutydeck-dsh.unitverse', version: '0.1.0', title: '单位换算（工具限定试点）', description: '固定转换dsh-unitverse 1.1.4的convert，十类单位换算；不包含客户端或通用库导出。' },
  tool: { upstreamName: 'convert', inputSchema: { type: 'object', properties: {
    value: { type: 'number', description: 'The numeric amount to convert (finite number).' },
    from: { type: 'string', description: 'Source unit token: symbol, English or Chinese name (case-insensitive).' },
    to: { type: 'string', description: 'Target unit token: symbol, English or Chinese name (case-insensitive).' },
  }, required: ['value', 'from', 'to'] } },
  dependencyDispositions: [
    { group: 'peerDependencies', name: '@deepseek-ai/cordis', specifier: '*', treatment: 'registration-lifecycle', reason: lifecycleReason },
    { group: 'peerDependencies', name: '@deepseek-ai/dsh-tools', specifier: clientRange, treatment: 'limited-tool-adapter', reason: toolsReason },
    ...['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-slots', 'react', 'react-dom'].map(name => ({
      group: 'peerDependencies' as const, name, specifier: name.startsWith('react') ? '^18.2.0' : clientRange,
      treatment: 'excluded-client' as const,
      reason: '独立./client导出被整体排除；所选ESM后端仅依赖纯计算chunk与defineTool，无客户端可达路径。不宣称满足原客户端/宿主peer；react-dom直接使用未确证。',
    })),
  ],
  limitations: [...commonLimitations,
    '保持上游大小写不敏感语义：mw表示MW而非mW；月/年按Julian平均值，不是历法计算；不校验绝对零度物理范围。',
    '结果十位有效数字，不公开significantDigits/helper API；有限输入运算溢出也会拒绝，不返回Infinity成功文本。',
  ],
}

/** 返回独立数据副本；这里的静态登记是审查输入，不是运行授权或verified标记。 */
export function getDshPilotRecipes(): DshBuildRecipe[] {
  return JSON.parse(JSON.stringify([pace, unitverse])) as DshBuildRecipe[]
}
