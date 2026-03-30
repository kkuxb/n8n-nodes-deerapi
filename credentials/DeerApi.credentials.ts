import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class DeerApi implements ICredentialType {
	name = 'deerApi';
	displayName = 'DeerAPI';
	documentationUrl = 'https://apidoc.deerapi.com/';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];
}