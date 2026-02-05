import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
	IBinaryData,
} from 'n8n-workflow';

// 图片数据接口
interface ImageData {
	base64: string;
	mimeType: string;
	fileName?: string;
	buffer: Buffer;
}

// 收集结果接口，包含 binary 数据和预读取的 buffer 映射
interface CollectedBinaryResult {
	binary: Record<string, IBinaryData>;
	bufferMap: Map<string, Buffer>; // propName -> 预读取的 buffer
}

// 从指定节点收集 Binary 数据并合并（同时预读取文件系统中的 binary）
async function collectBinaryFromNodes(
	context: IExecuteFunctions,
	itemIndex: number,
	sourceMode: 'current' | 'specified',
	specifiedNodes: string[],
): Promise<CollectedBinaryResult> {
	const mergedBinary: Record<string, IBinaryData> = {};
	const bufferMap = new Map<string, Buffer>();

	if (sourceMode === 'current') {
		// 当前模式：直接返回当前输入的 binary（不需要预读取，getBinaryDataBuffer 可用）
		const items = context.getInputData();
		if (items[itemIndex]?.binary) {
			return { binary: { ...items[itemIndex].binary }, bufferMap };
		}
		return { binary: mergedBinary, bufferMap };
	}

	// 获取工作流数据代理
	const workflowProxy = context.getWorkflowDataProxy(itemIndex);

	// 指定模式：使用用户提供的节点名称
	const targetNodeNames = specifiedNodes;

	// 从目标节点收集 Binary
	let binaryIndex = 0;

	for (const nodeName of targetNodeNames) {
		try {
			// 使用 $(nodeName).all() 获取节点数据（与 n8n Code 节点一致）
			const nodeProxy = workflowProxy.$(nodeName);
			const nodeItems: INodeExecutionData[] = nodeProxy.all();

			if (!nodeItems || nodeItems.length === 0) continue;

			// 取对应 itemIndex 的数据，如果不存在则取第一个
			const targetItemIndex = itemIndex < nodeItems.length ? itemIndex : 0;
			const nodeItem = nodeItems[targetItemIndex];

			if (!nodeItem?.binary) continue;

			// 合并 Binary 数据
			for (const [, binaryData] of Object.entries(nodeItem.binary)) {
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

				// 如果 binary 存储在文件系统中（有 id），立即预读取其内容
				if (binaryData.id) {
					try {
						const stream = await context.helpers.getBinaryStream(binaryData.id);
						const buffer = await context.helpers.binaryToBuffer(stream);
						bufferMap.set(newPropName, buffer);
					} catch {
						// 如果读取失败，尝试使用内联 data
						if (binaryData.data) {
							bufferMap.set(newPropName, Buffer.from(binaryData.data, 'base64'));
						}
					}
				} else if (binaryData.data) {
					// 内联 base64 数据，直接解码
					bufferMap.set(newPropName, Buffer.from(binaryData.data, 'base64'));
				}

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
			return { binary: { ...items[itemIndex].binary }, bufferMap };
		}
	}

	return { binary: mergedBinary, bufferMap };
}

// 从 Binary 对象中提取图片
async function extractImagesFromBinary(
	context: IExecuteFunctions,
	itemIndex: number,
	binary: Record<string, IBinaryData>,
	propNames: string[],
	maxImages: number,
	bufferMap?: Map<string, Buffer>,
): Promise<ImageData[]> {
	const images: ImageData[] = [];

	for (const propName of propNames) {
		if (images.length >= maxImages) break;

		const binaryData = binary[propName];
		if (!binaryData) continue;
		if (!binaryData.mimeType?.startsWith('image/')) continue;

		try {
			// 需要从 binary data 获取 buffer
			let buffer: Buffer;

			// 优先使用预读取的 buffer（跨节点收集时已读取）
			if (bufferMap?.has(propName)) {
				buffer = bufferMap.get(propName)!;
			} else if (binaryData.id) {
				// 存储在文件系统中的 binary（当前节点输入）
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

export class DeerApi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DeerAPI',
		name: 'deerApi',
		icon: 'file:deerapi.png',
		group: ['transform'],
		version: 1,
		description: '调用 DeerAPI 进行文字、图像、Sora 2 视频生成及向量嵌入',
		defaults: { name: 'DeerAPI' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'deerApi', required: true }],
		properties: [
			{
				displayName: '模式',
				name: 'mode',
				type: 'options',
				options: [
					{ name: '文字生成', value: 'text' },
					{ name: '图像生成', value: 'image' },
					{ name: '视频生成 (Sora 2)', value: 'video' },
					{ name: '向量嵌入 (Embeddings)', value: 'embeddings' },
				],
				default: 'text',
			},
			{
				displayName: '操作',
				name: 'videoOperation',
				type: 'options',
				displayOptions: { show: { mode: ['video'] } },
				options: [
					{ name: '创建视频', value: 'create' },
					{ name: '混编/修改视频', value: 'remix' },
					{ name: '检索视频', value: 'retrieve' },
					{ name: '下载视频', value: 'download' },
					{ name: '列出视频', value: 'list' },
				],
				default: 'create',
			},
			// --- 模型选择 ---
			{
				displayName: '生成模型',
				name: 'imageModel',
				type: 'options',
				displayOptions: { show: { mode: ['image'] } },
				options: [
					{ name: 'Gemini-3-Pro-Image', value: 'gemini-3-pro-image' },
					{ name: 'Gemini-2.5-Flash-Image', value: 'gemini-2.5-flash-image' },
					{ name: '即梦 4.5', value: 'doubao-seedream-4-5-251128' },
				],
				default: 'gemini-3-pro-image',
			},
			{
				displayName: '生成模型',
				name: 'videoModel',
				type: 'options',
				displayOptions: { show: { mode: ['video'], videoOperation: ['create'] } },
				options: [
					{ name: 'Sora 2', value: 'sora-2-all' },
					{ name: 'Sora 2 Pro', value: 'sora-2-pro-all' },
				],
				default: 'sora-2-all',
			},
			{
				displayName: '模型 ID',
				name: 'modelId',
				type: 'string',
				displayOptions: { show: { mode: ['text'] } },
				default: 'gemini-3-pro-preview',
				required: true,
			},
			{
				displayName: '系统提示词 (System Prompt)',
				name: 'systemPrompt',
				type: 'string',
				displayOptions: { show: { mode: ['text'] } },
				default: '你是一个专业的助手。',
			},
			{
				displayName: '用户提示词',
				name: 'userPrompt',
				type: 'string',
				displayOptions: { show: { mode: ['text', 'image'] } },
				default: '',
				required: true,
			},
			// --- 视频参数：故事板逻辑 ---
			{
				displayName: '故事板模式',
				name: 'storyboardMode',
				type: 'boolean',
				displayOptions: { show: { mode: ['video'], videoOperation: ['create'] } },
				default: false,
				description: '开启后可分镜头填写提示词，节点将自动组合格式',
			},
			{
				displayName: '分镜列表',
				name: 'storyboardShots',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				displayOptions: { show: { mode: ['video'], videoOperation: ['create'], storyboardMode: [true] } },
				placeholder: '添加分镜',
				default: {
					shots: [
						{ shotPrompt: '描述第一个镜头内容', duration: 5 },
						{ shotPrompt: '描述第二个镜头内容', duration: 5 },
					],
				},
				options: [
					{
						name: 'shots',
						displayName: 'Shots',
						values: [
							{
								displayName: '分镜描述',
								name: 'shotPrompt',
								type: 'string',
								default: '',
								required: true,
							},
							{
								displayName: '镜头时长 (秒)',
								name: 'duration',
								type: 'number',
								default: 5,
							},
						],
					},
				],
			},
			{
				displayName: '视频提示词',
				name: 'videoPrompt',
				type: 'string',
				displayOptions: { 
					show: { mode: ['video'], videoOperation: ['create', 'remix'] },
					hide: { storyboardMode: [true] }
				},
				default: '',
				required: true,
			},
			{
				displayName: '目标分辨率',
				name: 'videoSize',
				type: 'options',
				displayOptions: { show: { mode: ['video'], videoOperation: ['create'] } },
				options: [
					{ name: '720x1280 (9:16)', value: '720x1280' },
					{ name: '1280x720 (16:9)', value: '1280x720' },
					{ name: '1024x1792 (9:16)', value: '1024x1792' },
					{ name: '1792x1024 (16:9)', value: '1792x1024' },
				],
				default: '720x1280',
			},
			{
				displayName: '视频 ID',
				name: 'videoId',
				type: 'string',
				displayOptions: { show: { mode: ['video'], videoOperation: ['remix', 'retrieve', 'download'] } },
				default: '',
				required: true,
			},
			{
				displayName: '智能轮询等待',
				name: 'smartWait',
				type: 'boolean',
				displayOptions: { show: { mode: ['video'], videoOperation: ['retrieve'] } },
				default: true,
				description: '开启后将每15秒查询一次状态，直到完成或失败（上限10分钟）',
			},
			// --- 分辨率：图像生成 ---
			{
				displayName: '分辨率',
				name: 'imageSize',
				type: 'options',
				displayOptions: { show: { mode: ['image'], imageModel: ['gemini-3-pro-image'] } },
				options: [{ name: '1K', value: '1K' }, { name: '2K', value: '2K' }, { name: '4K', value: '4K' }],
				default: '1K',
			},
			{
				displayName: '分辨率',
				name: 'imageSize',
				type: 'options',
				displayOptions: { show: { mode: ['image'], imageModel: ['doubao-seedream-4-5-251128'] } },
				options: [{ name: '2K', value: '2K' }, { name: '4K', value: '4K' }],
				default: '2K',
			},
			{
				displayName: '尺寸比例',
				name: 'aspectRatio',
				type: 'options',
				displayOptions: { show: { mode: ['image'], imageModel: ['gemini-3-pro-image', 'gemini-2.5-flash-image'] } },
				options: [
					{ name: '1:1', value: '1:1' }, { name: '3:2', value: '3:2' },
					{ name: '2:3', value: '2:3' }, { name: '16:9', value: '16:9' },
					{ name: '9:16', value: '9:16' }, { name: '3:4', value: '3:4' },
					{ name: '4:3', value: '4:3' }, { name: '4:5', value: '4:5' },
					{ name: '5:4', value: '5:4' }, { name: '21:9', value: '21:9' },
				],
				default: '1:1',
			},
			// --- Embeddings 参数 ---
			{
				displayName: '嵌入模型',
				name: 'embeddingModel',
				type: 'options',
				displayOptions: { show: { mode: ['embeddings'] } },
				options: [
					{ name: 'text-embedding-3-large', value: 'text-embedding-3-large' },
					{ name: 'text-embedding-3-small', value: 'text-embedding-3-small' },
				],
				default: 'text-embedding-3-large',
			},
			{
				displayName: '输入文本',
				name: 'embeddingInput',
				type: 'string',
				displayOptions: { show: { mode: ['embeddings'] } },
				default: '',
				required: true,
				description: '需要生成向量嵌入的文本内容',
			},
			// --- 图片属性设置 ---
			{
				displayName: 'Binary 来源模式',
				name: 'binarySourceMode',
				type: 'options',
				options: [
					{ name: '当前节点输入', value: 'current' },
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
			{
				displayName: '图片属性名',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data, data0, data1, data2, file, attachment',
				displayOptions: {
					show: {
						mode: ['text', 'image', 'video']
					},
					hide: {
						videoOperation: ['remix', 'retrieve', 'download', 'list']
					}
				},
				description: '用于文字识别、图像参考、及视频创建的参考图',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('deerApi');
		const mode = this.getNodeParameter('mode', 0) as string;
		const rawBaseUrl = (credentials.baseUrl as string).replace(/\/$/, '');
		const soraBaseUrl = rawBaseUrl.replace(/\/v1$/, '');

		for (let i = 0; i < items.length; i++) {
			try {
				const binaryPropInput = this.getNodeParameter('binaryPropertyName', i, 'data, data0, data1, data2, file, attachment') as string;
				const propNames = binaryPropInput.split(',').map(s => s.trim()).filter(s => s !== '');

				if (mode === 'text') {
					const userPrompt = this.getNodeParameter('userPrompt', i) as string;
					const model = this.getNodeParameter('modelId', i) as string;
					const systemPrompt = this.getNodeParameter('systemPrompt', i) as string;
					let combinedPrompt = userPrompt;
					const extractedText = items[i].json.text as string | undefined;

					if (extractedText && extractedText.trim() !== '') {
						combinedPrompt = combinedPrompt ? `${combinedPrompt}\n\n[参考文档内容]:\n${extractedText}` : extractedText;
					}

					// 获取 Binary 来源模式参数
					const binarySourceMode = this.getNodeParameter('binarySourceMode', i, 'current') as 'current' | 'specified';
					const sourceNodeNamesInput = this.getNodeParameter('sourceNodeNames', i, '') as string;
					const specifiedNodes = sourceNodeNamesInput.split(',').map(s => s.trim()).filter(s => s !== '');

					// 收集 Binary 数据
					const { binary: collectedBinary, bufferMap } = await collectBinaryFromNodes(this, i, binarySourceMode, specifiedNodes);

					// 从收集的 Binary 中提取图片
					const extractedImages = await extractImagesFromBinary(this, i, collectedBinary, propNames, 1, bufferMap);
					const firstBase64 = extractedImages.length > 0 ? extractedImages[0].base64 : '';
					const firstMime = extractedImages.length > 0 ? extractedImages[0].mimeType : 'image/jpeg';

					const responseData = await this.helpers.request({
						method: 'POST',
						url: `${rawBaseUrl}/chat/completions`,
						headers: { Authorization: `Bearer ${credentials.apiKey}` },
						body: {
							model,
							messages: [
								{ role: 'system', content: systemPrompt },
								{ role: 'user', content: firstBase64 ? [{ type: 'text', text: combinedPrompt }, { type: 'image_url', image_url: { url: `data:${firstMime};base64,${firstBase64}` } }] : combinedPrompt }
							]
						},
						json: true,
					});
					returnData.push({ json: responseData });

				} else if (mode === 'image') {
					const userPrompt = this.getNodeParameter('userPrompt', i) as string;
					const imageModel = this.getNodeParameter('imageModel', i) as string;

					// 获取 Binary 来源模式参数
					const binarySourceMode = this.getNodeParameter('binarySourceMode', i, 'current') as 'current' | 'specified';
					const sourceNodeNamesInput = this.getNodeParameter('sourceNodeNames', i, '') as string;
					const specifiedNodes = sourceNodeNamesInput.split(',').map(s => s.trim()).filter(s => s !== '');

					// 收集 Binary 数据
					const { binary: collectedBinary, bufferMap } = await collectBinaryFromNodes(this, i, binarySourceMode, specifiedNodes);

					if (imageModel === 'gemini-3-pro-image' || imageModel === 'gemini-2.5-flash-image') {
						const aspectRatio = this.getNodeParameter('aspectRatio', i) as string;
						const parts: any[] = [{ text: userPrompt }];

						// 从收集的 Binary 中提取图片（最多3张）
						const extractedImages = await extractImagesFromBinary(this, i, collectedBinary, propNames, 3, bufferMap);
						for (const img of extractedImages) {
							parts.push({ inline_data: { data: img.base64, mime_type: img.mimeType } });
						}

						// 根据模型动态构建 generationConfig
						const generationConfig: Record<string, unknown> = {
							aspectRatio,
							responseModalities: ["IMAGE"],
						};
						// 只有 gemini-3-pro-image 需要 imageSize 参数
						if (imageModel === 'gemini-3-pro-image') {
							const rawSize = this.getNodeParameter('imageSize', i) as string;
							generationConfig.imageSize = rawSize;
						}

						const res = await this.helpers.request({
							method: 'POST',
							url: `${rawBaseUrl.replace(/\/v1$/, '')}/v1beta/models/${imageModel}:generateContent`,
							headers: { Authorization: `Bearer ${credentials.apiKey}` },
							body: { contents: [{ role: 'user', parts }], generationConfig },
							json: true,
						});
						const b64 = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData.data;
						if (b64) {
							const outputFileName = imageModel === 'gemini-2.5-flash-image' ? 'gemini_flash_image.png' : 'gemini_image.png';
							const binaryOutput = await this.helpers.prepareBinaryData(Buffer.from(b64, 'base64'), outputFileName, 'image/png');
							returnData.push({ json: { status: 'success' }, binary: { data: binaryOutput } });
						} else throw new Error(`Gemini 接口未返回图像。`);

					} else {
						// 即梦模型需要 imageSize 参数
						const rawSize = this.getNodeParameter('imageSize', i) as string;
						// 从收集的 Binary 中提取图片（最多3张）
						const extractedImages = await extractImagesFromBinary(this, i, collectedBinary, propNames, 3, bufferMap);
						const images: string[] = extractedImages.map(img => `data:${img.mimeType};base64,${img.base64}`);

						const responseData = await this.helpers.request({
							method: 'POST',
							url: `${rawBaseUrl}/images/generations`,
							headers: { Authorization: `Bearer ${credentials.apiKey}` },
							body: { model: imageModel, prompt: userPrompt, size: rawSize, n: 1, response_format: 'b64_json', image: images.length === 1 ? images[0] : (images.length > 1 ? images : undefined), watermark: true },
							json: true,
						});
						if (responseData.data?.[0]?.b64_json) {
							const binaryOutput = await this.helpers.prepareBinaryData(Buffer.from(responseData.data[0].b64_json, 'base64'), `doubao_image.png`, 'image/png');
							returnData.push({ json: { status: 'success' }, binary: { data: binaryOutput } });
						} else throw new Error(`即梦接口未返回图像。`);
					}

				} else if (mode === 'video') {
					const operation = this.getNodeParameter('videoOperation', i) as string;

					if (operation === 'create') {
						const storyboardMode = this.getNodeParameter('storyboardMode', i) as boolean;
						const model = this.getNodeParameter('videoModel', i) as string;
						const size = this.getNodeParameter('videoSize', i) as string;
						let finalPrompt = '';

						if (storyboardMode) {
							const shotCollection = this.getNodeParameter('storyboardShots', i) as any;
							if (shotCollection?.shots) {
								finalPrompt = shotCollection.shots.map((s: any, index: number) => {
									return `Shot ${index + 1}:\nduration: ${s.duration}sec\nScene: ${s.shotPrompt}`;
								}).join('\n\n');
							}
						} else {
							finalPrompt = this.getNodeParameter('videoPrompt', i, '') as string;
						}

						const formData: any = { prompt: finalPrompt, model, size };

						// 获取 Binary 来源模式参数
						const binarySourceMode = this.getNodeParameter('binarySourceMode', i, 'current') as 'current' | 'specified';
						const sourceNodeNamesInput = this.getNodeParameter('sourceNodeNames', i, '') as string;
						const specifiedNodes = sourceNodeNamesInput.split(',').map(s => s.trim()).filter(s => s !== '');

						// 收集 Binary 数据
						const { binary: collectedBinary, bufferMap } = await collectBinaryFromNodes(this, i, binarySourceMode, specifiedNodes);

						// 从收集的 Binary 中提取图片（只取第一张作为参考图）
						const extractedImages = await extractImagesFromBinary(this, i, collectedBinary, propNames, 1, bufferMap);
						if (extractedImages.length > 0) {
							const img = extractedImages[0];
							formData.input_reference = {
								value: img.buffer,
								options: { filename: img.fileName || 'reference.jpg', contentType: img.mimeType },
							};
						}

						const res = await this.helpers.request({
							method: 'POST',
							url: `${soraBaseUrl}/v1/videos`,
							headers: { Authorization: `${credentials.apiKey}` },
							formData,
							json: true,
						});
						returnData.push({ json: res });

					} else if (operation === 'remix') {
						const video_id = this.getNodeParameter('videoId', i) as string;
						const prompt = this.getNodeParameter('videoPrompt', i, '') as string;
						const res = await this.helpers.request({
							method: 'POST',
							url: `${soraBaseUrl}/v1/videos/${video_id}/remix`,
							headers: { Authorization: `${credentials.apiKey}` },
							body: { prompt },
							json: true,
						});
						returnData.push({ json: res });

					} else if (operation === 'retrieve') {
						const video_id = this.getNodeParameter('videoId', i) as string;
						const smartWait = this.getNodeParameter('smartWait', i) as boolean;
						
						let res: any;
						if (smartWait) {
							for (let attempt = 0; attempt < 40; attempt++) {
								res = await this.helpers.request({
									method: 'GET',
									url: `${soraBaseUrl}/v1/videos/${video_id}`,
									headers: { Authorization: `${credentials.apiKey}` },
									json: true,
								});
								if (['completed', 'failed'].includes(res.status)) break;
								await new Promise(resolve => setTimeout(resolve, 15000));
							}
						} else {
							res = await this.helpers.request({
								method: 'GET',
								url: `${soraBaseUrl}/v1/videos/${video_id}`,
								headers: { Authorization: `${credentials.apiKey}` },
								json: true,
							});
						}
						returnData.push({ json: res });

					} else if (operation === 'download') {
						const video_id = this.getNodeParameter('videoId', i) as string;
						const response = await this.helpers.request({
							method: 'GET',
							url: `${soraBaseUrl}/v1/videos/${video_id}/content`,
							headers: { Authorization: `${credentials.apiKey}` },
							qs: { variant: 'video' },
							encoding: null,
							resolveWithFullResponse: true,
							timeout: 300000, // 增加超时时间到 5 分钟 (300,000ms) 以支持大视频下载
						});
						const binaryOutput = await this.helpers.prepareBinaryData(
							Buffer.from(response.body), 
							'sora_video.mp4',
							'video/mp4'
						);
						returnData.push({ json: { status: 'success' }, binary: { data: binaryOutput } });

					} else if (operation === 'list') {
						const res = await this.helpers.request({
							method: 'GET',
							url: `${soraBaseUrl}/v1/videos`,
							headers: { Authorization: `${credentials.apiKey}` },
							json: true,
						});
						returnData.push({ json: res });
					}
				}

				else if (mode === 'embeddings') {
					const model = this.getNodeParameter('embeddingModel', i) as string;
					const input = this.getNodeParameter('embeddingInput', i) as string;

					const responseData = await this.helpers.request({
						method: 'POST',
						url: `${rawBaseUrl}/embeddings`,
						headers: { Authorization: `Bearer ${credentials.apiKey}` },
						body: { model, input },
						json: true,
					});
					returnData.push({ json: responseData });
				}
			} catch (error) {
				if (this.continueOnFail()) { returnData.push({ json: { error: error.message } }); continue; }
				throw new NodeOperationError(this.getNode(), error);
			}
		}
		return [returnData];
	}
}