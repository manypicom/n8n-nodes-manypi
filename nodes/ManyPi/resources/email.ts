import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { locator, showFor } from '../shared/descriptions';
import { manyPiApiRequest } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { prune, toList } from '../shared/utils';

const RESOURCE = 'email';

const MERGE_HINT =
	'Merge variables such as {{first_name}}, {{company}}, {{title}}, {{domain}} and {{location}} are filled in from the lead.';

export const emailDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Draft With AI',
				value: 'draft',
				action: 'Draft an email with AI',
				description:
					'Write a cold email or a whole follow-up sequence from a brief. Nothing is saved or sent.',
			},
			{
				name: 'Send',
				value: 'send',
				action: 'Send an email',
				description:
					'Send one email now from a connected inbox, outside any sequence. Requires a paid plan.',
			},
		],
		default: 'send',
	},

	// ── Send ──────────────────────────────────────────────────────────────────
	locator({
		displayName: 'Sending Inbox',
		name: 'inboxId',
		noun: 'inbox',
		searchListMethod: 'searchInboxes',
		show: showFor(RESOURCE, 'send'),
		description: 'The connected inbox to send from',
	}),
	locator({
		displayName: 'Lead',
		name: 'leadId',
		noun: 'lead',
		searchListMethod: 'searchLeads',
		show: showFor(RESOURCE, 'send'),
		required: false,
		description:
			'The lead that supplies the merge variables and the default recipient, and gets marked as contacted. Required unless you set To under Additional Fields.',
	}),
	{
		displayName: 'Subject',
		name: 'subject',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Quick question, {{first_name}}',
		description: MERGE_HINT,
		displayOptions: { show: showFor(RESOURCE, 'send') },
	},
	{
		displayName: 'Body (HTML)',
		name: 'html',
		type: 'string',
		typeOptions: { rows: 6 },
		required: true,
		default: '',
		placeholder: 'e.g. <p>Hi {{first_name}},</p>',
		description:
			'Simple HTML: paragraphs, bold text and links. Merge variables such as {{first_name}} and {{company}} are filled in from the lead.',
		displayOptions: { show: showFor(RESOURCE, 'send') },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'send') },
		options: [
			{
				displayName: 'BCC',
				name: 'bcc',
				type: 'string',
				default: '',
				placeholder: 'e.g. nathan@example.com',
				description: 'Addresses separated by commas. At most 10 recipients in total.',
			},
			{
				displayName: 'CC',
				name: 'cc',
				type: 'string',
				default: '',
				placeholder: 'e.g. nathan@example.com',
				description: 'Addresses separated by commas. At most 10 recipients in total.',
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'string',
				default: '',
				placeholder: 'e.g. nathan@example.com',
				description: "The recipient. Defaults to the lead's address.",
			},
		],
	},

	// ── Draft ─────────────────────────────────────────────────────────────────
	{
		displayName: 'Brief',
		name: 'instructions',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		placeholder: 'e.g. Intro our product-video service to DTC skincare founders, friendly and short',
		description: 'What the email should say and who it is for',
		displayOptions: { show: showFor(RESOURCE, 'draft') },
	},
	{
		displayName: 'Output',
		name: 'mode',
		type: 'options',
		options: [
			{ name: 'Single Email', value: 'email' },
			{ name: 'Follow-Up Sequence', value: 'sequence' },
		],
		default: 'email',
		displayOptions: { show: showFor(RESOURCE, 'draft') },
	},
	{
		displayName: 'Number of Steps',
		name: 'steps',
		type: 'number',
		typeOptions: { minValue: 2, maxValue: 5, numberPrecision: 0 },
		default: 3,
		displayOptions: { show: { ...showFor(RESOURCE, 'draft'), mode: ['sequence'] } },
	},
	locator({
		displayName: 'Example Lead',
		name: 'exampleLeadId',
		noun: 'lead',
		searchListMethod: 'searchLeads',
		show: showFor(RESOURCE, 'draft'),
		required: false,
		description: 'A lead to tailor the draft to. Nothing is sent to them.',
	}),
];

export const emailHandlers: ResourceHandlers = {
	async send(i) {
		const leadId = this.getNodeParameter('leadId', i, '', { extractValue: true }) as string;
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		if (!leadId && !additional.to) {
			throw new NodeOperationError(this.getNode(), 'The email has no recipient', {
				itemIndex: i,
				description: 'Pick a Lead, or add To under Additional Fields.',
			});
		}
		const body = prune({
			smtp_config_id: this.getNodeParameter('inboxId', i, '', { extractValue: true }) as string,
			subject: this.getNodeParameter('subject', i) as string,
			html: this.getNodeParameter('html', i) as string,
			lead_id: leadId,
			to: additional.to,
			cc: toList(additional.cc),
			bcc: toList(additional.bcc),
		});
		return (await manyPiApiRequest.call(this, 'POST', '/api/outreach/send', body, undefined, {
			itemIndex: i,
			resourceLabel: 'lead or inbox',
		})) as IDataObject;
	},

	async draft(i) {
		const mode = this.getNodeParameter('mode', i) as string;
		const body = prune({
			instructions: this.getNodeParameter('instructions', i) as string,
			mode,
			steps: mode === 'sequence' ? (this.getNodeParameter('steps', i) as number) : undefined,
			lead_id: this.getNodeParameter('exampleLeadId', i, '', { extractValue: true }) as string,
		});
		return (await manyPiApiRequest.call(this, 'POST', '/api/outreach/generate', body, undefined, {
			itemIndex: i,
			resourceLabel: 'example lead',
		})) as IDataObject;
	},
};
