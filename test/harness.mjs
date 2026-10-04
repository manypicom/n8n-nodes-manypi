// A minimal stand-in for the n8n execution context, enough to drive the
// compiled nodes in dist/ without a running n8n. Requests are answered by a
// queue of canned responses and recorded, so tests can assert on both.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NodeApiError } = require('n8n-workflow');

export function extractParameter(value, options) {
	if (options?.extractValue && value && typeof value === 'object' && '__rl' in value) {
		return value.value;
	}
	if (options?.extractValue && value && typeof value === 'object' && 'mode' in value) {
		return value.value;
	}
	return value;
}

export function locatorValue(value) {
	return { __rl: true, mode: 'id', value };
}

/** A response queue: each entry is `{ statusCode, body, headers }` or a function of the request. */
export function createTransport(responses = []) {
	const queue = [...responses];
	const calls = [];
	const httpRequestWithAuthentication = async function (credentialType, request) {
		calls.push({ credentialType, ...request });
		const next = queue.shift();
		if (next === undefined) {
			throw new Error(`No canned response left for ${request.method} ${request.url}`);
		}
		const response = typeof next === 'function' ? next(request) : next;
		const statusCode = response.statusCode ?? 200;
		const headers = response.headers ?? {};
		// What n8n does with a status outside 2xx when the request does not ask
		// to ignore it: axios rejects, and httpRequestWithAuthentication wraps
		// the rejection in a NodeApiError whose cause still holds the response.
		if (statusCode >= 300 && !request.ignoreHttpStatusErrors) {
			const axiosError = Object.assign(new Error(`Request failed with status code ${statusCode}`), {
				isAxiosError: true,
				response: { status: statusCode, headers, data: response.body },
			});
			throw new NodeApiError(NODE, axiosError);
		}
		return { statusCode, headers, body: response.body };
	};
	return { calls, httpRequestWithAuthentication, remaining: () => queue.length };
}

function baseHelpers(transport) {
	return {
		httpRequestWithAuthentication: transport.httpRequestWithAuthentication,
		returnJsonArray(data) {
			const list = Array.isArray(data) ? data : [data];
			return list.map((json) => ({ json }));
		},
		constructExecutionMetaData(items, { itemData }) {
			return items.map((item) => ({ ...item, pairedItem: itemData }));
		},
		async prepareBinaryData(buffer, fileName, mimeType) {
			return {
				data: Buffer.from(buffer).toString('base64'),
				fileName,
				mimeType,
				fileSize: String(buffer.length),
			};
		},
	};
}

const NODE = { id: 'test', name: 'ManyPI', type: 'n8n-nodes-manypi.manyPi', typeVersion: 1, parameters: {} };

/** Build an IExecuteFunctions for one run. `params` is one object per input item. */
export function executeContext({ params, transport, continueOnFail = false }) {
	const perItem = Array.isArray(params) ? params : [params];
	return {
		getInputData: () => perItem.map(() => ({ json: {} })),
		getNodeParameter(name, itemIndex, fallback, options) {
			const source = perItem[itemIndex] ?? perItem[0];
			const value = source[name];
			return extractParameter(value === undefined ? fallback : value, options);
		},
		getNode: () => NODE,
		continueOnFail: () => continueOnFail,
		helpers: baseHelpers(transport),
	};
}

/** Build an IPollFunctions. Static data persists across polls when the same object is passed in. */
export function pollContext({ params, transport, mode = 'trigger', staticData = {} }) {
	return {
		getNodeParameter(name, fallback, options) {
			const value = params[name];
			return extractParameter(value === undefined ? fallback : value, options);
		},
		getMode: () => mode,
		getWorkflowStaticData: () => staticData,
		getNode: () => ({ ...NODE, type: 'n8n-nodes-manypi.manyPiTrigger' }),
		helpers: baseHelpers(transport),
	};
}

export function loadContext({ params = {}, transport }) {
	return {
		getCurrentNodeParameter: (name) => params[name],
		getNodeParameter: (name, fallback) => params[name] ?? fallback,
		getNode: () => NODE,
		helpers: baseHelpers(transport),
	};
}
