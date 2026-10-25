import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentPluginService } from './content-plugin-service';
import type { ContentPluginSnapshot } from './content-plugin-service';
import type { PluginPackageManifest } from '@dutydeck/plugin-sdk';
/** 收集场景临时目录，测试结束清理真实包与稀疏文件。 */
const temporaryRoots: string[] = [];
afterEach(() => { for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true }); });
/** 每个场景独立根目录，避免共享状态干扰。 */
function root(): string { const directory = realpathSync(mkdtempSync(join(tmpdir(), 'content-plugin-'))); temporaryRoots.push(directory); return directory; }
describe('内容插件注册表安全边界', () => {
  test('Given 新目录 When 读取 Then 返回空注册表', () => {
    expect(new ContentPluginService(root()).snapshot()).toEqual({ revision: 0, plugins: [] });
  });
  test('Given 损坏状态 When 读取 Then 拒绝而非重建空注册表', () => {
    const directory = root();
    writeFileSync(join(directory, 'registry.v2.json'), '{}');
    expect(() => new ContentPluginService(directory).snapshot()).toThrow();
  });
  test('Given 存在锁 When 修改 Then 明确冲突', () => {
    const directory = root();
    mkdirSync(join(directory, '.mutation.lock'));
    expect(() => new ContentPluginService(directory).uninstall('acme.test', 0)).toThrow('锁');
  });
  test('Given 忙碌宿主 When 修改 Then 拒绝', () => {
    expect(() => new ContentPluginService(root(), () => true).uninstall('acme.test', 0)).toThrow('忙碌');
  });
  test('Given 源是符号链接 When 预览 Then 拒绝', () => {
    const directory = root();
    writeFileSync(join(directory, 'target'), 'invalid');
    symlinkSync(join(directory, 'target'), join(directory, 'link'));
    expect(() => new ContentPluginService(directory).preview(join(directory, 'link'))).toThrow();
  });
});

import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createPluginPackage, createStandardPluginFiles } from '@dutydeck/plugin-kit';
/** 真实标准模板与真实 Ed25519 私钥构成独立作者包。 */
function fixture(directory: string, version = '1.0.0', key?: KeyObject): string {
  const files = createStandardPluginFiles('acme.demo', '演示插件');
  const manifest = JSON.parse(Buffer.from(files.get('plugin.json')!).toString('utf8')) as PluginPackageManifest;
  manifest.version = version;
  files.set('plugin.json', Buffer.from(JSON.stringify(manifest)));
  const path = join(directory, `fixture-${version}.ddplugin`);
  writeFileSync(path, createPluginPackage(files, key));
  return path;
}
describe('真实签名内容包的安装使用生命周期', () => {
  test('Given 标准签名包 When 安装解析更新关闭卸载 Then 内容可用且用户数据保留', () => {
    const directory = realpathSync(root());
    const service = new ContentPluginService(join(directory, 'plugins'));
    const key = generateKeyPairSync('ed25519').privateKey;
    const preview = service.preview(fixture(directory, '1.0.0', key));
    expect(preview.operation).toBe('install');
    expect(() => service.install(preview.token)).toThrow('信任');
    const installed = service.install(preview.token, preview.signer!.keyId);
    expect(installed.revision).toBe(1);
    const moduleId = `acme.demo.${preview.manifest.modules[0]!.id}`;
    expect(service.resolveModule(moduleId).resources.length).toBeGreaterThan(0);
    expect(JSON.stringify(service.snapshot())).not.toContain('"content":');
    writeFileSync(join(directory, 'user-work.txt'), 'keep');
    const upgrade = service.preview(fixture(directory, '1.1.0', key));
    expect(upgrade.previousVersion).toBe('1.0.0');
    service.install(upgrade.token);
    expect(service.resolveModule(moduleId).version).toBe('1.1.0');
    service.setEnabled('acme.demo', false, 2);
    expect(() => service.resolveModule(moduleId)).toThrow('关闭');
    service.uninstall('acme.demo', 3);
    expect(service.snapshot().plugins).toHaveLength(0);
    expect(readFileSync(join(directory, 'user-work.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(directory, 'plugins/packages/acme.demo/1.0.0', `${preview.packageHash}.ddplugin`))).toBe(true);
  });
  test('Given 预览后源内容改变 When 安装 Then 仍安装确认过的精确字节', () => {
    const directory = realpathSync(root()); const service = new ContentPluginService(directory);
    const path = fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey);
    const preview = service.preview(path); writeFileSync(path, 'changed');
    expect(service.install(preview.token, preview.signer!.keyId).plugins[0]!.packageHash).toBe(preview.packageHash);
  });
  test('Given 拖入的包字节 When 预览 Then 不依赖源路径且安装同一摘要', () => {
    const directory = realpathSync(root());
    const service = new ContentPluginService(directory);
    const bytes = readFileSync(fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey));
    const preview = service.previewBytes(bytes);
    expect(preview.manifest.id).toBe('acme.demo');
    expect(service.install(preview.token, preview.signer!.keyId).plugins[0]!.packageHash).toBe(preview.packageHash);
  });
  test('Given 旧修订号或预览 When 别处已修改 Then 拒绝覆盖', () => {
    const directory = realpathSync(root()); const first = new ContentPluginService(directory); const second = new ContentPluginService(directory);
    const path = fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey);
    const one = first.preview(path); const two = second.preview(path);
    first.install(one.token, one.signer!.keyId);
    expect(() => second.install(two.token, two.signer!.keyId)).toThrow('修订');
    expect(() => first.setEnabled('acme.demo', false, 0)).toThrow('修订');
  });
  test('Given 已安装发布者 When 更新密钥或降级 Then 拒绝且保留原版本', () => {
    const directory = realpathSync(root()); const service = new ContentPluginService(directory); const key = generateKeyPairSync('ed25519').privateKey;
    const original = service.preview(fixture(directory, '1.0.0', key)); service.install(original.token, original.signer!.keyId);
    const changedKey = service.preview(fixture(directory, '2.0.0', generateKeyPairSync('ed25519').privateKey));
    expect(() => service.install(changedKey.token, changedKey.signer!.keyId)).toThrow('密钥');
    const downgrade = service.preview(fixture(directory, '0.9.0', key));
    expect(() => service.install(downgrade.token)).toThrow('更高版本');
    const sameVersion = service.preview(fixture(directory, '1.0.0', key));
    expect(() => service.install(sameVersion.token)).toThrow('更高版本');
    expect(service.snapshot().plugins[0]!.manifest.version).toBe('1.0.0');
  });
  test('Given unsigned 包 When 生产预览 Then 拒绝；显式开发模式隔离保存', () => {
    const directory = realpathSync(root()); const path = fixture(directory);
    expect(() => new ContentPluginService(directory).preview(path)).toThrow('签名');
    const development = new ContentPluginService(directory, () => false, { development: true });
    development.install(development.preview(path).token);
    expect(new ContentPluginService(directory).snapshot().plugins).toHaveLength(0);
    expect(existsSync(join(directory, 'development/registry.v2.json'))).toBe(true);
  });
  test('Given 包被篡改 When 解析 Then 拒绝；普通快照不读取正文', () => {
    const directory = realpathSync(root()); const service = new ContentPluginService(directory);
    const preview = service.preview(fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey));
    service.install(preview.token, preview.signer!.keyId);
    writeFileSync(join(directory, 'packages/acme.demo/1.0.0', `${preview.packageHash}.ddplugin`), 'corrupt');
    expect(service.snapshot().plugins).toHaveLength(1);
    expect(() => service.resolveModule(`acme.demo.${preview.manifest.modules[0]!.id}`)).toThrow();
  });
  test('Given 多个有效预览 When 超过数量预算 Then 拒绝继续缓存', () => {
    const directory = realpathSync(root()); const service = new ContentPluginService(directory);
    const path = fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey);
    for (let index = 0; index < 8; index++) service.preview(path);
    expect(() => service.preview(path)).toThrow('预算');
  });
});

import { ftruncateSync, openSync, closeSync, rmSync } from 'node:fs';
describe('注册表和安装目标拒绝不可信路径与摘要', () => {
  test('Given 注册表为链接 When 快照 Then 拒绝读取目标', () => {
    const directory = root(); const external = join(directory, 'external.json');
    writeFileSync(external, JSON.stringify({ formatVersion: 2, revision: 0, plugins: [] }));
    symlinkSync(external, join(directory, 'registry.v2.json'));
    expect(() => new ContentPluginService(directory).snapshot()).toThrow();
  });
  test('Given 安装目录为链接 When 安装 Then 拒绝且不提交注册表', () => {
    const directory = root(); const external = root(); const service = new ContentPluginService(directory);
    const preview = service.preview(fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey));
    symlinkSync(external, join(directory, 'packages'));
    expect(() => service.install(preview.token, preview.signer!.keyId)).toThrow('链接');
    expect(service.snapshot().revision).toBe(0);
  });
  test('Given 超大源文件 When 预览 Then 有限读取拒绝', () => {
    const directory = root(); const path = join(directory, 'large.ddplugin');
    const descriptor = openSync(path, 'wx');
    try { ftruncateSync(descriptor, 50 * 1024 * 1024 + 1); } finally { closeSync(descriptor); }
    expect(() => new ContentPluginService(directory).preview(path)).toThrow('预算');
  });
  test('Given 注册表资源被改成额外路径 When 快照 Then 摘要校验拒绝', () => {
    const directory = root(); const service = new ContentPluginService(directory);
    const preview = service.preview(fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey));
    service.install(preview.token, preview.signer!.keyId);
    const path = join(directory, 'registry.v2.json');
    const state = JSON.parse(readFileSync(path, 'utf8')) as ContentPluginSnapshot;
    state.plugins[0]!.resources[0]!.path = '../../external';
    writeFileSync(path, JSON.stringify(state));
    expect(() => service.snapshot()).toThrow('摘要');
  });
  test('Given 已安装包变成链接 When 解析 Then 拒绝链接；不影响快照', () => {
    const directory = root(); const service = new ContentPluginService(directory);
    const source = fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey);
    const preview = service.preview(source); service.install(preview.token, preview.signer!.keyId);
    const installed = join(directory, 'packages/acme.demo/1.0.0', `${preview.packageHash}.ddplugin`);
    rmSync(installed); symlinkSync(source, installed);
    expect(() => service.resolveModule(`acme.demo.${preview.manifest.modules[0]!.id}`)).toThrow('链接');
    expect(service.snapshot().plugins).toHaveLength(1);
  });
  test('Given 不支持本机平台的签名包 When 预览 Then 拒绝', () => {
    const directory = root(); const files = createStandardPluginFiles('acme.demo', '测试');
    const manifest = JSON.parse(Buffer.from(files.get('plugin.json')!).toString('utf8')) as PluginPackageManifest;
    manifest.compatibility.platforms = [process.platform === 'darwin' ? 'linux' : 'darwin'];
    files.set('plugin.json', Buffer.from(JSON.stringify(manifest)));
    const source = join(directory, 'incompatible.ddplugin');
    writeFileSync(source, createPluginPackage(files, generateKeyPairSync('ed25519').privateKey));
    expect(() => new ContentPluginService(directory).preview(source)).toThrow('平台');
  });
});

test('Given 两个独立进程同修订写入 When 同时改变开关 Then 仅一个提交成功', async () => {
  /** 父进程先建立同一个真实签名安装基线。 */
  const directory = root();
  const service = new ContentPluginService(directory);
  const preview = service.preview(fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey));
  service.install(preview.token, preview.signer!.keyId);
  /** 独立进程通过同一目录锁和 expectedRevision 竞争，不能共享 JS 内存锁。 */
  const script = `import { ContentPluginService } from ${JSON.stringify(join(import.meta.dir, 'content-plugin-service.ts'))}; try { new ContentPluginService(${JSON.stringify(directory)}).setEnabled('acme.demo', false, 1); } catch { process.exit(2); }`;
  const first = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'ignore' });
  const second = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'ignore' });
  expect((await Promise.all([first.exited, second.exited])).sort()).toEqual([0, 2]);
  expect(service.snapshot().revision).toBe(2);
});

test('Given 两个各17KiB的合法设计资源 When 安装并重读状态 Then 按单文件预算接受', () => {
  /** 多个设计资源不能被宿主误加一层 SDK 不存在的总量限制。 */
  const directory = root();
  const files = createStandardPluginFiles('acme.demo', '多设计资源');
  const manifest = JSON.parse(Buffer.from(files.get('plugin.json')!).toString('utf8')) as PluginPackageManifest;
  manifest.styles = ['first', 'second'].map(id => ({ id, version: '1.0.0', path: `styles/${id}.json` }));
  manifest.modules[0]!.styles = ['first', 'second'];
  for (const entry of manifest.styles) files.set(entry.path, Buffer.from(JSON.stringify({ schemaVersion: 1, id: entry.id, version: '1.0.0', displayName: entry.id, description: '合法资源', platforms: ['web'], tokens: { note: 'x'.repeat(17 * 1024) }, layout: {}, components: {}, motion: {}, accessibility: {}, do: [], dont: [], examples: [], license: 'MIT' })));
  files.set('plugin.json', Buffer.from(JSON.stringify(manifest)));
  const source = join(directory, 'styles.ddplugin');
  writeFileSync(source, createPluginPackage(files, generateKeyPairSync('ed25519').privateKey));
  const service = new ContentPluginService(directory);
  const preview = service.preview(source);
  service.install(preview.token, preview.signer!.keyId);
  expect(service.snapshot().plugins[0]!.resources.filter(resource => resource.kind === 'style')).toHaveLength(2);
  expect(service.resolveModule(`acme.demo.${manifest.modules[0]!.id}`).resources.filter(resource => resource.kind === 'style')).toHaveLength(2);
});

test('Given 紧凑注册表可读但格式化写入超限 When 修改开关 Then 拒绝并保留原字节和修订', () => {
  /** 先取得真正安装条目，再生成合法且接近读取预算的注册表。 */
  const directory = root(); const service = new ContentPluginService(directory);
  const preview = service.preview(fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey));
  service.install(preview.token, preview.signer!.keyId);
  const template = service.snapshot().plugins[0]!;
  template.manifest.description = 'x'.repeat(3000);
  const count = Math.floor(4 * 1024 * 1024 * 0.97 / Buffer.byteLength(JSON.stringify(template)));
  const state = { formatVersion: 2, revision: 1, plugins: Array.from({ length: count }, (_, index) => JSON.parse(JSON.stringify(template).replaceAll('acme.demo', `acme.p${String(index).padStart(4, '0')}`)) as typeof template) };
  const original = JSON.stringify(state);
  expect(Buffer.byteLength(original)).toBeLessThan(4 * 1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(state, null, 2))).toBeGreaterThan(4 * 1024 * 1024);
  const path = join(directory, 'registry.v2.json'); writeFileSync(path, original);
  expect(service.snapshot().revision).toBe(1);
  expect(() => service.setEnabled('acme.p0000', false, 1)).toThrow('预算');
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(service.snapshot().revision).toBe(1);
});

test('Given 注册表含无效UTF8字符串字节 When 读取 Then 拒绝且不重写原字节', () => {
  const directory = root(); const service = new ContentPluginService(directory);
  const preview = service.preview(fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey));
  service.install(preview.token, preview.signer!.keyId);
  const path = join(directory, 'registry.v2.json');
  const original = readFileSync(path);
  original[original.indexOf(Buffer.from('演示插件'))] = 0xff;
  writeFileSync(path, original);
  expect(() => service.snapshot()).toThrow();
  expect(readFileSync(path)).toEqual(original);
});

test('Given 两个不同插件注册表错误共享包hash When 同轮解析 Then 不复用另一身份的资源', () => {
  const directory = root(); const service = new ContentPluginService(directory);
  const preview = service.preview(fixture(directory, '1.0.0', generateKeyPairSync('ed25519').privateKey));
  service.install(preview.token, preview.signer!.keyId);
  const original = service.snapshot().plugins[0]!;
  const other = JSON.parse(JSON.stringify(original).replaceAll('acme.demo', 'acme.other')) as typeof original;
  writeFileSync(join(directory, 'registry.v2.json'), JSON.stringify({ formatVersion: 2, revision: 1, plugins: [original, other] }));
  expect(() => service.resolveModules(['acme.demo.assistant', 'acme.other.assistant'])).toThrow();
});

test('Given 多个模块共享同包提示 When 同轮选择 Then 提示去重预算且保留模块绑定', () => {
  const directory = root(); const files = createStandardPluginFiles('acme.demo', '共享提示');
  const manifest = JSON.parse(Buffer.from(files.get('plugin.json')!).toString('utf8')) as PluginPackageManifest;
  manifest.modules.push({ id: 'second', displayName: '另一个模块', activation: 'message-explicit', skills: [], prompts: ['workflow'] });
  files.set('plugin.json', Buffer.from(JSON.stringify(manifest)));
  const path = join(directory, 'shared.ddplugin'); writeFileSync(path, createPluginPackage(files, generateKeyPairSync('ed25519').privateKey));
  const service = new ContentPluginService(directory); const preview = service.preview(path); service.install(preview.token, preview.signer!.keyId);
  const resolved = service.resolveModules(['acme.demo.assistant', 'acme.demo.second']);
  expect(resolved).toHaveLength(2);
  expect(resolved[1]!.resources).toHaveLength(1);
  expect(resolved[0]!.resources.find(resource => resource.kind === 'prompt')).toBe(resolved[1]!.resources[0]);
});

test('Given 五个实际包各15KiB提示 When 同轮显式选择 Then 提前拒绝累计提示预算', () => {
  const directory = root(); const service = new ContentPluginService(directory);
  const modules: string[] = [];
  for (let index = 0; index < 5; index++) {
    const id = `acme.plugin${index}`;
    const files = createStandardPluginFiles(id, '累计提示');
    files.set('prompts/workflow.md', Buffer.concat([Buffer.from(files.get('prompts/workflow.md')!), Buffer.from('x'.repeat(15000))]));
    const path = join(directory, `${index}.ddplugin`); writeFileSync(path, createPluginPackage(files, generateKeyPairSync('ed25519').privateKey));
    const preview = service.preview(path); service.install(preview.token, preview.signer!.keyId); modules.push(`${id}.assistant`);
  }
  /** 删除包后仍应先报资源预算，而不是试图读取不存在的正文。 */
  rmSync(join(directory, 'packages'), { recursive: true });
  expect(() => service.resolveModules(modules)).toThrow('预算');
});

test('Given 两个各26MiB真实包且提示很小 When 同轮解析 Then 拒绝50MiB累计读取预算', () => {
  /** 大型静态资源不进入模型，却仍消耗包读取和验证内存。 */
  const directory = root(); const service = new ContentPluginService(directory);
  const modules: string[] = [];
  for (let index = 0; index < 2; index++) {
    const id = `acme.large${index}`;
    const files = createStandardPluginFiles(id, '大资源包');
    files.set('assets/first.txt', Buffer.alloc(13 * 1024 * 1024, 97));
    files.set('assets/second.txt', Buffer.alloc(13 * 1024 * 1024, 98));
    const source = join(directory, `${index}.ddplugin`);
    writeFileSync(source, createPluginPackage(files, generateKeyPairSync('ed25519').privateKey));
    const preview = service.preview(source); service.install(preview.token, preview.signer!.keyId);
    modules.push(`${id}.assistant`);
  }
  expect(() => service.resolveModules(modules)).toThrow('预算');
}, 15000);
