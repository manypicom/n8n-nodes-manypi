import type { IDisplayOptions, INodeProperties } from 'n8n-workflow';

type Show = NonNullable<IDisplayOptions['show']>;

export const UUID_PLACEHOLDER = 'e.g. 9f1c2a44-0c3e-4b7a-8f61-2d5e8b9a1c33';

export function showFor(resource: string, operation: string | string[]): Show {
	return {
		resource: [resource],
		operation: Array.isArray(operation) ? operation : [operation],
	};
}

interface LocatorOptions {
	displayName: string;
	name: string;
	/** Lower-case noun for the list placeholder, e.g. "scraper". */
	noun: string;
	searchListMethod: string;
	show: Show;
	required?: boolean;
	description?: string;
	/** Label for the typed mode. Endpoints are invoked by slug rather than ID. */
	idLabel?: string;
	idPlaceholder?: string;
}

/** A record picker: "From List" by default, or an ID typed or mapped from an earlier node. */
export function locator(options: LocatorOptions): INodeProperties {
	return {
		displayName: options.displayName,
		name: options.name,
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: options.required ?? true,
		description: options.description,
		displayOptions: { show: options.show },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: `Select a ${options.noun}...`,
				typeOptions: {
					searchListMethod: options.searchListMethod,
					searchable: true,
				},
			},
			{
				displayName: options.idLabel ?? 'ID',
				name: 'id',
				type: 'string',
				placeholder: options.idPlaceholder ?? UUID_PLACEHOLDER,
			},
		],
	};
}

/** Return All plus Limit, for routes ManyPI can page through. */
export function returnAllAndLimit(show: Show): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: { show },
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 50,
			description: 'Max number of results to return',
			displayOptions: { show: { ...show, returnAll: [false] } },
		},
	];
}

/** Limit alone, for routes that only serve their most recent records. */
export function limitOnly(show: Show, maxValue: number, hint: string): INodeProperties {
	return {
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue },
		default: 50,
		description: 'Max number of results to return',
		hint,
		displayOptions: { show },
	};
}

export function simplifyField(show: Show): INodeProperties {
	return {
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description: 'Whether to return a simplified version of the response instead of the raw data',
		displayOptions: { show },
	};
}

export const brandOption: INodeProperties = {
	displayName: 'Brand',
	name: 'brand',
	type: 'string',
	default: '',
	placeholder: 'e.g. all',
	description:
		'Narrow the results to one brand by its ID, or enter "all" for the whole workspace. Leave empty to use your current brand.',
};

export const LEAD_STATUS_OPTIONS = [
	{ name: 'Contacted', value: 'contacted' },
	{ name: 'Disqualified', value: 'disqualified' },
	{ name: 'New', value: 'new' },
	{ name: 'Qualified', value: 'qualified' },
];

/** The list and export routes also accept two flags that behave like statuses. */
export const LEAD_FILTER_STATUS_OPTIONS = [
	{ name: 'Archived', value: 'archived' },
	{ name: 'Contacted', value: 'contacted' },
	{ name: 'Disqualified', value: 'disqualified' },
	{ name: 'New', value: 'new' },
	{ name: 'Qualified', value: 'qualified' },
	{ name: 'Unsubscribed', value: 'unsubscribed' },
];

export const REPLY_KIND_OPTIONS = [
	{ name: 'Auto-Reply', value: 'auto_reply' },
	{ name: 'Bounce', value: 'bounce' },
	{ name: 'Human Reply', value: 'reply' },
];

export const REPLY_SENTIMENT_OPTIONS = [
	{ name: 'Negative', value: 'negative' },
	{ name: 'Neutral', value: 'neutral' },
	{ name: 'Objection', value: 'objection' },
	{ name: 'Out of Office', value: 'ooo' },
	{ name: 'Positive', value: 'positive' },
	{ name: 'Referral', value: 'referral' },
	{ name: 'Unsubscribe Request', value: 'unsubscribe' },
];

export const AGENT_RUN_STATUS_OPTIONS = [
	{ name: 'Cancelled', value: 'cancelled' },
	{ name: 'Completed', value: 'completed' },
	{ name: 'Failed', value: 'failed' },
	{ name: 'Paused (Waiting for an Answer)', value: 'paused' },
	{ name: 'Planning', value: 'planning' },
	{ name: 'Queued', value: 'queued' },
	{ name: 'Running', value: 'running' },
];

export const SCRAPER_RUN_STATUS_OPTIONS = [
	{ name: 'Cancelled', value: 'cancelled' },
	{ name: 'Completed', value: 'completed' },
	{ name: 'Failed', value: 'failed' },
	{ name: 'Pending', value: 'pending' },
	{ name: 'Running', value: 'running' },
];

export const VERIFICATION_JOB_STATUS_OPTIONS = [
	{ name: 'Completed', value: 'completed' },
	{ name: 'Failed', value: 'failed' },
	{ name: 'Queued', value: 'queued' },
	{ name: 'Running', value: 'running' },
];

export const LEAD_SIMPLE_KEYS = [
	'id',
	'full_name',
	'email',
	'company',
	'title',
	'domain',
	'status',
	'score',
	'email_status',
	'created_at',
];

export const REPLY_SIMPLE_KEYS = [
	'id',
	'kind',
	'from_email',
	'from_name',
	'subject',
	'body_text',
	'sentiment',
	'campaign_id',
	'lead_id',
	'received_at',
];
