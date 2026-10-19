import { PLUGIN_MANIFEST_SCHEMA } from '../src/schema.js';
/** 从解析器使用的同一份定义生成公开 Schema，禁止手工维护发行副本。 */
await Bun.write(new URL('../plugin-manifest.schema.json', import.meta.url), `${JSON.stringify(PLUGIN_MANIFEST_SCHEMA, null, 2)}\n`);
