import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ManyPiApi implements ICredentialType {
	name = 'manyPiApi';

	displayName = 'ManyPI API';

	icon: Icon = { light: 'file:../icons/manypi.svg', dark: 'file:../icons/manypi.dark.svg' };

	documentationUrl = 'https://github.com/manypicom/n8n-nodes-manypi#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'e.g. mpi_xxxxxxxxxxxxxxxx',
			description:
				'Create a key in the ManyPI dashboard under API Access. Grant it the permissions for the operations you plan to use: Read, Write, Run Scrapers, Run Agents, Invoke Endpoints, Verify Email Addresses and Send Outreach.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://app.manypi.com',
			url: '/api/user',
			method: 'GET',
		},
	};
}
