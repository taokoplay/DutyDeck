import { PLUGIN_CAPABILITY_IDS } from './capabilities.js'
import type { SchemaNode } from './schema.js'

/** 构造严格对象，所有未列出的字段均拒绝。 */
function object(properties: Record<string, SchemaNode>, required = Object.keys(properties)): SchemaNode {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 构造有界字符串数组。 */
function strings(maxItems = 64): SchemaNode {
  return {
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 256 },
    minItems: 0,
    maxItems,
    uniqueItems: true,
  }
}

/** 模块 ID 允许点、横线和下划线；全限定身份由解析器生成。 */
const localId: SchemaNode = {
  type: 'string',
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
  maxLength: 64,
}

/** 版本必须为严格 SemVer。 */
const semver: SchemaNode = {
  type: 'string',
  pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$',
}

/** 文本字段限制为可用于提示、标题和说明的普通字符串。 */
const text: SchemaNode = { type: 'string', minLength: 1, maxLength: 4096 }

/** 插件设置共享字段。 */
const settingBase = {
  key: localId,
  label: text,
  description: text,
  required: { type: 'boolean' },
  apply: { enum: ['next-run', 'restart-runtime'] },
} satisfies Record<string, SchemaNode>

/** 与解析器同源的 V3 公开 JSON Schema。 */
export const PLUGIN_MANIFEST_V3_SCHEMA: SchemaNode = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://dutydeck.app/schemas/plugin-manifest-v3.json',
  ...object({
    formatVersion: { const: 3 },
    apiVersion: { const: '1.0.0' },
    id: {
      type: 'string',
      pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
      maxLength: 129,
    },
    publisherId: localId,
    version: semver,
    displayName: text,
    description: text,
    license: text,
    profile: { const: 'module-runtime' },
    compatibility: object({
      hostApi: { type: 'string', minLength: 1, maxLength: 64 },
      runtimeProtocol: { const: 1 },
      platforms: {
        type: 'array',
        items: { enum: ['darwin', 'win32', 'linux'] },
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
      },
      architectures: {
        type: 'array',
        items: { enum: ['arm64', 'x64'] },
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
      },
    }),
    runtime: object({
      entry: { type: 'string', minLength: 1, maxLength: 240 },
      format: { const: 'module-esm' },
    }),
    modules: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: object({
        id: localId,
        displayName: text,
        description: text,
        icon: text,
        scope: { enum: ['session', 'project', 'global'] },
        activation: { enum: ['message-explicit', 'session-toggle'] },
        skillRefs: {
          type: 'array',
          maxItems: 64,
          items: object({
            id: { type: 'string', minLength: 1, maxLength: 256 },
            scope: { enum: ['project', 'workspace', 'builtin'] },
            versionRange: { type: 'string', minLength: 1, maxLength: 128 },
            required: { type: 'boolean' },
          }, ['id', 'scope', 'required']),
        },
        promptRefs: strings(),
        tools: strings(),
        surfaces: strings(),
        services: strings(),
        artifacts: strings(),
      }, [
        'id', 'displayName', 'description', 'icon', 'activation', 'skillRefs',
        'promptRefs', 'tools', 'surfaces', 'services', 'artifacts',
      ]),
    },
    tools: {
      type: 'array',
      maxItems: 128,
      items: object({
        id: localId,
        ownerModuleId: localId,
        agentName: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_]{0,63}$',
        },
        title: text,
        description: text,
        inputSchema: { type: 'object', additionalProperties: true },
        annotations: object({
          readOnly: { type: 'boolean' },
          destructive: { type: 'boolean' },
          idempotent: { type: 'boolean' },
          openWorld: { type: 'boolean' },
        }),
        approval: { enum: ['none', 'per-call', 'write'] },
        timeoutMs: { type: 'number', minimum: 1, maximum: 900000 },
        concurrencyKey: localId,
      }, [
        'id', 'ownerModuleId', 'title', 'description', 'inputSchema',
        'annotations', 'approval', 'timeoutMs',
      ]),
    },
    surfaces: {
      type: 'array',
      maxItems: 16,
      items: object({
        id: localId,
        ownerModuleId: localId,
        title: text,
        entry: { type: 'string', minLength: 1, maxLength: 240 },
        apiVersion: { const: 1 },
        defaultPlacement: { const: 'right-panel' },
        methods: strings(),
      }),
    },
    services: {
      type: 'array',
      maxItems: 16,
      items: object({
        id: localId,
        title: text,
        start: { const: 'lazy' },
        idleStopMs: { type: 'number', minimum: 1000, maximum: 86400000 },
      }),
    },
    artifacts: {
      type: 'array',
      maxItems: 128,
      items: object({
        id: localId,
        ownerModuleId: localId,
        title: text,
        schemaVersion: { type: 'number', minimum: 1, maximum: 1000000 },
        mimeTypes: strings(),
        retention: { enum: ['project', 'plugin'] },
      }),
    },
    prompts: {
      type: 'array',
      maxItems: 32,
      items: object({
        id: localId,
        version: semver,
        kind: { enum: ['workflow', 'output-contract', 'style-guidance'] },
        path: { type: 'string', minLength: 1, maxLength: 240 },
      }),
    },
    settings: {
      type: 'array',
      maxItems: 64,
      items: object({
        ...settingBase,
        type: { enum: ['boolean', 'integer', 'text', 'enum', 'credentialRef'] },
        defaultValue: {},
        minimum: { type: 'number' },
        maximum: { type: 'number' },
        maxLength: { type: 'number', minimum: 1, maximum: 65536 },
        enumValues: strings(),
      }, ['key', 'type', 'label', 'apply']),
    },
    capabilities: {
      type: 'array',
      items: { enum: PLUGIN_CAPABILITY_IDS },
      maxItems: PLUGIN_CAPABILITY_IDS.length,
      uniqueItems: true,
    },
    dependencies: {
      type: 'array',
      maxItems: 64,
      items: object({
        pluginId: text,
        versionRange: text,
        required: { type: 'boolean' },
      }),
    },
    exports: {
      type: 'array',
      maxItems: 128,
      items: object({
        resourceId: text,
        kind: { enum: ['artifact', 'tool', 'surface'] },
        apiVersion: { type: 'number', minimum: 1, maximum: 1000000 },
        visibility: {},
      }),
    },
  }),
}
