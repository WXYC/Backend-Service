import { flowsheet, intake_items, library, rotation } from '@wxyc/database';

/**
 * Every column that holds `labels.id`, with the free-text copy of the label name that sits beside it. The counts
 * read and the delete guard in `labels.service.ts` both walk this list, and so will the label merge, so a table that
 * gains a `label_id` is added here once. `tests/unit/services/label-references.test.ts` fails when the schema declares
 * a `references(() => labels.id)` that this list does not name.
 *
 * `source` is the key the API reports counts under. `labels.parent_label_id` is not here: it is a self-reference the
 * schema does not declare, counted separately as `child_labels`.
 */
export const LABEL_REFERENCES = [
  { source: 'library', table: library, fkColumn: library.label_id, textColumn: library.label },
  { source: 'rotation', table: rotation, fkColumn: rotation.label_id, textColumn: rotation.record_label },
  { source: 'flowsheet', table: flowsheet, fkColumn: flowsheet.label_id, textColumn: flowsheet.record_label },
  {
    source: 'intake_items',
    table: intake_items,
    fkColumn: intake_items.label_id,
    textColumn: intake_items.record_label,
  },
] as const;

export type LabelReferenceSource = (typeof LABEL_REFERENCES)[number]['source'];

/** Row counts keyed by source: what references a label, or how many rows a rename rewrote. */
export type LabelReferenceCounts = Record<LabelReferenceSource, number>;
