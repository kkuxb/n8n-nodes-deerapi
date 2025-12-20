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
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.deerapi.com/v1',
			placeholder: 'https://api.deerapi.com/v1',
			required: true,
		},
	];
}