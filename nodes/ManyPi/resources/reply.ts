import type { IDataObject, IExecuteFunctions, INodeProperties, IPollFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	REPLY_KIND_OPTIONS,
	REPLY_SENTIMENT_OPTIONS,
	REPLY_SIMPLE_KEYS,
	locator,
	returnAllAndLimit,
	showFor,
	simplifyField,
} from '../shared/descriptions';
import { manyPiApiRequest } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { fetchOffsetPages, simplify } from '../shared/utils';

const RESOURCE = 'reply';

/**
 * On plans without reply intelligence ManyPI ignores the sentiment filter and
 * returns every reply, with `canSeeSentiment: false`. Passing those on would
 * route every reply as if it were, say, positive, so stop instead.
 */
export function assertSentimentAvailable(
	this: IExecuteFunctions | IPollFunctions,
	body: unknown,
	sentiment: unknown,
	itemIndex?: number,
): void {
	if (!sentiment || !body || typeof body !== 'object') return;
	if ((body as IDataObject).canSeeSentiment === false) {
		throw new NodeOperationError(this.getNode(), 'Your ManyPI plan does not include reply sentiment', {
			itemIndex,
			description:
				'ManyPI ignores the Sentiment filter on this plan and would return every reply. Remove the filter, or upgrade to a plan with reply intelligence.',
		});
	}
}

export const replyDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Get Insights',
				value: 'getInsights',
				action: 'Get reply insights',
				description:
					"Retrieve patterns across a campaign's replies with suggestions for what to change",
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many replies',
				description:
					'Retrieve what came back from your campaigns: human replies, auto-replies and bounces. Requires a paid plan.',
			},
		],
		default: 'getAll',
	},
	locator({
		displayName: 'Campaign',
		name: 'campaignId',
		noun: 'campaign',
		searchListMethod: 'searchCampaigns',
		show: showFor(RESOURCE, 'getInsights'),
		description: 'The campaign whose replies to analyse',
	}),
	...returnAllAndLimit(showFor(RESOURCE, 'getAll')),
	simplifyField(showFor(RESOURCE, 'getAll')),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'getAll') },
		options: [
			{
				displayName: 'Campaign ID',
				name: 'campaign',
				type: 'string',
				default: '',
				placeholder: 'e.g. 6b2f8e10-9a4d-4c58-b7e3-1f0a5c8d2e77',
			},
			{
				displayName: 'Sentiment',
				name: 'sentiment',
				type: 'options',
				options: REPLY_SENTIMENT_OPTIONS,
				default: 'positive',
				description: 'Sentiment analysis requires a Pro or Business plan',
			},
			{
				displayName: 'Type',
				name: 'kind',
				type: 'options',
				options: REPLY_KIND_OPTIONS,
				default: 'reply',
			},
		],
	},
];

export const replyHandlers: ResourceHandlers = {
	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const shouldSimplify = this.getNodeParameter('simplify', i, true) as boolean;
		const replies = await fetchOffsetPages.call(this, {
			path: '/api/outreach/replies',
			qs: { campaign: filters.campaign, kind: filters.kind, sentiment: filters.sentiment },
			key: 'replies',
			pageSize: 200,
			returnAll,
			limit,
			itemIndex: i,
			inspect: (body) => assertSentimentAvailable.call(this, body, filters.sentiment, i),
		});
		return shouldSimplify ? replies.map((reply) => simplify(reply, REPLY_SIMPLE_KEYS)) : replies;
	},

	async getInsights(i) {
		const campaign = this.getNodeParameter('campaignId', i, '', { extractValue: true }) as string;
		return (await manyPiApiRequest.call(
			this,
			'GET',
			'/api/outreach/insights',
			undefined,
			{ campaign },
			{ itemIndex: i, resourceLabel: 'campaign' },
		)) as IDataObject;
	},
};
