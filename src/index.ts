import type { Field } from '@directus/types';
import type { HeaderRaw, Sort } from './core-clones/components/v-table/types';
import type { LayoutOptions, LayoutQuery } from './types';
import {
	defineLayout,
	useApi,
	useCollection,
	useItems,
	useStores,
	useSync,
} from '@directus/extensions-sdk';
import { getEndpoint } from '@directus/utils';
import { debounce, isEmpty } from 'lodash';
import { computed, ref, toRefs, unref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Actions from './actions.vue';
// CORE IMPORTS
import { useAliasFields } from './core-clones/composables/use-alias-fields';
import { useShortcut } from './core-clones/composables/use-shortcut';
import { adjustFieldsForDisplays } from './core-clones/utils/adjust-fields-for-displays';
import { formatCollectionItemsCount } from './core-clones/utils/format-collection-items-count';
import { getDefaultDisplayForType } from './core-clones/utils/get-default-display-for-type';
import { hideDragImage } from './core-clones/utils/hide-drag-image';
import { syncRefProperty } from './core-clones/utils/sync-ref-property';
import Layout from './layout.vue';
import Options from './options.vue';

export default defineLayout<LayoutOptions, LayoutQuery>({
	id: 'table-pro',
	name: 'Table Pro',
	icon: 'table',
	component: Layout,
	slots: {
		options: Options,
		sidebar: () => {},
		actions: Actions,
	},
	headerShadow: false,
	setup(props, { emit }) {
		const { useFieldsStore, useRelationsStore, useCollectionsStore } = useStores();
		const fieldsStore = useFieldsStore();
		const relationsStore = useRelationsStore();
		const collectionsStore = useCollectionsStore();

		const selection = useSync(props, 'selection', emit);
		const layoutOptions = useSync(props, 'layoutOptions', emit);
		const layoutQuery = useSync(props, 'layoutQuery', emit);

		const { collection, filter, filterUser, search } = toRefs(props);

		const {
			info,
			primaryKeyField,
			fields: fieldsInCollection,
			sortField,
		} = useCollection(collection);

		const { allowedFields, filterAllowedFields, isEditableField } = useAllowedFields();

		const { sort, limit, page, fields } = useItemOptions();

		const { aliasedFields, aliasQuery, aliasedKeys } = useAliasFields(
			fields,
			collection,
		);

		const fieldsWithRelationalAliased = computed(() => {
			return Object.values(aliasedFields.value).reduce<string[]>(
				(acc, value) => {
					return [...acc, ...value.fields];
				},
				[],
			);
		});

		// Translate UI-level sort entries (e.g. `author`) into a resolvable
		// scalar path the API can sort by (e.g. `author.first_name`) using
		// each field's configured display template.
		const apiSort = computed<string[]>(() => {
			const current = sort.value ?? [];
			if (!collection.value || current.length === 0)
				return current;

			return current.map((entry) => {
				if (!entry)
					return entry;
				const desc = entry.startsWith('-');
				const key = desc ? entry.slice(1) : entry;
				if (key.includes('.'))
					return entry;

				const expanded = adjustFieldsForDisplays(
					[key],
					collection.value!,
				);
				const translated
                    = expanded.find((f) => f !== key && f.startsWith(`${key}.`))
                    	?? key;

				return desc ? `-${translated}` : translated;
			});
		});

		const {
			items,
			loading,
			error,
			totalPages,
			itemCount,
			totalCount,
			changeManualSort,
			getItems,
			getItemCount,
			getTotalCount,
		} = useItems(collection, {
			sort: apiSort,
			limit,
			page,
			fields: fieldsWithRelationalAliased,
			alias: aliasQuery,
			filter,
			search,
		});

		// The `useItems` composable debounces its internal `fetchItems`
		// call via a 500ms lodash throttle. When a user adds a column
		// through the `+` menu the fields ref updates synchronously but
		// the trailing throttled call can land before the alias/fields
		// propagation has fully settled, which leaves the newly added
		// column blank until the user force-refreshes the page. Trigger
		// a direct fetch here whenever the user-level fields or alias
		// query change — this bypasses the throttle and ensures the
		// cells hydrate immediately.
		watch(
			[fields, aliasQuery],
			(next, prev) => {
				if (!collection.value)
					return;
				if (Array.isArray(prev?.[0]) && Array.isArray(next?.[0])) {
					const nextFields = next[0] as string[];
					const prevFields = prev[0] as string[];
					if (
						nextFields.length === prevFields.length
						&& nextFields.every((f, i) => f === prevFields[i])
					) {
						return;
					}
				}
				getItems();
			},
			{ flush: 'post' },
		);

		const {
			tableSort,
			tableHeaders,
			tableRowHeight,
			onSortChange,
			onAlignChange,
			tableSpacing,
		} = useTable();

		const showingCount = computed(() => {
			const filtering = Boolean(
				(itemCount.value || 0) < (totalCount.value || 0)
				&& filterUser.value,
			);

			return formatCollectionItemsCount(
				itemCount.value || 0,
				page.value,
				limit.value,
				filtering,
			);
		});

		const { unexpectedError } = useUnexpectedError();

		const {
			autoSave,
			edits,
			hasEdits,
			saving,
			saveEdits,
			autoSaveEdits,
			resetEdits,
		} = useSaveEdits();

		return {
			tableHeaders,
			items,
			loading,
			error,
			totalPages,
			tableSort,
			onSortChange,
			onAlignChange,
			tableRowHeight,
			page,
			toPage,
			itemCount,
			totalCount,
			fieldsInCollection,
			fields,
			limit,
			allowedFields,
			tableSpacing,
			primaryKeyField,
			info,
			showingCount,
			sortField,
			changeManualSort,
			hideDragImage,
			refresh,
			resetPresetAndRefresh,
			selectAll,
			filter,
			search,
			fieldsWithRelationalAliased,
			aliasedFields,
			aliasedKeys,
			autoSave,
			edits,
			hasEdits,
			saving,
			saveEdits,
			autoSaveEdits,
			resetEdits,
		};

		async function resetPresetAndRefresh() {
			await props?.resetPreset?.();
			refresh();
		}

		function refresh() {
			getItems();
			getTotalCount();
			getItemCount();
		}

		function toPage(newPage: number) {
			page.value = newPage;
		}

		function selectAll() {
			if (!primaryKeyField.value)
				return;
			const pk = primaryKeyField.value;
			selection.value = items.value.map((item) => item[pk.field]);
		}

		function useItemOptions() {
			const page = syncRefProperty(layoutQuery, 'page', 1);
			const limit = syncRefProperty(layoutQuery, 'limit', 25);

			const defaultSort = computed(() => {
				const field = sortField.value ?? primaryKeyField.value?.field;
				return field ? [field] : [];
			});

			const sort = syncRefProperty(layoutQuery, 'sort', defaultSort);

			const fieldsDefaultValue = computed(() => {
				return fieldsInCollection.value
					.filter(filterAllowedFields)
					.slice(0, 4)
					.map(({ field }: Field) => field)
					.sort();
			});

			const fields = computed({
				get() {
					if (layoutQuery.value?.fields) {
						// Mirror core tabular: drop any stored field that no
						// longer resolves. This prevents stale/orphan keys
						// from polluting the fetch payload (and silently
						// returning partial rows).
						return layoutQuery.value.fields.filter((field: string) =>
							!!fieldsStore.getField(collection.value!, field),
						);
					}
					return unref(fieldsDefaultValue);
				},
				set(value) {
					layoutQuery.value = Object.assign({}, layoutQuery.value, {
						fields: value,
					});
				},
			});

			const fieldsWithRelational = computed(() => {
				if (!props.collection)
					return [];
				return adjustFieldsForDisplays(fields.value, props.collection);
			});

			return { sort, limit, page, fields, fieldsWithRelational };
		}

		function useTable() {
			const tableSort = computed(() => {
				if (!sort.value?.[0]) {
					return null;
				}
				else if (sort.value?.[0].startsWith('-')) {
					return { by: sort.value[0].slice(1), desc: true };
				}
				else {
					return { by: sort.value[0], desc: false };
				}
			});

			const localWidths = ref<{ [field: string]: number }>({});

			watch(
				() => layoutOptions.value,
				() => {
					localWidths.value = {};
				},
			);

			const saveWidthsToLayoutOptions = debounce(() => {
				layoutOptions.value = Object.assign({}, layoutOptions.value, {
					widths: localWidths.value,
				});
			}, 350);

			const activeFields = computed<(Field & { key: string })[]>({
				get() {
					if (!collection.value)
						return [];

					return fields.value
						.map((key: any) => ({
							...fieldsStore.getField(collection.value!, key),
							key,
						}))
						.filter(filterAllowedFields) as (Field & {
						key: string;
					})[];
				},
				set(val) {
					fields.value = val.map((field) => field.field);
				},
			});

			const tableHeaders = computed<HeaderRaw[]>({
				get() {
					return activeFields.value.map((field) => {
						let description: string | null = null;

						const fieldParts = field.key.split('.');
						const isNested = fieldParts.length > 1;

						if (isNested) {
							const fieldNames = fieldParts.map(
								(fieldKey, index) => {
									const pathPrefix = fieldParts.slice(
										0,
										index,
									);

									const field = fieldsStore.getField(
										collection.value!,
										[...pathPrefix, fieldKey].join('.'),
									);

									return field?.name ?? fieldKey;
								},
							);

							description = fieldNames.join(' -> ');
						}

						// Nested paths refer to fields that live on related
						// collections. We cannot inline-edit those because the
						// resulting PATCH payload would target the wrong row.
						const editable = !isNested && isEditableField(field as Field);

						const { display: resolvedDisplay, displayOptions: resolvedDisplayOptions }
							= resolveDisplay(field as Field);

						return {
							text: field.name,
							value: field.key,
							description,
							width:
                                localWidths.value[field.key]
                                || layoutOptions.value?.widths?.[field.key]
                                || null,
							align:
                                layoutOptions.value?.align?.[field.key]
                                || 'left',
							field: {
								// CORE CHANGE: add whole field data and force some properties
								...field,
								hideLabel: true,
								meta: {
									...field.meta,
									width: 'fill',
									group: null,
								},
								// CORE CHANGE end
								display: resolvedDisplay,
								displayOptions: resolvedDisplayOptions,
								interface: field.meta?.interface,
								interfaceOptions: field.meta?.options,
								type: field.type,
								field: field.field,
								collection: field.collection,
							},
							editable,
							sortable:
                                ['json', 'alias', 'presentation', 'translations'].includes(field.type) === false,
						} as HeaderRaw;
					});
				},
				set(val) {
					const widths = {} as { [field: string]: number };

					for (const header of val) {
						if (header.width) {
							widths[header.value] = header.width;
						}
					}

					localWidths.value = widths;

					saveWidthsToLayoutOptions();

					fields.value = val.map((header) => header.value);
				},
			});

			const tableSpacing = syncRefProperty(
				layoutOptions,
				'spacing',
				'cozy',
			);

			const tableRowHeight = computed<number>(() => {
				switch (tableSpacing.value) {
					case 'compact':
						return 32;
					case 'comfortable':
						return 64;
					default:
						return 48;
				}
			});

			return {
				tableSort,
				tableHeaders,
				tableSpacing,
				tableRowHeight,
				onSortChange,
				onAlignChange,
				getFieldDisplay,
			};

			function onSortChange(newSort: Sort | null) {
				if (!newSort?.by) {
					sort.value = [];
					return;
				}

				let sortString = newSort.by;

				if (newSort.desc === true) {
					sortString = `-${sortString}`;
				}

				sort.value = [sortString];
			}

			function onAlignChange(
				field: string,
				align: 'left' | 'center' | 'right',
			) {
				layoutOptions.value = Object.assign({}, layoutOptions.value, {
					align: {
						...layoutOptions.value?.align,
						[field]: align,
					},
				});
			}

			function getFieldDisplay(fieldKey: string) {
				const field = fieldsInCollection.value.find(
					(field: Field) => field.field === fieldKey,
				);

				if (!field?.meta?.display)
					return null;

				return {
					display: field.meta.display,
					options: field.meta.display_options,
				};
			}

			// Pick a sensible display + options for a header. If the user has
			// not configured one explicitly and the field is relational, fall
			// back to `related-values` with the related collection's template
			// so `render-display` gets a template to render against. Using the
			// type-default would yield `formatted-value`, which prints full
			// related objects as `[object Object]`.
			function resolveDisplay(field: Field): {
				display: string;
				displayOptions: Record<string, any> | null | undefined;
			} {
				if (field.meta?.display) {
					return {
						display: field.meta.display,
						displayOptions: field.meta.display_options,
					};
				}

				const relatedCollection = findRelatedCollection(field);
				if (relatedCollection) {
					const colInfo = (collectionsStore as any).collections?.find?.(
						(c: any) => c.collection === relatedCollection,
					);
					const template = colInfo?.meta?.display_template ?? null;

					return {
						display: 'related-values',
						displayOptions: { template },
					};
				}

				return {
					display: getDefaultDisplayForType(field.type),
					displayOptions: field.meta?.display_options,
				};
			}

			function findRelatedCollection(field: Field): string | null {
				const allRelations: any[] = (relationsStore as any).relations ?? [];
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
		}

		// Based from the core: /app/src/utils/unexpected-error.ts
		function useUnexpectedError() {
			const { useNotificationsStore } = useStores();
			const notificationStore = useNotificationsStore();
			const { t } = useI18n();

			return {
				unexpectedError(error: any) {
					const code =
                        error.response?.data?.errors?.[0]?.extensions?.code || error?.extensions?.code || 'UNKNOWN';

					notificationStore.add({
						title: t(`errors.${code}`),
						type: 'error',
						code,
						dialog: true,
						error,
					});
				},
			};
		}

		function useSaveEdits() {
			const api = useApi();
			const autoSave = syncRefProperty(layoutOptions, 'autosave', true);
			const edits = ref<Record<string, any>>({});
			const hasEdits = computed(() => !isEmpty(edits.value));
			const saving = ref(false);

			watch(edits, cleanUpEmptyEdits, { deep: true });

			useShortcut('meta+s', saveEdits);

			return {
				autoSave,
				edits,
				hasEdits,
				saving,
				saveEdits,
				autoSaveEdits,
				resetEdits,
			};

			function resetEdits() {
				edits.value = {};
			}

			async function saveEdits() {
				if (!hasEdits.value)
					return;
				saving.value = true;

				try {
					for (const [id, payload] of Object.entries(edits.value)) {
						await api.patch(
							`${getEndpoint(collection.value!)}/${id}`,
							payload,
						);
					}
				}
				catch (error: any) {
					unexpectedError(error);
				}

				saving.value = false;
				resetEdits();
				refresh();
			}

			function autoSaveEdits() {
				if (!autoSave.value)
					return;
				saveEdits();
			}

			function cleanUpEmptyEdits() {
				if (!hasEdits.value)
					return;

				for (const [key, itemEdits] of Object.entries(edits.value)) {
					if (isEmpty(itemEdits)) {
						delete edits.value[key];
					}
				}
			}
		}

		function useAllowedFields() {
			const editableTypes = new Set([
				// strings
				'string',
				'text',
				'uuid',
				// numbers
				'bigInteger',
				'integer',
				'float',
				'decimal',
				// boolean
				'boolean',
				// dates
				'dateTime',
				'date',
				'time',
				'timestamp',
			]);

			const editableInterfaces = new Set([
				'boolean',
				'collection-item-dropdown',
				'datetime',
				'file',
				'file-image',
				'input',
				'input-autocomplete-api',
				'input-hash',
				'select-color',
				'select-dropdown',
				'select-dropdown-m2o',
				'select-icon',
				'select-multiple-dropdown',
				'slider',
			]);

			const allowedFields = computed(() =>
				fieldsInCollection.value
					.filter(filterAllowedFields)
					.map((field) => ({ field: field.field, name: field.name })),
			);

			return {
				allowedFields,
				filterAllowedFields,
				isEditableField,
			};

			function isEditableField(field: Field) {
				return (
					!!field.type
					&& editableTypes.has(field.type)
					&& !!field.meta?.interface
					&& editableInterfaces.has(field.meta.interface)
					&& !field.meta?.readonly
				);
			}

			// Mirror the core Table layout: show every field that isn't
			// hidden, a primary key, or marked as `no-data`. Editability is
			// decided separately via `isEditableField` so non-editable
			// fields appear as read-only columns.
			function filterAllowedFields(field: Field) {
				if (!field)
					return false;
				if (field.meta?.special?.includes('no-data'))
					return false;
				if (field.schema?.is_primary_key)
					return false;
				if (field.meta?.hidden)
					return false;
				return true;
			}
		}
	},
});
