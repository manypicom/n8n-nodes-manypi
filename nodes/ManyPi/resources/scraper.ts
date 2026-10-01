import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';
import { locator, returnAllAndLimit, showFor } from '../shared/descriptions';
import { manyPiApiRequest, segment } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { applyLimit, asArray, containsText, prune } from '../shared/utils';

const RESOURCE = 'scraper';
const FINISHED = ['completed', 'failed', 'cancelled'];

export const scraperDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many scrapers',
				description: 'Retrieve a list of your scrapers with their target URL, status and schema',
			},
			{
				name: 'Run',
				value: 'run',
				action: 'Run a scraper',
				description:
					'Start a scraper run, and optionally wait for it to finish and return the extracted data',
			},
		],
		default: 'run',
	},

	// ── Run ───────────────────────────────────────────────────────────────────
	locator({
		displayName: 'Scraper',
		name: 'scraperId',
		noun: 'scraper',
		searchListMethod: 'searchScrapers',
		show: showFor(RESOURCE, 'run'),
		description: 'The scraper to run',
	}),
	{
		displayName: 'Wait for Completion',
		name: 'waitForCompletion',
		type: 'boolean',
		default: true,
		description:
			'Whether to wait for the run to finish and return the extracted data. When off, the node returns the run ID at once.',
		displayOptions: { show: showFor(RESOURCE, 'run') },
	},
	{
		displayName: 'Max Wait (Seconds)',
		name: 'maxWaitSeconds',
		type: 'number',
		typeOptions: { minValue: 10, maxValue: 900, numberPrecision: 0 },
		default: 180,
		description:
			'How long to wait before returning. A run that is still going comes back with Wait Timed Out set, and keeps running in ManyPI.',
		displayOptions: { show: { ...showFor(RESOURCE, 'run'), waitForCompletion: [true] } },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'run') },
		options: [
			{
				displayName: 'URL Override',
				name: 'url',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://example.com/pricing',
				description: "Scrape this URL instead of the scraper's saved target, for this run only",
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
			{
				displayName: 'Name Contains',
				name: 'name',
				type: 'string',
				default: '',
			},
		],
	},
];

export const scraperHandlers: ResourceHandlers = {
	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const body = await manyPiApiRequest.call(this, 'GET', '/api/scrapers', undefined, undefined, {
			itemIndex: i,
		});
		const scrapers = asArray(body, 'scrapers').filter(
			(scraper) => !filters.name || containsText(scraper.scraper_name, filters.name as string),
		);
		return applyLimit(scrapers, returnAll, limit);
	},

	async run(i) {
		const scraperId = this.getNodeParameter('scraperId', i, '', { extractValue: true }) as string;
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;

		const started = (await manyPiApiRequest.call(
			this,
			'POST',
			`/api/scrape/${segment(scraperId)}`,
			prune({ url: additional.url }),
			undefined,
			{ itemIndex: i, resourceLabel: 'scraper' },
		)) as IDataObject;
		const startedData = (started.data ?? {}) as IDataObject;
		const metadata = (started.metadata ?? {}) as IDataObject;
		const runId = startedData.runId as string;
		const queued: IDataObject = {
			runId,
			scraperId,
			status: startedData.status ?? 'pending',
			creditsRemaining: metadata.creditsRemaining,
		};

		if (!(this.getNodeParameter('waitForCompletion', i, true) as boolean)) return queued;

		const deadline = Date.now() + (this.getNodeParameter('maxWaitSeconds', i, 180) as number) * 1000;
		let delay = 2000;
		let run: IDataObject = queued;
		while (!FINISHED.includes(String(run.status))) {
			if (Date.now() + delay > deadline) {
				return { ...queued, status: run.status, waitTimedOut: true };
			}
			await sleep(delay);
			delay = Math.min(Math.round(delay * 1.5), 10000);
			const polled = (await manyPiApiRequest.call(
				this,
				'GET',
				`/api/runs/${segment(runId)}`,
				undefined,
				undefined,
				{ itemIndex: i, resourceLabel: 'scraper run' },
			)) as IDataObject;
			run = (polled.data ?? polled) as IDataObject;
		}

		if (run.status !== 'completed') {
			throw new NodeOperationError(this.getNode(), `The scraper run ${run.status}`, {
				itemIndex: i,
				description: `Run ID ${runId}. Open it under Runs in the ManyPI dashboard to see what happened, then run the node again.`,
			});
		}

		// The run status carries an inline copy that is cut short for large
		// results. The data route hydrates the full result from storage.
		const data = await manyPiApiRequest.call(
			this,
			'GET',
			`/api/${segment(scraperId)}/data/${segment(runId)}`,
			undefined,
			undefined,
			{ itemIndex: i, resourceLabel: 'scraper run data' },
		);
		return {
			runId,
			scraperId,
			status: run.status,
			metadata: run.metadata,
			downloadUrl: run.downloadUrl,
			creditsRemaining: metadata.creditsRemaining,
			waitTimedOut: false,
			data: data as IDataObject,
		};
	},
};
