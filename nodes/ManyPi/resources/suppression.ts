import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { returnAllAndLimit, showFor } from '../shared/descriptions';
import { manyPiApiRequest } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { asArray, assertBatchSize, fetchOffsetPages, toList } from '../shared/utils';

const RESOURCE = 'suppression';

export const suppressionDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Add',
				value: 'add',
				action: 'Add addresses to the suppression list',
				description:
					'Add addresses to the do-not-contact list. No campaign, inbox or brand ever sends to them.',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many suppressed addresses',
				description: 'Retrieve a list of addresses on the do-not-contact list',
			},
			{
				name: 'Remove',
				value: 'remove',
				action: 'Remove an address from the suppression list',
				description:
					'Take one address off the do-not-contact list. Nobody is enrolled again automatically.',
			},
		],
		default: 'add',
	},
	{
		displayName: 'Email Addresses',
		name: 'emails',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. nathan@example.com, anna@example.com',
		description: 'The addresses to never contact, separated by commas',
		displayOptions: { show: showFor(RESOURCE, 'add') },
	},
	{
		displayName: 'Email Address',
		name: 'email',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. nathan@example.com',
		displayOptions: { show: showFor(RESOURCE, 'remove') },
	},
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
				displayName: 'Search',
				name: 'q',
				type: 'string',
				default: '',
				placeholder: 'e.g. example.com',
				description: 'Only return addresses containing this text',
			},
		],
	},
];

export const suppressionHandlers: ResourceHandlers = {
	async add(i) {
		const emails = toList(this.getNodeParameter('emails', i));
		// ManyPI keeps the first 5,000 and drops the rest without saying so.
		assertBatchSize.call(this, emails, 5000, 'email addresses', i);
		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/outreach/suppressions',
			{ emails },
			undefined,
			{ itemIndex: i },
		)) as IDataObject;
		return { ...data, submitted: emails.length };
	},

	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const records = await fetchOffsetPages.call(this, {
			path: '/api/outreach/suppressions',
			qs: { q: filters.q },
			key: 'suppressions',
			pageSize: 500,
			returnAll,
			limit,
			itemIndex: i,
			// Entries may be bare strings: give every row the same shape.
			map: (entry) => {
				const raw = entry as unknown;
				return typeof raw === 'string' ? { email: raw } : entry;
			},
		});
		return records;
	},

	async remove(i) {
		const email = (this.getNodeParameter('email', i) as string).trim();
		// The route answers ok whether or not the address was listed, so look it
		// up first and report whether anything was actually taken off.
		const listed = await manyPiApiRequest.call(
			this,
			'GET',
			'/api/outreach/suppressions',
			undefined,
			{ q: email, limit: 500 },
			{ itemIndex: i },
		);
		const wasSuppressed = asArray(listed, 'suppressions').some((entry) => {
			const raw = entry as unknown;
			const address = typeof raw === 'string' ? raw : (entry.email as string | undefined);
			return String(address ?? '').toLowerCase() === email.toLowerCase();
		});
		if (wasSuppressed) {
			await manyPiApiRequest.call(
				this,
				'DELETE',
				'/api/outreach/suppressions',
				undefined,
				{ email },
				{ itemIndex: i, resourceLabel: 'suppressed address' },
			);
		}
		return { email, removed: wasSuppressed };
	},
};
