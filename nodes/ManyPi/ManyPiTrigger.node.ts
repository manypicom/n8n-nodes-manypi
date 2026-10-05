import type {
	IDataObject,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	AGENT_RUN_STATUS_OPTIONS,
	LEAD_FILTER_STATUS_OPTIONS,
	REPLY_SENTIMENT_OPTIONS,
	SCRAPER_RUN_STATUS_OPTIONS,
	VERIFICATION_JOB_STATUS_OPTIONS,
	brandOption,
	locator,
} from './shared/descriptions';
import { assertSentimentAvailable } from './resources/reply';
import { searchCampaigns, searchScrapers } from './shared/listSearch';
import { manyPiApiRequest } from './shared/transport';
import { asArray, newestFirst, normalizeScraperRun } from './shared/utils';

/** How many already-emitted IDs to remember. Far more than any one poll can return. */
const MAX_SEEN = 2000;

interface PollState {
	/** The event and filters the seen IDs belong to. A change starts over. */
	key?: string;
	seen?: string[];
}

const forEvent = (event: string) => ({ show: { event: [event] } });

const statusesParameter = (
	event: string,
	options: Array<{ name: string; value: string }>,
	description: string,
): INodeProperties => ({
	displayName: 'Statuses',
	name: 'statuses',
	type: 'multiOptions',
	options,
	default: ['completed'],
	description,
	displayOptions: forEvent(event),
});

export class ManyPiTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ManyPI Trigger',
		name: 'manyPiTrigger',
		icon: { light: 'file:../../icons/manypi.svg', dark: 'file:../../icons/manypi.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description:
			'Starts the workflow when ManyPI saves a lead, a campaign gets a reply, or a run finishes',
		defaults: {
			name: 'ManyPI Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'manyPiApi',
				required: true,
				displayOptions: { show: { authentication: ['apiKey'] } },
			},
			{
				name: 'manyPiOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['oAuth2'] } },
			},
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: [
					{ name: 'API Key', value: 'apiKey' },
					{ name: 'OAuth2', value: 'oAuth2' },
				],
				default: 'apiKey',
			},
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				required: true,
				options: [
					{
						name: 'Agent Run Reached Status',
						value: 'agentRun',
						description:
							'Triggers when an agent run reaches a chosen status, such as completed, or paused with a question',
					},
					{
						name: 'Email Verification Reached Status',
						value: 'emailVerification',
						description: 'Triggers when an email verification job reaches a chosen status',
					},
					{
						name: 'New Campaign',
						value: 'campaign',
						description: 'Triggers when an outreach campaign is created',
					},
					{
						name: 'New Lead',
						value: 'lead',
						description: 'Triggers when a lead is saved to your workspace',
					},
					{
						name: 'New Reply',
						value: 'reply',
						description: 'Triggers when a campaign gets a reply, an auto-reply or a bounce',
					},
					{
						name: 'Scraper Run Reached Status',
						value: 'scraperRun',
						description:
							'Triggers when a scraper run reaches a chosen status, so its data is ready to use',
					},
				],
				default: 'lead',
			},

			// ── Scraper run ─────────────────────────────────────────────────────
			statusesParameter(
				'scraperRun',
				SCRAPER_RUN_STATUS_OPTIONS,
				'Fire when a run reaches one of these. Keep Completed so the data exists when the workflow starts: a run keeps its ID from queued to done, so it fires only once.',
			),
			locator({
				displayName: 'Scraper',
				name: 'scraperId',
				noun: 'scraper',
				searchListMethod: 'searchScrapers',
				show: { event: ['scraperRun'] },
				required: false,
				description: 'Only fire for runs of this scraper. Leave empty for every scraper.',
			}),

			// ── Agent run ───────────────────────────────────────────────────────
			statusesParameter(
				'agentRun',
				AGENT_RUN_STATUS_OPTIONS,
				'Fire when a run reaches one of these. Add Paused to hear when the agent needs an answer; reply with the ManyPI node.',
			),
			{
				displayName: 'Filters',
				name: 'agentRunFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: forEvent('agentRun'),
				options: [
					brandOption,
					{
						displayName: 'Conversation ID',
						name: 'conversationId',
						type: 'string',
						default: '',
						description: 'Only fire for runs in this conversation',
					},
				],
			},

			// ── Email verification ──────────────────────────────────────────────
			statusesParameter(
				'emailVerification',
				VERIFICATION_JOB_STATUS_OPTIONS,
				'Fire when a job reaches one of these',
			),

			// ── Lead ────────────────────────────────────────────────────────────
			{
				displayName: 'Filters',
				name: 'leadFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: forEvent('lead'),
				options: [
					brandOption,
					{
						displayName: 'Lead Search ID',
						name: 'campaign',
						type: 'string',
						default: '',
						placeholder: 'e.g. 5f6a7b8c-9d0e-4f12-a3b4-c5d6e7f8a9b0',
						description: 'Only fire for leads found by this lead search, using its run ID',
					},
					{
						displayName: 'Search',
						name: 'q',
						type: 'string',
						default: '',
						description: 'Text to match in the company, full name, email or domain',
					},
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						options: LEAD_FILTER_STATUS_OPTIONS,
						default: 'new',
					},
				],
			},

			// ── Reply ───────────────────────────────────────────────────────────
			{
				displayName: 'Type',
				name: 'kind',
				type: 'options',
				options: [
					{ name: 'All', value: '' },
					{ name: 'Auto-Reply', value: 'auto_reply' },
					{ name: 'Bounce', value: 'bounce' },
					{ name: 'Human Reply', value: 'reply' },
				],
				default: 'reply',
				description: 'Keep Human Reply to ignore bounces and out-of-office noise',
				displayOptions: forEvent('reply'),
			},
			locator({
				displayName: 'Campaign',
				name: 'campaignId',
				noun: 'campaign',
				searchListMethod: 'searchCampaigns',
				show: { event: ['reply'] },
				required: false,
				description: 'Only fire for replies to this campaign. Leave empty for every campaign.',
			}),
			{
				displayName: 'Filters',
				name: 'replyFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: forEvent('reply'),
				options: [
					{
						displayName: 'Sentiment',
						name: 'sentiment',
						type: 'options',
						options: REPLY_SENTIMENT_OPTIONS,
						default: 'positive',
						description:
							'Only fire for replies with this sentiment, such as Positive to route interested leads to your CRM. Requires a Pro or Business plan.',
					},
				],
			},

			// ── Campaign ────────────────────────────────────────────────────────
			{
				displayName: 'Filters',
				name: 'campaignFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: forEvent('campaign'),
				options: [brandOption],
			},
		],
	};

	methods = {
		listSearch: {
			searchCampaigns,
			searchScrapers,
		},
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const event = this.getNodeParameter('event') as string;
		const { records, filterKey, byStatus } = await fetchRecords.call(this, event);
		// Status events keep one ID from queued to done, so remember the pair.
		// A run that pauses with a question and later completes then fires for
		// both, once each.
		const identity = (record: IDataObject) =>
			byStatus ? `${record.id}:${record.status}` : String(record.id);

		// A manual test shows the newest match without touching what the active
		// workflow has already seen.
		if (this.getMode() === 'manual') {
			return records.length ? [this.helpers.returnJsonArray(records.slice(0, 1))] : null;
		}

		const state = this.getWorkflowStaticData('node') as PollState;
		const key = JSON.stringify({ event, ...filterKey });
		const ids = records.map(identity);

		// First poll, or the event or filters changed: remember what exists now
		// without firing, so activating a workflow never replays the backlog.
		if (state.key !== key || !Array.isArray(state.seen)) {
			state.key = key;
			state.seen = ids.slice(0, MAX_SEEN);
			return null;
		}

		const seen = new Set(state.seen);
		const fresh = records.filter((record) => !seen.has(identity(record)));
		if (!fresh.length) return null;

		state.seen = [...fresh.map(identity), ...state.seen].slice(0, MAX_SEEN);
		// Oldest first, so the workflow handles them in the order they happened.
		return [this.helpers.returnJsonArray(fresh.reverse())];
	}
}

async function fetchRecords(
	this: IPollFunctions,
	event: string,
): Promise<{ records: IDataObject[]; filterKey: IDataObject; byStatus: boolean }> {
	let records: IDataObject[];
	let filterKey: IDataObject;
	const byStatus = ['scraperRun', 'agentRun', 'emailVerification'].includes(event);

	switch (event) {
		case 'scraperRun': {
			const statuses = this.getNodeParameter('statuses', []) as string[];
			const scraperId = this.getNodeParameter('scraperId', '', { extractValue: true }) as string;
			const body = await manyPiApiRequest.call(this, 'GET', '/api/runs', undefined, {
				limit: 100,
				offset: 0,
			});
			records = asArray(body)
				.map(normalizeScraperRun)
				.filter(
					(run) =>
						(!statuses.length || statuses.includes(String(run.status))) &&
						(!scraperId || run.scraper_id === scraperId),
				);
			filterKey = { statuses, scraperId };
			break;
		}

		case 'agentRun': {
			const statuses = this.getNodeParameter('statuses', []) as string[];
			const filters = this.getNodeParameter('agentRunFilters', {}) as IDataObject;
			const body = await manyPiApiRequest.call(this, 'GET', '/api/agents/runs', undefined, {
				limit: 100,
				conversation_id: filters.conversationId,
				brand: filters.brand,
			});
			records = newestFirst(asArray(body), 'created_at').filter(
				(run) => !statuses.length || statuses.includes(String(run.status)),
			);
			filterKey = { statuses, ...filters };
			break;
		}

		case 'emailVerification': {
			const statuses = this.getNodeParameter('statuses', []) as string[];
			const body = await manyPiApiRequest.call(this, 'GET', '/api/leads/validate', undefined, {
				limit: 50,
			});
			records = newestFirst(asArray(body, 'jobs'), 'created_at').filter(
				(job) => !statuses.length || statuses.includes(String(job.status)),
			);
			filterKey = { statuses };
			break;
		}

		case 'lead': {
			const filters = this.getNodeParameter('leadFilters', {}) as IDataObject;
			const body = (await manyPiApiRequest.call(this, 'GET', '/api/leads', undefined, {
				q: filters.q,
				status: filters.status,
				campaign: filters.campaign,
				brand: filters.brand,
				// The largest page the route serves, which covers two full lead
				// searches landing between polls.
				limit: 500,
				offset: 0,
			})) as IDataObject;
			if (body?.billingLock) {
				throw new NodeOperationError(this.getNode(), 'This ManyPI workspace is locked for billing', {
					description:
						'ManyPI hides lead data until the subscription is active again. Resubscribe under Billing in the ManyPI dashboard.',
				});
			}
			records = newestFirst(asArray(body, 'leads'), 'created_at');
			filterKey = { ...filters };
			break;
		}

		case 'reply': {
			const kind = this.getNodeParameter('kind', '') as string;
			const campaignId = this.getNodeParameter('campaignId', '', { extractValue: true }) as string;
			const filters = this.getNodeParameter('replyFilters', {}) as IDataObject;
			const body = await manyPiApiRequest.call(this, 'GET', '/api/outreach/replies', undefined, {
				kind,
				campaign: campaignId,
				sentiment: filters.sentiment,
				limit: 200,
				offset: 0,
			});
			assertSentimentAvailable.call(this, body, filters.sentiment);
			records = newestFirst(asArray(body, 'replies'), 'received_at', 'created_at');
			filterKey = { kind, campaignId, ...filters };
			break;
		}

		case 'campaign': {
			const filters = this.getNodeParameter('campaignFilters', {}) as IDataObject;
			const body = await manyPiApiRequest.call(this, 'GET', '/api/outreach/campaigns', undefined, {
				brand: filters.brand,
			});
			records = newestFirst(asArray(body, 'campaigns'), 'created_at');
			filterKey = { ...filters };
			break;
		}

		default:
			throw new NodeOperationError(this.getNode(), `The event "${event}" is not available`, {
				description: 'Pick the event again from the list, then save the workflow.',
			});
	}

	// Deduplication depends on a stable ID. A record without one would be
	// reported as new on every poll, so leave it out instead.
	return {
		records: records.filter((record) => record.id !== undefined && record.id !== null),
		filterKey,
		byStatus,
	};
}
