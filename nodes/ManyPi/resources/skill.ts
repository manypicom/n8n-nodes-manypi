import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { returnAllAndLimit, showFor } from '../shared/descriptions';
import { manyPiApiRequest } from '../shared/transport';
import type { ResourceHandlers } from '../shared/types';
import { applyLimit, asArray, containsText, prune } from '../shared/utils';

const RESOURCE = 'skill';

export const skillDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [RESOURCE] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a skill',
				description: 'Create a reusable instruction set that shapes how the agent works',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many skills',
				description: "Retrieve the skills available to you: ManyPI's premade ones plus your own",
			},
		],
		default: 'getAll',
	},

	// ── Create ────────────────────────────────────────────────────────────────
	{
		displayName: 'Title',
		name: 'title',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Competitor teardown',
		displayOptions: { show: showFor(RESOURCE, 'create') },
	},
	{
		displayName: 'Instructions',
		name: 'systemPrompt',
		type: 'string',
		typeOptions: { rows: 6 },
		required: true,
		default: '',
		placeholder: 'e.g. When given a competitor URL, extract positioning, pricing tiers and claims.',
		description:
			'The instructions added to the agent prompt. A skill shapes behaviour only, it never adds tools.',
		displayOptions: { show: showFor(RESOURCE, 'create') },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showFor(RESOURCE, 'create') },
		options: [
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				default: '',
			},
			{
				displayName: 'Emoji',
				name: 'emoji',
				type: 'string',
				default: '',
				description: 'One emoji shown next to the skill in the ManyPI dashboard',
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
				displayName: 'Title Contains',
				name: 'title',
				type: 'string',
				default: '',
			},
		],
	},
];

export const skillHandlers: ResourceHandlers = {
	async create(i) {
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		const body = prune({
			title: this.getNodeParameter('title', i) as string,
			system_prompt: this.getNodeParameter('systemPrompt', i) as string,
			description: additional.description,
			emoji: additional.emoji,
		});
		return (await manyPiApiRequest.call(this, 'POST', '/api/skills', body, undefined, {
			itemIndex: i,
		})) as IDataObject;
	},

	async getAll(i) {
		const returnAll = this.getNodeParameter('returnAll', i) as boolean;
		const limit = returnAll ? 0 : (this.getNodeParameter('limit', i) as number);
		const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
		const body = await manyPiApiRequest.call(this, 'GET', '/api/skills', undefined, undefined, {
			itemIndex: i,
		});
		// A bare array today; the `{ skills }` form is what the published spec describes.
		const skills = asArray(body, 'skills').filter(
			(skill) => !filters.title || containsText(skill.title, filters.title as string),
		);
		return applyLimit(skills, returnAll, limit);
	},
};
