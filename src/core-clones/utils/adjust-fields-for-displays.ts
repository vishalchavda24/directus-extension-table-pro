import type { Field } from '@directus/types';
import { useExtensions, useStores } from '@directus/extensions-sdk';
import { getFieldsFromTemplate } from '@directus/utils';

// Module-level cache for the SDK's injected stores/extensions.
// `useStores()` and `useExtensions()` are backed by Vue's `inject()`,
// which only works during a component's `setup()` execution. When this
// helper is called from a downstream computed/watcher re-run (e.g. the
// user adds a column through the `+` menu), `inject()` returns undefined
// and the SDK throws "[useStores]: The stores could not be found.",
// which in turn aborts the entire reactive chain — manifesting to the
// user as "new columns render blank until a page refresh".
//
// The app-level Pinia stores are singletons once the Directus shell
// mounts, so caching them here is safe: the first successful call (which
// happens during the layout's setup) primes the cache, and all
// subsequent reactive re-runs reuse it without going through `inject()`.
interface Context {
	fieldsStore: any;
	relationsStore: any;
	collectionsStore: any;
	displays: () => any[];
}
let cachedContext: Context | null = null;

function getContext(): Context | null {
	if (cachedContext)
		return cachedContext;

	try {
		const { useFieldsStore, useRelationsStore, useCollectionsStore }
			= useStores();
		const extensions = useExtensions();
		cachedContext = {
			fieldsStore: useFieldsStore(),
			relationsStore: useRelationsStore(),
			collectionsStore: useCollectionsStore(),
			displays: () => (extensions as any)?.displays?.value ?? [],
		};
		return cachedContext;
	}
	catch {
		return null;
	}
}

/**
 * Expand user-selected fields with the sub-fields needed to render the
 * configured display. Mirrors the behaviour of Directus' core tabular layout:
 *
 *   1. If the field has a display whose `fields()` function returns sub-fields,
 *      use those.
 *   2. Otherwise, if the field has a display_options/options template, parse
 *      placeholders (e.g. {{name}}) and expand.
 *   3. Otherwise, if the related collection has a display_template, use that.
 *   4. As a last resort for a relational field, request `${field}.*` so that
 *      render-display still has enough data to work with (over-fetches).
 */
export function adjustFieldsForDisplays(
	fields: readonly string[],
	parentCollection: string,
): string[] {
	const ctx = getContext();
	if (!ctx)
		return [...fields];

	const { fieldsStore, relationsStore, collectionsStore, displays: getDisplays } = ctx;

	// Touch reactive state directly so the outer computed re-runs once the
	// stores finish hydrating. Method-based access (getField, getRelationsForField)
	// is not a reliable dependency trigger from inside nested flatMap calls.
	const allFields: Field[] = (fieldsStore as any).fields ?? [];
	const allRelations: any[] = (relationsStore as any).relations ?? [];
	const allCollections: any[] = (collectionsStore as any).collections ?? [];
	const displays: any[] = getDisplays();

	return fields.flatMap((fieldKey) => {
		const field = lookupField(parentCollection, fieldKey);
		if (!field)
			return fieldKey;

		const fromDisplay = expandFromDisplay(field, fieldKey);
		if (fromDisplay && fromDisplay.length > 0)
			return fromDisplay;

		if (!isRelationalField(field, parentCollection, fieldKey))
			return fieldKey;

		const fromTemplate = expandFromTemplate(field, fieldKey);
		if (fromTemplate && fromTemplate.length > 0)
			return fromTemplate;

		return [`${fieldKey}.*`];
	});

	function lookupField(collection: string, path: string): Field | null {
		if (!Array.isArray(allFields) || allFields.length === 0) {
			return (
				fieldsStore.getField?.(collection, path.split('.')[0]!)
				?? null
			);
		}

		const [head, ...rest] = path.split('.');
		const field = allFields.find(
			(f) => f.collection === collection && f.field === head,
		);
		if (!field)
			return null;

		if (rest.length === 0)
			return field;

		const related = findRelatedCollection(field);
		if (!related)
			return null;

		return lookupField(related, rest.join('.'));
	}

	function findRelatedCollection(field: Field): string | null {
		for (const relation of allRelations) {
			if (
				relation.collection === field.collection
				&& relation.field === field.field
				&& relation.related_collection
			) {
				return relation.related_collection;
			}

			if (
				relation.related_collection === field.collection
				&& relation.meta?.one_field === field.field
				&& relation.collection
			) {
				return relation.collection;
			}
		}
		return null;
	}

	function expandFromDisplay(field: Field, fieldKey: string): string[] | null {
		const displayId = field.meta?.display;
		if (!displayId)
			return null;

		const display = displays.find((d: any) => d.id === displayId);
		if (!display)
			return null;

		let subFields: string[] = [];

		if (Array.isArray(display.fields)) {
			subFields = display.fields;
		}
		else if (typeof display.fields === 'function') {
			try {
				subFields
					= display.fields(field.meta?.display_options, {
						collection: field.collection,
						field: field.field,
						type: field.type,
					}) ?? [];
			}
			catch {
				subFields = [];
			}
		}

		if (!subFields.length)
			return null;

		return subFields
			.map((sub) => sub.trim())
			.filter(Boolean)
			.map((sub) => prefixKey(fieldKey, sub, field));
	}

	function expandFromTemplate(field: Field, fieldKey: string): string[] | null {
		const fromField = getFieldsFromTemplate(
			field.meta?.display_options?.template
			?? field.meta?.options?.template
			?? null,
		);

		let subFields = fromField.filter(keepTemplatePart);

		if (subFields.length === 0) {
			const relatedCollection = findRelatedCollection(field);
			if (relatedCollection) {
				const colInfo = allCollections.find(
					(c: any) => c.collection === relatedCollection,
				);
				const colTemplate = colInfo?.meta?.display_template ?? null;
				subFields = getFieldsFromTemplate(colTemplate).filter(keepTemplatePart);
			}
		}

		if (subFields.length === 0)
			return null;

		return subFields.map((sub) => prefixKey(fieldKey, sub, field));
	}

	function isRelationalField(
		field: Field,
		collection: string,
		fieldKey: string,
	): boolean {
		const special = field.meta?.special ?? [];
		if (
			special.some((s) =>
				['m2o', 'file', 'files', 'm2a', 'translations', 'o2m', 'm2m'].includes(s),
			)
		) {
			return true;
		}

		for (const relation of allRelations) {
			if (
				relation.collection === collection
				&& relation.field === fieldKey
			) {
				return true;
			}
			if (
				relation.related_collection === collection
				&& relation.meta?.one_field === fieldKey
			) {
				return true;
			}
		}

		return false;
	}
}

function prefixKey(fieldKey: string, sub: string, field: Field): string {
	// Strip $thumbnail tokens for directus_files (matches core behaviour).
	if (sub === '$thumbnail' && field.collection === 'directus_files') {
		return fieldKey;
	}
	return `${fieldKey}.${sub}`;
}

function keepTemplatePart(part: string): boolean {
	if (!part)
		return false;
	if (part.startsWith('$'))
		return false;
	return true;
}
