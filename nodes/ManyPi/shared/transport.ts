import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export const BASE_URL = 'https://app.manypi.com';

export const API_KEY_CREDENTIAL = 'manyPiApi';
export const OAUTH2_CREDENTIAL = 'manyPiOAuth2Api';

export type ManyPiContext = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;

/** The credential the node's Authentication parameter points at. */
export function credentialTypeOf(context: ManyPiContext): string {
	let authentication: unknown;
	if ('getInputData' in context) {
		authentication = context.getNodeParameter('authentication', 0, 'apiKey');
	} else if ('getCurrentNodeParameter' in context) {
		// List searches run while the node is being edited, so read the value
		// shown in the editor rather than the last saved one.
		authentication = context.getCurrentNodeParameter('authentication') ?? 'apiKey';
	} else {
		authentication = context.getNodeParameter('authentication', 'apiKey');
	}
	return authentication === 'oAuth2' ? OAUTH2_CREDENTIAL : API_KEY_CREDENTIAL;
}

export interface ManyPiRequestOptions {
	/** The input item this request belongs to, so errors point at the right row. */
	itemIndex?: number;
	/** What the request is about, used when the record is not found, e.g. "scraper". */
	resourceLabel?: string;
	/** Download the body as raw bytes, for file exports. */
	binary?: boolean;
}

export interface ManyPiFullResponse {
	statusCode: number;
	headers: IDataObject;
	body: unknown;
}

/**
 * The permission an API key needs for a request. Mirrors requiredScopesFor()
 * in the ManyPI app: a key without it is answered with a 401, exactly like a
 * key that does not exist, so naming the permission is the only way the user
 * can tell the two apart.
 */
function requiredPermission(method: IHttpRequestMethods, path: string): string {
	const isRead = method === 'GET' || method === 'HEAD';
	if (path.startsWith('/v1/e/')) return 'Invoke Endpoints';
	if (path.startsWith('/api/agents/')) return isRead ? 'Read or Run Agents' : 'Run Agents';
	if (path.startsWith('/api/scrape')) return 'Run Scrapers';
	if (/^\/api\/outreach\/(send|enroll)\b/.test(path)) return 'Send Outreach';
	if (path.startsWith('/api/leads/validate')) {
		return isRead ? 'Read or Verify Email Addresses' : 'Verify Email Addresses';
	}
	return isRead ? 'Read' : 'Write';
}

function bodyText(body: unknown): string | undefined {
	if (body === undefined || body === null) return undefined;
	if (Buffer.isBuffer(body)) return body.toString('utf8');
	if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
	if (typeof body === 'string') return body;
	return undefined;
}

/** Pull the most useful sentence out of whatever shape ManyPI answered with. */
export function apiMessage(body: unknown): string | undefined {
	let parsed: unknown = body;
	const text = bodyText(body);
	if (text !== undefined) {
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith('<')) return undefined;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return trimmed.slice(0, 500);
		}
	}
	if (!parsed || typeof parsed !== 'object') return undefined;

	const data = parsed as IDataObject;
	let message: string | undefined;
	// Some routes pass zod's issue list straight through as `error`.
	if (Array.isArray(data.error)) {
		const issues = (data.error as IDataObject[])
			.map((issue) => {
				if (typeof issue === 'string') return issue;
				const path = Array.isArray(issue?.path) ? (issue.path as string[]).join('.') : '';
				const text = typeof issue?.message === 'string' ? issue.message : JSON.stringify(issue);
				return path ? `${path}: ${text}` : text;
			})
			.filter(Boolean);
		if (issues.length) return issues.join('; ');
	}
	if (typeof data.error === 'string') message = data.error;
	else if (data.error && typeof (data.error as IDataObject).message === 'string') {
		message = (data.error as IDataObject).message as string;
	} else if (typeof data.message === 'string') message = data.message;
	else if (typeof data.detail === 'string') message = data.detail;

	// Schema validation failures list what was wrong under `details`.
	if (message && Array.isArray(data.details) && data.details.length) {
		const details = data.details
			.map((detail) => (typeof detail === 'string' ? detail : JSON.stringify(detail)))
			.join('; ');
		message = `${message}: ${details}`;
	}
	return message;
}

function retryAfterSeconds(headers: IDataObject): number | undefined {
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	const seconds = parseInt(String(raw ?? ''), 10);
	return Number.isNaN(seconds) ? undefined : seconds;
}

function toErrorObject(body: unknown): JsonObject {
	const text = bodyText(body);
	if (text !== undefined) {
		try {
			return JSON.parse(text) as JsonObject;
		} catch {
			return { message: text.slice(0, 500) };
		}
	}
	if (body && typeof body === 'object') return body as JsonObject;
	return {};
}

export function manyPiApiError(
	node: INode,
	method: IHttpRequestMethods,
	path: string,
	response: ManyPiFullResponse,
	options: ManyPiRequestOptions,
	credentialType: string = API_KEY_CREDENTIAL,
): NodeApiError {
	const status = response.statusCode;
	const said = apiMessage(response.body);
	const saidSuffix = said ? ` ManyPI said: "${said}"` : '';

	let message: string;
	let description: string;

	switch (true) {
		case status >= 300 && status < 400: {
			// Followed, a redirect lands on the sign-in page, whose HTML would
			// pass for a successful result.
			const location = String(response.headers.location ?? response.headers.Location ?? '');
			message = 'ManyPI redirected the request instead of answering it';
			description = location.includes('/signin')
				? 'ManyPI asked for a browser sign-in, so this route does not accept API keys yet. Contact ManyPI support and mention the operation you used.'
				: `ManyPI answered with HTTP ${status}${location ? ` and pointed to ${location}` : ''}. Contact ManyPI support if this keeps happening.`;
			break;
		}
		case status === 401 && credentialType === OAUTH2_CREDENTIAL:
			// n8n has already tried to renew the token by the time a 401 gets here.
			message = 'ManyPI did not accept the OAuth2 connection';
			description =
				'The connection expired or was revoked, and n8n could not renew it. Open the ManyPI OAuth2 credential and reconnect your account.' +
				saidSuffix;
			break;
		case status === 401:
			message = 'ManyPI did not accept the API key';
			description =
				`The key may be wrong or revoked, or it may not have the "${requiredPermission(method, path)}" permission this operation needs. ` +
				'Check the key and its permissions under API Access in the ManyPI dashboard.' +
				saidSuffix;
			break;
		case status === 402:
			message = said ?? 'Your ManyPI plan does not cover this operation';
			description =
				'Add credits or upgrade your plan under Billing in the ManyPI dashboard, then run the node again.';
			break;
		case status === 403:
			message = said ?? 'Your ManyPI account is not allowed to do this';
			description =
				'This usually comes from a plan limit or your role in the workspace. Check your plan, or ask a workspace owner.';
			break;
		case status === 404:
			message = `The ${options.resourceLabel ?? 'requested record'} was not found in ManyPI`;
			description =
				'Check the ID or pick the record from the list. It may have been deleted, or it may belong to another workspace.' +
				saidSuffix;
			break;
		case status === 429: {
			// A 429 is also how ManyPI reports a spent sending allowance, such as an
			// inbox's 24-hour cap or the plan's monthly outreach limit. Retrying
			// does not help those, so only call it a rate limit when it is one.
			const wait = retryAfterSeconds(response.headers);
			if (said && wait === undefined) {
				message = said;
				description =
					'This is a sending or plan limit, so retrying right away will not help. Wait for it to reset, or raise it in the ManyPI dashboard.';
			} else {
				message = 'ManyPI rate limit reached';
				description =
					`Too many requests in a short time${wait ? `, so ManyPI asked to wait ${wait} seconds` : ''}. ` +
					'Slow the workflow down, or turn on Retry On Fail in the node settings.' +
					saidSuffix;
			}
			break;
		}
		case status >= 500:
			message = 'ManyPI could not complete the request';
			description = `ManyPI answered with HTTP ${status}. Wait a moment and run the node again.${saidSuffix}`;
			break;
		default:
			message = said ?? `ManyPI did not accept the request (HTTP ${status})`;
			description = 'Check the node parameters against the message above, then run the node again.';
	}

	return new NodeApiError(node, toErrorObject(response.body), {
		message,
		description,
		httpCode: String(status),
		itemIndex: options.itemIndex,
	});
}

function cleanQuery(qs: IDataObject | undefined): IDataObject | undefined {
	if (!qs) return undefined;
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(qs)) {
		if (value === undefined || value === null || value === '') continue;
		out[key] = value;
	}
	return out;
}

/**
 * Send one authenticated request to ManyPI and return the full response.
 * Any status outside 2xx becomes a NodeApiError that says what to do next.
 */
export async function manyPiApiRequestFull(
	this: ManyPiContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject | IDataObject[],
	qs?: IDataObject,
	options: ManyPiRequestOptions = {},
): Promise<ManyPiFullResponse> {
	const credentialType = credentialTypeOf(this);

	// Published endpoints are served by a separate function that only accepts
	// mpi_ API keys, so an OAuth2 token would be refused there every time.
	if (credentialType === OAUTH2_CREDENTIAL && path.startsWith('/v1/')) {
		throw new NodeOperationError(this.getNode(), 'Published endpoints need an API key', {
			itemIndex: options.itemIndex,
			description:
				'ManyPI answers calls to /v1/e/… only with an API key. Set Authentication to API Key on this node, or use a second ManyPI node with an API key for this operation.',
		});
	}

	// Error statuses are left to throw rather than ignored: n8n renews an
	// expired OAuth2 token only when a request throws a 401, so returning the
	// 401 here would leave an OAuth2 connection dead an hour after connecting.
	const request: IHttpRequestOptions = {
		method,
		url: `${BASE_URL}${path}`,
		headers: { Accept: 'application/json' },
		qs: cleanQuery(qs),
		json: !options.binary,
		returnFullResponse: true,
		disableFollowRedirect: true,
	};
	if (body !== undefined) request.body = body;
	if (options.binary) request.encoding = 'arraybuffer';

	let response: ManyPiFullResponse;
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			credentialType,
			request,
		)) as ManyPiFullResponse;
	} catch (error) {
		const failed = failedResponse(error);
		if (failed) throw manyPiApiError(this.getNode(), method, path, failed, options, credentialType);
		// No HTTP answer at all: DNS, TLS, a timeout, or a token renewal that failed.
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: options.itemIndex });
	}

	// n8n throws on error statuses, so this only catches a version that does not.
	if (response.statusCode >= 300) {
		throw manyPiApiError(this.getNode(), method, path, response, options, credentialType);
	}
	return response;
}

interface WrappedHttpError {
	httpCode?: string | null;
	cause?: { response?: AxiosLikeResponse };
	response?: AxiosLikeResponse;
	context?: { data?: unknown };
}

interface AxiosLikeResponse {
	status?: number;
	headers?: IDataObject;
	data?: unknown;
	body?: unknown;
}

/**
 * Recover the HTTP answer from a thrown request error. n8n wraps the failed
 * request in a NodeApiError whose `cause` is the original error, which still
 * holds the status, headers and body.
 */
function failedResponse(error: unknown): ManyPiFullResponse | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const wrapped = error as WrappedHttpError;
	const response = wrapped.cause?.response ?? wrapped.response;
	const status = Number(response?.status ?? wrapped.httpCode);
	if (!Number.isInteger(status) || status < 300 || status > 599) return undefined;
	return {
		statusCode: status,
		headers: response?.headers ?? {},
		body: response?.data ?? response?.body ?? wrapped.context?.data,
	};
}

/** Same as manyPiApiRequestFull, returning only the parsed body. */
export async function manyPiApiRequest(
	this: ManyPiContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject | IDataObject[],
	qs?: IDataObject,
	options: ManyPiRequestOptions = {},
): Promise<unknown> {
	const response = await manyPiApiRequestFull.call(this, method, path, body, qs, options);
	return response.body;
}

/** Encode one path segment, so an ID mapped from an earlier step cannot change the route. */
export function segment(value: string): string {
	return encodeURIComponent(String(value).trim());
}
