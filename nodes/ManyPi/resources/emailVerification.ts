import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	VERIFICATION_JOB_STATUS_OPTIONS,
	limitOnly,
	locator,
	showFor,
} from '../shared/descriptions';
import { manyPiApiRequest, segment } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { asArray, assertBatchSize, newestFirst, prune, toList } from '../shared/utils';

const RESOURCE = 'emailVerification';
const MAX_BATCH = 5000;

export const emailVerificationDescription: INodeProperties[] = [
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
				action: 'Get an email verification',
				description:
					'Retrieve a verification job with its progress, per-status counts and per-address results',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many email verifications',
				description: 'Retrieve a list of recent verification jobs',
			},
			{
				name: 'Verify',
				value: 'verify',
				action: 'Verify email addresses',
				description:
					'Check whether addresses can receive mail. Results are written back onto the leads. The job continues in the background.',
			},
		],
		default: 'verify',
	},

	// ── Verify ────────────────────────────────────────────────────────────────
	{
		displayName: 'Lead IDs',
		name: 'leadIds',
		type: 'string',
		default: '',
		placeholder: 'e.g. d4e7f1a2-8b30-4c95-a1d6-5f2e9c8b7a04, 1b2c3d4e-...',
		description:
			'Leads whose addresses should be checked, separated by commas. Each result lands on its lead as the email status.',
		displayOptions: { show: showFor(RESOURCE, 'verify') },
	},
	{
		displayName: 'Email Addresses',
		name: 'emails',
		type: 'string',
		default: '',
		placeholder: 'e.g. nathan@example.com, anna@example.com',
		description: 'Addresses that are not tied to a lead, separated by commas',
		displayOptions: { show: showFor(RESOURCE, 'verify') },
	},
	{
		displayName: 'Estimate Only',
		name: 'estimateOnly',
		type: 'boolean',
		default: false,
		description:
			'Whether to only price the job and return the estimate, without queueing it or spending credits',
		displayOptions: { show: showFor(RESOURCE, 'verify') },
	},

	// ── Get ───────────────────────────────────────────────────────────────────
	locator({
		displayName: 'Verification Job',
		name: 'jobId',
		noun: 'verification job',
		searchListMethod: 'searchVerificationJobs',
		show: showFor(RESOURCE, 'get'),
		description: 'The job to retrieve',
	}),
	{
		displayName: 'Include Per-Address Results',
		name: 'includeItems',
		type: 'boolean',
		default: true,
		description:
			'Whether to include the result for every address. Turn off for just the summary on large jobs.',
		displayOptions: { show: showFor(RESOURCE, 'get') },
	},

	// ── Get Many ──────────────────────────────────────────────────────────────
	limitOnly(showFor(RESOURCE, 'getAll'), 50, 'ManyPI returns up to the 50 most recent jobs.'),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'getAll') },
		options: [
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: VERIFICATION_JOB_STATUS_OPTIONS,
				default: 'completed',
			},
		],
	},
];

export const emailVerificationHandlers: ResourceHandlers = {
	async verify(i) {
		const leadIds = toList(this.getNodeParameter('leadIds', i, ''));
		const emails = toList(this.getNodeParameter('emails', i, ''));
		if (!leadIds.length && !emails.length) {
			throw new NodeOperationError(this.getNode(), 'There is nothing to verify', {
				itemIndex: i,
				description: 'Enter Lead IDs, Email Addresses, or both.',
			});
		}
		if (leadIds.length) assertBatchSize.call(this, leadIds, MAX_BATCH, 'lead IDs', i);
		if (emails.length) assertBatchSize.call(this, emails, MAX_BATCH, 'email addresses', i);
		const data = (await manyPiApiRequest.call(
			this,
			'POST',
			'/api/leads/validate',
			prune({
				lead_ids: leadIds,
				emails,
				estimate_only: this.getNodeParameter('estimateOnly', i, false) as boolean,
			}),
			undefined,
			{ itemIndex: i },
		)) as IDataObject;
		// An estimate returns `{ estimate }` with no job, because nothing was queued.
		return { ...data, queued: data.job_id !== undefined };
	},

	async get(i) {
		const jobId = this.getNodeParameter('jobId', i, '', { extractValue: true }) as string;
		const includeItems = this.getNodeParameter('includeItems', i, true) as boolean;
		const data = (await manyPiApiRequest.call(
			this,
			'GET',
			`/api/leads/validate/${segment(jobId)}`,
			undefined,
			{ items: includeItems ? 'true' : 'false' },
			{ itemIndex: i, resourceLabel: 'verification job' },
		)) as IDataObject;
		const job = (data.job ?? data) as IDataObject;
		return includeItems ? { ...job, items: data.items } : job;
	},

	async getAll(i) {
		const limit = this.getNodeParameter('limit', i) as number;
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const body = await manyPiApiRequest.call(
			this,
			'GET',
			'/api/leads/validate',
			undefined,
			{ limit: filters.status ? 50 : limit },
			{ itemIndex: i },
		);
		return newestFirst(asArray(body, 'jobs'), 'created_at')
			.filter((job) => !filters.status || job.status === filters.status)
			.slice(0, limit);
	},
};
