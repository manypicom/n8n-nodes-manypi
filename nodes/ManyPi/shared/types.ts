import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

/**
 * What one operation returns for one input item: a record, a list of records
 * (each becomes its own output item), or a complete item when it carries a
 * binary file.
 */
export type OperationResult = IDataObject | IDataObject[] | INodeExecutionData;

export type OperationHandler = (
	this: IExecuteFunctions,
	itemIndex: number,
) => Promise<OperationResult>;

export type ResourceHandlers = Record<string, OperationHandler>;

export function isExecutionData(result: OperationResult): result is INodeExecutionData {
	return (
		!Array.isArray(result) &&
		typeof result === 'object' &&
		result !== null &&
		'json' in result &&
		'binary' in result
	);
}
