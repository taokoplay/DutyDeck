/** 仅采用 SDK 校验器明确支持的 JSON Schema 子集。 */
export interface SchemaNode {
  type?: 'object' | 'string' | 'number' | 'boolean' | 'array';
  const?: unknown;
  enum?: readonly unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
  $schema?: string;
  $id?: string;
  $comment?: string;
}
/** 本地身份只使用稳定 ASCII 小写标识。 */
const id: SchemaNode = {
  type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 64
};
/** SemVer 严格禁止数字预发布标识的前导零。 */
const version: SchemaNode = {
  type: 'string', pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$'
};
/** 普通展示字段不能为空，限制元数据体积。 */
const text: SchemaNode = {
  type: 'string', minLength: 1, maxLength: 4096
};
/** 构造严格对象，所有未列出的字段均被拒绝。 */
function object(properties: Record<string, SchemaNode>, required = Object.keys(properties)): SchemaNode { return {
  type: 'object', properties, required, additionalProperties: false
}; }
/** 构造有界数组，避免元数据无限膨胀。 */
function array(items: SchemaNode, minItems = 0): SchemaNode { return {
  type: 'array', items, minItems, maxItems: 256, uniqueItems: true
}; }
/** 尚未开放的能力必须保持空数组。 */
const unsupported: SchemaNode = {
  type: 'array', maxItems: 0
};
/** 与运行时解析器同源的 Schema；路径、身份、资源归属属于额外语义校验。 */
export const PLUGIN_MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://dutydeck.app/schemas/plugin-manifest-v2.json',
  $comment: 'Cross references, reserved identities, portable resource paths and byte budgets additionally require SDK semantic/resource validation. Structural validity does not establish publisher trust or signature validity.',
  ...object({
    formatVersion: {
      const: 2
    }, apiVersion: {
      const: '1.0.0'
    }, id: {
      type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 129
    }, publisherId: id, version, displayName: text, description: text, license: text, profile: {
      const: 'content'
    },
    compatibility: object({
      hostApi: {
        enum: ['1.0.0', '^1.0.0']
      }, requiredFeatures: {
        type: 'array', items: {
          const: 'plugin-packages-v2'
        }, minItems: 1, maxItems: 1, uniqueItems: true
      }, platforms: array({
        enum: ['darwin', 'win32', 'linux']
      }, 1), architectures: array({
        enum: ['arm64', 'x64']
      }, 1)
    }),
    modules: array(object({
      id, displayName: text, activation: {
        enum: ['message-explicit', 'session-toggle']
      }, skills: array(id), prompts: array(id), styles: array(id)
    }, ['id', 'displayName', 'skills', 'prompts']), 1),
    skills: array(object({
      id, ownerModuleId: id, displayName: text, version, path: text, required: {
        type: 'boolean'
      }
    })),
    prompts: array(object({
      id, version, kind: {
        enum: ['workflow', 'output-contract', 'style-guidance']
      }, path: text
    })), styles: array(object({
      id, version, path: text
    })), permissions: unsupported, dependencies: unsupported, exports: unsupported,
    support: object({
      repository: {
        type: 'string', pattern: '^https://[^\\s]+$'
      }, issues: {
        type: 'string', pattern: '^https://[^\\s]+$'
      }
    }, []),
  }, ['formatVersion', 'apiVersion', 'id', 'publisherId', 'version', 'displayName', 'description', 'license', 'profile', 'compatibility', 'modules', 'skills', 'prompts', 'permissions', 'dependencies', 'exports']),
};
