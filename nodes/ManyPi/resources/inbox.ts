import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { brandOption, returnAllAndLimit, showFor } from '../shared/descriptions';
import { manyPiApiRequest } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { applyLimit, asArray, normalizeInbox } from '../shared/utils';

const RESOURCE = 'inbox';

export const inboxDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many inboxes',
				description:
					'Retrieve your sending inboxes with their health: sends today against the warmup-aware cap, 14-day delivery stats, and whether sending is paused',
			},
		],
		default: 'getAll',
	},
	...returnAllAndLimit(showFor(RESOURCE, 'getAll')),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'getAll') },
		options: [brandOption],
	},
];

export const inboxHandlers: ResourceHandlers = {
	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const body = await manyPiApiRequest.call(
			this,
			'GET',
			'/api/outreach/inboxes',
			undefined,
			{ brand: filters.brand },
			{ itemIndex: i },
		);
		return applyLimit(asArray(body, 'inboxes').map(normalizeInbox), returnAll, limit);
	},
};
