import type { IDataObject, INodeProperties } from 'n8n-workflow';
import {
	SCRAPER_RUN_STATUS_OPTIONS,
	locator,
	returnAllAndLimit,
	showFor,
} from '../shared/descriptions';
import { manyPiApiRequest, segment } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { fetchOffsetPages, normalizeScraperRun } from '../shared/utils';

const RESOURCE = 'scraperRun';

const runLocator = (operation: string[]) =>
	locator({
		displayName: 'Scraper Run',
		name: 'runId',
		noun: 'scraper run',
		searchListMethod: 'searchScraperRuns',
		show: showFor(RESOURCE, operation),
		description: 'Pick a recent run, or map the run ID returned by the Run operation',
	});

export const scraperRunDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				action: 'Get a scraper run',
				description: 'Retrieve the status, usage and inline result of a scraper run',
			},
			{
				name: 'Get Data',
				value: 'getData',
				action: 'Get the data of a scraper run',
				description:
					'Retrieve the full extracted data of a completed run, however large it is',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many scraper runs',
				description: 'Retrieve a list of recent runs across your scrapers, newest first',
			},
		],
		default: 'get',
	},

	runLocator(['get']),
	locator({
		displayName: 'Scraper',
		name: 'scraperId',
		noun: 'scraper',
		searchListMethod: 'searchScrapers',
		show: showFor(RESOURCE, 'getData'),
		description: 'The scraper the run belongs to',
	}),
	runLocator(['getData']),

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
				displayName: 'Scraper ID',
				name: 'scraperId',
				type: 'string',
				default: '',
				placeholder: 'e.g. 9f1c2a44-0c3e-4b7a-8f61-2d5e8b9a1c33',
				description: 'Only return runs of this scraper',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: SCRAPER_RUN_STATUS_OPTIONS,
				default: 'completed',
			},
		],
	},
];

export const scraperRunHandlers: ResourceHandlers = {
	async get(i) {
		const runId = this.getNodeParameter('runId', i, '', { extractValue: true }) as string;
		const body = (await manyPiApiRequest.call(
			this,
			'GET',
			`/api/runs/${segment(runId)}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'scraper run' },
		)) as IDataObject;
		return (body.data ?? body) as IDataObject;
	},

	async getData(i) {
		const scraperId = this.getNodeParameter('scraperId', i, '', { extractValue: true }) as string;
		const runId = this.getNodeParameter('runId', i, '', { extractValue: true }) as string;
		const data = await manyPiApiRequest.call(
			this,
			'GET',
			`/api/${segment(scraperId)}/data/${segment(runId)}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'scraper run data' },
		);
		// The extracted data follows each scraper's own schema, so it goes under
		// `data` where none of its fields can collide with the run's.
		return { runId, scraperId, data: data as IDataObject };
	},

	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		// The route filters on neither scraper nor status, so both are applied
		// here while paging.
		return await fetchOffsetPages.call(this, {
			path: '/api/runs',
			pageSize: 100,
			returnAll,
			limit,
			itemIndex: i,
			map: normalizeScraperRun,
			filter: (run) =>
				(!filters.status || run.status === filters.status) &&
				(!filters.scraperId || run.scraper_id === filters.scraperId),
		});
	},
};
