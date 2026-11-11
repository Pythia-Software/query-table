// LIMIT / OFFSET row: page size, offset and the row-count paging hint.

import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import type { QueryBuilderClassNames } from "../classNames";
import { Icon } from "../Icon";
import { cx } from "./helpers";

// ---- LIMIT / OFFSET -------------------------------------------------------

export function WindowRow<Row>({
  api,
  total,
  classNames,
  disabled,
  compact,
}: {
  api: QueryTableApi<Row>;
  total: number | null;
  compact?: boolean;
  classNames: QueryBuilderClassNames | undefined;
  disabled: boolean | undefined;
}) {
  const { query } = api;
  const offsetId = useId();
  const [addingOffset, setAddingOffset] = useState(false);
  const offsetInput = useRef<HTMLInputElement>(null);
  const [limitDraft, setLimitDraft] = useState(String(query.limit));
  const [offsetDraft, setOffsetDraft] = useState(String(query.offset));
  useEffect(() => setLimitDraft(String(query.limit)), [query.limit]);
  useEffect(() => setOffsetDraft(String(query.offset)), [query.offset]);
  useEffect(() => {
    if (query.offset > 0) setAddingOffset(false);
  }, [query.offset]);
  useEffect(() => {
    if (addingOffset) {
      offsetInput.current?.focus();
      offsetInput.current?.select();
    }
  }, [addingOffset]);

  function commitLimit() {
    api.setLimit(Math.max(1, Number(limitDraft) || query.limit));
  }
  function commitOffset() {
    api.setOffset(Math.max(0, Number(offsetDraft) || 0));
  }

  return (
    <div className="qt-qb-row qt-qb-pagination">
      <label className="qt-qb-window-field">
        <span className="qt-qb-kw" data-mobile-label="Limit">
          limit
        </span>
        <input
          className={cx("qt-qb-num", classNames?.input)}
          type="number"
          min={1}
          value={limitDraft}
          disabled={disabled}
          onChange={(e) => setLimitDraft(e.target.value)}
          onBlur={commitLimit}
          onKeyDown={(e) => e.key === "Enter" && commitLimit()}
        />
      </label>
      {(!compact || query.offset > 0 || addingOffset) ? <div className="qt-qb-window-field">
        <label
          className="qt-qb-kw"
          htmlFor={offsetId}
          data-mobile-label="Offset"
        >
          offset
        </label>
        <span className="qt-qb-num-combo">
          <input
            ref={offsetInput}
            id={offsetId}
            className={cx("qt-qb-num", classNames?.input)}
            type="number"
            min={0}
            value={offsetDraft}
            disabled={disabled}
            onChange={(e) => setOffsetDraft(e.target.value)}
            onBlur={commitOffset}
            onKeyDown={(e) => e.key === "Enter" && commitOffset()}
          />
          {query.offset >= query.limit && (
            <button
              type="button"
              className="qt-qb-num-step"
              onClick={() => api.setOffset(query.offset - query.limit)}
              disabled={disabled}
              title={`Previous ${query.limit} rows`}
              aria-label={`Previous ${query.limit} rows`}
            >
              −{query.limit}
            </button>
          )}
          <button
            type="button"
            className="qt-qb-num-step"
            onClick={() => api.setOffset(query.offset + query.limit)}
            disabled={
              disabled || (total != null && query.offset + query.limit >= total)
            }
            title={`Next ${query.limit} rows`}
            aria-label={`Next ${query.limit} rows`}
          >
            +{query.limit}
          </button>
        </span>
        {compact && <button type="button" className="qt-chip-x" aria-label="Clear offset" disabled={disabled} onClick={() => { setAddingOffset(false); api.setOffset(0); }}><Icon name="close" /></button>}
      </div> : <button type="button" className="qt-add" aria-label="Add offset" disabled={disabled} onClick={() => setAddingOffset(true)}><Icon name="add" />add offset</button>}
    </div>
  );
}
