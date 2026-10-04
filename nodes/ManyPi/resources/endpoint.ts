import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { locator, returnAllAndLimit, showFor } from '../shared/descriptions';
import { BASE_URL, manyPiApiRequest, manyPiApiRequestFull, segment } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import {
	applyLimit,
	asArray,
	containsText,
	parseJsonObjectParameter,
	prune,
} from '../shared/utils';

const RESOURCE = 'endpoint';

const endpointLocator = (operation: string[], description: string) =>
	locator({
		displayName: 'Endpoint',
		name: 'endpointId',
		noun: 'endpoint',
		searchListMethod: 'searchEndpoints',
		show: showFor(RESOURCE, operation),
		description,
	});

const endpointSlugLocator = (operation: string[]) =>
	locator({
		displayName: 'Endpoint',
		name: 'endpointSlug',
		noun: 'endpoint',
		searchListMethod: 'searchEndpointSlugs',
		show: showFor(RESOURCE, operation),
		idLabel: 'Slug',
		idPlaceholder: 'e.g. competitor-pricing',
		description: 'The endpoint to call. In the typed mode, enter its slug rather than its ID.',
	});

function withInvokeUrl(endpoint: IDataObject): IDataObject {
	return endpoint.slug ? { ...endpoint, invoke_url: `${BASE_URL}/v1/e/${endpoint.slug}` } : endpoint;
}

export const endpointDescription: INodeProperties[] = [
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
				action: 'Create an endpoint',
				description: 'Publish a scraper as a typed REST endpoint at app.manypi.com/v1/e/{slug}',
			},
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete an endpoint',
				description: 'Delete an endpoint permanently. Its URL stops answering.',
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get an endpoint',
				description: 'Retrieve an endpoint with its schemas and recent invocations',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many endpoints',
				description: 'Retrieve a list of your published endpoints',
			},
			{
				name: 'Get Result',
				value: 'getResult',
				action: 'Get the result of an endpoint call',
				description:
					'Retrieve the result of an async call, or of one that took longer than the inline wait',
			},
			{
				name: 'Invoke',
				value: 'invoke',
				action: 'Invoke an endpoint',
				description:
					'Call a published endpoint. A fresh cached result returns at once; otherwise the scrape runs first.',
			},
		],
		default: 'invoke',
	},

	// ── Create ────────────────────────────────────────────────────────────────
	{
		displayName: 'Slug',
		name: 'slug',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. competitor-pricing',
		description:
			'Lowercase letters, digits and dashes. It becomes the URL, and must be unique in your account.',
		displayOptions: { show: showFor(RESOURCE, 'create') },
	},
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Competitor pricing',
		displayOptions: { show: showFor(RESOURCE, 'create') },
	},
	locator({
		displayName: 'Scraper',
		name: 'scraperId',
		noun: 'scraper',
		searchListMethod: 'searchScrapers',
		show: showFor(RESOURCE, 'create'),
		description: 'The scraper this endpoint runs',
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
				displayName: 'Cache TTL (Seconds)',
				name: 'cacheTtlSeconds',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 604800, numberPrecision: 0 },
				default: 3600,
				description: 'How long a cached result counts as fresh',
			},
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				default: '',
			},
			{
				displayName: 'Freshness',
				name: 'freshness',
				type: 'options',
				options: [
					{
						name: 'Always Fresh',
						value: 'always_fresh',
						description: 'Scrape on every call',
					},
					{
						name: 'Cached OK',
						value: 'cached_ok',
						description: 'Reuse a fresh cached result when there is one',
					},
				],
				default: 'cached_ok',
			},
			{
				displayName: 'HTTP Method',
				name: 'method',
				type: 'options',
				options: [
					{ name: 'GET', value: 'GET' },
					{ name: 'POST', value: 'POST' },
				],
				default: 'GET',
			},
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				options: [
					{
						name: 'Async',
						value: 'async',
						description: 'Return a run ID at once, to collect with Get Result',
					},
					{
						name: 'Sync',
						value: 'sync',
						description: 'Wait for the result, up to about 110 seconds',
					},
				],
				default: 'sync',
			},
			{
				displayName: 'Output Schema',
				name: 'outputSchema',
				type: 'json',
				default: '{\n  "type": "object",\n  "properties": {}\n}',
				description: 'A JSON Schema describing the result',
			},
			{
				displayName: 'Parameter Schema',
				name: 'paramSchema',
				type: 'json',
				default: '{\n  "type": "object",\n  "properties": {\n    "url": { "type": "string" }\n  }\n}',
				description: 'A JSON Schema for the input, checked on every call',
			},
		],
	},

	// ── Get, Delete ───────────────────────────────────────────────────────────
	endpointLocator(['get'], 'The endpoint to retrieve'),
	endpointLocator(['delete'], 'The endpoint to delete'),

	// ── Invoke, Get Result ────────────────────────────────────────────────────
	{
		displayName:
			'Published endpoints only accept API keys. Set Authentication to API Key to use this operation.',
		name: 'oauthEndpointNotice',
		type: 'notice',
		default: '',
		displayOptions: {
			show: { ...showFor(RESOURCE, ['invoke', 'getResult']), '/authentication': ['oAuth2'] },
		},
	},
	endpointSlugLocator(['invoke', 'getResult']),
	{
		displayName: 'Parameters',
		name: 'parameters',
		type: 'json',
		default: '{}',
		placeholder: 'e.g. {"url": "https://example.com/pricing"}',
		description:
			"The endpoint's input as a JSON object. It is checked against the endpoint's parameter schema, so the names must match.",
		displayOptions: { show: showFor(RESOURCE, 'invoke') },
	},
	{
		displayName: 'Run ID',
		name: 'runId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. b3c4d5e6-7f80-4912-a3b4-c5d6e7f8a901',
		description: 'The run ID returned by an Invoke call that was still pending',
		displayOptions: { show: showFor(RESOURCE, 'getResult') },
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
			{
				displayName: 'Slug or Name Contains',
				name: 'search',
				type: 'string',
				default: '',
			},
		],
	},
];

function endpointId(this: IExecuteFunctions, i: number): string {
	return this.getNodeParameter('endpointId', i, '', { extractValue: true }) as string;
}

function endpointSlug(this: IExecuteFunctions, i: number): string {
	return this.getNodeParameter('endpointSlug', i, '', { extractValue: true }) as string;
}

/**
 * A 202 means the work is still running: say so plainly instead of returning
 * an empty result. The endpoint's own output goes under `data`, so none of its
 * fields can collide with the ones added here.
 */
function invocationResult(
	slug: string,
	statusCode: number,
	headers: IDataObject,
	body: unknown,
): IDataObject {
	const envelope =
		body && typeof body === 'object' && !Array.isArray(body) ? (body as IDataObject) : {};
	if (statusCode === 202) {
		return {
			slug,
			pending: true,
			status: envelope.status ?? 'running',
			run_id: envelope.run_id ?? headers['x-manypi-run-id'] ?? null,
		};
	}
	return {
		slug,
		pending: false,
		cache: headers['x-manypi-cache'] ?? null,
		run_id: headers['x-manypi-run-id'] ?? null,
		data: body as IDataObject,
	};
}

export const endpointHandlers: ResourceHandlers = {
	async create(i) {
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		const body = prune({
			slug: this.getNodeParameter('slug', i) as string,
			name: this.getNodeParameter('name', i) as string,
			scraper_id: this.getNodeParameter('scraperId', i, '', { extractValue: true }) as string,
			description: additional.description,
			method: additional.method,
			freshness: additional.freshness,
			cache_ttl_seconds: additional.cacheTtlSeconds,
			mode: additional.mode,
			param_schema: parseJsonObjectParameter.call(this, additional.paramSchema, 'Parameter Schema', i),
			output_schema: parseJsonObjectParameter.call(this, additional.outputSchema, 'Output Schema', i),
		});
		const data = (await manyPiApiRequest.call(this, 'POST', '/api/endpoints', body, undefined, {
			itemIndex: i,
			resourceLabel: 'scraper',
		})) as IDataObject;
		return withInvokeUrl(data);
	},

	async delete(i) {
		const path = `/api/endpoints/${segment(endpointId.call(this, i))}`;
		const options = { itemIndex: i, resourceLabel: 'endpoint' };
		// The delete route answers ok whether or not the endpoint existed.
		await manyPiApiRequest.call(this, 'GET', path, undefined, undefined, options);
		await manyPiApiRequest.call(this, 'DELETE', path, undefined, undefined, options);
		return { deleted: true };
	},

	async get(i) {
		const data = (await manyPiApiRequest.call(
			this,
			'GET',
			`/api/endpoints/${segment(endpointId.call(this, i))}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'endpoint' },
		)) as IDataObject;
		return withInvokeUrl(data);
	},

	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const search = (filters.search as string) || '';
		const body = await manyPiApiRequest.call(this, 'GET', '/api/endpoints', undefined, undefined, {
			itemIndex: i,
		});
		const endpoints = asArray(body)
			.filter(
				(endpoint) =>
					!search || containsText(endpoint.slug, search) || containsText(endpoint.name, search),
			)
			.map(withInvokeUrl);
		return applyLimit(endpoints, returnAll, limit);
	},

	async invoke(i) {
		const slug = endpointSlug.call(this, i);
		const parameters =
			parseJsonObjectParameter.call(this, this.getNodeParameter('parameters', i, '{}'), 'Parameters', i) ??
			{};
		// POST with a JSON body works for GET and POST endpoints alike, and keeps
		// numbers and booleans typed instead of flattening them into a query string.
		const response = await manyPiApiRequestFull.call(
			this,
			'POST',
			`/v1/e/${segment(slug)}`,
			parameters,
			undefined,
			{ itemIndex: i, resourceLabel: 'active endpoint' },
		);
		return invocationResult(slug, response.statusCode, response.headers, response.body);
	},

	async getResult(i) {
		const slug = endpointSlug.call(this, i);
		const runId = this.getNodeParameter('runId', i) as string;
		const response = await manyPiApiRequestFull.call(
			this,
			'GET',
			`/v1/e/${segment(slug)}/results/${segment(runId)}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'endpoint run' },
		);
		return invocationResult(slug, response.statusCode, response.headers, response.body);
	},
};
