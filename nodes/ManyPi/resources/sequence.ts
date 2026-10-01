import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { brandOption, returnAllAndLimit, showFor } from '../shared/descriptions';
import { manyPiApiRequest } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { applyLimit, asArray, containsText, prune } from '../shared/utils';

const RESOURCE = 'sequence';

export const sequenceDescription: INodeProperties[] = [
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
				action: 'Create a sequence',
				description:
					'Create the email steps a campaign sends. Step 1 goes out on enrollment, each later step after its wait.',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many sequences',
				description: 'Retrieve a list of your saved sequences with their steps',
			},
		],
		default: 'getAll',
	},

	// ── Create ────────────────────────────────────────────────────────────────
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Agency intro, 3 steps',
		displayOptions: { show: showFor(RESOURCE, 'create') },
	},
	{
		displayName: 'Steps',
		name: 'steps',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		required: true,
		placeholder: 'Add Step',
		default: {},
		description:
			'The emails in order. Merge variables such as {{first_name}} and {{company}} are filled in from each lead.',
		displayOptions: { show: showFor(RESOURCE, 'create') },
		options: [
			{
				displayName: 'Step',
				name: 'step',
				values: [
					{
						displayName: 'Subject',
						name: 'subject',
						type: 'string',
						default: '',
						placeholder: 'e.g. Quick question, {{first_name}}',
						description:
							'Leave empty only on a Reply in Thread step, which is sent as "Re:" the first subject',
					},
					{
						displayName: 'Body (HTML)',
						name: 'bodyHtml',
						type: 'string',
						typeOptions: { rows: 5 },
						default: '',
						placeholder: 'e.g. <p>Hi {{first_name}},</p>',
						description: 'Simple HTML: paragraphs, bold text and links',
					},
					{
						displayName: 'Wait Days',
						name: 'waitDays',
						type: 'number',
						typeOptions: { minValue: 0, numberPrecision: 0 },
						default: 3,
						description:
							'Days to wait after the previous step. Ignored on the first step, which sends on enrollment.',
					},
					{
						displayName: 'Thread Mode',
						name: 'threadMode',
						type: 'options',
						options: [
							{ name: 'New Email', value: 'new' },
							{ name: 'Reply in Thread', value: 'reply' },
						],
						default: 'new',
						description: 'The first step is always a new email',
					},
				],
			},
		],
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
				displayName: 'Description',
				name: 'description',
				type: 'string',
				default: '',
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
			brandOption,
			{
				displayName: 'Name Contains',
				name: 'name',
				type: 'string',
				default: '',
			},
		],
	},
];

export const sequenceHandlers: ResourceHandlers = {
	async create(i) {
		const rows =
			((this.getNodeParameter('steps', i, {}) as IDataObject).step as IDataObject[]) ?? [];
		const steps = rows
			.filter((row) => String(row.bodyHtml ?? '').trim())
			.map((row, index) => ({
				subject: String(row.subject ?? ''),
				body_html: String(row.bodyHtml),
				// The first step always sends on enrollment as a new email.
				wait_days: index === 0 ? 0 : Number(row.waitDays ?? 0),
				thread_mode: index === 0 ? 'new' : String(row.threadMode ?? 'new'),
			}));

		if (!steps.length) {
			throw new NodeOperationError(this.getNode(), 'The sequence has no steps with a body', {
				itemIndex: i,
				description: 'Add at least one step under Steps and fill in its Body (HTML).',
			});
		}
		steps.forEach((step, index) => {
			if (!step.subject.trim() && step.thread_mode !== 'reply') {
				throw new NodeOperationError(this.getNode(), `Step ${index + 1} has no subject`, {
					itemIndex: i,
					description:
						'Enter a subject, or set the step to Reply in Thread so it is sent as "Re:" the first subject.',
				});
			}
		});

		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/outreach/sequences',
			prune({
				name: this.getNodeParameter('name', i) as string,
				description: additional.description,
				steps: steps as unknown as IDataObject[],
			}),
			undefined,
			{ itemIndex: i },
		)) as IDataObject;
		return (data.sequence ?? data) as IDataObject;
	},

	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const body = await manyPiApiRequest.call(
			this,
			'GET',
			'/api/outreach/sequences',
			undefined,
			{ brand: filters.brand },
			{ itemIndex: i },
		);
		const sequences = asArray(body, 'sequences')
			.filter((sequence) => !filters.name || containsText(sequence.name, filters.name as string))
			.map((sequence) => ({
				...sequence,
				step_count: Array.isArray(sequence.steps) ? sequence.steps.length : 0,
			}));
		return applyLimit(sequences, returnAll, limit);
	},
};
