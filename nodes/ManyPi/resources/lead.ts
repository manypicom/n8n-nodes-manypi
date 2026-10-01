import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	LEAD_FILTER_STATUS_OPTIONS,
	LEAD_SIMPLE_KEYS,
	LEAD_STATUS_OPTIONS,
	brandOption,
	locator,
	returnAllAndLimit,
	showFor,
	simplifyField,
} from '../shared/descriptions';
import { manyPiApiRequest, manyPiApiRequestFull, segment } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import {
	assertBatchSize,
	fetchOffsetPages,
	parseJsonParameter,
	prune,
	simplify,
	slugifyCustomKeys,
	slugifyFieldKey,
	toList,
} from '../shared/utils';

const RESOURCE = 'lead';
const MAX_IMPORT = 100;
const MAX_BULK = 500;

/** The core fields a lead has, as n8n parameter name and ManyPI key. */
const CORE_FIELDS: Array<{ displayName: string; name: string; key: string; placeholder: string }> =
	[
		{ displayName: 'Company', name: 'company', key: 'company', placeholder: 'e.g. Northwind Studio' },
		{ displayName: 'Domain', name: 'domain', key: 'domain', placeholder: 'e.g. example.com' },
		{ displayName: 'Email', name: 'email', key: 'email', placeholder: 'e.g. nathan@example.com' },
		{ displayName: 'Full Name', name: 'fullName', key: 'full_name', placeholder: 'e.g. Nathan Smith' },
		{ displayName: 'Job Title', name: 'title', key: 'title', placeholder: 'e.g. Head of Growth' },
		{
			displayName: 'LinkedIn URL',
			name: 'linkedinUrl',
			key: 'linkedin_url',
			placeholder: 'e.g. https://www.linkedin.com/in/example',
		},
		{ displayName: 'Location', name: 'location', key: 'location', placeholder: 'e.g. Austin, TX' },
		{ displayName: 'Phone', name: 'phone', key: 'phone', placeholder: 'e.g. +1 555 0100' },
		{
			displayName: 'Source URL',
			name: 'sourceUrl',
			key: 'source_url',
			placeholder: 'e.g. https://example.com/about',
		},
	];

const coreFieldOptions = (exclude: string[] = []): INodeProperties[] =>
	CORE_FIELDS.filter((field) => !exclude.includes(field.name)).map((field) => ({
		displayName: field.displayName,
		name: field.name,
		type: 'string',
		default: '',
		placeholder: field.placeholder,
	}));

const scoreOption: INodeProperties = {
	displayName: 'Score',
	name: 'score',
	type: 'number',
	typeOptions: { minValue: 0, maxValue: 100, numberPrecision: 0 },
	default: 50,
	description: 'A 0-100 fit score',
};

const statusOption: INodeProperties = {
	displayName: 'Status',
	name: 'status',
	type: 'options',
	options: LEAD_STATUS_OPTIONS,
	default: 'new',
};

const customFieldsParameter = (operation: string, description: string): INodeProperties => ({
	displayName: 'Custom Fields',
	name: 'customFields',
	type: 'fixedCollection',
	typeOptions: { multipleValues: true },
	placeholder: 'Add Custom Field',
	default: {},
	description,
	displayOptions: { show: showFor(RESOURCE, operation) },
	options: [
		{
			displayName: 'Field',
			name: 'field',
			values: [
				{
					displayName: 'Key',
					name: 'key',
					type: 'string',
					default: '',
					placeholder: 'e.g. tech_stack',
					description:
						'The key of the custom column, as listed by Lead Column > Get Many. A label such as "Tech Stack" is turned into its key, tech_stack.',
				},
				{
					displayName: 'Value',
					name: 'value',
					type: 'string',
					default: '',
				},
			],
		},
	],
});

const onDuplicateOption: INodeProperties = {
	displayName: 'On Duplicate',
	name: 'duplicates',
	type: 'options',
	options: [
		{
			name: 'Merge',
			value: 'merge',
			description: 'Fill in blanks on the existing lead and keep its values',
		},
		{
			name: 'Overwrite',
			value: 'overwrite',
			description: 'Replace the existing values with the incoming ones',
		},
		{
			name: 'Skip',
			value: 'skip',
			description: 'Leave the existing lead untouched',
		},
	],
	default: 'merge',
	description: 'What to do when a lead with the same email, or the same domain and name, exists',
};

const leadLocator = (operation: string[], description: string) =>
	locator({
		displayName: 'Lead',
		name: 'leadId',
		noun: 'lead',
		searchListMethod: 'searchLeads',
		show: showFor(RESOURCE, operation),
		description,
	});

const leadIdsParameter = (operation: string, description: string): INodeProperties => ({
	displayName: 'Lead IDs',
	name: 'leadIds',
	type: 'string',
	required: true,
	default: '',
	placeholder: 'e.g. d4e7f1a2-8b30-4c95-a1d6-5f2e9c8b7a04, 1b2c3d4e-...',
	description,
	displayOptions: { show: showFor(RESOURCE, operation) },
});

export const leadDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Create or Update',
				value: 'upsert',
				action: 'Create or update a lead',
				description:
					'Create a new record, or update the current one if it already exists (upsert)',
			},
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete a lead',
				description:
					'Delete a lead permanently. Archiving with Update keeps it recoverable instead.',
			},
			{
				name: 'Delete Many',
				value: 'deleteMany',
				action: 'Delete many leads',
				description: 'Delete up to 500 leads permanently in one call',
			},
			{
				name: 'Export',
				value: 'export',
				action: 'Export leads to a file',
				description:
					'Export the matching leads, up to 10,000, as a CSV, TSV, JSON or text file. Archived leads are left out.',
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get a lead',
				description: 'Retrieve a lead with its custom fields and email status',
			},
			{
				name: 'Get Capacity',
				value: 'getCapacity',
				action: 'Get lead capacity',
				description: 'Retrieve how many more leads your plan can store',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many leads',
				description: 'Retrieve a list of leads, newest first',
			},
			{
				name: 'Import',
				value: 'import',
				action: 'Import leads',
				description: 'Create or update up to 100 leads from a JSON array in one call',
			},
			{
				name: 'Update',
				value: 'update',
				action: 'Update a lead',
				description: 'Update the fields, status, score or archive state of a lead',
			},
			{
				name: 'Update Many',
				value: 'updateMany',
				action: 'Update many leads',
				description: 'Change the status or archive state of up to 500 leads in one call',
			},
		],
		default: 'getAll',
	},

	// ── Create or Update ──────────────────────────────────────────────────────
	{
		displayName: 'Email',
		name: 'email',
		type: 'string',
		default: '',
		placeholder: 'e.g. nathan@example.com',
		description:
			'Leads are matched on email. Without an email, set Domain and Full Name under Additional Fields.',
		displayOptions: { show: showFor(RESOURCE, 'upsert') },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'upsert') },
		options: [...coreFieldOptions(['email']), scoreOption, statusOption],
	},
	customFieldsParameter(
		'upsert',
		'Values for your custom lead columns. A column must be declared first, or its value is dropped.',
	),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'upsert') },
		options: [
			{
				displayName: 'Declare Missing Columns',
				name: 'declareColumns',
				type: 'boolean',
				default: false,
				description:
					'Whether to create the custom columns used above when they do not exist yet. Requires a plan with custom columns.',
			},
			onDuplicateOption,
		],
	},

	// ── Import ────────────────────────────────────────────────────────────────
	{
		displayName: 'Leads',
		name: 'leads',
		type: 'json',
		required: true,
		default: '[\n  {\n    "email": "nathan@example.com",\n    "full_name": "Nathan Smith",\n    "company": "Example Inc"\n  }\n]',
		description:
			'A JSON array of up to 100 leads. Keys: company, full_name, title, email, phone, domain, linkedin_url, location, source_url, score, status, and custom for an object of custom column values.',
		displayOptions: { show: showFor(RESOURCE, 'import') },
	},
	{
		displayName: 'Options',
		name: 'importOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'import') },
		options: [
			{
				displayName: 'Declare Columns',
				name: 'declareColumns',
				type: 'string',
				default: '',
				placeholder: 'e.g. Tech Stack, Annual Revenue',
				description:
					'Labels of custom columns to create before importing, separated by commas. Values for undeclared columns are dropped.',
			},
			onDuplicateOption,
		],
	},

	// ── Get, Update, Delete ───────────────────────────────────────────────────
	leadLocator(['get'], 'The lead to retrieve'),
	leadLocator(['update'], 'The lead to update'),
	leadLocator(['delete'], 'The lead to delete permanently'),
	simplifyField(showFor(RESOURCE, 'get')),
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'update') },
		options: [
			{
				displayName: 'Archived',
				name: 'archived',
				type: 'boolean',
				default: true,
				description:
					'Whether the lead is archived. Archived leads are hidden everywhere but can be restored.',
			},
			...coreFieldOptions(),
			{
				displayName: 'Fields to Clear',
				name: 'clearFields',
				type: 'string',
				default: '',
				placeholder: 'e.g. phone, tech_stack',
				description:
					'Keys of core or custom fields to blank, separated by commas. Empty values in other fields are ignored rather than written, so an expression that resolves to nothing cannot wipe a field by accident.',
			},
			scoreOption,
			statusOption,
		],
	},
	customFieldsParameter('update', 'Values to write to your custom lead columns'),

	// ── Update Many, Delete Many ──────────────────────────────────────────────
	leadIdsParameter('updateMany', 'Up to 500 lead IDs, separated by commas'),
	{
		displayName: 'Update Fields',
		name: 'updateManyFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'updateMany') },
		options: [
			{
				displayName: 'Archived',
				name: 'archived',
				type: 'boolean',
				default: true,
				description: 'Whether to archive the leads. Turn off to restore archived leads.',
			},
			statusOption,
		],
	},
	leadIdsParameter('deleteMany', 'Up to 500 lead IDs to delete permanently, separated by commas'),

	// ── Get Many ──────────────────────────────────────────────────────────────
	...returnAllAndLimit(showFor(RESOURCE, 'getAll')),
	simplifyField(showFor(RESOURCE, 'getAll')),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showFor(RESOURCE, ['getAll', 'export']) },
		options: [
			{ ...brandOption, displayOptions: { show: { '/operation': ['getAll'] } } },
			{
				displayName: 'Lead Search ID',
				name: 'campaign',
				type: 'string',
				default: '',
				placeholder: 'e.g. 5f6a7b8c-9d0e-4f12-a3b4-c5d6e7f8a9b0',
				description: 'Only return leads found by this lead search, using its run ID',
				displayOptions: { show: { '/operation': ['getAll'] } },
			},
			{
				displayName: 'Search',
				name: 'q',
				type: 'string',
				default: '',
				placeholder: 'e.g. northwind',
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

	// ── Export ────────────────────────────────────────────────────────────────
	{
		displayName: 'File Format',
		name: 'format',
		type: 'options',
		options: [
			{ name: 'CSV', value: 'csv' },
			{ name: 'JSON', value: 'json' },
			{ name: 'Text', value: 'txt' },
			{ name: 'TSV', value: 'tsv' },
		],
		default: 'csv',
		displayOptions: { show: showFor(RESOURCE, 'export') },
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		hint: 'The name of the output binary field to put the file in',
		displayOptions: { show: showFor(RESOURCE, 'export') },
	},
];

function leadId(this: IExecuteFunctions, i: number): string {
	return this.getNodeParameter('leadId', i, '', { extractValue: true }) as string;
}

/**
 * Read Custom Fields into an object keyed by column key, skipping rows with no
 * key or no value. Also returns the label each key came from, for declaring.
 */
function customValues(this: IExecuteFunctions, i: number): { values: IDataObject; labels: IDataObject } {
	const rows =
		((this.getNodeParameter('customFields', i, {}) as IDataObject).field as IDataObject[]) ?? [];
	const values: IDataObject = {};
	const labels: IDataObject = {};
	for (const row of rows) {
		const label = String(row.key ?? '').trim();
		const value = row.value;
		if (!label || value === undefined || value === null || value === '') continue;
		const key = slugifyFieldKey(label);
		values[key] = value;
		labels[key] = label;
	}
	return { values, labels };
}

/** Stop before sending placeholder rows on as real leads. */
function assertNotLocked(this: IExecuteFunctions, body: unknown, i: number): void {
	if (body && typeof body === 'object' && (body as IDataObject).billingLock) {
		throw new NodeOperationError(this.getNode(), 'This ManyPI workspace is locked for billing', {
			itemIndex: i,
			description:
				'ManyPI hides lead data until the subscription is active again. Resubscribe under Billing in the ManyPI dashboard.',
		});
	}
}

async function patchLead(
	this: IExecuteFunctions,
	i: number,
	id: string,
	body: IDataObject,
): Promise<IDataObject> {
	const data = (await manyPiApiRequest.call(
		this,
		'PATCH',
		`/api/leads/${segment(id)}`,
		body,
		undefined,
		{ itemIndex: i, resourceLabel: 'lead' },
	)) as IDataObject;
	return (data.lead ?? data) as IDataObject;
}

export const leadHandlers: ResourceHandlers = {
	async upsert(i) {
		const email = (this.getNodeParameter('email', i, '') as string).trim();
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		const options = this.getNodeParameter('options', i, {}) as IDataObject;
		const { values: custom, labels } = customValues.call(this, i);

		const row: IDataObject = { email };
		for (const field of CORE_FIELDS) {
			if (field.name !== 'email') row[field.key] = additional[field.name];
		}
		row.score = additional.score;
		row.status = additional.status;
		row.custom = custom;
		const lead = prune(row);

		if (!lead.email && !(lead.domain && (lead.full_name || lead.company))) {
			throw new NodeOperationError(this.getNode(), 'The lead has nothing to match it on', {
				itemIndex: i,
				description:
					'Enter an Email, or add Domain plus Full Name or Company under Additional Fields.',
			});
		}

		const declareFields = options.declareColumns
			? Object.keys(custom).map((key) => ({ label: labels[key], key }))
			: [];

		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/leads/import',
			prune({
				rows: [lead],
				duplicates: options.duplicates,
				declare_fields: declareFields,
			}),
			undefined,
			{ itemIndex: i },
		)) as IDataObject;

		// One row went in. Name what happened to it, so a workflow can branch on
		// a word rather than on a row of counters.
		const leadId = Array.isArray(data.rowLeadIds) ? (data.rowLeadIds[0] ?? null) : null;
		const failed = Array.isArray(data.failed) ? data.failed.length > 0 : false;
		let result = 'failed';
		if (Number(data.created) > 0) result = 'created';
		else if (Number(data.updated) > 0) result = 'updated';
		else if (Number(data.skippedDuplicate) > 0) result = 'skippedDuplicate';
		else if (Number(data.skippedOverLimit) > 0 || data.code === 'lead_limit') {
			result = 'skippedOverLimit';
		} else if (Number(data.skippedNoIdentity) > 0) result = 'skippedNoIdentity';
		else if (Number(data.skippedOtherWorkspace) > 0) result = 'skippedOtherWorkspace';
		else if (Number(data.skippedConflict) > 0) result = 'skippedConflict';
		// Matched an existing lead that the merge had nothing new to add to:
		// every counter stays at zero, but the row still resolved to a lead.
		else if (leadId && !failed) result = 'unchanged';

		return { result, leadId, ...data };
	},

	async import(i) {
		const parsed = parseJsonParameter.call(this, this.getNodeParameter('leads', i), 'Leads', i);
		const parsedRows = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) as IDataObject[];
		assertBatchSize.call(this, parsedRows, MAX_IMPORT, 'leads', i);
		if (parsedRows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
			throw new NodeOperationError(this.getNode(), 'Each lead in "Leads" must be a JSON object', {
				itemIndex: i,
				description: 'Use an array of objects, e.g. [{"email": "nathan@example.com"}].',
			});
		}
		// Custom values are filed under each column's key, so "Tech Stack" has to
		// arrive as tech_stack, the key its declared column gets.
		const rows = parsedRows.map((row) =>
			row.custom === undefined ? row : { ...row, custom: slugifyCustomKeys(row.custom) },
		);

		const options = this.getNodeParameter('importOptions', i, {}) as IDataObject;
		const declareFields = toList(options.declareColumns).map((label) => ({ label }));

		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/leads/import',
			prune({ rows, duplicates: options.duplicates, declare_fields: declareFields }),
			undefined,
			{ itemIndex: i },
		)) as IDataObject;

		// A full workspace still answers 200, with a `lead_limit` code.
		return { ...data, submitted: rows.length, hitLeadLimit: data.code === 'lead_limit' };
	},

	async get(i) {
		const data = (await manyPiApiRequest.call(
			this,
			'GET',
			`/api/leads/${segment(leadId.call(this, i))}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'lead' },
		)) as IDataObject;
		const lead = (data.lead ?? data) as IDataObject;
		return (this.getNodeParameter('simplify', i, true) as boolean)
			? simplify(lead, LEAD_SIMPLE_KEYS)
			: lead;
	},

	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const leads = await fetchOffsetPages.call(this, {
			path: '/api/leads',
			qs: {
				q: filters.q,
				status: filters.status,
				campaign: filters.campaign,
				brand: filters.brand,
			},
			key: 'leads',
			pageSize: 500,
			returnAll,
			limit,
			itemIndex: i,
			inspect: (body) => assertNotLocked.call(this, body, i),
		});
		return (this.getNodeParameter('simplify', i, true) as boolean)
			? leads.map((lead) => simplify(lead, LEAD_SIMPLE_KEYS))
			: leads;
	},

	async getCapacity(i) {
		return (await manyPiApiRequest.call(this, 'GET', '/api/leads/capacity', undefined, undefined, {
			itemIndex: i,
		})) as IDataObject;
	},

	async update(i) {
		const id = leadId.call(this, i);
		const fields = this.getNodeParameter('updateFields', i, {}) as IDataObject;

		// ManyPI writes one field per request, alongside any status, score and
		// archive change. Queue the writes, then send them in order.
		const writes: IDataObject[] = [];
		const state = prune({ status: fields.status, score: fields.score });
		if (fields.archived !== undefined) state.archived = fields.archived;
		if (Object.keys(state).length) writes.push(state);

		for (const field of CORE_FIELDS) {
			const value = fields[field.name];
			if (value !== undefined && value !== '') writes.push({ field: field.key, value: String(value) });
		}
		for (const [key, value] of Object.entries(customValues.call(this, i).values)) {
			writes.push({ field: key, value: String(value) });
		}
		for (const key of toList(fields.clearFields)) {
			const core = CORE_FIELDS.find((field) => field.key === key || field.name === key);
			writes.push({ field: core ? core.key : slugifyFieldKey(key), value: '' });
		}

		if (!writes.length) {
			throw new NodeOperationError(this.getNode(), 'No fields to update were set', {
				itemIndex: i,
				description: 'Add a field under Update Fields or Custom Fields, or list Fields to Clear.',
			});
		}

		let lead: IDataObject = {};
		for (const body of writes) {
			lead = await patchLead.call(this, i, id, body);
		}
		return lead;
	},

	async updateMany(i) {
		const ids = toList(this.getNodeParameter('leadIds', i));
		assertBatchSize.call(this, ids, MAX_BULK, 'lead IDs', i);
		const fields = this.getNodeParameter('updateManyFields', i, {}) as IDataObject;
		if (fields.status === undefined && fields.archived === undefined) {
			throw new NodeOperationError(this.getNode(), 'No fields to update were set', {
				itemIndex: i,
				description: 'Add Status, Archived, or both under Update Fields.',
			});
		}
		const body: IDataObject = { ids };
		if (fields.status !== undefined) body.status = fields.status;
		if (fields.archived !== undefined) body.archived = fields.archived;
		const data = (await manyPiApiRequest.call(this, 'PATCH', '/api/leads', body, undefined, {
			itemIndex: i,
		})) as IDataObject;
		return { ...data, submitted: ids.length };
	},

	async delete(i) {
		const path = `/api/leads/${segment(leadId.call(this, i))}`;
		const options = { itemIndex: i, resourceLabel: 'lead' };
		// The delete route answers ok whether or not the lead existed, so check
		// first: a mistyped ID should fail, not report a deletion.
		await manyPiApiRequest.call(this, 'GET', path, undefined, undefined, options);
		await manyPiApiRequest.call(this, 'DELETE', path, undefined, undefined, options);
		return { deleted: true };
	},

	async deleteMany(i) {
		const ids = toList(this.getNodeParameter('leadIds', i));
		assertBatchSize.call(this, ids, MAX_BULK, 'lead IDs', i);
		const data = (await manyPiApiRequest.call(this, 'DELETE', '/api/leads', { ids }, undefined, {
			itemIndex: i,
		})) as IDataObject;
		return { ...data, submitted: ids.length };
	},

	async export(i) {
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const format = this.getNodeParameter('format', i) as string;
		const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
		const response = await manyPiApiRequestFull.call(
			this,
			'GET',
			'/api/leads/export',
			undefined,
			{ status: filters.status, q: filters.q, format },
			{ itemIndex: i, binary: true },
		);
		const buffer = Buffer.from(response.body as ArrayBuffer);
		const mimeType = String(response.headers['content-type'] ?? 'text/plain').split(';')[0];
		const binary = await this.helpers.prepareBinaryData(buffer, `manypi-leads.${format}`, mimeType);
		return {
			json: { format, fileName: `manypi-leads.${format}`, bytes: buffer.length },
			binary: { [binaryPropertyName]: binary },
		};
	},
};
