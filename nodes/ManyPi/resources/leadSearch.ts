import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';
import { locator, returnAllAndLimit, showFor } from '../shared/descriptions';
import { manyPiApiRequest, segment } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { applyLimit, asArray, containsText, prune, toList } from '../shared/utils';

const RESOURCE = 'leadSearch';
const MAX_SEED_LEADS = 50;
const MAX_LEADS_PER_SEARCH = 250;

/** A run in one of these has stopped: finished, failed, or waiting for an answer. */
const SETTLED = new Set(['completed', 'failed', 'cancelled', 'paused']);

/**
 * One lead search's state, in the names a workflow branches on. The run row
 * comes from GET /api/agents/runs/{id}.
 */
function searchStatus(run: IDataObject): IDataObject {
	const status = String(run.status ?? '');
	return {
		runId: run.id,
		status,
		done: ['completed', 'failed', 'cancelled'].includes(status),
		waitingForAnswer: status === 'paused',
		leadsSaved: run.leads_kept ?? null,
		leadsWithEmail: run.leads_with_email ?? null,
		targetLeadCount: run.target_lead_count ?? null,
		summary: run.result_summary ?? null,
		error: run.error ?? null,
		conversationId: run.conversation_id ?? null,
		startedAt: run.started_at ?? null,
		finishedAt: run.finished_at ?? null,
	};
}

async function getRun(this: IExecuteFunctions, i: number, runId: string): Promise<IDataObject> {
	return (await manyPiApiRequest.call(
		this,
		'GET',
		`/api/agents/runs/${segment(runId)}`,
		undefined,
		undefined,
		{ itemIndex: i, resourceLabel: 'lead search' },
	)) as IDataObject;
}

const KIND_OPTIONS = [
	{ name: 'Find Similar to Seed Leads', value: 'similar' },
	{ name: 'Ideal Customer Profile', value: 'icp' },
];

/** The criteria a lead search enforces. Shared by Start and Create or Update. */
const criteriaOptions: INodeProperties[] = [
	{
		displayName: 'Company Size',
		name: 'companySize',
		type: 'string',
		default: '',
		placeholder: 'e.g. 5-50 employees',
		description: 'Free text on purpose, such as "Series A" or "under $5M ARR"',
	},
	{
		displayName: 'Exclusions',
		name: 'exclusions',
		type: 'string',
		default: '',
		placeholder: 'e.g. agencies, marketplaces',
		description: 'Hard excludes, separated by commas. Matches are dropped, not saved.',
	},
	{
		displayName: 'Extra Columns',
		name: 'extraColumns',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Column',
		default: {},
		description: "Extra facts to research for each lead, written to the lead's custom columns",
		options: [
			{
				displayName: 'Column',
				name: 'column',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						placeholder: 'e.g. Tech stack',
					},
					{
						displayName: 'What to Look For',
						name: 'description',
						type: 'string',
						default: '',
						placeholder: 'e.g. Ecommerce platform and main marketing tools',
					},
				],
			},
		],
	},
	{
		displayName: 'Industries',
		name: 'industries',
		type: 'string',
		default: '',
		placeholder: 'e.g. skincare, supplements',
		description: 'Separated by commas',
	},
	{
		displayName: 'Job Titles',
		name: 'titles',
		type: 'string',
		default: '',
		placeholder: 'e.g. Head of Growth, Founder',
		description: 'Roles to reach inside each company, separated by commas',
	},
	{
		displayName: 'Locations',
		name: 'locations',
		type: 'string',
		default: '',
		placeholder: 'e.g. Austin TX, United Kingdom',
		description: 'Separated by commas',
	},
	{
		displayName: 'Notes',
		name: 'notes',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		description: 'Anything else the agent should know',
	},
	{
		displayName: 'Number of Leads',
		name: 'count',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: MAX_LEADS_PER_SEARCH, numberPrecision: 0 },
		default: 20,
		description:
			'How many new leads to find, up to 250. Without it ManyPI finds 20, or 1 when the description names one company. Lowered to your remaining plan capacity when needed, which the output reports under clamped.',
	},
	{
		displayName: 'Required Fields',
		name: 'requiredFields',
		type: 'multiOptions',
		options: [
			{ name: 'Email', value: 'email' },
			{ name: 'Full Name', value: 'full_name' },
			{ name: 'Job Title', value: 'title' },
			{ name: 'LinkedIn URL', value: 'linkedin_url' },
			{ name: 'Location', value: 'location' },
			{ name: 'Phone', value: 'phone' },
		],
		default: ['email'],
		description: 'A lead missing any of these is not saved',
	},
	{
		displayName: 'Required Signals',
		name: 'keywords',
		type: 'string',
		default: '',
		placeholder: 'e.g. uses Shopify, hiring',
		description: 'Signals a company must show to qualify, separated by commas',
	},
	{
		displayName: 'Sources',
		name: 'sources',
		type: 'string',
		default: '',
		placeholder: 'e.g. Google Maps, Crunchbase',
		description:
			'Where to look, such as directories, marketplaces, maps or specific sites, separated by commas',
	},
];

function readCriteria(this: IExecuteFunctions, i: number, description: string): IDataObject {
	const fields = this.getNodeParameter('criteria', i, {}) as IDataObject;
	const extraColumns = (((fields.extraColumns as IDataObject)?.column as IDataObject[]) ?? [])
		.filter((column) => String(column.name ?? '').trim())
		.map((column) => ({ name: column.name, description: column.description ?? '' }));
	return prune({
		description,
		count: fields.count,
		locations: toList(fields.locations),
		industries: toList(fields.industries),
		company_size: fields.companySize,
		titles: toList(fields.titles),
		keywords: toList(fields.keywords),
		exclusions: toList(fields.exclusions),
		required_fields: fields.requiredFields,
		extra_columns: extraColumns,
		sources: toList(fields.sources),
		notes: fields.notes,
	});
}

const savedSearchLocator = (operation: string, required: boolean, description: string) =>
	locator({
		displayName: 'Saved Search',
		name: 'savedSearchId',
		noun: 'saved search',
		searchListMethod: 'searchSavedLeadSearches',
		show: showFor(RESOURCE, operation),
		required,
		description,
	});

export const leadSearchDescription: INodeProperties[] = [
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
				action: 'Create or update a saved lead search',
				description:
					'Create a new record, or update the current one if it already exists (upsert)',
			},
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete a saved lead search',
				description: 'Delete a saved lead search permanently. Leads it found are kept.',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many saved lead searches',
				description: 'Retrieve a list of saved lead searches with their criteria and run counts',
			},
			{
				name: 'Get Status',
				value: 'getStatus',
				action: 'Get the status of a lead search',
				description:
					'Check whether a lead search is still running, finished, failed, or waiting for an answer, and how many leads it saved',
			},
			{
				name: 'Start',
				value: 'start',
				action: 'Start a lead search',
				description:
					'Run the lead generation agent on your criteria, a saved search, or seed leads. Returns the run ID and status, and can wait for it to finish.',
			},
		],
		default: 'start',
	},

	// ── Start ─────────────────────────────────────────────────────────────────
	{
		displayName: 'Ideal Customer Description',
		name: 'description',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		placeholder: 'e.g. DTC skincare brands in the UK with 5-50 staff that sell on Shopify',
		description:
			'Who you want to find, in plain language. Required unless you pick a Saved Search or enter Seed Lead IDs.',
		displayOptions: { show: showFor(RESOURCE, 'start') },
	},
	savedSearchLocator(
		'start',
		false,
		'Run a saved search. Criteria you set below replace only the matching parts of it.',
	),
	{
		displayName: 'Seed Lead IDs',
		name: 'seedLeadIds',
		type: 'string',
		default: '',
		placeholder: 'e.g. d4e7f1a2-8b30-4c95-a1d6-5f2e9c8b7a04, 1b2c3d4e-...',
		description: 'Find more leads like these, up to 50, separated by commas',
		displayOptions: { show: showFor(RESOURCE, 'start') },
	},
	{
		displayName: 'Wait for Completion',
		name: 'waitForCompletion',
		type: 'boolean',
		default: false,
		description:
			'Whether to wait until the search finishes, fails, or stops to ask a question, and return its final status. When off, the node returns the run ID at once, with the status it started in.',
		displayOptions: { show: showFor(RESOURCE, 'start') },
	},
	{
		displayName: 'Max Wait (Minutes)',
		name: 'maxWaitMinutes',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 60, numberPrecision: 0 },
		default: 15,
		description:
			'How long to wait. A search still running after this comes back with Wait Timed Out set and keeps going in ManyPI. Most searches take 3 to 15 minutes.',
		displayOptions: { show: { ...showFor(RESOURCE, 'start'), waitForCompletion: [true] } },
	},

	// ── Create or Update ──────────────────────────────────────────────────────
	savedSearchLocator('upsert', false, 'The saved search to update. Leave empty to create a new one.'),
	{
		displayName: 'Ideal Customer Description',
		name: 'description',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		placeholder: 'e.g. DTC skincare brands in the UK with 5-50 staff that sell on Shopify',
		description: 'Who you want to find, in plain language',
		displayOptions: { show: showFor(RESOURCE, 'upsert') },
	},

	// ── Criteria, shared by Start and Create or Update ────────────────────────
	{
		displayName: 'Criteria',
		name: 'criteria',
		type: 'collection',
		placeholder: 'Add Criterion',
		default: {},
		displayOptions: { show: showFor(RESOURCE, ['start', 'upsert']) },
		options: criteriaOptions,
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showFor(RESOURCE, ['start', 'upsert']) },
		options: [
			{
				displayName: 'Kind',
				name: 'kind',
				type: 'options',
				options: KIND_OPTIONS,
				default: 'icp',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				placeholder: 'e.g. DTC skincare, UK',
				description: 'The name to save the search under',
			},
			{
				displayName: 'Save as Reusable Search',
				name: 'save',
				type: 'boolean',
				default: false,
				description:
					'Whether to store the criteria so the search can be run again, or to write them back to the picked saved search. Used by Start only.',
			},
			{
				displayName: 'Search Even If Leads Exist',
				name: 'forceSearch',
				type: 'boolean',
				default: false,
				description:
					'Whether to run the search even when the description names leads the workspace already has. When off, ManyPI returns those leads and starts no run. Used by Start only.',
			},
		],
	},

	// ── Get Status ────────────────────────────────────────────────────────────
	locator({
		displayName: 'Lead Search',
		name: 'leadSearchRunId',
		noun: 'lead search',
		searchListMethod: 'searchLeadSearchRuns',
		show: showFor(RESOURCE, 'getStatus'),
		description:
			'The run ID that Start returned, or a lead search picked from the list. The list shows searches that saved leads.',
	}),

	// ── Delete ────────────────────────────────────────────────────────────────
	savedSearchLocator('delete', true, 'The saved search to delete'),

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
				displayName: 'Name Contains',
				name: 'name',
				type: 'string',
				default: '',
			},
		],
	},
];

function savedSearchId(this: IExecuteFunctions, i: number): string {
	return this.getNodeParameter('savedSearchId', i, '', { extractValue: true }) as string;
}

async function findSavedSearch(this: IExecuteFunctions, i: number, id: string): Promise<IDataObject> {
	const body = await manyPiApiRequest.call(
		this,
		'GET',
		'/api/leads/research-profiles',
		undefined,
		undefined,
		{ itemIndex: i },
	);
	const profile = asArray(body, 'profiles').find((candidate) => candidate.id === id);
	if (!profile) {
		throw new NodeOperationError(this.getNode(), 'The saved search was not found in ManyPI', {
			itemIndex: i,
			description: 'Pick the saved search from the list. It may have been deleted.',
		});
	}
	return profile;
}

export const leadSearchHandlers: ResourceHandlers = {
	async start(i) {
		const description = this.getNodeParameter('description', i, '') as string;
		const criteria = readCriteria.call(this, i, description);
		const profileId = savedSearchId.call(this, i);
		const seedLeadIds = toList(this.getNodeParameter('seedLeadIds', i, ''));
		const options = this.getNodeParameter('options', i, {}) as IDataObject;

		if (!description.trim() && !profileId && !seedLeadIds.length) {
			throw new NodeOperationError(this.getNode(), 'The lead search has nothing to work from', {
				itemIndex: i,
				description: 'Enter an Ideal Customer Description, pick a Saved Search, or enter Seed Lead IDs.',
			});
		}
		if (seedLeadIds.length > MAX_SEED_LEADS) {
			throw new NodeOperationError(
				this.getNode(),
				`A lead search takes at most ${MAX_SEED_LEADS} seed leads, and this item has ${seedLeadIds.length}`,
				{ itemIndex: i, description: 'Pick the most representative leads and run again.' },
			);
		}

		// ManyPI replaces a saved search's criteria wholesale with any criteria
		// sent alongside it. Merge here, so overriding one field keeps the rest.
		let sentCriteria: IDataObject | undefined = Object.keys(criteria).length ? criteria : undefined;
		if (profileId && sentCriteria) {
			const saved = await findSavedSearch.call(this, i, profileId);
			sentCriteria = { ...((saved.criteria as IDataObject) ?? {}), ...sentCriteria };
		}

		// ManyPI sizes a search from the number its description states, not from
		// criteria.count, so put the count where it is read. First, so it wins
		// over any number further on.
		if (sentCriteria && typeof criteria.count === 'number') {
			const count = criteria.count;
			const text = String(sentCriteria.description ?? '').trim();
			sentCriteria.description = `Find ${count} ${count === 1 ? 'lead' : 'leads'}.${text ? ` ${text}` : ''}`;
		}

		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/leads/research',
			prune({
				criteria: sentCriteria,
				profile_id: profileId,
				seed_lead_ids: seedLeadIds,
				// Sent explicitly: ManyPI saves by default, which in a workflow that
				// runs on a schedule would pile up saved searches, or rewrite the
				// picked one with this run's overrides.
				save: (options.save as boolean | undefined) ?? false,
				name: options.name,
				kind: options.kind,
				// The node already says this is a lead search, so skip the
				// free-text check that would otherwise turn it into a plain agent run.
				check_intent: false,
				force_search: options.forceSearch,
			}),
			undefined,
			{ itemIndex: i, resourceLabel: 'saved search or seed lead' },
		)) as IDataObject;

		// When the description names leads the workspace already has, ManyPI
		// answers with those leads and starts nothing.
		if (!data.run_id && data.known) {
			return { started: false, known: data.known, description: data.description };
		}
		const started: IDataObject = {
			started: Boolean(data.run_id),
			...data,
			runId: data.run_id,
			// `clamped` only appears when the plan could not fit the requested count.
			wasClamped: Boolean(data.clamped),
		};
		if (!data.run_id || !(this.getNodeParameter('waitForCompletion', i, false) as boolean)) {
			return started;
		}

		const runId = String(data.run_id);
		const deadline = Date.now() + (this.getNodeParameter('maxWaitMinutes', i, 15) as number) * 60_000;
		let delay = 5_000;
		let run: IDataObject = { id: runId, status: data.status };
		while (!SETTLED.has(String(run.status))) {
			if (Date.now() + delay > deadline) {
				return { ...started, ...searchStatus(run), waitTimedOut: true };
			}
			await sleep(delay);
			delay = Math.min(delay * 1.5, 30_000);
			run = await getRun.call(this, i, runId);
		}
		return { ...started, ...searchStatus(run), waitTimedOut: false };
	},

	async getStatus(i) {
		const runId = this.getNodeParameter('leadSearchRunId', i, '', { extractValue: true }) as string;
		return searchStatus(await getRun.call(this, i, runId));
	},

	async upsert(i) {
		const description = this.getNodeParameter('description', i) as string;
		const options = this.getNodeParameter('options', i, {}) as IDataObject;
		const id = savedSearchId.call(this, i);
		// An update without a name or kind would rename the search and reset it
		// to an ideal customer profile, so carry the current ones over.
		const current: IDataObject = id ? await findSavedSearch.call(this, i, id) : {};
		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/leads/research-profiles',
			prune({
				id,
				name: options.name ?? current.name,
				kind: options.kind ?? current.kind,
				// Stored criteria are replaced whole, so keep what this node has
				// no field for, such as a "find similar" search's seed leads.
				criteria: {
					...((current.criteria as IDataObject) ?? {}),
					...readCriteria.call(this, i, description),
				},
			}),
			undefined,
			{ itemIndex: i, resourceLabel: 'saved search' },
		)) as IDataObject;
		return (data.profile ?? data) as IDataObject;
	},

	async delete(i) {
		// ManyPI answers ok for an ID that does not exist, so check first.
		await findSavedSearch.call(this, i, savedSearchId.call(this, i));
		await manyPiApiRequest.call(
			this,
			'DELETE',
			`/api/leads/research-profiles/${segment(savedSearchId.call(this, i))}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'saved search' },
		);
		return { deleted: true };
	},

	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const body = await manyPiApiRequest.call(
			this,
			'GET',
			'/api/leads/research-profiles',
			undefined,
			undefined,
			{ itemIndex: i },
		);
		const profiles = asArray(body, 'profiles').filter(
			(profile) => !filters.name || containsText(profile.name, filters.name as string),
		);
		return applyLimit(profiles, returnAll, limit);
	},
};
