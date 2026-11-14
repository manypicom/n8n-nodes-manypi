import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { locator, returnAllAndLimit, showFor } from '../shared/descriptions';
import { manyPiApiRequest, segment } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { applyLimit, asArray, containsText, prune } from '../shared/utils';

const RESOURCE = 'form';
/** The largest page GET /api/forms/{id}/responses serves. */
const RESPONSE_PAGE = 200;

export const FORM_RESPONSE_STATUS_OPTIONS = [
	{ name: 'All but Spam', value: 'all', description: 'Finished, unfinished and held responses' },
	{ name: 'Completed', value: 'completed', description: 'Finished responses' },
	{
		name: 'Held',
		value: 'held',
		description: 'Over the monthly limit. Their answers stay hidden until you upgrade or the month turns.',
	},
	{ name: 'Spam', value: 'spam' },
	{ name: 'Unfinished', value: 'partial', description: 'Started but not submitted. Pro and Business.' },
];

const formLocator = (operation: string[], description: string) =>
	locator({
		displayName: 'Form',
		name: 'formId',
		noun: 'form',
		searchListMethod: 'searchForms',
		show: showFor(RESOURCE, operation),
		description,
		idLabel: 'ID or Key',
		idPlaceholder: 'e.g. demo-request',
	});

export const formDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Close',
				value: 'close',
				action: 'Close a form',
				description: 'Stop a live form from taking responses. Its link shows a closed page.',
			},
			{
				name: 'Create',
				value: 'create',
				action: 'Create a form',
				description: 'Create a form, blank or from a template, and optionally publish it',
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get a form',
				description: 'Retrieve a form with its link, questions and settings',
			},
			{
				name: 'Get Analytics',
				value: 'getAnalytics',
				action: 'Get form analytics',
				description: 'Retrieve views, starts, completions, drop-off per question and sources',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many forms',
				description: 'Retrieve your forms with their links and response totals',
			},
			{
				name: 'Get Responses',
				value: 'getResponses',
				action: 'Get form responses',
				description: 'Retrieve the responses to a form, newest first, with each answer as a field',
			},
			{
				name: 'Publish',
				value: 'publish',
				action: 'Publish a form',
				description: 'Make the current draft the live version of the form',
			},
			{
				name: 'Reopen',
				value: 'reopen',
				action: 'Reopen a form',
				description: 'Let a closed form take responses again',
			},
		],
		default: 'getResponses',
	},

	// ── Create ────────────────────────────────────────────────────────────────
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Demo request',
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
				displayName: 'Brand ID',
				name: 'brandId',
				type: 'string',
				default: '',
				description: 'The brand the form belongs to. Defaults to your current brand.',
			},
			{
				displayName: 'Key',
				name: 'key',
				type: 'string',
				default: '',
				placeholder: 'e.g. demo-request',
				description:
					'A stable name to find the form by in later calls: lowercase letters, numbers and dashes',
			},
			{
				displayName: 'Publish',
				name: 'publish',
				type: 'boolean',
				default: false,
				description: 'Whether to publish the form right away so its link takes responses',
			},
			{
				displayName: 'Template',
				name: 'template',
				type: 'string',
				default: '',
				placeholder: 'e.g. demo-request',
				description:
					'The slug of a template from the ManyPI form library. Leave empty for a blank form.',
			},
		],
	},

	// ── Every operation on one form ───────────────────────────────────────────
	formLocator(['get'], 'The form to retrieve'),
	formLocator(['getResponses'], 'The form to read responses from'),
	formLocator(['getAnalytics'], 'The form to read analytics for'),
	formLocator(['publish'], 'The form to publish'),
	formLocator(['close'], 'The live form to close'),
	formLocator(['reopen'], 'The closed form to reopen'),

	// ── Get Responses ─────────────────────────────────────────────────────────
	...returnAllAndLimit(showFor(RESOURCE, ['getResponses', 'getAll'])),
	{
		displayName: 'Filters',
		name: 'responseFilters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'getResponses') },
		options: [
			{
				displayName: 'Email Contains',
				name: 'q',
				type: 'string',
				default: '',
				placeholder: 'e.g. acme.com',
			},
			{
				displayName: 'Include Test Responses',
				name: 'includeTests',
				type: 'boolean',
				default: false,
				description: 'Whether to include responses sent from the form preview',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: FORM_RESPONSE_STATUS_OPTIONS,
				default: 'completed',
			},
		],
	},

	// ── Get Analytics ─────────────────────────────────────────────────────────
	{
		displayName: 'Options',
		name: 'analyticsOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'getAnalytics') },
		options: [
			{
				displayName: 'From',
				name: 'from',
				type: 'dateTime',
				default: '',
				description: 'The first day to count. Defaults to 30 days ago.',
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'dateTime',
				default: '',
				description: 'The last day to count. Defaults to today.',
			},
		],
	},

	// ── Get Many ──────────────────────────────────────────────────────────────
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'getAll') },
		options: [
			{
				displayName: 'Archived',
				name: 'archived',
				type: 'boolean',
				default: false,
				description: 'Whether to return archived forms instead of the current ones',
			},
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
					{ name: 'Closed', value: 'closed' },
					{ name: 'Draft', value: 'draft' },
					{ name: 'Live', value: 'live' },
				],
				default: 'live',
			},
		],
	},
];

function formId(this: IExecuteFunctions, i: number): string {
	const id = String(this.getNodeParameter('formId', i, '', { extractValue: true }) ?? '').trim();
	if (!id) {
		throw new NodeOperationError(this.getNode(), 'No form was picked', {
			itemIndex: i,
			description: 'Pick a form from the list, or enter its ID or key.',
		});
	}
	return id;
}

/**
 * One response with its answers as plain fields, keyed by each question's
 * reference, so a workflow can map `fields.team_size` instead of searching the
 * answers list. The list itself stays for labels and order.
 */
export function flattenResponse(response: IDataObject): IDataObject {
	const fields: IDataObject = {};
	for (const answer of asArray(response.answers)) {
		const key = String(answer.ref ?? answer.label ?? '').trim();
		if (key) fields[key] = answer.text ?? null;
	}
	return { ...response, fields };
}

/** YYYY-MM-DD from whatever the date picker or an expression produced. */
function day(value: unknown): string | undefined {
	if (!value) return undefined;
	const text = String(value);
	if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
	const parsed = Date.parse(text);
	return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
}

async function setOpen(this: IExecuteFunctions, i: number, open: boolean): Promise<IDataObject> {
	const data = (await manyPiApiRequest.call(
		this,
		'POST',
		`/api/forms/${segment(formId.call(this, i))}/close`,
		{ open },
		undefined,
		{ itemIndex: i, resourceLabel: 'form' },
	)) as IDataObject;
	return data;
}

export const formHandlers: ResourceHandlers = {
	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const body = (await manyPiApiRequest.call(
			this,
			'GET',
			'/api/forms',
			undefined,
			{ archived: filters.archived ? '1' : undefined },
			{ itemIndex: i },
		)) as IDataObject;
		const forms = asArray(body, 'forms').filter(
			(form) =>
				(filters.archived || !filters.status || form.status === filters.status) &&
				(!filters.name || containsText(form.name, filters.name as string)),
		);
		return applyLimit(forms, returnAll, limit);
	},

	async get(i) {
		const data = (await manyPiApiRequest.call(
			this,
			'GET',
			`/api/forms/${segment(formId.call(this, i))}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'form' },
		)) as IDataObject;
		const { form, ...rest } = data;
		return { ...((form as IDataObject) ?? {}), ...rest };
	},

	async getResponses(i) {
		const id = formId.call(this, i);
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('responseFilters', i, {}) as IDataObject;
		const results: IDataObject[] = [];
		let offset = 0;
		// A hard stop, so a route that ignores `offset` can never loop forever.
		for (let page = 0; page < 500; page++) {
			const body = (await manyPiApiRequest.call(
				this,
				'GET',
				`/api/forms/${segment(id)}/responses`,
				undefined,
				{ status: filters.status ?? 'completed', q: filters.q, limit: RESPONSE_PAGE, offset },
				{ itemIndex: i, resourceLabel: 'form' },
			)) as IDataObject;
			const rows = asArray(body, 'responses');
			for (const row of rows) {
				if (row.is_test && !filters.includeTests) continue;
				results.push(flattenResponse(row));
				if (!returnAll && results.length >= limit) return results;
			}
			if (rows.length < RESPONSE_PAGE) break;
			offset += rows.length;
		}
		return results;
	},

	async getAnalytics(i) {
		const options = this.getNodeParameter('analyticsOptions', i, {}) as IDataObject;
		return (await manyPiApiRequest.call(
			this,
			'GET',
			`/api/forms/${segment(formId.call(this, i))}/analytics`,
			undefined,
			{ from: day(options.from), to: day(options.to) },
			{ itemIndex: i, resourceLabel: 'form' },
		)) as IDataObject;
	},

	async create(i) {
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/forms',
			prune({
				name: this.getNodeParameter('name', i) as string,
				key: additional.key,
				brand_id: additional.brandId,
				template: additional.template,
				publish: additional.publish,
			}),
			undefined,
			{ itemIndex: i, resourceLabel: 'form template' },
		)) as IDataObject;
		return data;
	},

	async publish(i) {
		return (await manyPiApiRequest.call(
			this,
			'POST',
			`/api/forms/${segment(formId.call(this, i))}/publish`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'form' },
		)) as IDataObject;
	},

	async close(i) {
		return await setOpen.call(this, i, false);
	},

	async reopen(i) {
		return await setOpen.call(this, i, true);
	},
};
