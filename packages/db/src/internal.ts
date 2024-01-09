import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { createClient } from '@libsql/client';
import type {
	BooleanField,
	DBCollection,
	DBCollections,
	DBField,
	DateField,
	FieldType,
	JsonField,
	NumberField,
	TextField,
} from './types.js';
import { type LibSQLDatabase, drizzle } from 'drizzle-orm/libsql';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { bold } from 'kleur/colors';
import { type SQL, type ColumnBuilderBaseConfig, type ColumnDataType, sql } from 'drizzle-orm';
import {
	customType,
	integer,
	sqliteTable,
	text,
	type SQLiteColumnBuilderBase,
} from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { nanoid } from 'nanoid';

export type SqliteDB = SqliteRemoteDatabase;
export type {
	AstroTable,
	AstroText,
	AstroDate,
	AstroBoolean,
	AstroNumber,
	AstroJson,
	AstroId,
} from './types.js';

const sqlite = new SQLiteAsyncDialect();

export async function createDb({
	collections,
	dbUrl,
	createTables = false,
}: {
	collections: DBCollections;
	dbUrl: string;
	createTables?: boolean;
}) {
	const client = createClient({ url: dbUrl });
	const db = drizzle(client);

	if (createTables) {
		await createDbTables(db, collections);
	}
	return db;
}

async function createDbTables(db: LibSQLDatabase, collections: DBCollections) {
	const setupQueries: SQL[] = [];
	for (const [name, collection] of Object.entries(collections)) {
		const dropQuery = sql.raw(`DROP TABLE IF EXISTS ${name}`);
		const createQuery = sql.raw(getCreateTableQuery(name, collection));
		setupQueries.push(dropQuery, createQuery);
	}
	for (const q of setupQueries) {
		await db.run(q);
	}
}

export function getCreateTableQuery(collectionName: string, collection: DBCollection) {
	let query = `CREATE TABLE ${sqlite.escapeName(collectionName)} (`;

	const colQueries = ['"id" text PRIMARY KEY'];
	for (const [columnName, column] of Object.entries(collection.fields)) {
		const colQuery = `${sqlite.escapeName(columnName)} ${schemaTypeToSqlType(
			column.type
		)}${getModifiers(columnName, column)}`;
		colQueries.push(colQuery);
	}

	query += colQueries.join(', ') + ')';
	return query;
}

function schemaTypeToSqlType(type: FieldType): 'text' | 'integer' {
	switch (type) {
		case 'date':
		case 'text':
		case 'json':
			return 'text';
		case 'number':
		case 'boolean':
			return 'integer';
	}
}

function getModifiers(columnName: string, column: DBField) {
	let modifiers = '';
	if (!column.optional) {
		modifiers += ' NOT NULL';
	}
	if (column.unique) {
		modifiers += ' UNIQUE';
	}
	if (hasDefault(column)) {
		modifiers += ` DEFAULT ${getDefaultValueSql(columnName, column)}`;
	}
	return modifiers;
}

// Using `DBField` will not narrow `default` based on the column `type`
// Handle each field separately
type WithDefaultDefined<T extends DBField> = T & Required<Pick<T, 'default'>>;
type DBFieldWithDefault =
	| WithDefaultDefined<TextField>
	| WithDefaultDefined<DateField>
	| WithDefaultDefined<NumberField>
	| WithDefaultDefined<BooleanField>
	| WithDefaultDefined<JsonField>;

// Type narrowing the default fails on union types, so use a type guard
function hasDefault(field: DBField): field is DBFieldWithDefault {
	return field.default !== undefined;
}

function hasRuntimeDefault(field: DBField): field is DBFieldWithDefault {
	return field.type === 'date' && field.default === 'now';
}

function getDefaultValueSql(columnName: string, column: DBFieldWithDefault): string {
	switch (column.type) {
		case 'boolean':
			return column.default ? 'TRUE' : 'FALSE';
		case 'number':
			return `${column.default}`;
		case 'text':
			return sqlite.escapeString(column.default);
		case 'date':
			return column.default === 'now' ? 'CURRENT_TIMESTAMP' : sqlite.escapeString(column.default);
		case 'json': {
			let stringified = '';
			try {
				stringified = JSON.stringify(column.default);
			} catch (e) {
				console.info(
					`Invalid default value for column ${bold(
						columnName
					)}. Defaults must be valid JSON when using the \`json()\` type.`
				);
				process.exit(0);
			}

			return sqlite.escapeString(stringified);
		}
	}
}

function generateId() {
	return nanoid(12);
}

const dateType = customType<{ data: Date; driverData: string }>({
	dataType() {
		return 'text';
	},
	toDriver(value) {
		return value.toISOString();
	},
	fromDriver(value) {
		return new Date(value);
	},
});

const jsonType = customType<{ data: unknown; driverData: string }>({
	dataType() {
		return 'text';
	},
	toDriver(value) {
		return JSON.stringify(value);
	},
	fromDriver(value) {
		return JSON.parse(value);
	},
});

const initialColumns = {
	id: text('id')
		.primaryKey()
		.$default(() => generateId()),
};

type D1ColumnBuilder = SQLiteColumnBuilderBase<
	ColumnBuilderBaseConfig<ColumnDataType, string> & { data: unknown }
>;

export function collectionToTable(
	name: string,
	collection: DBCollection,
	isJsonSerializable = true
) {
	const columns: Record<string, D1ColumnBuilder> & typeof initialColumns = {
		// Spread to avoid mutating `initialColumns`
		...initialColumns,
	};

	for (const [fieldName, field] of Object.entries(collection.fields)) {
		columns[fieldName] = columnMapper(fieldName, field, isJsonSerializable);
	}

	const table = sqliteTable(name, columns);
	return table;
}

function columnMapper(fieldName: string, field: DBField, isJsonSerializable: boolean) {
	let c: ReturnType<
		| typeof text
		| typeof integer
		| typeof jsonType
		| typeof dateType
		| typeof integer<string, 'boolean'>
	>;

	switch (field.type) {
		case 'text': {
			c = text(fieldName);
			// Duplicate default logic across cases to preserve type inference.
			// No clean generic for every column builder.
			if (field.default !== undefined) c = c.default(field.default);
			break;
		}
		case 'number': {
			c = integer(fieldName);
			if (field.default !== undefined) c = c.default(field.default);
			break;
		}
		case 'boolean': {
			c = integer(fieldName, { mode: 'boolean' });
			if (field.default !== undefined) c = c.default(field.default);
			break;
		}
		case 'json':
			c = jsonType(fieldName);
			if (field.default !== undefined) c = c.default(field.default);
			break;
		case 'date': {
			// Parse dates as strings when in JSON serializable mode
			if (isJsonSerializable) {
				c = text(fieldName);
				if (field.default !== undefined) {
					c = c.default(field.default === 'now' ? sql`CURRENT_TIMESTAMP` : field.default);
				}
			} else {
				c = dateType(fieldName);
				if (field.default !== undefined) {
					c = c.default(
						field.default === 'now'
							? sql`CURRENT_TIMESTAMP`
							: // default comes pre-transformed to an ISO string for D1 storage.
								// parse back to a Date for Drizzle.
								z.coerce.date().parse(field.default)
					);
				}
			}
			break;
		}
	}

	if (!field.optional) c = c.notNull();
	if (field.unique) c = c.unique();
	return c;
}
