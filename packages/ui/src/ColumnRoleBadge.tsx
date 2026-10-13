/** Presentation metadata supplied by the host, independent of field type. */
export interface ColumnRole {
  kind: "row" | "key" | "aggregate";
  badge: string;
  title: string;
}

/** Role colors inherit the instance's --qt-column-{role}-* CSS tokens. */
export function ColumnRoleBadge({
  role,
  className,
}: {
  role: ColumnRole | undefined;
  className?: string;
}) {
  return role ? (
    <span
      className={`qt-header-role qt-column-role-badge${className ? ` ${className}` : ""}`}
      data-column-role={role.kind}
      title={role.title}
      aria-label={
        role.kind === "row"
          ? "Row value"
          : role.kind === "key"
            ? "Group key"
            : `${role.badge} aggregate`
      }
    >
      {role.badge}
    </span>
  ) : null;
}
