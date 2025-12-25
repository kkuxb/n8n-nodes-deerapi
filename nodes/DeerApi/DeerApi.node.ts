import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

export class DeerApi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DeerAPI',
		name: 'deerApi',
		icon: 'file:deerapi.png',
		group: ['transform'],
		version: 1,
		description: '便捷调用DeerAPI平台上的各种大模型',
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
				],
				default: 'text',
			},
			{
				displayName: '生成模型',
				name: 'imageModel',
				type: 'options',
				displayOptions: { show: { mode: ['image'] } },
				options: [
					{ name: 'Gemini-3-Pro-Image', value: 'gemini-3-pro-image' },
					{ name: '即梦 4.5', value: 'doubao-seedream-4-5-251128' },
				],
				default: 'gemini-3-pro-image',
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
				default: '',
				required: true,
			},
			// --- 分辨率：Gemini 专用 (包含 1K) ---
			{
				displayName: '分辨率',
				name: 'imageSize',
				type: 'options',
				displayOptions: { 
					show: { 
						mode: ['image'], 
						imageModel: ['gemini-3-pro-image'] 
					} 
				},
				options: [
					{ name: '1K', value: '1K' },
					{ name: '2K', value: '2K' },
					{ name: '4K', value: '4K' },
				],
				default: '1K',
			},
			// --- 分辨率：即梦 4.5 专用 (剔除 1K) ---
			{
				displayName: '分辨率',
				name: 'imageSize',
				type: 'options',
				displayOptions: { 
					show: { 
						mode: ['image'], 
						imageModel: ['doubao-seedream-4-5-251128'] 
					} 
				},
				options: [
					{ name: '2K', value: '2K' },
					{ name: '4K', value: '4K' },
				],
				default: '2K',
			},
			{
				displayName: '尺寸比例',
				name: 'aspectRatio',
				type: 'options',
				displayOptions: { show: { mode: ['image'], imageModel: ['gemini-3-pro-image'] } },
				options: [
					{ name: '1:1', value: '1:1' }, { name: '3:2', value: '3:2' },
					{ name: '2:3', value: '2:3' }, { name: '16:9', value: '16:9' },
					{ name: '9:16', value: '9:16' }, { name: '3:4', value: '3:4' },
					{ name: '4:3', value: '4:3' }, { name: '4:5', value: '4:5' },
					{ name: '5:4', value: '5:4' }, { name: '21:9', value: '21:9' },
				],
				default: '1:1',
			},
			{
				displayName: '图片属性名',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data, data0, data1, data2, file, attachment',
				description: '代码将自动探测这些属性并提取存在的图片作为参考图',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('deerApi');
		const mode = this.getNodeParameter('mode', 0) as string;
		const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');

		for (let i = 0; i < items.length; i++) {
			try {
				const userPrompt = this.getNodeParameter('userPrompt', i) as string;
				const binaryPropInput = this.getNodeParameter('binaryPropertyName', i) as string;
				const propNames = binaryPropInput.split(',').map(s => s.trim()).filter(s => s !== '');

				if (mode === 'text') {
					const model = this.getNodeParameter('modelId', i) as string;
					const systemPrompt = this.getNodeParameter('systemPrompt', i) as string;
					let combinedPrompt = userPrompt;
					const extractedText = items[i].json.text as string | undefined;

					if (extractedText && extractedText.trim() !== '') {
						combinedPrompt = combinedPrompt ? `${combinedPrompt}\n\n[参考文档内容]:\n${extractedText}` : extractedText;
					}

					let firstBase64 = '';
					let firstMime = 'image/jpeg';
					if (items[i].binary) {
						for (const p of propNames) {
							if (items[i].binary![p] && items[i].binary![p].mimeType.startsWith('image/')) {
								const buffer = await this.helpers.getBinaryDataBuffer(i, p);
								firstBase64 = Buffer.from(buffer).toString('base64');
								firstMime = items[i].binary![p].mimeType;
								break;
							}
						}
					}

					const responseData = await this.helpers.request({
						method: 'POST',
						url: `${baseUrl}/chat/completions`,
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

				} else {
					const imageModel = this.getNodeParameter('imageModel', i) as string;
					// n8n 会自动获取当前可见的那个名为 imageSize 的参数值
					const rawSize = this.getNodeParameter('imageSize', i) as string;

					if (imageModel === 'gemini-3-pro-image') {
						const aspectRatio = this.getNodeParameter('aspectRatio', i) as string;
						const parts: any[] = [{ text: userPrompt }];
						if (items[i].binary) {
							let count = 0;
							for (const p of propNames) {
								if (items[i].binary![p] && count < 3) {
									const buffer = await this.helpers.getBinaryDataBuffer(i, p);
									parts.push({ inline_data: { data: Buffer.from(buffer).toString('base64'), mime_type: items[i].binary![p].mimeType } });
									count++;
								}
							}
						}
						const res = await this.helpers.request({
							method: 'POST',
							url: `${baseUrl.replace(/\/v1$/, '')}/v1beta/models/gemini-3-pro-image:generateContent`,
							headers: { Authorization: `Bearer ${credentials.apiKey}` },
							body: { contents: [{ role: 'user', parts }], generationConfig: { imageSize: rawSize, aspectRatio, responseModalities: ["IMAGE"] } },
							json: true,
						});

						const b64 = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData.data;
						if (b64) {
							const binaryOutput = await this.helpers.prepareBinaryData(Buffer.from(b64, 'base64'), 'gemini_image.png', 'image/png');
							returnData.push({ json: { status: 'success' }, binary: { data: binaryOutput } });
						} else throw new Error(`Gemini 接口未返回图像。`);

					} else {
						// --- 即梦 4.5 模式 ---
						const images: string[] = [];
						if (items[i].binary) {
							for (const p of propNames) {
								if (items[i].binary![p] && images.length < 3) {
									const bin = items[i].binary![p];
									const buffer = await this.helpers.getBinaryDataBuffer(i, p);
									images.push(`data:${bin.mimeType};base64,${Buffer.from(buffer).toString('base64')}`);
								}
							}
						}

						const responseData = await this.helpers.request({
							method: 'POST',
							url: `${baseUrl}/images/generations`,
							headers: { Authorization: `Bearer ${credentials.apiKey}` },
							body: {
								model: imageModel,
								prompt: userPrompt,
								size: rawSize,
								n: 1,
								response_format: 'b64_json',
								image: images.length === 1 ? images[0] : (images.length > 1 ? images : undefined),
								watermark: true
							},
							json: true,
						});

						if (responseData.data && responseData.data[0]) {
							const imgItem = responseData.data[0];
							const b64Data = imgItem.b64_json || imgItem.url;
							
							if (b64Data) {
								const binaryOutput = await this.helpers.prepareBinaryData(
									Buffer.from(b64Data, 'base64'), 
									`doubao_image.png`, 
									'image/png'
								);
								returnData.push({ 
									json: { 
										status: 'success', 
										model: responseData.model,
										created: responseData.created 
									}, 
									binary: { data: binaryOutput } 
								});
							}
						} else {
							throw new Error(`即梦接口未返回有效的图像数据。`);
						}
					}
				}
			} catch (error) {
				if (this.continueOnFail()) { returnData.push({ json: { error: error.message } }); continue; }
				throw new NodeOperationError(this.getNode(), error);
			}
		}
		return [returnData];
	}
}