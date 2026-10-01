import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { manyPiApiRequest } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';

export const accountDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['account'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				action: 'Get the connected account',
				description:
					'Retrieve the account behind the API key, with the key permissions and rate limit',
			},
		],
		default: 'get',
	},
];

export const accountHandlers: ResourceHandlers = {
	async get(i) {
		const body = (await manyPiApiRequest.call(this, 'GET', '/api/user', undefined, undefined, {
			itemIndex: i,
		})) as IDataObject;
		const data = ((body && body.data) ?? body) as IDataObject;
		return { id: data.userId, ...data };
	},
};
