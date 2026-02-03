# Changelog

## [1.5.4] - 2026-02-03

### Fixed

- **彻底修复跨节点 Binary 读取问题**
- 使用 `getWorkflowDataProxy().$()` 直接获取节点数据，与 Code 节点写法一致
- 使用 `(context.helpers as any).getBinaryDataBuffer(i, key, nodeName)` 保持 `this` 绑定
- 修复了两个根本问题：
  1. `evaluateExpression` 返回序列化副本导致 Binary 引用丢失
  2. 类型断言后赋值给变量导致 `this` 绑定丢失

## [1.5.2] - 2026-02-03

### Fixed

- **修复跨节点 Binary 读取问题**：使用正确的 API 实现跨节点读取
- 使用 `getBinaryDataBuffer(itemIndex, propertyName, sourceNodeName)` 的第三个参数指定源节点
- 该方法同时支持 n8n 的内存模式和文件存储模式

## [1.5.0] - 2025-02-03

### Added

- 新增"图片来源"功能，支持三种模式：
  - **仅当前输入**（默认）：保持原有行为
  - **自动查找**：自动向上遍历工作流节点查找 Binary 图片
  - **指定节点**：手动指定包含图片的节点名称（支持逗号分隔多个）
- 新增"来源节点名称"参数，用于指定节点模式

### Fixed

- 重写图片收集逻辑，修复跨节点读取 Binary 图片的问题
- 支持从 `$('NodeName').all()` 表达式获取其他节点的图片数据
- 优化图片去重逻辑，避免重复处理相同图片

## [1.4.0] - 2025-01-13

### Added

- 新增向量嵌入 (Embeddings) 模式
- 支持 `text-embedding-3-large` 和 `text-embedding-3-small` 模型

## [1.3.0]

### Added

- 新增视频生成模式 (Sora 2)
- 支持创建、混编、检索、下载、列出视频操作
- 故事板模式支持分镜头描述
- 智能轮询等待功能

## [1.2.0]

### Added

- 图像生成支持即梦 4.5 模型

## [1.1.0]

### Added

- 图像生成模式
- 支持 Gemini-3-Pro-Image 模型

## [1.0.0]

### Added

- 初始版本
- 文字生成模式
- 支持多模态（文字 + 图片）输入
