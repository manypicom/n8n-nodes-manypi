import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import {
	AGENT_RUN_STATUS_OPTIONS,
	brandOption,
	limitOnly,
	locator,
	showFor,
} from '../shared/descriptions';
import { manyPiApiRequest, segment } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { asArray, parseJsonObjectParameter, prune } from '../shared/utils';

const RESOURCE = 'agentRun';
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

const agentRunLocator = (operation: string[], description: string) =>
	locator({
		displayName: 'Agent Run',
		name: 'agentRunId',
		noun: 'agent run',
		searchListMethod: 'searchAgentRuns',
		show: showFor(RESOURCE, operation),
		description,
	});

export const agentRunDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Cancel',
				value: 'cancel',
				action: 'Cancel an agent run',
				description: 'Stop an agent run now and free the parallel-run slot it holds',
			},
			{
				name: 'Create',
				value: 'create',
				action: 'Create an agent run',
				description:
					'Start the ManyPI agent on a goal written in plain language. The run continues in the background.',
			},
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete an agent run',
				description: 'Delete an agent run permanently, with its events and artifacts',
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get an agent run',
				description: 'Retrieve an agent run with its status, result and artifacts',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many agent runs',
				description: 'Retrieve a list of your most recent agent runs',
			},
			{
				name: 'Reply',
				value: 'reply',
				action: 'Reply to an agent run',
				description:
					'Answer a paused run so it resumes, or give a finished run a follow-up instruction',
			},
		],
		default: 'create',
	},

	// ── Create ────────────────────────────────────────────────────────────────
	{
		displayName: 'Goal',
		name: 'goal',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		placeholder: 'e.g. Find 25 DTC skincare brands in the UK that are hiring a head of growth',
		description:
			'What the agent should do, in plain language. If the goal is ambiguous the agent pauses and asks instead of guessing.',
		displayOptions: { show: showFor(RESOURCE, 'create') },
	},
	{
		displayName: 'Sources',
		name: 'sources',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Source',
		default: {},
		description: 'Material the agent should work from',
		displayOptions: { show: showFor(RESOURCE, 'create') },
		options: [
			{
				displayName: 'Source',
				name: 'source',
				values: [
					{
						displayName: 'Type',
						name: 'type',
						type: 'options',
						options: [
							{ name: 'Data Connection', value: 'data_connection' },
							{ name: 'File', value: 'file' },
							{ name: 'Scraper Run', value: 'scraper_run' },
							{ name: 'URL', value: 'url' },
						],
						default: 'url',
					},
					{
						displayName: 'URL',
						name: 'url',
						type: 'string',
						default: '',
						placeholder: 'e.g. https://example.com/pricing',
						displayOptions: { show: { type: ['url'] } },
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
						default: '',
						placeholder: 'e.g. b3c4d5e6-7f80-4912-a3b4-c5d6e7f8a901',
						description: 'The ID of the file, scraper run or data connection',
						displayOptions: { hide: { type: ['url'] } },
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
				displayName: 'Conversation ID',
				name: 'conversationId',
				type: 'string',
				default: '',
				description:
					'Attach the run to an existing conversation so it keeps that context. Leave empty to start fresh.',
			},
			{
				displayName: 'Max Pages',
				name: 'maxPages',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 500, numberPrecision: 0 },
				default: 50,
				description: 'The most pages the agent may visit',
			},
			{
				displayName: 'Max Steps',
				name: 'maxSteps',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 200, numberPrecision: 0 },
				default: 50,
				description: 'The most steps the agent may take',
			},
			{
				displayName: 'Output Schema',
				name: 'outputSchema',
				type: 'json',
				default: '{\n  "type": "object",\n  "properties": {}\n}',
				description:
					'A JSON Schema the result must follow, so later nodes always get the same shape',
			},
			{
				displayName: 'Playbook',
				name: 'playbook',
				type: 'string',
				default: '',
				placeholder: 'e.g. lead_generation',
				description: 'The slug of a playbook the run should follow',
			},
		],
	},

	// ── Get, Cancel, Delete, Reply ────────────────────────────────────────────
	agentRunLocator(['get'], 'The agent run to retrieve'),
	agentRunLocator(['cancel'], 'The agent run to stop'),
	agentRunLocator(['delete'], 'The agent run to delete, with its events and artifacts'),
	agentRunLocator(['reply'], 'The agent run to reply to'),
	{
		displayName: 'Message',
		name: 'message',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		placeholder: 'e.g. Only include brands that ship to the EU',
		description:
			'Your answer to a paused run, or the next instruction for a finished one, such as "find 25 more like those"',
		displayOptions: { show: showFor(RESOURCE, 'reply') },
	},
	{
		displayName: 'Interrupt Running Run',
		name: 'interrupt',
		type: 'boolean',
		default: false,
		description:
			'Whether to stop a run that is still working and start a new one with this message. When off, replying to a running run is refused.',
		displayOptions: { show: showFor(RESOURCE, 'reply') },
	},

	// ── Get Many ──────────────────────────────────────────────────────────────
	limitOnly(showFor(RESOURCE, 'getAll'), 100, 'ManyPI returns up to the 100 most recent runs.'),
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
				displayName: 'Conversation ID',
				name: 'conversationId',
				type: 'string',
				default: '',
				description: 'Only return runs in this conversation',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: AGENT_RUN_STATUS_OPTIONS,
				default: 'completed',
			},
		],
	},
];

function runId(this: IExecuteFunctions, i: number): string {
	return this.getNodeParameter('agentRunId', i, '', { extractValue: true }) as string;
}

export const agentRunHandlers: ResourceHandlers = {
	async create(i) {
		const goal = this.getNodeParameter('goal', i) as string;
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		const sourceRows =
			((this.getNodeParameter('sources', i, {}) as IDataObject).source as IDataObject[]) ?? [];

		const sources = sourceRows
			.map((row) =>
				row.type === 'url'
					? prune({ type: row.type, url: row.url })
					: prune({ type: row.type, id: row.id }),
			)
			.filter((source) => Object.keys(source).length > 1);

		const body = prune({
			goal,
			conversation_id: additional.conversationId,
			playbook: additional.playbook,
			max_steps: additional.maxSteps,
			max_pages: additional.maxPages,
			output_schema: parseJsonObjectParameter.call(
				this,
				additional.outputSchema,
				'Output Schema',
				i,
			),
			sources,
		});

		return (await manyPiApiRequest.call(this, 'POST', '/api/agents/runs', body, undefined, {
			itemIndex: i,
		})) as IDataObject;
	},

	async get(i) {
		return (await manyPiApiRequest.call(
			this,
			'GET',
			`/api/agents/runs/${segment(runId.call(this, i))}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'agent run' },
		)) as IDataObject;
	},

	async getAll(i) {
		const limit = this.getNodeParameter('limit', i) as number;
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const body = await manyPiApiRequest.call(
			this,
			'GET',
			'/api/agents/runs',
			undefined,
			{
				conversation_id: filters.conversationId,
				brand: filters.brand,
				// Status is filtered here, so fetch the full window first.
				limit: filters.status ? 100 : limit,
			},
			{ itemIndex: i },
		);
		const runs = asArray(body).filter((run) => !filters.status || run.status === filters.status);
		return runs.slice(0, limit);
	},

	async reply(i) {
		const body = {
			message: this.getNodeParameter('message', i) as string,
			interrupt: this.getNodeParameter('interrupt', i, false) as boolean,
		};
		return (await manyPiApiRequest.call(
			this,
			'POST',
			`/api/agents/runs/${segment(runId.call(this, i))}/reply`,
			body,
			undefined,
			{ itemIndex: i, resourceLabel: 'agent run' },
		)) as IDataObject;
	},

	async cancel(i) {
		const id = runId.call(this, i);
		const options = { itemIndex: i, resourceLabel: 'agent run' };
		// The cancel route answers ok for any ID and leaves finished runs alone,
		// so read the run first and report what actually happened.
		const run = (await manyPiApiRequest.call(
			this,
			'GET',
			`/api/agents/runs/${segment(id)}`,
			undefined,
			undefined,
			options,
		)) as IDataObject;
		const previousStatus = run.status;
		if (FINISHED_STATUSES.includes(String(previousStatus))) {
			return { id, cancelled: false, previousStatus };
		}
		await manyPiApiRequest.call(
			this,
			'POST',
			`/api/agents/runs/${segment(id)}/cancel`,
			undefined,
			undefined,
			options,
		);
		return { id, cancelled: true, previousStatus };
	},

	async delete(i) {
		const path = `/api/agents/runs/${segment(runId.call(this, i))}`;
		const options = { itemIndex: i, resourceLabel: 'agent run' };
		// The delete route answers ok whether or not the run existed.
		await manyPiApiRequest.call(this, 'GET', path, undefined, undefined, options);
		await manyPiApiRequest.call(this, 'DELETE', path, undefined, undefined, options);
		return { deleted: true };
	},
};
