import { useEffect, useRef, useState } from "react";
import type { FieldDef, OrderByClause } from "@pythia-software/query-table-core";
import { FieldPicker } from "./FieldPicker";
import { Icon } from "./Icon";

/** Choose a field and direction before committing a sort. */
export function SortPicker<Row>({
  fields,
  onPick,
  onRegex,
  onClose,
}: {
  fields: FieldDef<Row>[];
  onPick: (field: FieldDef<Row>, direction: OrderByClause["dir"]) => void;
  onRegex: (field: FieldDef<Row>) => void;
  onClose: () => void;
}) {
  const [field, setField] = useState<FieldDef<Row> | null>(null);
  const [search, setSearch] = useState("");
  const ascending = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (field) ascending.current?.focus();
  }, [field]);

  return (
    <FieldPicker
      title={field ? `Sort by ${field.label}` : "Add sort"}
      fields={fields}
      searchValue={search}
      onSearchChange={setSearch}
      onPick={setField}
      onClose={onClose}
      {...(field ? { onBack: () => setField(null) } : {})}
    >
      {field && (
        <div className="qt-sort-picker-options">
          <div className="qt-sort-direction-grid" role="group" aria-label="Sort direction">
            <button ref={ascending} type="button" className="qt-btn" onClick={() => onPick(field, "asc")}>
              <Icon name="arrowUp" /> Ascending
            </button>
            <button type="button" className="qt-btn" onClick={() => onPick(field, "desc")}>
              <Icon name="arrowDown" /> Descending
            </button>
          </div>
          <button type="button" className="qt-link-btn qt-sort-picker-regex" aria-haspopup="dialog" onClick={() => onRegex(field)}>
            Regex extraction <Icon name="chevronRight" size={14} />
          </button>
        </div>
      )}
    </FieldPicker>
  );
}
