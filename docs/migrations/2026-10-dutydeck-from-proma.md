# 从 Proma 迁移到 DutyDeck

DutyDeck 的新安装默认使用 `~/.DutyDeck/`。已有用户的 `~/.proma/` 会被识别为旧数据根，迁移前不会删除或覆盖源目录。

## 迁移步骤

1. 退出正在运行的 DutyDeck，并备份整个 `~/.proma/` 目录。备份只需要文件，不要把任何 API key、密码或 Safe Storage 明文写入文档或工单。
2. 启动 DutyDeck，打开“设置 > 路径与迁移”。确认页面显示的源路径是旧 `.proma` 根，目标路径是 `~/.DutyDeck` 或你选择的自定义目录。
3. 确认迁移后等待校验完成，再重启 DutyDeck。
4. 检查会话、工作区、渠道、Skills 和项目内 `.proma/` 数据是否可读。凭据只需通过原来的渠道连接测试验证，不要尝试导出密钥值。
5. 确认新版本工作正常后，再按自己的备份策略保留旧根；应用不会自动删除它。

Safe Storage 凭据会在本机密钥库可用时从旧服务名 `@proma/electron` 迁移到 `@dutydeck/electron`。密钥库不可用或某个候选值无法解密时，DutyDeck 会保留旧值并在下次启动重试。

旧版 `proma` CLI、`PROMA_CONFIG_DIR` / `PROMA_DEV` 和历史 `proma_*` 协议值仍可读取。新写入使用 DutyDeck 的目录、包名和 localStorage key；旧 localStorage 值会在读取时复制到新 key，不删除旧 key。

如果迁移失败：保留旧根和迁移提示中的日志编号，先重启并重试；不要手工改写会话 JSONL 或凭据字段。向维护者报告时只提供日志编号、失败阶段和路径，不提供任何密钥值。
