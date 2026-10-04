import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { accountDescription, accountHandlers } from './resources/account';
import { agentRunDescription, agentRunHandlers } from './resources/agentRun';
import { campaignDescription, campaignHandlers } from './resources/campaign';
import { emailDescription, emailHandlers } from './resources/email';
import {
	emailVerificationDescription,
	emailVerificationHandlers,
} from './resources/emailVerification';
import { endpointDescription, endpointHandlers } from './resources/endpoint';
import { inboxDescription, inboxHandlers } from './resources/inbox';
import { leadDescription, leadHandlers } from './resources/lead';
import { leadColumnDescription, leadColumnHandlers } from './resources/leadColumn';
import { leadSearchDescription, leadSearchHandlers } from './resources/leadSearch';
import { replyDescription, replyHandlers } from './resources/reply';
import { scraperDescription, scraperHandlers } from './resources/scraper';
import { scraperRunDescription, scraperRunHandlers } from './resources/scraperRun';
import { sequenceDescription, sequenceHandlers } from './resources/sequence';
import { skillDescription, skillHandlers } from './resources/skill';
import { suppressionDescription, suppressionHandlers } from './resources/suppression';
import * as listSearch from './shared/listSearch';
import type { ResourceHandlers } from './shared/types';
import { isExecutionData } from './shared/types';

const handlers: Record<string, ResourceHandlers> = {
	account: accountHandlers,
	agentRun: agentRunHandlers,
	campaign: campaignHandlers,
	email: emailHandlers,
	emailVerification: emailVerificationHandlers,
	endpoint: endpointHandlers,
	inbox: inboxHandlers,
	lead: leadHandlers,
	leadColumn: leadColumnHandlers,
	leadSearch: leadSearchHandlers,
	reply: replyHandlers,
	scraper: scraperHandlers,
	scraperRun: scraperRunHandlers,
	sequence: sequenceHandlers,
	skill: skillHandlers,
	suppression: suppressionHandlers,
};

export class ManyPi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ManyPI',
		name: 'manyPi',
		icon: { light: 'file:../../icons/manypi.svg', dark: 'file:../../icons/manypi.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Run scrapers and AI agents, find and verify leads, and send cold email outreach with ManyPI',
		defaults: {
			name: 'ManyPI',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
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
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Agent Run', value: 'agentRun' },
					{ name: 'Campaign', value: 'campaign' },
					{ name: 'Email', value: 'email' },
					{ name: 'Email Verification', value: 'emailVerification' },
					{ name: 'Endpoint', value: 'endpoint' },
					{ name: 'Inbox', value: 'inbox' },
					{ name: 'Lead', value: 'lead' },
					{ name: 'Lead Column', value: 'leadColumn' },
					{ name: 'Lead Search', value: 'leadSearch' },
					{ name: 'Reply', value: 'reply' },
					{ name: 'Scraper', value: 'scraper' },
					{ name: 'Scraper Run', value: 'scraperRun' },
					{ name: 'Sequence', value: 'sequence' },
					{ name: 'Skill', value: 'skill' },
					{ name: 'Suppression', value: 'suppression' },
				],
				default: 'scraper',
			},
			...accountDescription,
			...agentRunDescription,
			...campaignDescription,
			...emailDescription,
			...emailVerificationDescription,
			...endpointDescription,
			...inboxDescription,
			...leadDescription,
			...leadColumnDescription,
			...leadSearchDescription,
			...replyDescription,
			...scraperDescription,
			...scraperRunDescription,
			...sequenceDescription,
			...skillDescription,
			...suppressionDescription,
		],
	};

	methods = {
		listSearch: {
			searchAgentRuns: listSearch.searchAgentRuns,
			searchCampaigns: listSearch.searchCampaigns,
			searchEndpoints: listSearch.searchEndpoints,
			searchEndpointSlugs: listSearch.searchEndpointSlugs,
			searchInboxes: listSearch.searchInboxes,
			searchLeads: listSearch.searchLeads,
			searchSavedLeadSearches: listSearch.searchSavedLeadSearches,
			searchScraperRuns: listSearch.searchScraperRuns,
			searchScrapers: listSearch.searchScrapers,
			searchSequences: listSearch.searchSequences,
			searchVerificationJobs: listSearch.searchVerificationJobs,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const handler = handlers[resource]?.[operation];
		if (!handler) {
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not available for "${resource}"`,
				{ description: 'Pick the operation again from the list, then run the node.' },
			);
		}

		for (let i = 0; i < items.length; i++) {
			try {
				const result = await handler.call(this, i);
				if (isExecutionData(result)) {
					returnData.push({ ...result, pairedItem: { item: i } });
					continue;
				}
				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(result),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// A NodeApiError already carries the HTTP status and the item index;
				// wrapping it again would hide both. Anything else gets wrapped.
				throw error instanceof NodeApiError
					? error
					: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
