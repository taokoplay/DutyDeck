/** 内容插件的模块声明；本地 ID 与展示名相互独立。 */
export interface PluginModule {
  id: string;
  displayName: string;
  activation: 'message-explicit';
  skills: string[];
  prompts: string[];
  styles?: string[];
}
/** 独占归属某个模块的 Skill 资源。 */
export interface PluginSkill {
  id: string;
  ownerModuleId: string;
  displayName: string;
  version: string;
  path: string;
  required: boolean;
}
/** 包内纯文本提示资源。 */
export interface PluginPrompt {
  id: string;
  version: string;
  kind: 'workflow' | 'output-contract' | 'style-guidance';
  path: string;
}
/** 可选的包内设计约束资源声明。 */
export interface PluginStyle {
  id: string;
  version: string;
  path: string;
}
/** V2 内容插件合同，不授予运行代码或系统权限。 */
export interface PluginPackageManifest {
  formatVersion: 2;
  apiVersion: '1.0.0';
  id: string;
  publisherId: string;
  version: string;
  displayName: string;
  description: string;
  license: string;
  profile: 'content';
  compatibility: {
    hostApi: string;
    requiredFeatures: string[];
    platforms: ('darwin' | 'win32' | 'linux')[];
    architectures: ('arm64' | 'x64')[];
  };
  modules: PluginModule[];
  skills: PluginSkill[];
  prompts: PluginPrompt[];
  styles?: PluginStyle[];
  permissions: never[];
  dependencies: never[];
  exports: never[];
  support?: {
    repository?: string;
    issues?: string;
  };
}
/** 结构错误始终保留源文件和 JSON 字段定位。 */
export interface ValidationIssue {
  code: 'schema' | 'unsupported' | 'identity' | 'path' | 'reference' | 'resource' | 'budget';
  message: string;
  file: string;
  field: string;
}
/** 成功仅代表结构有效，不代表签名有效或发布者可信。 */
export type ValidationResult<T> = {
  ok: true;
  value: T;
  issues: ValidationIssue[];
} | {
  ok: false;
  issues: ValidationIssue[];
};
/** 资源绑定供宿主在完成发布者信任验证后使用。 */
export interface ValidatedPluginResource {
  id: string;
  kind: 'skill' | 'prompt' | 'style';
  ownerModuleIds: string[];
  path: string;
  version: string;
  content: string;
  byteLength: number;
}
/** 整包资源校验结果不声明系统隔离或签名有效。 */
export interface ValidatedPluginResources {
  pluginId: string;
  trust: 'unverified';
  resources: ValidatedPluginResource[];
}
/** 资源与单轮预算，以 UTF-8 字节计算。 */
export const RESOURCE_LIMITS = Object.freeze({
  promptBytes: 16 * 1024, totalPromptBytes: 64 * 1024, skillBytes: 64 * 1024, turnPromptBytes: 64 * 1024, turnSkillBytes: 128 * 1024
});
/** 生成全限定模块身份；入参必须来自成功校验的 manifest。 */
export function getModuleId(pluginId: string, localId: string): string { return `${pluginId}.${localId}`; }
/** 生成全限定 Skill 身份；入参必须来自成功校验的 manifest。 */
export function getSkillId(pluginId: string, localId: string): string { return `${pluginId}/skills/${localId}`; }
