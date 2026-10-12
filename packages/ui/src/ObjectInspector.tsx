import type { ReactNode } from "react";
import type { PropertyViewState, PropertyViewStorage } from "@pythia-software/query-table-core";
import { usePropertyView, type PropertyViewApi } from "@pythia-software/query-table-react";
import { ObjectProperties, type ObjectPropertiesProps } from "./ObjectProperties";
import { PropertyViewControls } from "./PropertyViewEditor";
import { Icon } from "./Icon";
import { ShareButton } from "./ShareButton";

export interface ObjectInspectorProps<Row> extends Omit<ObjectPropertiesProps<Row>, "view"> {
  storage?: PropertyViewStorage;
  initialView?: PropertyViewState;
  objectType?: string;
  /** Accessible identity; surrounding page/modal owns visible item headings. */
  typeLabel?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Share one controller across table details and standalone cards. */
  propertyApi?: PropertyViewApi;
  /** Names the edited modality in the properties editor's context strip. */
  viewScope?: string;
  /** Host-owned share URL, including identity and the supplied property snapshot. */
  shareUrl?: (view: PropertyViewState) => string;
  shareAction?: ReactNode;
  /** Show a close control beside the view history when this card is a dialog. */
  onClose?: () => void;
  closeLabel?: string;
  /** Icon controls for a compact surface such as a popover. */
  compact?: boolean;
}
/** Opinionated read-only item card, starting with the same state bar as the builder. */
export function ObjectInspector<Row>(props: ObjectInspectorProps<Row>): ReactNode {
  return props.propertyApi
    ? <InspectorCard {...props} propertyApi={props.propertyApi} />
    : <OwnedInspector {...props} />;
}
function OwnedInspector<Row>(props: ObjectInspectorProps<Row>): ReactNode {
  const api = usePropertyView({ schema: props.schema,
    ...(props.objectType ? { key: props.objectType } : {}),
    ...(props.storage ? { storage: props.storage } : {}),
    ...(props.initialView ? { initialView: props.initialView } : {}),
  });
  return <InspectorCard {...props} propertyApi={api} />;
}
function InspectorCard<Row>({
  propertyApi: api, storage: _storage, initialView: _initialView, objectType,
  typeLabel, title, subtitle: _subtitle, className, viewScope, shareUrl, shareAction, onClose, closeLabel, compact, ...props
}: ObjectInspectorProps<Row> & { propertyApi: PropertyViewApi }): ReactNode {
  return (
    <section className={`qt-object-inspector${compact ? " qt-object-inspector--compact" : ""}${className ? ` ${className}` : ""}`} aria-label={typeof title === "string" ? title : `${typeLabel ?? props.schema.name} properties`}>
      <PropertyViewControls key={objectType ?? props.schema.name} api={api} schema={props.schema} preview={props}
        shareAction={shareAction ?? (shareUrl ? <ShareButton compact={compact ?? false} getUrl={() => shareUrl(api.view)} /> : undefined)}
        {...(onClose ? { onClose } : {})}
        {...(closeLabel ? { closeLabel } : {})}
        {...(compact !== undefined ? { compact } : {})}
        {...(viewScope ? { scope: viewScope } : {})} />
      {api.loading ? <p className="qt-object-loading qt-muted" role="status">Loading property view…</p> : <ObjectProperties {...props} view={api.view} onViewChange={api.setView} />}
      <footer className="qt-object-footer">
        <span><Icon name="panelList" size={13} />{api.view.properties.length} {api.view.properties.length === 1 ? "property" : "properties"}</span>
        <span>Read only</span>
      </footer>
    </section>
  );
}
