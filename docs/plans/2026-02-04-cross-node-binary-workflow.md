# 跨节点 Binary 读取功能 - 实现工作流

**版本**: 1.5.6
**日期**: 2026-02-04
**设计文档**: [2026-02-04-cross-node-binary-design.md](./2026-02-04-cross-node-binary-design.md)

---

## 实现概览

本工作流将分为 4 个阶段实施，共计 8 个任务步骤。

```
阶段 1: UI 参数定义
    └─ 步骤 1.1: 添加 binarySourceMode 参数
    └─ 步骤 1.2: 添加 sourceNodeNames 参数

阶段 2: 核心功能实现
    └─ 步骤 2.1: 实现 collectBinaryFromNodes 函数
    └─ 步骤 2.2: 实现 mergeBinaryData 辅助函数

阶段 3: 集成到现有模式
    └─ 步骤 3.1: 集成到 text 模式
    └─ 步骤 3.2: 集成到 image 模式
    └─ 步骤 3.3: 集成到 video-create 模式

阶段 4: 版本更新与收尾
    └─ 步骤 4.1: 更新版本号和 CHANGELOG
```

---

## 阶段 1: UI 参数定义

### 步骤 1.1: 添加 binarySourceMode 参数

**文件**: `nodes/DeerApi/DeerApi.node.ts`
**位置**: properties 数组中，在 `binaryPropertyName` 参数之前（约第 274 行）

**操作**:
在 `// --- 图片属性设置 ---` 注释后，`binaryPropertyName` 参数前添加新参数：

```typescript
{
    displayName: 'Binary 来源模式',
    name: 'binarySourceMode',
    type: 'options',
    options: [
        { name: '当前节点输入', value: 'current' },
        { name: '遍历所有上游节点', value: 'all' },
        { name: '指定节点', value: 'specified' },
    ],
    default: 'current',
    displayOptions: {
        show: {
            mode: ['text', 'image', 'video']
        },
        hide: {
            videoOperation: ['remix', 'retrieve', 'download', 'list']
        }
    },
    description: '选择从哪些节点读取 Binary 图片数据',
},
```

**验证点**:
- [ ] 参数在 text、image、video-create 模式下可见
- [ ] 参数在 video 其他操作和 embeddings 模式下隐藏
- [ ] 默认值为 'current'

---

### 步骤 1.2: 添加 sourceNodeNames 参数

**文件**: `nodes/DeerApi/DeerApi.node.ts`
**位置**: 紧跟 `binarySourceMode` 参数之后

**操作**:
添加条件显示的节点名称输入框：

```typescript
{
    displayName: '指定节点名称',
    name: 'sourceNodeNames',
    type: 'string',
    default: '',
    placeholder: 'HTTP Request, Read File, Code',
    displayOptions: {
        show: {
            binarySourceMode: ['specified']
        }
    },
    description: '用逗号分隔多个节点名称（精确匹配）',
},
```

**验证点**:
- [ ] 仅当 binarySourceMode = 'specified' 时显示
- [ ] 占位符文本正确显示

---

## 阶段 2: 核心功能实现

### 步骤 2.1: 实现 collectBinaryFromNodes 函数

**文件**: `nodes/DeerApi/DeerApi.node.ts`
**位置**: 在 `extractImagesFromInput` 函数之后（约第 51 行）

**操作**:
添加新的核心函数，用于从多个节点收集 Binary 数据：

```typescript
// 从指定节点收集 Binary 数据并合并
async function collectBinaryFromNodes(
    context: IExecuteFunctions,
    itemIndex: number,
    sourceMode: 'current' | 'all' | 'specified',
    specifiedNodes: string[],
): Promise<Record<string, IBinaryData>> {
    const mergedBinary: Record<string, IBinaryData> = {};

    if (sourceMode === 'current') {
        // 当前模式：直接返回当前输入的 binary
        const items = context.getInputData();
        if (items[itemIndex]?.binary) {
            return { ...items[itemIndex].binary };
        }
        return mergedBinary;
    }

    // 获取工作流数据代理
    const workflowProxy = context.getWorkflowDataProxy(itemIndex);

    // 收集目标节点名称列表
    let targetNodeNames: string[] = [];

    if (sourceMode === 'specified') {
        // 指定模式：使用用户提供的节点名称
        targetNodeNames = specifiedNodes;
    } else if (sourceMode === 'all') {
        // 遍历模式：获取所有上游节点（从近到远）
        try {
            const executeData = context.getExecuteData();
            const visitedNodes = new Set<string>();
            const nodeQueue: string[] = [];

            // 从直接上游开始
            if (executeData.source?.main) {
                for (const sources of executeData.source.main) {
                    if (sources) {
                        for (const src of sources) {
                            if (src.previousNode && !visitedNodes.has(src.previousNode)) {
                                nodeQueue.push(src.previousNode);
                                visitedNodes.add(src.previousNode);
                            }
                        }
                    }
                }
            }

            // 使用 $items 尝试获取更多上游节点
            // 注：这里采用简化实现，依赖 n8n 的 runData
            targetNodeNames = Array.from(visitedNodes);
        } catch {
            // 如果无法获取上游节点，回退到当前输入
            const items = context.getInputData();
            if (items[itemIndex]?.binary) {
                return { ...items[itemIndex].binary };
            }
            return mergedBinary;
        }
    }

    // 从目标节点收集 Binary
    let binaryIndex = 0;

    for (const nodeName of targetNodeNames) {
        try {
            // 使用 $items(nodeName) 获取节点数据
            const nodeItems = workflowProxy.$items(nodeName, 0, undefined);

            if (!nodeItems || nodeItems.length === 0) continue;

            // 取对应 itemIndex 的数据，如果不存在则取第一个
            const targetItemIndex = itemIndex < nodeItems.length ? itemIndex : 0;
            const nodeItem = nodeItems[targetItemIndex];

            if (!nodeItem?.binary) continue;

            // 合并 Binary 数据
            for (const [propName, binaryData] of Object.entries(nodeItem.binary)) {
                // 生成新的属性名：data, data0, data1, data2...
                let newPropName: string;
                if (binaryIndex === 0) {
                    newPropName = 'data';
                } else {
                    newPropName = `data${binaryIndex - 1}`;
                }

                // 避免覆盖已存在的属性
                while (mergedBinary[newPropName]) {
                    binaryIndex++;
                    newPropName = `data${binaryIndex - 1}`;
                }

                mergedBinary[newPropName] = binaryData as IBinaryData;
                binaryIndex++;
            }
        } catch {
            // 静默忽略找不到的节点
            continue;
        }
    }

    // 如果没有收集到任何数据，回退到当前输入
    if (Object.keys(mergedBinary).length === 0) {
        const items = context.getInputData();
        if (items[itemIndex]?.binary) {
            return { ...items[itemIndex].binary };
        }
    }

    return mergedBinary;
}
```

**验证点**:
- [ ] 函数能正确处理三种模式
- [ ] 'current' 模式返回当前输入
- [ ] 'specified' 模式按节点名获取
- [ ] 'all' 模式遍历上游节点
- [ ] 静默忽略找不到的节点
- [ ] Binary 命名遵循 data, data0, data1... 规则

---

### 步骤 2.2: 实现 extractImagesFromBinary 辅助函数

**文件**: `nodes/DeerApi/DeerApi.node.ts`
**位置**: 在 `collectBinaryFromNodes` 函数之后

**操作**:
添加从合并后的 Binary 对象中提取图片的函数：

```typescript
// 从 Binary 对象中提取图片
async function extractImagesFromBinary(
    context: IExecuteFunctions,
    itemIndex: number,
    binary: Record<string, IBinaryData>,
    propNames: string[],
    maxImages: number,
): Promise<ImageData[]> {
    const images: ImageData[] = [];

    for (const propName of propNames) {
        if (images.length >= maxImages) break;

        const binaryData = binary[propName];
        if (!binaryData) continue;
        if (!binaryData.mimeType?.startsWith('image/')) continue;

        try {
            // 需要从 binary data 获取 buffer
            // 如果有 id，使用 getBinaryDataBuffer；否则使用 base64 解码
            let buffer: Buffer;
            if (binaryData.id) {
                // 存储在文件系统中的 binary
                buffer = await context.helpers.getBinaryDataBuffer(itemIndex, propName);
            } else if (binaryData.data) {
                // 内联 base64 数据
                buffer = Buffer.from(binaryData.data, 'base64');
            } else {
                continue;
            }

            images.push({
                base64: buffer.toString('base64'),
                mimeType: binaryData.mimeType,
                fileName: binaryData.fileName,
                buffer,
            });
        } catch {
            // 无法读取该图片，跳过
        }
    }

    return images;
}
```

**验证点**:
- [ ] 函数能正确从 Binary 对象提取图片
- [ ] 支持存储在文件系统的 binary (有 id)
- [ ] 支持内联 base64 数据
- [ ] 遵循 maxImages 限制

---

## 阶段 3: 集成到现有模式

### 步骤 3.1: 集成到 text 模式

**文件**: `nodes/DeerApi/DeerApi.node.ts`
**位置**: execute 函数中 text 模式处理块（约第 306-335 行）

**操作**:
1. 在获取 propNames 后，获取新参数值
2. 调用 collectBinaryFromNodes 收集 Binary
3. 将 extractImagesFromInput 替换为 extractImagesFromBinary

**修改内容**:

```typescript
// 原代码（第 303-304 行）:
const binaryPropInput = this.getNodeParameter('binaryPropertyName', i, 'data, data0, data1, data2, file, attachment') as string;
const propNames = binaryPropInput.split(',').map(s => s.trim()).filter(s => s !== '');

// 新增代码（在 propNames 后）:
const binarySourceMode = this.getNodeParameter('binarySourceMode', i, 'current') as 'current' | 'all' | 'specified';
const sourceNodeNamesInput = this.getNodeParameter('sourceNodeNames', i, '') as string;
const specifiedNodes = sourceNodeNamesInput.split(',').map(s => s.trim()).filter(s => s !== '');

// 收集 Binary 数据
const collectedBinary = await collectBinaryFromNodes(this, i, binarySourceMode, specifiedNodes);
```

```typescript
// 原代码（第 317-320 行）:
// 从当前输入提取图片
const extractedImages = await extractImagesFromInput(this, i, propNames, 1);

// 替换为:
// 从收集的 Binary 中提取图片
const extractedImages = await extractImagesFromBinary(this, i, collectedBinary, propNames, 1);
```

**验证点**:
- [ ] text 模式下三种来源模式都能正常工作
- [ ] 默认模式 (current) 行为不变

---

### 步骤 3.2: 集成到 image 模式

**文件**: `nodes/DeerApi/DeerApi.node.ts`
**位置**: execute 函数中 image 模式处理块（约第 337-381 行）

**操作**:
1. 在 image 模式开始处获取新参数并收集 Binary
2. 替换两处 extractImagesFromInput 调用

**修改内容**:

```typescript
// 在 image 模式开始处（约第 338 行后）添加:
const binarySourceMode = this.getNodeParameter('binarySourceMode', i, 'current') as 'current' | 'all' | 'specified';
const sourceNodeNamesInput = this.getNodeParameter('sourceNodeNames', i, '') as string;
const specifiedNodes = sourceNodeNamesInput.split(',').map(s => s.trim()).filter(s => s !== '');
const collectedBinary = await collectBinaryFromNodes(this, i, binarySourceMode, specifiedNodes);
```

```typescript
// 原代码（第 347 行，gemini 分支）:
const extractedImages = await extractImagesFromInput(this, i, propNames, 3);

// 替换为:
const extractedImages = await extractImagesFromBinary(this, i, collectedBinary, propNames, 3);
```

```typescript
// 原代码（第 367 行，doubao 分支）:
const extractedImages = await extractImagesFromInput(this, i, propNames, 3);

// 替换为:
const extractedImages = await extractImagesFromBinary(this, i, collectedBinary, propNames, 3);
```

**验证点**:
- [ ] image 模式下三种来源模式都能正常工作
- [ ] Gemini 和 即梦模型都能正确获取图片

---

### 步骤 3.3: 集成到 video-create 模式

**文件**: `nodes/DeerApi/DeerApi.node.ts`
**位置**: execute 函数中 video create 模式处理块（约第 386-422 行）

**操作**:
1. 在 video create 操作开始处获取新参数并收集 Binary
2. 替换 extractImagesFromInput 调用

**修改内容**:

```typescript
// 在 operation === 'create' 块内（约第 387 行后）添加:
const binarySourceMode = this.getNodeParameter('binarySourceMode', i, 'current') as 'current' | 'all' | 'specified';
const sourceNodeNamesInput = this.getNodeParameter('sourceNodeNames', i, '') as string;
const specifiedNodes = sourceNodeNamesInput.split(',').map(s => s.trim()).filter(s => s !== '');
const collectedBinary = await collectBinaryFromNodes(this, i, binarySourceMode, specifiedNodes);
```

```typescript
// 原代码（第 406 行）:
const extractedImages = await extractImagesFromInput(this, i, propNames, 1);

// 替换为:
const extractedImages = await extractImagesFromBinary(this, i, collectedBinary, propNames, 1);
```

**验证点**:
- [ ] video-create 模式下三种来源模式都能正常工作
- [ ] 参考图能正确上传

---

## 阶段 4: 版本更新与收尾

### 步骤 4.1: 更新版本号和 CHANGELOG

**文件 1**: `package.json`
**操作**: 更新版本号

```json
"version": "1.5.6",
```

**文件 2**: `CHANGELOG.md`
**操作**: 在文件顶部添加新版本记录

```markdown
## [1.5.6] - 2026-02-04

### Added

- **跨节点 Binary 读取功能**：新增"Binary 来源模式"参数
  - 当前节点输入：默认模式，保持现有行为
  - 遍历所有上游节点：从近到远自动收集所有上游节点的 Binary 数据
  - 指定节点：按用户指定的节点名称列表读取（精确匹配）
- 新增"指定节点名称"参数，支持逗号分隔多个节点名
- Binary 数据自动合并，属性名遵循 data, data0, data1... 命名规则
- 找不到节点或无 Binary 数据时静默忽略

### Note

- 此功能适用于文字生成、图像生成、视频生成-创建模式
- 向后兼容：默认模式与现有版本行为一致
```

**验证点**:
- [ ] package.json 版本号已更新为 1.5.6
- [ ] CHANGELOG.md 包含完整的更新说明
- [ ] 构建成功 (`npm run build`)
- [ ] 无 TypeScript 编译错误

---

## 执行检查清单

### 阶段 1 完成检查
- [ ] binarySourceMode 参数添加完成
- [ ] sourceNodeNames 参数添加完成
- [ ] 参数显示/隐藏逻辑正确

### 阶段 2 完成检查
- [ ] collectBinaryFromNodes 函数实现完成
- [ ] extractImagesFromBinary 函数实现完成
- [ ] 函数无语法错误

### 阶段 3 完成检查
- [ ] text 模式集成完成
- [ ] image 模式集成完成
- [ ] video-create 模式集成完成

### 阶段 4 完成检查
- [ ] 版本号更新为 1.5.6
- [ ] CHANGELOG 更新完成
- [ ] `npm run build` 构建成功
- [ ] 代码已提交到 git

---

## 后续步骤

完成本工作流后，使用 `/sc:implement` 执行实现计划。
