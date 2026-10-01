import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { ManyPiContext } from './transport';
import { manyPiApiRequest } from './transport';

/**
 * Drop keys whose value carries nothing, so a parameter the user left blank
 * never overwrites a stored value with an empty one.
 */
export function prune(object: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(object)) {
		if (value === undefined || value === null || value === '') continue;
		if (Array.isArray(value) && value.length === 0) continue;
		if (
			typeof value === 'object' &&
			!Array.isArray(value) &&
			Object.keys(value as IDataObject).length === 0
		) {
			continue;
		}
		out[key] = value;
	}
	return out;
}

/**
 * Accept a list as an array, or as one string separated by commas or new
 * lines, which is what a value mapped from an earlier step often turns into.
 */
export function toList(value: unknown): string[] {
	if (value === undefined || value === null || value === '') return [];
	const raw = Array.isArray(value) ? value : [value];
	return raw
		.flatMap((item) => (typeof item === 'string' ? item.split(/[,\n]/) : [item]))
		.map((item) => (typeof item === 'string' ? item.trim() : String(item)))
		.filter((item) => item !== '' && item !== 'undefined' && item !== 'null');
}

/** Read a JSON parameter that may arrive as an object or as a JSON string. */
export function parseJsonParameter(
	this: IExecuteFunctions,
	value: unknown,
	displayName: string,
	itemIndex: number,
): unknown {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		throw new NodeOperationError(this.getNode(), `"${displayName}" is not valid JSON`, {
			itemIndex,
			description: 'Fix the JSON in this parameter, or map an object from an earlier node.',
		});
	}
}

export function parseJsonObjectParameter(
	this: IExecuteFunctions,
	value: unknown,
	displayName: string,
	itemIndex: number,
): IDataObject | undefined {
	const parsed = parseJsonParameter.call(this, value, displayName, itemIndex);
	if (parsed === undefined) return undefined;
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new NodeOperationError(this.getNode(), `"${displayName}" must be a JSON object`, {
			itemIndex,
			description: 'Use curly braces, e.g. {"type": "object", "properties": {}}.',
		});
	}
	return parsed as IDataObject;
}

/** Fail before any request when a batch is bigger than ManyPI accepts in one call. */
export function assertBatchSize(
	this: IExecuteFunctions,
	values: unknown[],
	max: number,
	label: string,
	itemIndex: number,
): void {
	if (values.length === 0) {
		throw new NodeOperationError(this.getNode(), `No ${label} were given`, {
			itemIndex,
			description: `Enter at least one of the ${label}, separated by commas, or map a list from an earlier node.`,
		});
	}
	if (values.length > max) {
		throw new NodeOperationError(
			this.getNode(),
			`ManyPI accepts at most ${max} ${label} per call, and this item has ${values.length}`,
			{
				itemIndex,
				description: `Split the list upstream, for example with a Loop Over Items node set to batches of ${max}.`,
			},
		);
	}
}

/**
 * ManyPI's rule for turning a column label into a custom field key (the same
 * as slugifyFieldKey in the app). Row values are filed under the slug, so a
 * key like "Tech Stack" has to arrive as "tech_stack" or it is dropped.
 */
export function slugifyFieldKey(label: string): string {
	const slug = label
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 40)
		.replace(/_+$/g, '');
	return /^[a-z]/.test(slug) ? slug : `f_${slug}`.slice(0, 40).replace(/_+$/g, '');
}

/** Rewrite the keys of a `custom` object to the slugs ManyPI files them under. */
export function slugifyCustomKeys(custom: unknown): IDataObject | undefined {
	if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return undefined;
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(custom as IDataObject)) {
		out[slugifyFieldKey(key)] = value;
	}
	return out;
}

/**
 * Total every skip counter an enrollment reports. The route names each reason
 * separately (no email, unsubscribed, bounced, over the batch limit and so on)
 * and adds new ones over time, so sum by prefix rather than by a fixed list.
 */
export function totalSkipped(result: IDataObject): number {
	return Object.entries(result)
		.filter(([key]) => key.startsWith('skipped_') || key === 'already_enrolled')
		.reduce((sum, [, value]) => sum + (typeof value === 'number' ? value : 0), 0);
}

export function simplify(record: IDataObject, keys: string[]): IDataObject {
	const out: IDataObject = {};
	for (const key of keys) {
		if (record[key] !== undefined) out[key] = record[key];
	}
	return out;
}

function pick(source: IDataObject, ...names: string[]): IDataObject[string] {
	for (const name of names) {
		const value = source[name];
		if (value !== undefined && value !== null) return value;
	}
	return undefined;
}

/**
 * The live inbox objects use different names from the published API spec
 * (`from` rather than `from_email`, `sent24h` rather than `sentToday`, and
 * camelCase pause fields). Expose both, plus two derived fields that save a
 * workflow from doing the arithmetic.
 */
export function normalizeInbox(raw: IDataObject): IDataObject {
	const fromEmail = pick(raw, 'from_email', 'from') as string | undefined;
	const sentToday = pick(raw, 'sentToday', 'sent24h') as number | undefined;
	const capToday = pick(raw, 'capToday', 'cap', 'dailyLimit') as number | undefined;
	const pausedAt = pick(raw, 'sending_paused_at', 'sendingPausedAt');
	return {
		...raw,
		from_email: fromEmail,
		sentToday,
		capToday,
		warmup_enabled: pick(raw, 'warmup_enabled', 'warmupEnabled'),
		sending_paused_at: pausedAt ?? null,
		sending_paused_reason: pick(raw, 'sending_paused_reason', 'sendingPausedReason') ?? null,
		is_paused: Boolean(pausedAt),
		remaining_today: Math.max(0, (capToday ?? 0) - (sentToday ?? 0)),
	};
}

export function inboxLabel(inbox: IDataObject): string {
	const fromEmail = inbox.from_email as string | undefined;
	const name = inbox.name as string | undefined;
	if (fromEmail) return name && name !== fromEmail ? `${fromEmail} (${name})` : fromEmail;
	return name ?? String(inbox.id);
}

/** GET /api/runs is camelCase; add the snake_case names the rest of the API uses. */
export function normalizeScraperRun(raw: IDataObject): IDataObject {
	const scraperId = pick(raw, 'scraperId', 'scraper_id');
	const createdAt = pick(raw, 'createdAt', 'created_at');
	const updatedAt = pick(raw, 'updatedAt', 'updated_at');
	return {
		...raw,
		scraperId,
		scraper_id: scraperId,
		createdAt,
		created_at: createdAt,
		updatedAt,
		updated_at: updatedAt,
	};
}

/** The stats totals report today's sends as `sent24h`; expose the spec names too. */
export function normalizeOutreachTotals(raw: IDataObject): IDataObject {
	return {
		...raw,
		sentToday: pick(raw, 'sentToday', 'sent24h'),
		capToday: pick(raw, 'capToday', 'cap'),
	};
}

export function newestFirst(records: IDataObject[], ...dateKeys: string[]): IDataObject[] {
	const time = (record: IDataObject) => {
		for (const key of dateKeys) {
			const value = record[key];
			if (typeof value === 'string') {
				const parsed = Date.parse(value);
				if (!Number.isNaN(parsed)) return parsed;
			}
		}
		return 0;
	};
	return records.slice().sort((a, b) => time(b) - time(a));
}

export function containsText(value: unknown, needle: string): boolean {
	return String(value ?? '')
		.toLowerCase()
		.includes(needle.trim().toLowerCase());
}

export function asArray(value: unknown, key?: string): IDataObject[] {
	if (Array.isArray(value)) return value as IDataObject[];
	if (key && value && typeof value === 'object') {
		const nested = (value as IDataObject)[key];
		if (Array.isArray(nested)) return nested as IDataObject[];
	}
	return [];
}

export interface OffsetPageOptions {
	path: string;
	qs?: IDataObject;
	/** Where the records sit in the response body, e.g. "leads". Omit for a bare array. */
	key?: string;
	/** The largest page ManyPI serves for this route. */
	pageSize: number;
	returnAll: boolean;
	limit: number;
	/** Client-side filter for fields the route cannot filter on itself. */
	filter?: (record: IDataObject) => boolean;
	map?: (record: IDataObject) => IDataObject;
	/** Inspect each raw page, e.g. to stop on a billing lock. */
	inspect?: (body: unknown) => void;
	itemIndex?: number;
}

/** Walk a limit/offset route until the limit is met or the records run out. */
export async function fetchOffsetPages(
	this: ManyPiContext,
	options: OffsetPageOptions,
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	let offset = 0;
	// A hard stop, so a route that ignores `offset` can never loop forever.
	for (let page = 0; page < 1000; page++) {
		const body = await manyPiApiRequest.call(
			this,
			'GET',
			options.path,
			undefined,
			{ ...options.qs, limit: options.pageSize, offset },
			{ itemIndex: options.itemIndex },
		);
		options.inspect?.(body);
		const records = asArray(body, options.key);
		for (const raw of records) {
			const record = options.map ? options.map(raw) : raw;
			if (options.filter && !options.filter(record)) continue;
			results.push(record);
			if (!options.returnAll && results.length >= options.limit) return results;
		}
		if (records.length < options.pageSize) break;
		offset += records.length;
	}
	return results;
}

export function applyLimit<T>(records: T[], returnAll: boolean, limit: number): T[] {
	return returnAll ? records : records.slice(0, limit);
}
