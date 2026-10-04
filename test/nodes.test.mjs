// Behaviour tests for the compiled nodes. Run `npm run build` first; `npm test`
// does both. No network access and no ManyPI account needed.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import {
	createTransport,
	executeContext,
	loadContext,
	locatorValue,
	pollContext,
} from './harness.mjs';

const require = createRequire(import.meta.url);
const { ManyPi } = require('../dist/nodes/ManyPi/ManyPi.node.js');
const { ManyPiTrigger } = require('../dist/nodes/ManyPi/ManyPiTrigger.node.js');
const { ManyPiApi } = require('../dist/credentials/ManyPiApi.credentials.js');
const listSearch = require('../dist/nodes/ManyPi/shared/listSearch.js');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');

const node = new ManyPi();
const BASE = 'https://app.manypi.com';

async function run(params, responses, options = {}) {
	const transport = createTransport(responses);
	const context = executeContext({ params, transport, ...options });
	const [output] = await node.execute.call(context);
	return { output, calls: transport.calls, transport };
}

const lead = (n) => ({ id: `lead-${n}`, email: `l${n}@example.com`, created_at: '2026-09-01T00:00:00Z' });

describe('node description', () => {
	it('declares every resource and wires an operation handler for each option', () => {
		const properties = node.description.properties;
		const resources = properties.find((p) => p.name === 'resource').options.map((o) => o.value);
		assert.equal(resources.length, 16);
		for (const resource of resources) {
			const operation = properties.find(
				(p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes(resource),
			);
			assert.ok(operation, `no operation list for ${resource}`);
			assert.ok(operation.options.length > 0);
		}
	});

	it('names every list search method a locator refers to', () => {
		const methods = new Set(Object.keys(node.methods.listSearch));
		const walk = (props) => {
			for (const prop of props) {
				for (const mode of prop.modes ?? []) {
					const method = mode.typeOptions?.searchListMethod;
					if (method) assert.ok(methods.has(method), `missing listSearch.${method}`);
				}
				if (prop.options) walk(prop.options.filter((o) => typeof o === 'object' && 'type' in o));
			}
		};
		walk(node.description.properties);
	});

	it('authenticates with a bearer header and tests against /api/user', () => {
		const credential = new ManyPiApi();
		assert.equal(credential.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
		assert.equal(credential.test.request.baseURL, BASE);
		assert.equal(credential.test.request.url, '/api/user');
		assert.equal(credential.properties[0].typeOptions.password, true);
	});
});

describe('requests', () => {
	it('flattens the account envelope', async () => {
		const { output, calls } = await run(
			{ resource: 'account', operation: 'get' },
			[{ body: { data: { userId: 'u1', email: 'a@example.com' } } }],
		);
		assert.equal(calls[0].method, 'GET');
		assert.equal(calls[0].url, `${BASE}/api/user`);
		assert.equal(calls[0].credentialType, 'manyPiApi');
		assert.deepEqual(output[0].json, { id: 'u1', userId: 'u1', email: 'a@example.com' });
		assert.deepEqual(output[0].pairedItem, { item: 0 });
	});

	it('starts a scraper run without waiting', async () => {
		const { output, calls } = await run(
			{
				resource: 'scraper',
				operation: 'run',
				scraperId: locatorValue('scr/1'),
				waitForCompletion: false,
				additionalFields: {},
			},
			[
				{
					statusCode: 202,
					body: {
						success: true,
						data: { runId: 'run-1', status: 'pending' },
						metadata: { creditsRemaining: 10 },
					},
				},
			],
		);
		assert.equal(calls[0].method, 'POST');
		// The ID is encoded, so a mapped value cannot change the route.
		assert.equal(calls[0].url, `${BASE}/api/scrape/scr%2F1`);
		assert.deepEqual(calls[0].body, {});
		assert.deepEqual(output[0].json, {
			runId: 'run-1',
			scraperId: 'scr/1',
			status: 'pending',
			creditsRemaining: 10,
		});
	});

	it('waits for a scraper run and returns the full data', { timeout: 20000 }, async () => {
		const { output, calls } = await run(
			{
				resource: 'scraper',
				operation: 'run',
				scraperId: locatorValue('scr-1'),
				waitForCompletion: true,
				maxWaitSeconds: 60,
				additionalFields: { url: 'https://example.com/p' },
			},
			[
				{ statusCode: 202, body: { data: { runId: 'run-1', status: 'pending' }, metadata: {} } },
				{ body: { data: { runId: 'run-1', status: 'running' } } },
				{ body: { data: { runId: 'run-1', status: 'completed', metadata: { creditsUsed: 3 } } } },
				{ body: { price: 49, product: 'Pro' } },
			],
		);
		assert.deepEqual(calls[0].body, { url: 'https://example.com/p' });
		assert.equal(calls[1].url, `${BASE}/api/runs/run-1`);
		assert.equal(calls[3].url, `${BASE}/api/scr-1/data/run-1`);
		assert.equal(output[0].json.status, 'completed');
		assert.equal(output[0].json.waitTimedOut, false);
		assert.deepEqual(output[0].json.data, { price: 49, product: 'Pro' });
	});

	it('pages through leads until the records run out', async () => {
		const page1 = Array.from({ length: 500 }, (_, n) => lead(n));
		const page2 = [lead(500), lead(501), lead(502)];
		const { output, calls } = await run(
			{ resource: 'lead', operation: 'getAll', returnAll: true, simplify: false, filters: { status: 'new' } },
			[{ body: { leads: page1 } }, { body: { leads: page2 } }],
		);
		assert.equal(output.length, 503);
		assert.equal(calls[0].qs.offset, 0);
		assert.equal(calls[0].qs.limit, 500);
		assert.equal(calls[0].qs.status, 'new');
		assert.equal(calls[1].qs.offset, 500);
		// Empty filters never reach the query string.
		assert.equal('q' in calls[0].qs, false);
	});

	it('stops at the limit without fetching another page', async () => {
		const { output, calls } = await run(
			{ resource: 'lead', operation: 'getAll', returnAll: false, limit: 2, simplify: true, filters: {} },
			[{ body: { leads: [lead(1), { ...lead(2), custom: { x: 1 }, phone: '1' }, lead(3)] } }],
		);
		assert.equal(calls.length, 1);
		assert.equal(output.length, 2);
		assert.equal('custom' in output[1].json, false, 'Simplify keeps only the chosen fields');
	});

	it('refuses placeholder leads from a billing-locked workspace', async () => {
		await assert.rejects(
			run(
				{ resource: 'lead', operation: 'getAll', returnAll: true, simplify: false, filters: {} },
				[{ body: { leads: [{ id: 'placeholder' }], billingLock: { reason: 'past_due' } } }],
			),
			(error) => error instanceof NodeOperationError && /locked for billing/.test(error.message),
		);
	});

	it('updates a lead one field per request, then the state change first', async () => {
		const { output, calls } = await run(
			{
				resource: 'lead',
				operation: 'update',
				leadId: locatorValue('lead-1'),
				updateFields: { status: 'qualified', company: 'Acme', phone: '', clearFields: 'tech_stack' },
				customFields: { field: [{ key: 'tier', value: 'gold' }] },
			},
			[
				{ body: { lead: { id: 'lead-1', status: 'qualified' } } },
				{ body: { lead: { id: 'lead-1', company: 'Acme' } } },
				{ body: { lead: { id: 'lead-1', custom: { tier: 'gold' } } } },
				{ body: { lead: { id: 'lead-1', custom: { tier: 'gold', tech_stack: null } } } },
			],
		);
		assert.deepEqual(
			calls.map((call) => call.body),
			[
				{ status: 'qualified' },
				{ field: 'company', value: 'Acme' },
				{ field: 'tier', value: 'gold' },
				{ field: 'tech_stack', value: '' },
			],
		);
		assert.ok(calls.every((call) => call.method === 'PATCH' && call.url === `${BASE}/api/leads/lead-1`));
		assert.deepEqual(output[0].json.custom, { tier: 'gold', tech_stack: null });
	});

	it('names the outcome of a lead upsert', async () => {
		const { output, calls } = await run(
			{
				resource: 'lead',
				operation: 'upsert',
				email: 'nathan@example.com',
				additionalFields: { fullName: 'Nathan', score: 80 },
				customFields: { field: [{ key: 'tech_stack', value: 'Shopify' }] },
				options: { declareColumns: true, duplicates: 'overwrite' },
			},
			[{ body: { created: 0, updated: 1 } }],
		);
		assert.equal(calls[0].url, `${BASE}/api/leads/import`);
		assert.deepEqual(calls[0].body, {
			rows: [{ email: 'nathan@example.com', full_name: 'Nathan', score: 80, custom: { tech_stack: 'Shopify' } }],
			duplicates: 'overwrite',
			declare_fields: [{ label: 'tech_stack', key: 'tech_stack' }],
		});
		assert.equal(output[0].json.result, 'updated');
	});

	it('rejects an import over 100 rows before sending anything', async () => {
		const rows = JSON.stringify(Array.from({ length: 101 }, (_, n) => ({ email: `x${n}@example.com` })));
		const transport = createTransport([]);
		const context = executeContext({
			params: { resource: 'lead', operation: 'import', leads: rows, importOptions: {} },
			transport,
		});
		await assert.rejects(node.execute.call(context), /at most 100 leads/);
		assert.equal(transport.calls.length, 0);
	});

	it('exports leads as a binary file', async () => {
		const csv = 'id,email\nlead-1,a@example.com\n';
		const { output, calls } = await run(
			{
				resource: 'lead',
				operation: 'export',
				format: 'csv',
				binaryPropertyName: 'data',
				filters: { status: 'qualified' },
			},
			[{ body: Buffer.from(csv), headers: { 'content-type': 'text/csv; charset=utf-8' } }],
		);
		assert.equal(calls[0].encoding, 'arraybuffer');
		assert.equal(calls[0].json, false);
		assert.equal(calls[0].qs.format, 'csv');
		const file = output[0].binary.data;
		assert.equal(file.mimeType, 'text/csv');
		assert.equal(file.fileName, 'manypi-leads.csv');
		assert.equal(Buffer.from(file.data, 'base64').toString(), csv);
		assert.deepEqual(output[0].pairedItem, { item: 0 });
	});

	it('totals the skip counters when enrolling leads', async () => {
		const { output, calls } = await run(
			{
				resource: 'campaign',
				operation: 'enrollLeads',
				campaignId: locatorValue('c1'),
				leadIds: 'a, b,\nc',
			},
			[{ body: { enrolled: 1, skipped_no_email: 1, already_enrolled: 1 } }],
		);
		assert.deepEqual(calls[0].body, { campaign_id: 'c1', lead_ids: ['a', 'b', 'c'] });
		assert.equal(output[0].json.skipped, 2);
		assert.equal(output[0].json.submitted, 3);
	});

	it('sends campaign removals as query parameters', async () => {
		const { calls } = await run(
			{ resource: 'campaign', operation: 'removeLeads', campaignId: locatorValue('c1'), leadIds: 'a,b' },
			[{ body: { removed: 1 } }],
		);
		assert.equal(calls[0].method, 'DELETE');
		assert.deepEqual(calls[0].qs, { campaign_id: 'c1', lead_ids: 'a,b' });
		assert.equal(calls[0].body, undefined);
	});

	it('reports a pending endpoint call instead of an empty result', async () => {
		const { output, calls } = await run(
			{
				resource: 'endpoint',
				operation: 'invoke',
				endpointSlug: locatorValue('pricing'),
				parameters: '{"url": "https://example.com", "pages": 2}',
			},
			[{ statusCode: 202, body: { status: 'accepted', run_id: 'r1', poll: '/v1/e/pricing/results/r1' } }],
		);
		assert.equal(calls[0].method, 'POST');
		assert.equal(calls[0].url, `${BASE}/v1/e/pricing`);
		assert.deepEqual(calls[0].body, { url: 'https://example.com', pages: 2 });
		assert.deepEqual(output[0].json, { slug: 'pricing', pending: true, status: 'accepted', run_id: 'r1' });
	});

	it('nests a finished endpoint result under data', async () => {
		const { output } = await run(
			{ resource: 'endpoint', operation: 'invoke', endpointSlug: locatorValue('pricing'), parameters: {} },
			[{ body: { pending: 'scraped value', tiers: [] }, headers: { 'x-manypi-cache': 'hit', 'x-manypi-run-id': 'r2' } }],
		);
		assert.equal(output[0].json.pending, false, "the endpoint's own fields cannot overwrite ours");
		assert.equal(output[0].json.cache, 'hit');
		assert.deepEqual(output[0].json.data, { pending: 'scraped value', tiers: [] });
	});

	it('refuses a sequence step with no subject unless it replies in thread', async () => {
		const params = {
			resource: 'sequence',
			operation: 'create',
			name: 'Intro',
			additionalFields: {},
			steps: {
				step: [
					{ subject: 'Hi', bodyHtml: '<p>1</p>', waitDays: 5, threadMode: 'reply' },
					{ subject: '', bodyHtml: '<p>2</p>', waitDays: 3, threadMode: 'new' },
				],
			},
		};
		await assert.rejects(run(params, []), /Step 2 has no subject/);

		params.steps.step[1].threadMode = 'reply';
		const { calls } = await run(params, [{ body: { sequence: { id: 's1' } } }]);
		// The first step always sends on enrollment as a new email.
		assert.deepEqual(calls[0].body.steps[0], {
			subject: 'Hi',
			body_html: '<p>1</p>',
			wait_days: 0,
			thread_mode: 'new',
		});
	});

	it('requires a recipient before sending an email', async () => {
		await assert.rejects(
			run(
				{
					resource: 'email',
					operation: 'send',
					inboxId: locatorValue('i1'),
					leadId: locatorValue(''),
					subject: 'Hi',
					html: '<p>Hi</p>',
					additionalFields: {},
				},
				[],
			),
			/no recipient/,
		);
	});
});

describe('OAuth2', () => {
	const { ManyPiOAuth2Api } = require('../dist/credentials/ManyPiOAuth2Api.credentials.js');

	it('registers itself with ManyPI through dynamic client registration', () => {
		const credential = new ManyPiOAuth2Api();
		assert.equal(credential.name, 'manyPiOAuth2Api');
		assert.deepEqual(credential.extends, ['oAuth2Api']);
		const prop = (name) => credential.properties.find((p) => p.name === name);
		assert.equal(prop('useDynamicClientRegistration').default, true);
		assert.equal(prop('serverUrl').default, 'https://rtedeohuyuwawyvamvyf.supabase.co/auth/v1');
	});

	it('offers both credentials, each behind the Authentication choice', () => {
		for (const description of [node.description, new ManyPiTrigger().description]) {
			assert.deepEqual(
				description.credentials.map((c) => [c.name, c.displayOptions.show.authentication[0]]),
				[['manyPiApi', 'apiKey'], ['manyPiOAuth2Api', 'oAuth2']],
			);
			assert.equal(description.properties[0].name, 'authentication');
			assert.equal(description.properties[0].default, 'apiKey');
		}
	});

	it('signs requests with the credential the node is set to', async () => {
		const apiKey = await run({ resource: 'account', operation: 'get' }, [{ body: { data: {} } }]);
		assert.equal(apiKey.calls[0].credentialType, 'manyPiApi');
		const oauth = await run({ resource: 'account', operation: 'get', authentication: 'oAuth2' }, [{ body: { data: {} } }]);
		assert.equal(oauth.calls[0].credentialType, 'manyPiOAuth2Api');
	});

	it('lets error statuses throw, which is what makes n8n renew an expired token', async () => {
		const { calls } = await run({ resource: 'account', operation: 'get', authentication: 'oAuth2' }, [{ body: { data: {} } }]);
		assert.equal(calls[0].ignoreHttpStatusErrors, undefined);
	});

	it('uses the OAuth2 credential in the trigger and in list searches too', async () => {
		const trigger = new ManyPiTrigger();
		const pollTransport = createTransport([{ body: [] }]);
		await trigger.poll.call(
			pollContext({
				params: { authentication: 'oAuth2', event: 'scraperRun', statuses: ['completed'], scraperId: locatorValue('') },
				transport: pollTransport,
			}),
		);
		assert.equal(pollTransport.calls[0].credentialType, 'manyPiOAuth2Api');

		const listTransport = createTransport([{ body: { scrapers: [] } }]);
		await listSearch.searchScrapers.call(loadContext({ params: { authentication: 'oAuth2' }, transport: listTransport }));
		assert.equal(listTransport.calls[0].credentialType, 'manyPiOAuth2Api');
	});

	it('stops endpoint calls before sending them, since /v1/e only takes API keys', async () => {
		const transport = createTransport([]);
		const context = executeContext({
			params: { authentication: 'oAuth2', resource: 'endpoint', operation: 'invoke', endpointSlug: locatorValue('pricing'), parameters: '{}' },
			transport,
		});
		await assert.rejects(
			node.execute.call(context),
			(error) => error instanceof NodeOperationError && /need an API key/.test(error.message),
		);
		assert.equal(transport.calls.length, 0);
	});

	it('asks for a reconnect when ManyPI still refuses the token', async () => {
		await assert.rejects(
			run(
				{ resource: 'account', operation: 'get', authentication: 'oAuth2' },
				[{ statusCode: 401, body: { error: 'Unauthorized' } }],
			),
			(error) =>
				error instanceof NodeApiError &&
				error.message === 'ManyPI did not accept the OAuth2 connection' &&
				error.description.includes('reconnect'),
		);
	});
});

describe('regressions from the route review', () => {
	it('sends the campaign that reply insights require', async () => {
		const { calls } = await run(
			{ resource: 'reply', operation: 'getInsights', campaignId: locatorValue('c1') },
			[{ body: { suggestions: [] } }],
		);
		assert.deepEqual(calls[0].qs, { campaign: 'c1' });
	});

	it('refuses a sentiment filter the plan would silently ignore', async () => {
		const params = {
			resource: 'reply',
			operation: 'getAll',
			returnAll: false,
			limit: 10,
			simplify: true,
			filters: { sentiment: 'positive' },
		};
		await assert.rejects(
			run(params, [{ body: { replies: [{ id: 'r1' }], canSeeSentiment: false } }]),
			/does not include reply sentiment/,
		);
		const trigger = new ManyPiTrigger();
		const transport = createTransport([{ body: { replies: [], canSeeSentiment: false } }]);
		await assert.rejects(
			trigger.poll.call(
				pollContext({
					params: { event: 'reply', kind: 'reply', campaignId: locatorValue(''), replyFilters: { sentiment: 'positive' } },
					transport,
				}),
			),
			/does not include reply sentiment/,
		);
	});

	it("merges overrides into a saved search's criteria instead of replacing them", async () => {
		const { output, calls } = await run(
			{
				resource: 'leadSearch',
				operation: 'start',
				description: '',
				savedSearchId: locatorValue('p1'),
				seedLeadIds: '',
				criteria: { count: 50 },
				options: {},
			},
			[
				{ body: { profiles: [{ id: 'p1', name: 'DTC', criteria: { description: 'DTC brands', count: 25, titles: ['CEO'] } }] } },
				{ body: { run_id: 'run-1', status: 'queued' } },
			],
		);
		assert.deepEqual(calls[1].body, {
			criteria: { description: 'DTC brands', count: 50, titles: ['CEO'] },
			profile_id: 'p1',
			save: false,
			check_intent: false,
		});
		assert.equal(output[0].json.started, true);
	});

	it('reports known leads instead of claiming a search started', async () => {
		const { output } = await run(
			{
				resource: 'leadSearch',
				operation: 'start',
				description: 'Northwind Studio',
				savedSearchId: locatorValue(''),
				seedLeadIds: '',
				criteria: {},
				options: {},
			},
			[{ body: { known: { leads: [{ id: 'l1' }] }, description: 'Northwind Studio' } }],
		);
		assert.equal(output[0].json.started, false);
		assert.deepEqual(output[0].json.known, { leads: [{ id: 'l1' }] });
	});

	it('keeps the name and kind of a saved search it updates', async () => {
		const { calls } = await run(
			{
				resource: 'leadSearch',
				operation: 'upsert',
				description: 'DTC brands in the UK',
				savedSearchId: locatorValue('p1'),
				criteria: {},
				options: {},
			},
			[
				{ body: { profiles: [{ id: 'p1', name: 'DTC', kind: 'similar', criteria: {} }] } },
				{ body: { profile: { id: 'p1' } } },
			],
		);
		assert.equal(calls[1].body.name, 'DTC');
		assert.equal(calls[1].body.kind, 'similar');
	});

	it('names an unchanged upsert and returns the lead ID', async () => {
		const { output, calls } = await run(
			{
				resource: 'lead',
				operation: 'upsert',
				email: 'nathan@example.com',
				additionalFields: {},
				customFields: { field: [{ key: 'Tech Stack', value: 'Shopify' }] },
				options: { declareColumns: true },
			},
			[{ body: { created: 0, updated: 0, skippedDuplicate: 0, failed: [], rowLeadIds: ['lead-9'] } }],
		);
		assert.deepEqual(calls[0].body.rows[0].custom, { tech_stack: 'Shopify' });
		assert.deepEqual(calls[0].body.declare_fields, [{ label: 'Tech Stack', key: 'tech_stack' }]);
		assert.equal(output[0].json.result, 'unchanged');
		assert.equal(output[0].json.leadId, 'lead-9');
	});

	it('files imported custom values under their column keys', async () => {
		const { calls } = await run(
			{
				resource: 'lead',
				operation: 'import',
				leads: [{ email: 'a@example.com', custom: { 'Tech Stack': 'Shopify', 'Année': 2024 } }],
				importOptions: {},
			},
			[{ body: { created: 1 } }],
		);
		assert.deepEqual(calls[0].body.rows[0].custom, { tech_stack: 'Shopify', annee: 2024 });
	});

	it('checks that a record exists before reporting it deleted', async () => {
		await assert.rejects(
			run(
				{ resource: 'lead', operation: 'delete', leadId: locatorValue('missing') },
				[{ statusCode: 404, body: { error: 'Not found' } }],
			),
			/The lead was not found/,
		);
		const { calls } = await run(
			{ resource: 'campaign', operation: 'delete', campaignId: locatorValue('c1') },
			[{ body: { campaign: { id: 'c1' } } }, { body: { ok: true } }],
		);
		assert.deepEqual(
			calls.map((call) => `${call.method} ${call.url.replace(BASE, '')}`),
			['GET /api/outreach/campaigns/c1', 'DELETE /api/outreach/campaigns'],
		);
	});

	it('does not claim to cancel a run that already finished', async () => {
		const { output, calls } = await run(
			{ resource: 'agentRun', operation: 'cancel', agentRunId: locatorValue('a1') },
			[{ body: { id: 'a1', status: 'completed' } }],
		);
		assert.equal(calls.length, 1, 'no cancel request for a finished run');
		assert.deepEqual(output[0].json, { id: 'a1', cancelled: false, previousStatus: 'completed' });
	});

	it('reports whether an address was actually unsuppressed', async () => {
		const { output, calls } = await run(
			{ resource: 'suppression', operation: 'remove', email: 'Nathan@Example.com' },
			[{ body: { suppressions: [{ email: 'other@example.com' }] } }],
		);
		assert.equal(calls.length, 1, 'nothing to remove, so no delete');
		assert.deepEqual(output[0].json, { email: 'Nathan@Example.com', removed: false });
	});

	it('totals every enrollment skip reason the route reports', async () => {
		const { output } = await run(
			{ resource: 'campaign', operation: 'enrollLeads', campaignId: locatorValue('c1'), leadIds: 'a,b,c,d' },
			[{ body: { enrolled: 0, skipped_unsubscribed: 2, skipped_bounced: 1, skipped_over_limit: 1, queued_for_validation: 3 } }],
		);
		assert.equal(output[0].json.skipped, 4);
	});

	it('returns the campaign itself from create, not its envelope', async () => {
		const { output } = await run(
			{
				resource: 'campaign',
				operation: 'create',
				name: 'Q3',
				sequenceId: locatorValue('s1'),
				inboxId: locatorValue('i1'),
				additionalFields: { sendFrom: '09:00' },
			},
			[{ body: { campaign: { id: 'c1', name: 'Q3' } } }],
		);
		assert.equal(output[0].json.id, 'c1');
	});

	it('refuses send times and timezones ManyPI would silently drop', async () => {
		const base = { resource: 'campaign', operation: 'create', name: 'Q3', sequenceId: locatorValue('s1'), inboxId: locatorValue('i1') };
		await assert.rejects(run({ ...base, additionalFields: { sendFrom: '9am' } }, []), /Send From/);
		// The same Intl check ManyPI runs: "CEST" is refused there too.
		await assert.rejects(run({ ...base, additionalFields: { timezone: 'CEST' } }, []), /not a timezone/);
	});

	it('fires once per status for a run that pauses and then completes', async () => {
		const trigger = new ManyPiTrigger();
		const staticData = {};
		const params = { event: 'agentRun', statuses: ['paused', 'completed'], agentRunFilters: {} };
		const poll = (body) =>
			trigger.poll.call(pollContext({ params, transport: createTransport([{ body }]), staticData }));

		assert.equal(await poll([]), null);
		const [paused] = await poll([{ id: 'a1', status: 'paused', created_at: '2026-09-01' }]);
		assert.deepEqual(paused.map((item) => item.json.status), ['paused']);
		const [completed] = await poll([{ id: 'a1', status: 'completed', created_at: '2026-09-01' }]);
		assert.deepEqual(completed.map((item) => item.json.status), ['completed']);
		assert.equal(await poll([{ id: 'a1', status: 'completed', created_at: '2026-09-01' }]), null);
	});
});

describe('errors', () => {
	it('keeps the reason when a 429 is a sending limit, not a rate limit', async () => {
		await assert.rejects(
			run(
				{
					resource: 'email',
					operation: 'send',
					inboxId: locatorValue('i1'),
					leadId: locatorValue('l1'),
					subject: 'Hi',
					html: '<p>Hi</p>',
					additionalFields: {},
				},
				[{ statusCode: 429, body: { error: 'This inbox has sent its limit for the last 24 hours' } }],
			),
			(error) =>
				error.message === 'This inbox has sent its limit for the last 24 hours' &&
				error.description.includes('will not help'),
		);
	});

	it('spells out validation issues that arrive as an array', async () => {
		await assert.rejects(
			run(
				{ resource: 'lead', operation: 'deleteMany', leadIds: 'not-a-uuid' },
				[{ statusCode: 400, body: { error: [{ path: ['ids', 0], message: 'Invalid uuid' }] } }],
			),
			(error) => error.message === 'ids.0: Invalid uuid',
		);
	});

	it('names the missing permission on a 401', async () => {
		await assert.rejects(
			run(
				{ resource: 'scraper', operation: 'run', scraperId: locatorValue('s1'), waitForCompletion: false, additionalFields: {} },
				[{ statusCode: 401, body: { success: false, error: 'Invalid API key' } }],
			),
			(error) =>
				error instanceof NodeApiError &&
				error.message === 'ManyPI did not accept the API key' &&
				error.description.includes('"Run Scrapers"') &&
				error.description.includes('Invalid API key') &&
				error.httpCode === '401' &&
				error.context.itemIndex === 0,
		);
	});

	it('surfaces the API message on a 400', async () => {
		await assert.rejects(
			run(
				{ resource: 'skill', operation: 'create', title: 'x', systemPrompt: 'y', additionalFields: {} },
				[{ statusCode: 400, body: { error: 'Invalid parameters', details: ['title too long'] } }],
			),
			(error) => error instanceof NodeApiError && error.message === 'Invalid parameters: title too long',
		);
	});

	it('treats a redirect to sign-in as a failure, never as a result', async () => {
		const transport = createTransport([
			{ statusCode: 307, headers: { location: '/signin?redirectedFrom=%2Fv1%2Fe%2Fpricing' }, body: '' },
		]);
		const context = executeContext({
			params: { resource: 'endpoint', operation: 'getResult', endpointSlug: locatorValue('pricing'), runId: 'r1' },
			transport,
		});
		await assert.rejects(
			node.execute.call(context),
			(error) =>
				error instanceof NodeApiError &&
				error.httpCode === '307' &&
				error.description.includes('does not accept API keys'),
		);
		assert.equal(transport.calls[0].disableFollowRedirect, true);
	});

	it('says which record was not found on a 404', async () => {
		await assert.rejects(
			run(
				{ resource: 'agentRun', operation: 'get', agentRunId: locatorValue('nope') },
				[{ statusCode: 404, body: { error: 'Not found' } }],
			),
			(error) => error.message === 'The agent run was not found in ManyPI',
		);
	});

	it('keeps going per item when Continue On Fail is on', async () => {
		const { output } = await run(
			[
				{ resource: 'agentRun', operation: 'get', agentRunId: locatorValue('a') },
				{ resource: 'agentRun', operation: 'get', agentRunId: locatorValue('b') },
			],
			[{ statusCode: 500, body: 'oops' }, { body: { id: 'b', status: 'completed' } }],
			{ continueOnFail: true },
		);
		assert.equal(output.length, 2);
		assert.equal(output[0].json.error, 'ManyPI could not complete the request');
		assert.deepEqual(output[0].pairedItem, { item: 0 });
		assert.equal(output[1].json.id, 'b');
		assert.deepEqual(output[1].pairedItem, { item: 1 });
	});
});

describe('trigger', () => {
	const trigger = new ManyPiTrigger();
	const runs = (...items) => ({ body: items });

	it('is a polling trigger with no inputs', () => {
		assert.equal(trigger.description.polling, true);
		assert.deepEqual(trigger.description.inputs, []);
		assert.equal(trigger.description.usableAsTool, undefined);
	});

	it('records the backlog on the first poll, then fires only for new matches', async () => {
		const staticData = {};
		const params = { event: 'scraperRun', statuses: ['completed'], scraperId: locatorValue('') };

		const first = createTransport([
			runs({ id: 'r1', status: 'completed', scraperId: 's1' }, { id: 'r2', status: 'pending', scraperId: 's1' }),
		]);
		assert.equal(await trigger.poll.call(pollContext({ params, transport: first, staticData })), null);
		// Status events remember the ID together with the status it reached.
		assert.deepEqual(staticData.seen, ['r1:completed']);

		// r2 finished and r3 arrived finished: both fire once, oldest first.
		const second = createTransport([
			runs(
				{ id: 'r3', status: 'completed', scraperId: 's1' },
				{ id: 'r2', status: 'completed', scraperId: 's1' },
				{ id: 'r1', status: 'completed', scraperId: 's1' },
			),
		]);
		const [items] = await trigger.poll.call(pollContext({ params, transport: second, staticData }));
		assert.deepEqual(items.map((item) => item.json.id), ['r2', 'r3']);

		const third = createTransport([runs({ id: 'r3', status: 'completed', scraperId: 's1' })]);
		assert.equal(await trigger.poll.call(pollContext({ params, transport: third, staticData })), null);
	});

	it('starts over without firing when the filters change', async () => {
		const staticData = { key: JSON.stringify({ event: 'lead', status: 'new' }), seen: ['old'] };
		const transport = createTransport([{ body: { leads: [lead(1)] } }]);
		const result = await trigger.poll.call(
			pollContext({ params: { event: 'lead', leadFilters: { status: 'qualified' } }, transport, staticData }),
		);
		assert.equal(result, null);
		assert.deepEqual(staticData.seen, ['lead-1']);
	});

	it('returns the newest match in a manual test without touching the state', async () => {
		const staticData = {};
		const transport = createTransport([
			{ body: { replies: [{ id: 'old', received_at: '2026-01-01' }, { id: 'new', received_at: '2026-09-01' }] } },
		]);
		const [items] = await trigger.poll.call(
			pollContext({
				params: { event: 'reply', kind: 'reply', campaignId: locatorValue(''), replyFilters: {} },
				transport,
				staticData,
				mode: 'manual',
			}),
		);
		assert.deepEqual(items.map((item) => item.json.id), ['new']);
		assert.deepEqual(staticData, {});
		assert.equal(transport.calls[0].qs.kind, 'reply');
		assert.equal('campaign' in transport.calls[0].qs, false);
	});
});

describe('list search', () => {
	it('searches leads on the server and pages with an offset token', async () => {
		const transport = createTransport([{ body: { leads: Array.from({ length: 100 }, (_, n) => lead(n)) } }]);
		const result = await listSearch.searchLeads.call(loadContext({ transport }), 'acme', '200');
		assert.equal(transport.calls[0].qs.q, 'acme');
		assert.equal(transport.calls[0].qs.offset, 200);
		assert.equal(result.paginationToken, '300');
		assert.equal(result.results[0].value, 'lead-0');
	});

	it('filters scrapers by name locally', async () => {
		const transport = createTransport([
			{ body: { scrapers: [{ id: '1', scraper_name: 'Competitor pricing' }, { id: '2', scraper_name: 'Jobs' }] } },
		]);
		const result = await listSearch.searchScrapers.call(loadContext({ transport }), 'PRICING');
		assert.deepEqual(result.results, [{ name: 'Competitor pricing', value: '1' }]);
	});
});
