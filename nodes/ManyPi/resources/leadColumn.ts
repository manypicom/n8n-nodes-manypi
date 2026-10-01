import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { returnAllAndLimit, showFor } from '../shared/descriptions';
import { manyPiApiRequest } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { applyLimit, asArray, containsText, prune, toList } from '../shared/utils';

const RESOURCE = 'leadColumn';

export const leadColumnDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a lead column',
				description:
					'Declare a custom column so leads can carry it. Values for undeclared columns are dropped.',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many lead columns',
				description: 'Retrieve a list of your custom lead columns in display order',
			},
		],
		default: 'getAll',
	},

	// ── Create ────────────────────────────────────────────────────────────────
	{
		displayName: 'Label',
		name: 'label',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Tech Stack',
		description: 'The column name people see',
		displayOptions: { show: showFor(RESOURCE, 'create') },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'create') },
		options: [
			{
				displayName: 'Auto-Research',
				name: 'autoResearch',
				type: 'boolean',
				default: false,
				description:
					'Whether the agent should fill this column in on every future lead search without being asked',
			},
			{
				displayName: 'Choices',
				name: 'options',
				type: 'string',
				default: '',
				placeholder: 'e.g. Shopify, WooCommerce, Magento',
				description: 'The allowed values for Choice and Tags columns, separated by commas',
			},
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				default: '',
				description: 'What belongs in the column. The agent reads this when it researches leads.',
			},
			{
				displayName: 'Key',
				name: 'key',
				type: 'string',
				default: '',
				placeholder: 'e.g. tech_stack',
				description: 'The key used in the API and in custom fields. Derived from the label when empty.',
			},
			{
				displayName: 'Type',
				name: 'type',
				type: 'options',
				options: [
					{ name: 'Choice', value: 'select' },
					{ name: 'Date', value: 'date' },
					{ name: 'Email', value: 'email' },
					{ name: 'Link', value: 'url' },
					{ name: 'Long Text', value: 'long_text' },
					{ name: 'Number', value: 'number' },
					{ name: 'Phone', value: 'phone' },
					{ name: 'Tags', value: 'multi_select' },
					{ name: 'Text', value: 'text' },
					{ name: 'Yes / No', value: 'boolean' },
				],
				default: 'text',
			},
		],
	},

	// ── Get Many ──────────────────────────────────────────────────────────────
	...returnAllAndLimit(showFor(RESOURCE, 'getAll')),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'getAll') },
		options: [
			{
				displayName: 'Label or Key Contains',
				name: 'search',
				type: 'string',
				default: '',
			},
		],
	},
];

export const leadColumnHandlers: ResourceHandlers = {
	async create(i) {
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/leads/fields',
			prune({
				label: this.getNodeParameter('label', i) as string,
				key: additional.key,
				type: additional.type,
				options: toList(additional.options),
				description: additional.description,
				auto_research: additional.autoResearch,
			}),
			undefined,
			{ itemIndex: i },
		)) as IDataObject;
		// Declaring a column is idempotent: `created` is false when it already existed.
		return data.field ? { ...(data.field as IDataObject), created: data.created } : data;
	},

	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const search = (filters.search as string) || '';
		const body = await manyPiApiRequest.call(this, 'GET', '/api/leads/fields', undefined, undefined, {
			itemIndex: i,
		});
		const columns = asArray(body, 'fields').filter(
			(column) => !search || containsText(column.label, search) || containsText(column.key, search),
		);
		return applyLimit(columns, returnAll, limit);
	},
};
