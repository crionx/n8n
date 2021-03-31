import { IDataObject, INodeExecutionData } from 'n8n-workflow';
import pgPromise = require('pg-promise');
import pg = require('pg-promise/typescript/pg-subset');

/**
 * Returns of a shallow copy of the items which only contains the json data and
 * of that only the define properties
 *
 * @param {INodeExecutionData[]} items The items to copy
 * @param {string[]} properties The properties it should include
 * @returns
 */
export function getItemsCopy(items: INodeExecutionData[], properties: string[]): IDataObject[] {
	let newItem: IDataObject;
	return items.map(item => {
		newItem = {};
		for (const property of properties) {
			newItem[property] = item.json[property];
		}
		return newItem;
	});
}

/**
 * Returns of a shallow copy of the item which only contains the json data and
 * of that only the define properties
 *
 * @param {INodeExecutionData} item The item to copy
 * @param {string[]} properties The properties it should include
 * @returns
 */
export function getItemCopy(item: INodeExecutionData, properties: string[]): IDataObject {
	const newItem: IDataObject = {};
	for (const property of properties) {
		newItem[property] = item.json[property];
	}
	return newItem;
}

/**
 * Returns a returning clause from a comma separated string
 * @param {pgPromise.IMain<{}, pg.IClient>} pgp The pgPromise instance
 * @param string returning The comma separated string
 * @returns string
 */
export function generateReturning(pgp: pgPromise.IMain<{}, pg.IClient>, returning: string): string {
	return ' RETURNING ' + returning.split(',').map(returnedField => pgp.as.name(returnedField.trim())).join(', ');
}

/**
 * Executes the given SQL query on the database.
 *
 * @param {Function} getNodeParam The getter for the Node's parameters
 * @param {pgPromise.IMain<{}, pg.IClient>} pgp The pgPromise instance
 * @param {pgPromise.IDatabase<{}, pg.IClient>} db The pgPromise database connection
 * @param {input[]} input The Node's input data
 * @returns Promise<Array<IDataObject>>
 */
export async function pgQuery(
	getNodeParam: Function,
	pgp: pgPromise.IMain<{}, pg.IClient>,
	db: pgPromise.IDatabase<{}, pg.IClient>,
	input: INodeExecutionData[],
	continueOnFail: boolean,
): Promise<IDataObject[]> {
	const additionalFields = getNodeParam('additionalFields', 0) as IDataObject;
	const mode = additionalFields.mode ?? 'multiple' as string;
	if(mode === 'multiple') {
		const queries: string[] = [];
		for (let i = 0; i < input.length; i++) {
			queries.push(getNodeParam('query', i) as string);
		}
		return (await db.multi(pgp.helpers.concat(queries))).flat(1);
	} else if(mode === 'transaction') {
		return db.tx(async t => {
			const result:IDataObject[] = [];
			for (let i = 0; i < input.length; i++) {
				try {
					Array.prototype.push.apply(result, await t.any(getNodeParam('query', i) as string));
				} catch(err) {
					if(continueOnFail === false) throw err;
					result.push({...input[i].json, code: err.code, message: err.message});
					return result;
				}
			}
			return result;
		});
	} else if(mode === 'independently') {
		return db.task(async t => {
			const result:IDataObject[] = [];
			for (let i = 0; i < input.length; i++) {
				try {
					Array.prototype.push.apply(result, await t.any(getNodeParam('query', i) as string));
				} catch(err) {
					if(continueOnFail === false) throw err;
					result.push({...input[i].json, code: err.code, message: err.message});
				}
			}
			return result;
		});
	}
	throw new Error('multiple, independently or transaction are valid options');
}

/**
 * Inserts the given items into the database.
 *
 * @param {Function} getNodeParam The getter for the Node's parameters
 * @param {pgPromise.IMain<{}, pg.IClient>} pgp The pgPromise instance
 * @param {pgPromise.IDatabase<{}, pg.IClient>} db The pgPromise database connection
 * @param {INodeExecutionData[]} items The items to be inserted
 * @returns Promise<Array<IDataObject>>
 */
export async function pgInsert(
	getNodeParam: Function,
	pgp: pgPromise.IMain<{}, pg.IClient>,
	db: pgPromise.IDatabase<{}, pg.IClient>,
	items: INodeExecutionData[],
	continueOnFail: boolean,
): Promise<IDataObject[]> {
	const table = getNodeParam('table', 0) as string;
	const schema = getNodeParam('schema', 0) as string;
	const columns = (getNodeParam('columns', 0) as string).split(',').map(column => column.trim());
	const cs = new pgp.helpers.ColumnSet(columns, { table: { table, schema } });
	
	const additionalFields = getNodeParam('additionalFields', 0) as IDataObject;
	const mode = additionalFields.mode ?? 'multiple' as string;
	
	const returning = generateReturning(pgp, getNodeParam('returnFields', 0) as string);
	if(mode === 'multiple') {
		const query = pgp.helpers.insert(getItemsCopy(items, columns), cs) + returning;
		return db.any(query);
	} else if(mode === 'transaction') {
		return db.tx(async t => {
			const result:IDataObject[] = [];
			for (let i = 0; i < items.length; i++) {
				const itemCopy = getItemCopy(items[i], columns);
				try {
					result.push(await t.one(pgp.helpers.insert(itemCopy, cs) + returning));
				} catch(err) {
					if(continueOnFail === false) throw err;
					result.push({...itemCopy, code: err.code, message: err.message});
					return result;
				}
			}
			return result;
		});
	} else if(mode === 'independently') {
		return db.task(async t => {
			const result:IDataObject[] = [];
			for (let i = 0; i < items.length; i++) {
				const itemCopy = getItemCopy(items[i], columns);
				try {
					const insertResult = await t.oneOrNone(pgp.helpers.insert(itemCopy, cs) + returning);
					if (insertResult !== null) {
						result.push(insertResult);
					}
				} catch(err) {
					if(continueOnFail === false) {
						throw err;
					}
					result.push({...itemCopy, code: err.code, message: err.message});
				}
			}
			return result;
		});
	}
	
	throw new Error('multiple, independently or transaction are valid options');
}

/**
 * Updates the given items in the database.
 *
 * @param {Function} getNodeParam The getter for the Node's parameters
 * @param {pgPromise.IMain<{}, pg.IClient>} pgp The pgPromise instance
 * @param {pgPromise.IDatabase<{}, pg.IClient>} db The pgPromise database connection
 * @param {INodeExecutionData[]} items The items to be updated
 * @returns Promise<Array<IDataObject>>
 */
export async function pgUpdate(
	getNodeParam: Function,
	pgp: pgPromise.IMain<{}, pg.IClient>,
	db: pgPromise.IDatabase<{}, pg.IClient>,
	items: INodeExecutionData[],
	continueOnFail: boolean,
): Promise<IDataObject[]> {
	const table = getNodeParam('table', 0) as string;
	const schema = getNodeParam('schema', 0) as string;
	const updateKeys = (getNodeParam('updateKey', 0) as string).split(',').map(column => column.trim());
	const columns = (getNodeParam('columns', 0) as string).split(',').map(column => column.trim());
	const additionalFields = getNodeParam('additionalFields', 0) as IDataObject;
	const mode = additionalFields.mode ?? 'multiple' as string;
	const queryColumns = columns.slice();
	
	updateKeys.forEach(updateKey => {
		if (!queryColumns.includes(updateKey)) {
			columns.unshift(updateKey);
			queryColumns.unshift('?' + updateKey);
		}
	});

	const cs = new pgp.helpers.ColumnSet(queryColumns, { table: { table, schema } });
	
	const returning = generateReturning(pgp, getNodeParam('returnFields', 0) as string);
	if(mode === 'multiple') {
		const query =
			pgp.helpers.update(getItemsCopy(items, columns), cs)
			+ ' WHERE ' + updateKeys.map(updateKey => {
				updateKey = pgp.as.name(updateKey);
				return 'v.' + updateKey + ' = t.' + updateKey;
			}).join(' AND ')
			+ returning;
		return await db.any(query);
	} else {
		const where = ' WHERE ' + updateKeys.map(updateKey => pgp.as.name(updateKey) + ' = ${' + updateKey + '}').join(' AND ');
		if(mode === 'transaction') {
			return db.tx(async t => {
				const result:IDataObject[] = [];
				for (let i = 0; i < items.length; i++) {
					const itemCopy = getItemCopy(items[i], columns);
					try {
						Array.prototype.push.apply(result, await t.any(pgp.helpers.update(itemCopy, cs) + pgp.as.format(where, itemCopy) + returning));
					} catch(err) {
						if(continueOnFail === false) throw err;
						result.push({...itemCopy, code: err.code, message: err.message});
						return result;
					}
				}
				return result;
			});
		} else if(mode === 'independently') {
			return db.task(async t => {
				const result:IDataObject[] = [];
				for (let i = 0; i < items.length; i++) {
					const itemCopy = getItemCopy(items[i], columns);
					try {
						Array.prototype.push.apply(result, await t.any(pgp.helpers.update(itemCopy, cs) + pgp.as.format(where, itemCopy) + returning));
					} catch(err) {
						if(continueOnFail === false) throw err;
						result.push({...itemCopy, code: err.code, message: err.message});
					}
				}
				return result;
			});
		}
	}
	throw new Error('multiple, independently or transaction are valid options');
}