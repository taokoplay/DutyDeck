import { describe, expect, it } from 'bun:test';
import { getModuleId, getSkillId, parsePluginManifest, validatePluginResources, PLUGIN_MANIFEST_SCHEMA } from '../src/index.js';
/** 创建独立且完整的普通内容插件夹具。 */
function fixture() {
  return { formatVersion: 2, apiVersion: '1.0.0', id: 'sample.demo', publisherId: 'sample', version: '1.0.0', displayName: '同名模块', description: '说明', license: 'MIT', profile: 'content', compatibility: { hostApi: '^1.0.0', requiredFeatures: ['plugin-packages-v2'], platforms: ['darwin'], architectures: ['arm64'] }, modules: [{ id: 'writer', displayName: '同名模块', activation: 'message-explicit', skills: ['draft'], prompts: ['guide'] }], skills: [{ id: 'draft', ownerModuleId: 'writer', displayName: '草稿', version: '1.2.0', path: 'skills/draft/SKILL.md', required: true }], prompts: [{ id: 'guide', version: '2.0.0', kind: 'workflow', path: 'prompts/guide.md' }], permissions: [], dependencies: [], exports: [] };
}
/** 为资源夹具创建 UTF-8 字节。 */
function files() { return new Map([['skills/draft/SKILL.md', new TextEncoder().encode('---\nname: draft\nversion: 1.2.0\ndescription: 草稿\n---\n## 适用任务\n草稿\n## 输入\n文本\n## 输出\n草稿\n## 执行步骤\n写作\n## 工具边界\n无\n## 失败/取消\n停止\n## 验收\n检查')], ['prompts/guide.md', new TextEncoder().encode('---\nname: guide\nversion: 2.0.0\ndescription: 工作流\n---\n## 用途\n流程\n## 输入\n文字\n## 输出\n文字\n## 内容\n工作流')]]); }
describe('Given V2 内容插件', () => {
  it('When 结构及资源完整 Then 返回稳定身份与未验证信任', () => {
    const result = parsePluginManifest(fixture()); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('夹具应合法');
    const resources = validatePluginResources(result.value, files()); expect(resources.ok).toBe(true);
    expect(getModuleId('sample.demo', 'writer')).toBe('sample.demo.writer'); expect(getSkillId('sample.demo', 'draft')).toBe('sample.demo/skills/draft');
    if (resources.ok) expect(resources.value.trust).toBe('unverified');
  });
  it('When 模块声明 session-toggle Then 保留会话激活合同', () => {
    const input = fixture();
    input.modules[0]!.activation = 'session-toggle';
    const result = parsePluginManifest(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.modules[0]!.activation).toBe('session-toggle');
  });
  it('When 旧插件缺少 activation Then 安全降级为逐消息显式调用', () => {
    const input = fixture();
    delete (input.modules[0] as { activation?: string }).activation;
    const result = parsePluginManifest(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.modules[0]!.activation).toBe('message-explicit');
  });
  it('When 无可选资源 Then 接受空资源集合', () => { const input = fixture(); input.skills = []; input.prompts = []; input.modules[0]!.skills = []; input.modules[0]!.prompts = []; expect(parsePluginManifest(input).ok).toBe(true); });
  for (const path of ['../escape.md', '/etc/passwd', 'a\\b', 'a/CON.md', 'a/é.md', 'a/./x', 'a//x', 'a/name.']) it(`When 路径攻击 ${path} Then 拒绝`, () => { const input = fixture(); input.prompts[0]!.path = path; expect(parsePluginManifest(input).ok).toBe(false); });
  it('When 未知执行字段或未来能力 Then 明确拒绝', () => { expect(parsePluginManifest({...fixture(), entry: 'index.js'}).ok).toBe(false); const input = fixture(); input.compatibility.requiredFeatures.push('future'); expect(parsePluginManifest(input).issues.some(i => i.code === 'unsupported')).toBe(true); expect(parsePluginManifest({...fixture(), dependencies:['other']}).ok).toBe(false); });
  it('When Skill 错误归属或缺引用 Then 返回字段定位', () => { const input = fixture(); input.skills[0]!.ownerModuleId = 'other'; const result = parsePluginManifest(input); expect(result.ok).toBe(false); expect(result.issues.some(i => i.field.includes('ownerModuleId'))).toBe(true); });
  it('When 资源缺失、无效编码或版本不一致 Then 拒绝', () => { const parsed = parsePluginManifest(fixture()); if (!parsed.ok) throw new Error('fixture'); expect(validatePluginResources(parsed.value,new Map()).ok).toBe(false); const input = files(); input.set('prompts/guide.md',new Uint8Array([255])); expect(validatePluginResources(parsed.value,input).ok).toBe(false); });
  it('When 超出单提示预算 Then 拒绝', () => { const parsed = parsePluginManifest(fixture()); if (!parsed.ok) throw new Error('fixture'); const input = files(); input.set('prompts/guide.md',new TextEncoder().encode('x'.repeat(16385))); expect(validatePluginResources(parsed.value,input).issues.some(i=>i.code==='budget')).toBe(true); });
  it('When 读取 Schema Then 严格声明结构且禁止额外字段', () => { expect(PLUGIN_MANIFEST_SCHEMA.additionalProperties).toBe(false); expect(PLUGIN_MANIFEST_SCHEMA.properties!.formatVersion!.const).toBe(2); });
});

/** 可选设计资源夹具只包含声明式 JSON，不包含执行入口。 */
function styleFixture() { return { schemaVersion: 1, id: 'calm', version: '1.0.0', displayName: '克制', description: '包内设计约束', platforms: ['web'], tokens: { gap: 8 }, layout: {}, components: {}, motion: {}, accessibility: {}, do: ['保持对比度'], dont: [], examples: [], license: 'MIT' }; }
describe('Given 可选设计资源与严格包边界', () => {
  it('When 提供合法设计资源 Then 与无设计资源一样可验证', () => {
    const input = { ...fixture(), styles: [{id:'calm',version:'1.0.0',path:'styles/calm.json'}] };
    const parsed = parsePluginManifest(input); expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error('fixture');
    const data = files(); data.set('styles/calm.json',new TextEncoder().encode(JSON.stringify(styleFixture())));
    expect(validatePluginResources(parsed.value,data).ok).toBe(true);
    data.set('styles/calm.json',new TextEncoder().encode(JSON.stringify({...styleFixture(),entry:'run.js'})));
    expect(validatePluginResources(parsed.value,data).ok).toBe(false);
  });
  it('When style 数值、深度、示例路径越界 Then 拒绝', () => {
    const parsed = parsePluginManifest({...fixture(),styles:[{id:'calm',version:'1.0.0',path:'styles/calm.json'}]}); if (!parsed.ok) throw new Error('fixture');
    for (const invalid of [{...styleFixture(),tokens:{x:1e10}}, {...styleFixture(),examples:['../escape']}, {...styleFixture(),examples:['missing.png']}, {...styleFixture(),do:Array(65).fill('x')}, {...styleFixture(),tokens:{a:{a:{a:{a:{a:{a:{a:{a:{a:1}}}}}}}}}}]) {
      const data = files(); data.set('styles/calm.json',new TextEncoder().encode(JSON.stringify(invalid))); expect(validatePluginResources(parsed.value,data).ok).toBe(false);
    }
  });
  it('When 同名不同发布者 Then 身份仍保持区分', () => { expect(getModuleId('sample.demo','writer')).not.toBe(getModuleId('other.demo','writer')); });
  it('When 大小写路径冲突、保留身份或无效 SemVer Then 拒绝', () => {
    const input = fixture(); input.prompts[0]!.path = 'SKILLS/draft/skill.MD'; expect(parsePluginManifest(input).ok).toBe(false);
    expect(parsePluginManifest({...fixture(),publisherId:'builtin',id:'builtin.demo'}).ok).toBe(false);
    expect(parsePluginManifest({...fixture(),version:'1.0.0-01'}).ok).toBe(false);
  });
  it('When Skill 被多个业务模块借用 Then 拒绝', () => { const input = fixture(); input.modules.push({...input.modules[0]!,id:'other'}); expect(parsePluginManifest(input).issues.some(issue=>issue.code==='reference')).toBe(true); });
  it('When 字段未知 Then 返回该字段路径', () => { const result = parsePluginManifest({...fixture(),entry:'x.js'}); expect(result.issues.some(issue=>issue.field==='$.entry')).toBe(true); });
});

describe('Given 可发布 SDK 产物', () => {
  it('When 导出的 JSON Schema 与内存定义比较 Then 完全同源', async () => {
    /** 发行产物必须与解析器使用的定义相同。 */
    const artifact = await Bun.file(new URL('../plugin-manifest.schema.json',import.meta.url)).json();
    expect(artifact).toEqual(PLUGIN_MANIFEST_SCHEMA);
  });
  it('When 同时超过总提示预算 Then 拒绝', () => {
    /** 每项单独合法，但总量必须限制。 */
    const input = fixture(); input.prompts = Array.from({length:5},(_,index)=>({id:`guide-${index}`,version:'2.0.0',kind:'workflow',path:`prompts/guide-${index}.md`})); input.modules[0]!.prompts = input.prompts.map(prompt=>prompt.id);
    const parsed = parsePluginManifest(input); if (!parsed.ok) throw new Error('fixture');
    const data = files(); for (const prompt of input.prompts) data.set(prompt.path,new TextEncoder().encode(`---\nname: ${prompt.id}\nversion: 2.0.0\ndescription: guide\n---\n## 用途\n## 输入\n## 输出\n## 内容\n${'x'.repeat(14000)}`));
    expect(validatePluginResources(parsed.value,data).issues.some(issue=>issue.code==='budget')).toBe(true);
  });
  it('When frontmatter 版本与资源分离版本冲突 Then 拒绝', () => {
    const input = fixture(); input.skills[0]!.version = '3.0.0'; const parsed = parsePluginManifest(input); if (!parsed.ok) throw new Error('fixture'); expect(validatePluginResources(parsed.value,files()).ok).toBe(false);
  });
});

describe('Given 不可信对象与 Markdown 资源', () => {
  for (const key of ['constructor', 'toString', '__proto__']) {
    it(`When JSON 包含未知自有字段 ${key} Then 拒绝`, () => {
      /** JSON.parse 保留危险名称为自有数据字段。 */
      const input = JSON.parse(JSON.stringify(fixture()).slice(0, -1) + `,"${key}":{}}`);
      expect(parsePluginManifest(input).ok).toBe(false);
    });
  }
  it('When 必需标题只出现在代码围栏 Then 拒绝', () => {
    /** 代码示例不能替代真实提示章节。 */
    const parsed = parsePluginManifest(fixture());
    if (!parsed.ok) throw new Error('fixture');
    const data = files();
    data.set('prompts/guide.md', new TextEncoder().encode('---\nname: guide\nversion: 2.0.0\ndescription: 示例\n---\n```markdown\n## 用途\n用途\n## 输入\n输入\n## 输出\n输出\n## 内容\n内容\n```'));
    expect(validatePluginResources(parsed.value, data).ok).toBe(false);
  });
  it('When 真实必需章节没有正文 Then 拒绝', () => {
    /** 提示内容缺失不能被后续标题或空白掩盖。 */
    const parsed = parsePluginManifest(fixture());
    if (!parsed.ok) throw new Error('fixture');
    const data = files();
    data.set('prompts/guide.md', new TextEncoder().encode('---\nname: guide\nversion: 2.0.0\ndescription: 示例\n---\n## 用途\n用途\n## 输入\n输入\n## 输出\n输出\n## 内容\n  \n'));
    expect(validatePluginResources(parsed.value, data).ok).toBe(false);
  });
});

describe('Given 文件与目录共享前缀', () => {
  it('When 清单路径大小写不敏感地占用另一资源目录 Then 拒绝', () => {
    /** 文件不能同时充当其它资源的父目录。 */
    const input = fixture();
    input.skills[0]!.path = 'PROMPTS';
    expect(parsePluginManifest(input).issues.some(issue => issue.code === 'path')).toBe(true);
  });
  it('When 文件集合包含逆序父目录文件 Then 拒绝', () => {
    /** 未声明文件同样受跨平台路径集合约束。 */
    const parsed = parsePluginManifest(fixture());
    if (!parsed.ok) throw new Error('fixture');
    const data = files();
    data.set('PROMPTS', new TextEncoder().encode('目录冲突'));
    expect(validatePluginResources(parsed.value, data).issues.some(issue => issue.code === 'path')).toBe(true);
  });
});

describe('Given JSON Schema 与设计资源预算边界', () => {
  it('When 数组存在稀疏空位 Then 返回校验失败而非抛错', () => {
    /** 稀疏数组不是合法的模块或资源声明。 */
    const modules = { ...fixture(), modules: new Array(1), skills: [], prompts: [] };
    const skills = { ...fixture(), skills: new Array(1) };
    skills.modules[0]!.skills = [];
    expect(parsePluginManifest(modules).ok).toBe(false);
    expect(parsePluginManifest(skills).ok).toBe(false);
  });
  it('When 描述包含合法数量的非 BMP 码点 Then 与 JSON Schema 一致接受', () => {
    /** JSON Schema maxLength 使用 Unicode 码点而非 UTF-16 单元。 */
    expect(parsePluginManifest({ ...fixture(), description: '😀'.repeat(3000) }).ok).toBe(true);
    expect(parsePluginManifest({ ...fixture(), description: '😀'.repeat(4097) }).ok).toBe(false);
  });
  it('When 单份 style 说明超过 8KiB Then 拒绝', () => {
    /** 文件总量未超限也不能绕过说明自身的字节预算。 */
    const parsed = parsePluginManifest({ ...fixture(), styles: [{ id: 'calm', version: '1.0.0', path: 'styles/calm.json' }] });
    if (!parsed.ok) throw new Error('fixture');
    const data = files();
    data.set('styles/calm.json', new TextEncoder().encode(JSON.stringify({ ...styleFixture(), description: '中'.repeat(2731) })));
    expect(validatePluginResources(parsed.value, data).ok).toBe(false);
  });
  it('When 两份 style 各自低于 32KiB 但总量超出 Then 接受', () => {
    /** 设计 JSON 的 32KiB 是单文件预算，整轮预算由宿主控制。 */
    const styles = ['calm', 'bright'].map(id => ({ id, version: '1.0.0', path: `styles/${id}.json` }));
    const parsed = parsePluginManifest({ ...fixture(), styles });
    if (!parsed.ok) throw new Error('fixture');
    const data = files();
    for (const style of styles) {
      data.set(style.path, new TextEncoder().encode(JSON.stringify({ ...styleFixture(), id: style.id, tokens: { note: 'x'.repeat(17000) } })));
    }
    expect(validatePluginResources(parsed.value, data).ok).toBe(true);
  });
});
