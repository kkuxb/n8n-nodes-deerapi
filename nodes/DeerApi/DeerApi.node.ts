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
		description: '调用 DeerAPI 进行文字生成和 Gemini 图像生成（支持多图探测）',
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
					{ name: '文字生成 (自选模型)', value: 'text' },
					{ name: '图像生成 (Gemini-3-Pro-Image)', value: 'image' },
				],
				default: 'text',
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
			{
				displayName: '分辨率',
				name: 'imageSize',
				type: 'options',
				displayOptions: { show: { mode: ['image'] } },
				options: [
					{ name: '1K', value: '1K' },
					{ name: '2K', value: '2K' },
					{ name: '4K', value: '4K' },
				],
				default: '1K',
			},
			{
				displayName: '尺寸比例',
				name: 'aspectRatio',
				type: 'options',
				displayOptions: { show: { mode: ['image'] } },
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
				description: '代码将自动探测这些属性并提取前3张存在的图片，多个名称用逗号隔开',
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
					// --- 文字生成模式 (OpenAI 格式) ---
					const model = this.getNodeParameter('modelId', i) as string;
					const systemPrompt = this.getNodeParameter('systemPrompt', i) as string;
					
					// 仅探测第一张图片用于多模态对话
					let firstBase64 = '';
					let firstMime = 'image/jpeg';
					if (items[i].binary) {
						for (const p of propNames) {
							if (items[i].binary![p]) {
								const buffer = await this.helpers.getBinaryDataBuffer(i, p);
								firstBase64 = Buffer.from(buffer).toString('base64');
								firstMime = items[i].binary![p].mimeType;
								break;
							}
						}
					}

					const body: any = {
						model,
						messages: [
							{ role: 'system', content: systemPrompt },
							{ role: 'user', content: firstBase64 ? 
								[{ type: 'text', text: userPrompt }, { type: 'image_url', image_url: { url: `data:${firstMime};base64,${firstBase64}` } }] : 
								userPrompt 
							}
						]
					};

					const responseData = await this.helpers.request({
						method: 'POST',
						url: `${baseUrl}/chat/completions`,
						headers: { Authorization: `Bearer ${credentials.apiKey}` },
						body,
						json: true,
					});
					returnData.push({ json: responseData });

				} else {
					// --- 图像生成模式 (Gemini v1beta 格式) --- 
					const imageSize = this.getNodeParameter('imageSize', i) as string;
					const aspectRatio = this.getNodeParameter('aspectRatio', i) as string;

					const parts: any[] = [{ text: userPrompt }]; // [cite: 8]

					// 自动探测并过滤存在的图片，最多取3张 
					let imageCount = 0;
					if (items[i].binary) {
						for (const p of propNames) {
							if (items[i].binary![p] && imageCount < 3) {
								const buffer = await this.helpers.getBinaryDataBuffer(i, p);
								parts.push({
									inline_data: { // 
										data: Buffer.from(buffer).toString('base64'), // [cite: 31]
										mime_type: items[i].binary![p].mimeType
									}
								});
								imageCount++;
							}
						}
					}

					const body = {
						contents: [{ role: 'user', parts }],
						generationConfig: { 
							imageSize, 
							aspectRatio,
							responseModalities: ["IMAGE"] // 
						}
					};

					const res = await this.helpers.request({
						method: 'POST',
						// 适配文档要求的 v1beta 路径 
						url: `${baseUrl.replace(/\/v1$/, '')}/v1beta/models/gemini-3-pro-image:generateContent`,
						headers: { Authorization: `Bearer ${credentials.apiKey}` }, // 
						body,
						json: true,
					});

					// 解析响应中的 inlineData 
					let b64Image = '';
					if (res.candidates && res.candidates[0]?.content?.parts) {
						for (const part of res.candidates[0].content.parts) {
							if (part.inlineData?.data) {
								b64Image = part.inlineData.data;
								break;
							}
						}
					}

					if (b64Image) {
						const binaryOutput = await this.helpers.prepareBinaryData(
							Buffer.from(b64Image, 'base64'), 
							'generated_image.png', 
							'image/png'
						); // [cite: 30]
						
						returnData.push({
							json: { status: 'success', finishReason: res.candidates[0].finishReason },
							binary: { data: binaryOutput }
						});
					} else {
						const apiError = res.error?.message || JSON.stringify(res);
						throw new Error(`API 未返回图像。详情: ${apiError}`);
					}
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: error.message } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error);
			}
		}
		return [returnData];
	}
}