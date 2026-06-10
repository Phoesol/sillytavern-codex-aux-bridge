# Codex 辅助桥

SillyTavern 第三方扩展，用于给 Codex 生图工作流提供可配置的辅助任务设置和最小上下文快照。

## 功能

- 导出最近有限楼层，避免 Codex 读取整段聊天。
- 可配置显性成人词脱敏。
- 格式修复设置：补 `<time>`、`<content>`、`<now_plot>`，移除占位符。
- 世界推衍设置：读取 `Codex 世界引擎` 或旧世界引擎快照。
- 资料补全设置：导出搜索范围、候选查询和百科补全需求。
- 使用右下角悬浮按钮打开或关闭配置面板。

## 安装

在 SillyTavern 的扩展安装页面导入：

```text
https://github.com/Phoesol/sillytavern-codex-aux-bridge
```

## 输出文件

扩展会通过 SillyTavern 文件接口写入：

```text
data/default-user/user/files/codex-aux-bridge-state.json
data/default-user/user/files/codex-aux-bridge-task-*.json
```

这些文件由本地 Codex 生图后端读取。单独安装本扩展不会自动生成图片，需要配合 Codex Image Bridge 和本地 Codex 工作流使用。

## 发布规则

- 每次功能更新递增 0.1 小版本。
- 每 10 次小版本更新合并为 1 次大版本。
- 发布版本同步推送到 GitHub。
