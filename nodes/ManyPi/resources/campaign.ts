import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { brandOption, locator, returnAllAndLimit, showFor } from '../shared/descriptions';
import { manyPiApiRequest, segment } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import {
	applyLimit,
	asArray,
	assertBatchSize,
	containsText,
	newestFirst,
	normalizeOutreachTotals,
	prune,
	toList,
	totalSkipped,
} from '../shared/utils';

const RESOURCE = 'campaign';
const MAX_ENROLL = 1000;

const campaignLocator = (operation: string[], description: string) =>
	locator({
		displayName: 'Campaign',
		name: 'campaignId',
		noun: 'campaign',
		searchListMethod: 'searchCampaigns',
		show: showFor(RESOURCE, operation),
		description,
	});

const leadIdsField = (operation: string, description: string): INodeProperties => ({
	displayName: 'Lead IDs',
	name: 'leadIds',
	type: 'string',
	required: true,
	default: '',
	placeholder: 'e.g. d4e7f1a2-8b30-4c95-a1d6-5f2e9c8b7a04, 1b2c3d4e-...',
	description,
	displayOptions: { show: showFor(RESOURCE, operation) },
});

const INBOX_STRATEGY_OPTIONS = [
	{ name: 'Match Recipient Provider', value: 'provider_match' },
	{ name: 'Rotate', value: 'rotate' },
	{ name: 'Round Robin', value: 'round_robin' },
	{ name: 'Single Inbox', value: 'single' },
];

export const campaignDescription: INodeProperties[] = [
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
				action: 'Create a campaign',
				description:
					'Bind a sequence to a sending inbox. Nothing is sent until you enroll leads.',
			},
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete a campaign',
				description: 'Delete a campaign permanently, with its sending history',
			},
			{
				name: 'Enroll Leads',
				value: 'enrollLeads',
				action: 'Enroll leads in a campaign',
				description:
					'Queue the campaign sequence for real sending to up to 1,000 leads, within the inbox warmup and daily caps',
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get a campaign',
				description:
					'Retrieve a campaign with its stats, per-step breakdown and enrolled leads',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many campaigns',
				description: 'Retrieve a list of campaigns with their stats',
			},
			{
				name: 'Get Stats',
				value: 'getStats',
				action: 'Get outreach stats across campaigns',
				description:
					'Retrieve 14 days of sending activity across every campaign: sends, opens, replies, bounces and unsubscribes',
			},
			{
				name: 'Remove Leads',
				value: 'removeLeads',
				action: 'Remove leads from a campaign',
				description:
					'Cancel the remaining sequence steps for these leads. Emails already sent are not recalled.',
			},
			{
				name: 'Update',
				value: 'update',
				action: 'Update a campaign',
				description: 'Pause, resume or archive a campaign, or change its settings',
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
		placeholder: 'e.g. Q3 agency outreach',
		displayOptions: { show: showFor(RESOURCE, 'create') },
	},
	locator({
		displayName: 'Sequence',
		name: 'sequenceId',
		noun: 'sequence',
		searchListMethod: 'searchSequences',
		show: showFor(RESOURCE, 'create'),
		description: 'The email steps this campaign sends',
	}),
	locator({
		displayName: 'Sending Inbox',
		name: 'inboxId',
		noun: 'inbox',
		searchListMethod: 'searchInboxes',
		show: showFor(RESOURCE, 'create'),
		description: 'The connected inbox to send from. Its warmup-aware daily cap always applies.',
	}),
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'create') },
		options: [
			{
				displayName: 'Daily Limit',
				name: 'dailyLimit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 2000, numberPrecision: 0 },
				default: 50,
				description:
					"How many emails a day this campaign may send. It never exceeds the inbox's own cap.",
			},
			{
				displayName: 'Inbox Strategy',
				name: 'inboxStrategy',
				type: 'options',
				options: INBOX_STRATEGY_OPTIONS,
				default: 'single',
			},
			{
				displayName: 'Priority',
				name: 'priority',
				type: 'number',
				typeOptions: { numberPrecision: 0 },
				default: 5,
				description: 'When campaigns share an inbox, the higher priority gets the next send slot',
			},
			{
				displayName: 'Reply-To',
				name: 'replyTo',
				type: 'string',
				placeholder: 'e.g. nathan@example.com',
				default: '',
				description: 'Where replies should land. Defaults to the inbox address.',
			},
			{
				displayName: 'Schedule Enabled',
				name: 'scheduleEnabled',
				type: 'boolean',
				default: true,
				description: 'Whether to send only within the days and hours set in this campaign',
			},
			{
				displayName: 'Send Days',
				name: 'sendDays',
				type: 'multiOptions',
				options: [
					{ name: 'Friday', value: 5 },
					{ name: 'Monday', value: 1 },
					{ name: 'Saturday', value: 6 },
					{ name: 'Sunday', value: 0 },
					{ name: 'Thursday', value: 4 },
					{ name: 'Tuesday', value: 2 },
					{ name: 'Wednesday', value: 3 },
				],
				default: [1, 2, 3, 4, 5],
				description: 'The weekdays to send on',
			},
			{
				displayName: 'Send From',
				name: 'sendFrom',
				type: 'string',
				default: '09:00',
				placeholder: 'e.g. 09:00',
				description: 'The earliest local send time, as HH:MM in the campaign timezone',
			},
			{
				displayName: 'Send Until',
				name: 'sendTo',
				type: 'string',
				default: '17:00',
				placeholder: 'e.g. 17:00',
				description: 'The latest local send time, as HH:MM in the campaign timezone',
			},
			{
				displayName: 'Timezone',
				name: 'timezone',
				type: 'string',
				default: '',
				placeholder: 'e.g. America/New_York',
				description: 'An IANA timezone name',
			},
			{
				displayName: 'Track Opens',
				name: 'trackOpens',
				type: 'boolean',
				default: false,
				description: 'Whether to add an open-tracking pixel to each email',
			},
		],
	},

	// ── Get, Delete, Update, Enroll, Remove ───────────────────────────────────
	campaignLocator(['get'], 'The campaign to retrieve'),
	campaignLocator(['delete'], 'The campaign to delete, with its history'),
	campaignLocator(['update'], 'The campaign to update'),
	campaignLocator(['enrollLeads'], 'The campaign to enroll the leads in'),
	campaignLocator(['removeLeads'], 'The campaign to remove the leads from'),
	leadIdsField(
		'enrollLeads',
		'Up to 1,000 lead IDs, separated by commas. Leads with no email, already enrolled, or suppressed are skipped rather than failed.',
	),
	leadIdsField('removeLeads', 'The lead IDs whose remaining steps should be cancelled'),
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'update') },
		options: [
			{
				displayName: 'Daily Limit',
				name: 'dailyLimit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 2000, numberPrecision: 0 },
				default: 50,
			},
			{
				displayName: 'Inbox Strategy',
				name: 'inboxStrategy',
				type: 'options',
				options: INBOX_STRATEGY_OPTIONS,
				default: 'single',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
			},
			{
				displayName: 'Priority',
				name: 'priority',
				type: 'number',
				typeOptions: { numberPrecision: 0 },
				default: 5,
				description: 'When campaigns share an inbox, the higher priority gets the next send slot',
			},
			{
				displayName: 'Reply-To',
				name: 'replyTo',
				type: 'string',
				placeholder: 'e.g. nathan@example.com',
				default: '',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: [
					{
						name: 'Active',
						value: 'active',
						description: 'Resume sending',
					},
					{
						name: 'Archived',
						value: 'archived',
						description: 'Stop sending and hide the campaign, keeping its history',
					},
					{
						name: 'Paused',
						value: 'paused',
						description: 'Stop sending and keep every lead where it is',
					},
				],
				default: 'paused',
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
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: [
					{ name: 'Active', value: 'active' },
					{ name: 'Archived', value: 'archived' },
					{ name: 'Paused', value: 'paused' },
				],
				default: 'active',
			},
		],
	},

	// ── Get Stats ─────────────────────────────────────────────────────────────
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'getStats') },
		options: [brandOption],
	},
];

function campaignId(this: IExecuteFunctions, i: number): string {
	return this.getNodeParameter('campaignId', i, '', { extractValue: true }) as string;
}

// The same pattern ManyPI checks against. It drops a send time that does not
// match without saying so, which would leave the campaign on its default hours.
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Stop on send times and timezones ManyPI would silently ignore. */
function assertSchedule(this: IExecuteFunctions, fields: IDataObject, i: number): void {
	for (const [name, label] of [
		['sendFrom', 'Send From'],
		['sendTo', 'Send Until'],
	]) {
		const value = fields[name];
		if (value !== undefined && value !== '' && !HHMM.test(String(value))) {
			throw new NodeOperationError(this.getNode(), `"${label}" is not a time ManyPI understands`, {
				itemIndex: i,
				description: 'Use 24-hour HH:MM, e.g. 09:00 or 17:30.',
			});
		}
	}
	if (fields.timezone) {
		try {
			new Intl.DateTimeFormat('en-US', { timeZone: String(fields.timezone) });
		} catch {
			throw new NodeOperationError(this.getNode(), `"${fields.timezone}" is not a timezone ManyPI understands`, {
				itemIndex: i,
				description: 'Use an IANA timezone name such as America/New_York or Europe/London.',
			});
		}
	}
}

export const campaignHandlers: ResourceHandlers = {
	async create(i) {
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		assertSchedule.call(this, additional, i);
		const body = prune({
			name: this.getNodeParameter('name', i) as string,
			sequence_id: this.getNodeParameter('sequenceId', i, '', { extractValue: true }) as string,
			smtp_config_id: this.getNodeParameter('inboxId', i, '', { extractValue: true }) as string,
			reply_to: additional.replyTo,
			daily_limit: additional.dailyLimit,
			schedule_enabled: additional.scheduleEnabled,
			send_days: additional.sendDays,
			send_from: additional.sendFrom,
			send_to: additional.sendTo,
			timezone: additional.timezone,
			track_opens: additional.trackOpens,
			priority: additional.priority,
			inbox_strategy: additional.inboxStrategy,
		});
		const data = (await manyPiApiRequest.call(this, 'POST', '/api/outreach/campaigns', body, undefined, {
			itemIndex: i,
			resourceLabel: 'sequence or inbox',
		})) as IDataObject;
		return (data.campaign ?? data) as IDataObject;
	},

	async delete(i) {
		const id = campaignId.call(this, i);
		const options = { itemIndex: i, resourceLabel: 'campaign' };
		// The delete route answers ok for a campaign that does not exist, so
		// check first: a mistyped ID should fail, not report a deletion.
		await manyPiApiRequest.call(this, 'GET', `/api/outreach/campaigns/${segment(id)}`, undefined, undefined, options);
		await manyPiApiRequest.call(this, 'DELETE', '/api/outreach/campaigns', undefined, { id }, options);
		return { deleted: true };
	},

	async enrollLeads(i) {
		const leadIds = toList(this.getNodeParameter('leadIds', i));
		assertBatchSize.call(this, leadIds, MAX_ENROLL, 'lead IDs', i);
		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/outreach/enroll',
			{ campaign_id: campaignId.call(this, i), lead_ids: leadIds },
			undefined,
			{ itemIndex: i, resourceLabel: 'campaign' },
		)) as IDataObject;

		// Skips come back as one counter per reason. Total them so a workflow can
		// branch on one number, and keep the breakdown next to it.
		return { ...data, submitted: leadIds.length, skipped: totalSkipped(data) };
	},

	async get(i) {
		const data = (await manyPiApiRequest.call(
			this,
			'GET',
			`/api/outreach/campaigns/${segment(campaignId.call(this, i))}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'campaign' },
		)) as IDataObject;
		const campaign = (data.campaign ?? {}) as IDataObject;
		return {
			...campaign,
			stats: data.stats ?? campaign.stats,
			perStep: data.perStep ?? data.steps,
			leads: data.leads ?? data.enrollments,
		};
	},

	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const body = await manyPiApiRequest.call(
			this,
			'GET',
			'/api/outreach/campaigns',
			undefined,
			{ brand: filters.brand },
			{ itemIndex: i },
		);
		const campaigns = newestFirst(asArray(body, 'campaigns'), 'created_at').filter(
			(campaign) =>
				(!filters.status || campaign.status === filters.status) &&
				(!filters.name || containsText(campaign.name, filters.name as string)),
		);
		return applyLimit(campaigns, returnAll, limit);
	},

	async getStats(i) {
		const options = this.getNodeParameter('options', i, {}) as IDataObject;
		const data = (await manyPiApiRequest.call(
			this,
			'GET',
			'/api/outreach/stats',
			undefined,
			{ brand: options.brand },
			{ itemIndex: i },
		)) as IDataObject;
		return {
			...normalizeOutreachTotals((data.totals ?? {}) as IDataObject),
			days: data.days,
		};
	},

	async removeLeads(i) {
		const leadIds = toList(this.getNodeParameter('leadIds', i));
		assertBatchSize.call(this, leadIds, MAX_ENROLL, 'lead IDs', i);
		const data = (await manyPiApiRequest.call(
			this,
			'DELETE',
			'/api/outreach/enroll',
			undefined,
			// This route takes its arguments as query parameters, with the IDs
			// joined by commas rather than repeated.
			{ campaign_id: campaignId.call(this, i), lead_ids: leadIds.join(',') },
			{ itemIndex: i, resourceLabel: 'campaign' },
		)) as IDataObject;
		// `removed` counts cancelled enrollments, which is lower than the number
		// submitted when some leads had already finished the sequence.
		return { removed: 0, ...data, submitted: leadIds.length };
	},

	async update(i) {
		const id = campaignId.call(this, i);
		const fields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
		const changes = prune({
			status: fields.status,
			name: fields.name,
			reply_to: fields.replyTo,
			daily_limit: fields.dailyLimit,
			priority: fields.priority,
			inbox_strategy: fields.inboxStrategy,
		});
		if (Object.keys(changes).length === 0) {
			throw new NodeOperationError(this.getNode(), 'No fields to update were set', {
				itemIndex: i,
				description: 'Add at least one field under Update Fields, such as Status.',
			});
		}
		const data = (await manyPiApiRequest.call(
			this,
			'PATCH',
			'/api/outreach/campaigns',
			{ id, ...changes },
			undefined,
			{ itemIndex: i, resourceLabel: 'campaign' },
		)) as IDataObject;
		return ((data && data.campaign) ?? data) as IDataObject;
	},
};
