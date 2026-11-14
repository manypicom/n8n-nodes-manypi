import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';
import { manyPiApiRequest } from './transport';
import { asArray, containsText, inboxLabel, newestFirst, normalizeInbox } from './utils';

const LEAD_PAGE = 100;

function matching(
	records: IDataObject[],
	filter: string | undefined,
	toItem: (record: IDataObject) => INodeListSearchItems,
): INodeListSearchResult {
	const items = records.map(toItem);
	const results = filter ? items.filter((item) => containsText(item.name, filter)) : items;
	return { results };
}

function shortDate(value: unknown): string {
	return typeof value === 'string' ? value.slice(0, 16).replace('T', ' ') : '';
}

export async function searchScrapers(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const body = await manyPiApiRequest.call(this, 'GET', '/api/scrapers');
	return matching(asArray(body, 'scrapers'), filter, (scraper) => ({
		name: String(scraper.scraper_name ?? scraper.id),
		value: String(scraper.id),
	}));
}

export async function searchScraperRuns(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const [runsBody, scrapersBody] = await Promise.all([
		manyPiApiRequest.call(this, 'GET', '/api/runs', undefined, { limit: 100, offset: 0 }),
		manyPiApiRequest.call(this, 'GET', '/api/scrapers'),
	]);
	const names = new Map(
		asArray(scrapersBody, 'scrapers').map((scraper) => [
			String(scraper.id),
			String(scraper.scraper_name ?? ''),
		]),
	);
	return matching(asArray(runsBody), filter, (run) => {
		const scraperName = names.get(String(run.scraperId ?? run.scraper_id)) || 'Scraper run';
		return {
			name: `${scraperName} · ${run.status} · ${shortDate(run.createdAt ?? run.created_at)}`,
			value: String(run.id),
		};
	});
}

export async function searchAgentRuns(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const body = await manyPiApiRequest.call(this, 'GET', '/api/agents/runs', undefined, {
		limit: 100,
	});
	return matching(asArray(body), filter, (run) => ({
		name: `${String(run.goal ?? 'Untitled run').slice(0, 80)} (${run.status})`,
		value: String(run.id),
	}));
}

export async function searchLeads(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	// Leads are the one list that can run to thousands, so search server-side
	// and page, rather than loading everything to filter here.
	const offset = paginationToken ? parseInt(paginationToken, 10) || 0 : 0;
	const body = (await manyPiApiRequest.call(this, 'GET', '/api/leads', undefined, {
		q: filter,
		limit: LEAD_PAGE,
		offset,
		meta: '0',
	})) as IDataObject;
	const leads = body?.billingLock ? [] : asArray(body, 'leads');
	const results = leads.map((lead) => {
		const who = lead.full_name || lead.company || lead.email || lead.id;
		return {
			name: lead.email && lead.email !== who ? `${who} (${lead.email})` : String(who),
			value: String(lead.id),
		};
	});
	return {
		results,
		paginationToken: leads.length === LEAD_PAGE ? String(offset + LEAD_PAGE) : undefined,
	};
}

/**
 * Lead searches that saved leads, newest first. The leads list answers with
 * them under `campaigns` (each run's label, saved-lead count and start time),
 * so one small request gives the picker exactly the runs that have leads to
 * fetch. A search still running with nothing saved yet is not listed; its run
 * ID can still be entered by hand.
 */
export async function searchLeadSearchRuns(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const body = (await manyPiApiRequest.call(this, 'GET', '/api/leads', undefined, {
		limit: 1,
	})) as IDataObject;
	const runs = body?.billingLock ? [] : asArray(body, 'campaigns');
	return matching(runs, filter, (run) => {
		const count = Number(run.count ?? 0);
		const when = shortDate(run.created_at);
		return {
			name: `${String(run.label ?? run.id)} · ${count} ${count === 1 ? 'lead' : 'leads'}${when ? ` · ${when}` : ''}`,
			value: String(run.id),
		};
	});
}

export async function searchCampaigns(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	// view=names skips the per-campaign stats, which read every send and reply.
	const body = await manyPiApiRequest.call(this, 'GET', '/api/outreach/campaigns', undefined, {
		view: 'names',
	});
	return matching(asArray(body, 'campaigns'), filter, (campaign) => ({
		name: `${campaign.name ?? campaign.id} (${campaign.status})`,
		value: String(campaign.id),
	}));
}

export async function searchSequences(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const body = await manyPiApiRequest.call(this, 'GET', '/api/outreach/sequences');
	return matching(asArray(body, 'sequences'), filter, (sequence) => ({
		name: String(sequence.name ?? sequence.id),
		value: String(sequence.id),
	}));
}

export async function searchInboxes(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	// Current brand only: sending and campaigns resolve the inbox within the
	// active brand, so an inbox from another brand would fail at send time.
	const body = await manyPiApiRequest.call(this, 'GET', '/api/outreach/inboxes');
	return matching(asArray(body, 'inboxes').map(normalizeInbox), filter, (inbox) => ({
		name: inboxLabel(inbox),
		value: String(inbox.id),
	}));
}

export async function searchEndpoints(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const body = await manyPiApiRequest.call(this, 'GET', '/api/endpoints');
	return matching(asArray(body), filter, (endpoint) => ({
		name: `${endpoint.name ?? endpoint.slug} (/${endpoint.slug})`,
		value: String(endpoint.id),
	}));
}

/** Endpoints are invoked by slug, so this picker's value is the slug rather than the ID. */
export async function searchEndpointSlugs(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const body = await manyPiApiRequest.call(this, 'GET', '/api/endpoints');
	return matching(asArray(body), filter, (endpoint) => ({
		name: `${endpoint.name ?? endpoint.slug} (/${endpoint.slug})`,
		value: String(endpoint.slug),
	}));
}

export async function searchForms(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const body = await manyPiApiRequest.call(this, 'GET', '/api/forms');
	return matching(asArray(body, 'forms'), filter, (form) => ({
		name: `${String(form.name ?? form.key ?? form.id)} (${form.status})`,
		value: String(form.id),
		url: typeof form.url === 'string' ? form.url : undefined,
	}));
}

export async function searchSavedLeadSearches(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const body = await manyPiApiRequest.call(this, 'GET', '/api/leads/research-profiles');
	return matching(asArray(body, 'profiles'), filter, (profile) => ({
		name: String(profile.name ?? profile.id),
		value: String(profile.id),
	}));
}

export async function searchVerificationJobs(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const body = await manyPiApiRequest.call(this, 'GET', '/api/leads/validate', undefined, {
		limit: 50,
	});
	return matching(newestFirst(asArray(body, 'jobs'), 'created_at'), filter, (job) => ({
		name: `${shortDate(job.created_at)} · ${job.status} · ${job.total ?? 0} addresses`,
		value: String(job.id),
	}));
}
