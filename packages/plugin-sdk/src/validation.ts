import type { PluginPackageManifest, ValidationIssue, ValidationResult, ValidatedPluginResources, ValidatedPluginResource } from './contracts.js';
import { getModuleId, getSkillId, RESOURCE_LIMITS } from './contracts.js';
import { PLUGIN_MANIFEST_SCHEMA } from './schema.js';
import type { SchemaNode } from './schema.js';
/** 判断值是否是普通对象，拒绝类实例等非 JSON 输入。 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** 遍历同源 Schema 子集，将错误累积到具有文件定位的结果中。 */
function check(value: unknown, schema: SchemaNode, field: string, file: string, issues: ValidationIssue[]): void {
  /** 添加当前字段错误，不中断其它字段检查。 */
  const fail = (message: string): void => {
    issues.push({
      code: /profile|apiVersion|requiredFeatures|hostApi|dependencies|exports|permissions/.test(field) ? 'unsupported' : 'schema',
      message,
      file,
      field,
    });
  };
  if ('const' in schema && value !== schema.const)
    fail('值不属于当前支持的合同');
  if (schema.enum && !schema.enum.includes(value))
    fail('值不属于允许枚举');
  if (schema.type === 'object') {
    if (!record(value)) {
      fail('必须是普通对象');
      return;
    }
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key))
        fail(`缺少字段 ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      const child = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (!child)
        issues.push({
          code: 'schema', message: `未知字段 ${key}`, file, field: `${field}.${key}`
        });
      else
        check(entry, child, `${field}.${key}`, file, issues);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      fail('必须是数组');
      return;
    }
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) {
      fail('数组长度超出合同范围');
      return;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        issues.push({
          code: 'schema', message: '数组不得含稀疏空位', file, field: `${field}[${index}]`
        });
        return;
      }
    }
    if (schema.uniqueItems) {
      try {
        if (new Set(value.map(entry => JSON.stringify(entry))).size !== value.length)
          fail('数组不得重复');
      } catch {
        fail('输入必须是无循环 JSON');
        return;
      }
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        check(value[index], schema.items, `${field}[${index}]`, file, issues);
      }
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') {
      fail('必须是字符串');
      return;
    }
    /** JSON Schema 长度约束按 Unicode 码点计算。 */
    const codePointLength = [...value].length;
    if (codePointLength < (schema.minLength ?? 0) || codePointLength > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))
      fail('字符串不符合合同格式');
  } else if (schema.type && typeof value !== schema.type)
    fail(`必须是 ${schema.type}`);
}
/** 检查跨平台路径，ASCII 限制消除 Unicode 归一化混淆。 */
export function isPortableResourcePath(path: string): boolean {
  return path.length <= 240
    && /^[A-Za-z0-9_.\/-]+$/.test(path)
    && path.split('/').every(part =>
      !!part && part !== '.' && part !== '..'
      && !/[. ]$/.test(part)
      && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
    );
}
/** 登记文件路径并检测文件/目录冲突；两个集合按小写保存以适配大小写不敏感系统。 */
function registerResourcePath(path: string, files: Set<string>, directories: Set<string>): boolean {
  /** 规范化仅用于碰撞比较，不改变调用者原始路径。 */
  const normalized = path.toLowerCase();
  /** 目录集合让逆序插入父文件时也能立即发现冲突。 */
  const segments = normalized.split('/');
  let conflict = !isPortableResourcePath(path) || files.has(normalized) || directories.has(normalized);
  let parent = '';
  for (const segment of segments.slice(0, -1)) {
    parent = parent ? `${parent}/${segment}` : segment;
    if (files.has(parent))
      conflict = true;
    directories.add(parent);
  }
  files.add(normalized);
  return !conflict;
}
/** 解析未知输入；成功仅表示结构及引用关系合法，不证明签名或发布者身份。 */
export function parsePluginManifest(input: unknown, file = 'plugin.json'): ValidationResult<PluginPackageManifest> {
  /** 累积校验问题，避免让作者逐个修复后重跑。 */
  const issues: ValidationIssue[] = [];
  check(input, PLUGIN_MANIFEST_SCHEMA, '$', file, issues);
  if (issues.length)
    return {
      ok: false, issues
    };
  /** 同源 Schema 已检查所有字段，此后只执行语义校验。 */
  const manifest = input as PluginPackageManifest;
  /** 创建具备位置的语义错误。 */
  const fail = (code: ValidationIssue['code'], field: string, message: string): void => {
    issues.push({ code, field, file, message });
  };
  if (!manifest.id.startsWith(`${manifest.publisherId}.`) || manifest.publisherId === 'builtin' || manifest.id.startsWith('builtin.'))
    fail('identity', '$.id', '插件身份必须属于发布者且不得使用 builtin 保留身份');
  /** 检查各命名空间的唯一身份。 */
  for (const [kind, entries] of [['modules', manifest.modules], ['skills', manifest.skills], ['prompts', manifest.prompts], ['styles', manifest.styles ?? []]] as const) {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (seen.has(entry.id) || entry.id === 'builtin')
        fail('identity', `$.${kind}[${index}].id`, '身份重复或保留');
      seen.add(entry.id);
    });
  }
  /** 所有资源路径在大小写不敏感文件系统上也必须唯一。 */
  const paths = new Set<string>();
  /** 已占用目录集合同时拒绝正序与逆序的前缀冲突。 */
  const directories = new Set<string>();
  for (const [kind, entries] of [['skills', manifest.skills], ['prompts', manifest.prompts], ['styles', manifest.styles ?? []]] as const)
    entries.forEach((entry, index) => {
      if (!registerResourcePath(entry.path, paths, directories))
        fail('path', `$.${kind}[${index}].path`, '资源路径不规范、大小写冲突或文件与目录冲突');
    });
  manifest.modules.forEach((module, index) => {
    for (const [kind, ids, entries] of [['skills', module.skills, manifest.skills], ['prompts', module.prompts, manifest.prompts], ['styles', module.styles ?? [], manifest.styles ?? []]] as const)
      ids.forEach(id => {
        if (!entries.some(entry => entry.id === id))
          fail('reference', `$.modules[${index}].${kind}`, '引用资源不存在');
      });
  });
  manifest.skills.forEach((skill, index) => {
    const owners = manifest.modules.filter(module => module.skills.includes(skill.id));
    if (owners.length !== 1 || owners[0]?.id !== skill.ownerModuleId)
      fail('reference', `$.skills[${index}].ownerModuleId`, 'Skill 必须恰好由声明的模块独占引用');
  });
  return issues.length ? {
    ok: false, issues
  } : {
    ok: true, value: manifest, issues
  };
}
/** 校验入口别名，保证 CLI 与宿主复用完全相同的解析规则。 */
export const validatePluginManifest = parsePluginManifest;
/** 验证有界 JSON 设计资源；不支持执行代码或宿主扩展。 */
function validateStyle(value: unknown, id: string, version: string): boolean {
  if (!record(value))
    return false;
  /** 顶层白名单防止误接纳未知扩展点。 */
  const allowed = ['schemaVersion', 'id', 'version', 'displayName', 'description', 'platforms', 'tokens', 'layout', 'components', 'motion', 'accessibility', 'do', 'dont', 'examples', 'license'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key)))
    return false;
  if (value.schemaVersion !== 1 || value.id !== id || value.version !== version)
    return false;
  if (!['displayName', 'description', 'license'].every(key => typeof value[key] === 'string' && (value[key] as string).trim().length > 0))
    return false;
  /** 设计说明单独限制 UTF-8 预算，与整个 JSON 文件预算分开。 */
  if (new TextEncoder().encode(value.description as string).byteLength > 8 * 1024)
    return false;
  if (!Array.isArray(value.platforms) || !value.platforms.length || !value.platforms.every(platform => ['web', 'desktop', 'mobile', 'darwin', 'win32', 'linux'].includes(platform)))
    return false;
  if (!['tokens', 'layout', 'components', 'motion', 'accessibility'].every(key => record(value[key])))
    return false;
  if (!['do', 'dont', 'examples'].every(key => Array.isArray(value[key]) && (value[key] as unknown[]).every(item => typeof item === 'string')))
    return false;
  if (!(value.examples as string[]).every(isPortableResourcePath))
    return false;
  /** 深度与节点数上限防止过大结构消耗解析和提示预算。 */
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 8)
      return false;
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string')
      return true;
    if (typeof entry === 'number')
      return Number.isFinite(entry) && Math.abs(entry) <= 1e9;
    if (Array.isArray(entry))
      return entry.length <= 64 && entry.every(child => visit(child, depth + 1));
    return record(entry) && Object.keys(entry).length <= 128 && Object.entries(entry).every(([key, child]) => !['__proto__', 'constructor', 'prototype'].includes(key) && visit(child, depth + 1));
  };
  return visit(value, 0);
}
/** 检查真正的二级 Markdown 章节；代码围栏、缩进代码与 HTML 注释不能伪造标题。 */
function hasRequiredMarkdownSections(body: string, required: readonly string[]): boolean {
  /** 保存每个真实二级标题是否已出现有效正文。 */
  const sections = new Map<string, boolean>();
  /** 当前二级章节；顶层标题会结束原章节。 */
  let current: string | undefined;
  /** 围栏必须由同类且不少于起始长度的字符闭合。 */
  let fence: {
    character: string;
    length: number;
  } | undefined;
  /** 注释内内容不可作为可见章节或正文。 */
  const visibleBody = body.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const line of visibleBody.split(/\r?\n/)) {
    /** 仅零至三个空格缩进的围栏具有 Markdown 围栏语义。 */
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        fence = undefined;
      } else if (current && line.trim()) {
        sections.set(current, true);
      }
      continue;
    }
    if (marker) {
      fence = {
        character: marker[1]![0]!, length: marker[1]!.length
      };
      continue;
    }
    /** 标题只识别顶层 ATX 形式，列表和引用内的标题不计入合同。 */
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (heading[1]!.length <= 2) {
        current = heading[1]!.length === 2 ? heading[2]!.trim() : undefined;
        if (current && !sections.has(current))
          sections.set(current, false);
      }
      continue;
    }
    if (current && line.trim())
      sections.set(current, true);
  }
  return required.every(section => sections.get(section) === true);
}
/** 校验调用方提供的包内字节集合，返回可供可信安装绑定的纯文本元数据。 */
export function validatePluginResources(manifest: PluginPackageManifest, files: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>): ValidationResult<ValidatedPluginResources> {
  /** 防止调用者以类型断言跳过 manifest 校验。 */
  const parsed = parsePluginManifest(manifest);
  if (!parsed.ok)
    return parsed;
  /** 校验结果与已解码资源均只在内存保留。 */
  const issues: ValidationIssue[] = [];
  const resources: ValidatedPluginResource[] = [];
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  const bytesByPath = new Map(entries);
  const seen = new Set<string>();
  /** 包内未声明文件也不能与资源目录冲突。 */
  const directories = new Set<string>();
  for (const [path] of entries) {
    if (!registerResourcePath(path, seen, directories)) {
      issues.push({
        code: 'path', file: path, field: '$', message: '包内路径不规范或文件/目录冲突'
      });
    }
  }
  let promptBytes = 0;
  for (const [kind, declarations] of [['skill', manifest.skills], ['prompt', manifest.prompts], ['style', manifest.styles ?? []]] as const)
    for (const declaration of declarations) {
      /** 对每一资源保留源文件定位。 */
      const fail = (code: ValidationIssue['code'], message: string): void => { issues.push({
        code, message, file: declaration.path, field: '$'
      }); };
      const bytes = bytesByPath.get(declaration.path);
      if (!(bytes instanceof Uint8Array)) {
        fail('resource', '缺少已声明的包内资源');
        continue;
      }
      if (kind === 'prompt')
        promptBytes += bytes.byteLength;
      const limit = kind === 'skill' ? RESOURCE_LIMITS.skillBytes : kind === 'prompt' ? RESOURCE_LIMITS.promptBytes : 32768;
      if (bytes.byteLength > limit) {
        fail('budget', '资源超出单文件字节预算');
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder('utf-8', {
          fatal: true
        }).decode(bytes);
      } catch {
        fail('resource', '资源不是有效 UTF-8');
        continue;
      }
      if (kind === 'style') {
        try {
          const value: unknown = JSON.parse(content);
          if (!validateStyle(value, declaration.id, declaration.version))
            fail('resource', '设计资源不符合有界 JSON 合同');
          else
            for (const path of (value as {
              examples: string[];
            }).examples)
              if (!bytesByPath.has(path))
                fail('resource', `示例文件不存在: ${path}`);
        } catch {
          fail('resource', '设计资源必须为 JSON');
        }
      } else {
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
        const fields = new Map<string, string>();
        if (frontmatter)
          for (const line of frontmatter[1]!.split(/\r?\n/)) {
            const match = /^([a-zA-Z]+):\s*(.*?)\s*$/.exec(line);
            if (!match || fields.has(match[1]!)) {
              fail('resource', 'frontmatter 仅支持不重复的单行标量');
              continue;
            }
            fields.set(match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, '$2'));
          }
        if (!frontmatter || fields.get('name') !== declaration.id || fields.get('version') !== declaration.version || !fields.get('description')?.trim())
          fail('resource', 'frontmatter name/version/description 与资源合同不一致');
        const sections = kind === 'skill' ? ['适用任务', '输入', '执行步骤', '工具边界', '输出', '失败/取消', '验收'] : ['用途', '输入', '输出', '内容'];
        const body = content.slice(frontmatter?.[0].length ?? 0);
        if (!hasRequiredMarkdownSections(body, sections))
          fail('resource', '缺少真实必需章节或章节正文为空');
      }
      const owners = manifest.modules.filter(module => kind === 'skill' ? module.skills.includes(declaration.id) : kind === 'prompt' ? module.prompts.includes(declaration.id) : module.styles?.includes(declaration.id));
      resources.push({
        id: kind === 'skill' ? getSkillId(manifest.id, declaration.id) : `${manifest.id}/${kind}s/${declaration.id}`,
        kind,
        ownerModuleIds: owners.map(module => getModuleId(manifest.id, module.id)),
        path: declaration.path,
        version: declaration.version,
        content,
        byteLength: bytes.byteLength
      });
    }
  if (promptBytes > RESOURCE_LIMITS.totalPromptBytes)
    issues.push({
      code: 'budget', file: 'plugin.json', field: '$', message: '包内提示总字节预算超限'
    });
  return issues.length ? {
    ok: false, issues
  } : {
    ok: true, value: {
      pluginId: manifest.id, trust: 'unverified', resources
    }, issues
  };
}
/** 宿主与打包器共用的可移植路径入口，语义等同 isPortableResourcePath。 */
export const isPluginResourcePath = isPortableResourcePath;
