import { useRef, useState } from "react";
import { FieldPicker, Icon, Menu, MenuButton, MenuGroup, MenuItem, MenuSeparator, MenuSubmenu, Popover, type MenuAnchor } from "@pythia-software/query-table-ui";
import { PresentedValueInput } from "../../packages/ui/src/FilterValuePresentation";
import { ModalSurface } from "../../packages/ui/src/AdaptiveOverlay";
import "@pythia-software/query-table-ui/theme.css";
import "./menuDemo.css";

/** A permanent playground for the shared menu primitives and their browser checks. */
export function MenuDemo() {
  const [palette, setPalette] = useState("light");
  const [rtl, setRtl] = useState(false);
  const [dense, setDense] = useState(true);
  const [result, setResult] = useState("Choose an action to try the menu.");
  const [choice, setChoice] = useState("Keep A");
  const [value, setValue] = useState("alpha");
  const [picker, setPicker] = useState(false);
  const [settings, setSettings] = useState(false);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState(false);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; trigger: HTMLElement; long: boolean } | null>(null);
  const open = (trigger: HTMLElement, long = false, point?: { x: number; y: number }) => setMenu({ anchor: point ?? trigger, trigger, long });
  const actions = (long: boolean) => <>
    <div className="qt-cm-header"><span className="qt-cm-field">View actions</span></div>
    <MenuItem icon={<Icon name="copy" />} shortcut="⌘C" onSelect={() => setResult("Copied view")}>Copy view</MenuItem>
    <MenuItem disabled onSelect={() => setResult("Disabled action fired")}>Duplicate view</MenuItem>
    <MenuSeparator />
    <MenuSubmenu label="Display">
      <MenuItem checked={dense} closeOnSelect={false} onSelect={() => setDense(value => !value)}>Compact rows</MenuItem>
      <MenuItem onSelect={() => setResult("Fit columns")}>Fit columns</MenuItem>
      <MenuSubmenu label="Alignment">
        <MenuItem onSelect={() => setResult("Align left")}>Align left</MenuItem>
        <MenuItem onSelect={() => setResult("Align right")}>Align right</MenuItem>
      </MenuSubmenu>
    </MenuSubmenu>
    <MenuSubmenu label="Export">
      <MenuSubmenu label="Spreadsheet">
        <MenuItem onSelect={() => setResult("Export CSV")}>CSV</MenuItem>
        <MenuItem onSelect={() => setResult("Export TSV")}>TSV</MenuItem>
      </MenuSubmenu>
      <MenuItem onSelect={() => setResult("Export text")}>Plain text</MenuItem>
      <MenuItem disabled>Image</MenuItem>
    </MenuSubmenu>
    {long && <>
      <MenuSeparator />
      {Array.from({ length: 40 }, (_, index) => <MenuItem key={index} onSelect={() => setResult(`Selected item ${index + 1}`)}>Item {index + 1}</MenuItem>)}
      <MenuSubmenu label="Last submenu">
        {Array.from({ length: 40 }, (_, index) => <MenuItem key={index} onSelect={() => setResult(`Selected child ${index + 1}`)}>Child {index + 1}</MenuItem>)}
      </MenuSubmenu>
    </>}
    <MenuSeparator />
    <MenuItem tone="danger" onSelect={() => setResult("Removed view")}>Remove view</MenuItem>
  </>;
  const trigger = (label: string, long = false) => <button
    type="button" aria-haspopup="menu" aria-expanded={menu?.trigger.textContent === label}
    onClick={event => menu?.trigger === event.currentTarget ? setMenu(null) : open(event.currentTarget, long)}
    onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); open(event.currentTarget, long); } }}
  >{label}<Icon name="chevronDown" /></button>;
  const menuContent = menu && <Menu label="View actions" anchor={menu.anchor} returnFocus={menu.trigger} onClose={() => setMenu(null)}>{actions(menu.long)}</Menu>;
  return <main className="qt-menu-demo" data-theme={palette} dir={rtl ? "rtl" : "ltr"}>
    <header>
      <a href="/">← Table playground</a>
      <p className="qt-menu-demo-eyebrow">COMPONENT PLAYGROUND</p>
      <h1>Menus, made consistent.</h1>
      <p>Explore nested actions with a mouse, keyboard, or touch.</p>
      <div className="qt-menu-demo-controls">
        <label>Palette <select aria-label="Palette" value={palette} onChange={event => setPalette(event.target.value)}><option value="light">Light</option><option value="dark">Dark</option><option value="warm">Warm</option></select></label>
        <label><input type="checkbox" checked={rtl} onChange={event => setRtl(event.target.checked)} /> Right to left</label>
        <button onClick={() => setDialog(true)}>Open dialog</button>
      </div>
    </header>
    <section className="qt-menu-demo-stage" aria-label="Clipping container">
      <div className="qt-menu-demo-stage-top">{trigger("Left edge")}{trigger("Right edge")}</div>
      <div className="qt-menu-demo-stage-center">{trigger("Open menu")}{trigger("Long menu", true)}</div>
      <div className="qt-menu-demo-stage-bottom">{trigger("Bottom edge")}</div>
      <p>This panel clips its contents. Menus remain visible.</p>
      {dialog ? null : menuContent}
    </section>
    <section className="qt-menu-demo-controls qt-menu-demo-examples" aria-label="Picker and form examples">
      <MenuButton label="Paired actions" trigger="Paired actions" width={300}>
        <MenuGroup label="Match mode" columns={2}>
          {["Keep A", "Exclude A", "Keep B", "Exclude B"].map(label => <MenuItem key={label} checked={choice === label} selectionType="radio"
            tone={label.startsWith("Exclude") ? "danger" : "default"} onSelect={() => { setChoice(label); setResult(label); }}>{label}</MenuItem>)}
        </MenuGroup>
      </MenuButton>
      <button ref={pickerTrigger} aria-haspopup="dialog" aria-expanded={picker} onClick={() => setPicker(previous => !previous)}>Choose field</button>
      {picker && pickerTrigger.current && <FieldPicker anchor={pickerTrigger.current} fields={[
        { name: "name", label: "Name", type: "text", source: { kind: "backend" }, group: "Identity" },
        { name: "email", label: "Email", type: "text", source: { kind: "backend" }, group: "Identity", aliases: ["contact"] },
        { name: "status", label: "Status", type: "enum", source: { kind: "backend" }, group: "Details" },
      ]} onPick={field => { setResult(`Selected ${field.label}`); setPicker(false); }} onClose={() => setPicker(false)} />}
      <PresentedValueInput field="category" value={value} options={[{ value: "alpha", label: "Alpha" }, { value: "beta", label: "Beta" }]}
        onChange={next => { setValue(next); setResult(`Selected ${next}`); }} />
      <button ref={settingsTrigger} aria-haspopup="dialog" aria-expanded={settings} onClick={() => setSettings(previous => !previous)}>Open settings</button>
      {settings && settingsTrigger.current && <Popover anchor={settingsTrigger.current} label="View settings" className="qt-menu-demo-settings" onClose={() => setSettings(false)}>
        <label>View name <input className="qt-input" defaultValue="My view" /></label>
        <label>Description <input className="qt-input" defaultValue="Shared team view" /></label>
        <button className="qt-btn" onClick={() => { setResult("Saved settings"); setSettings(false); }}>Save settings</button>
      </Popover>}
    </section>
    <div className="qt-menu-demo-context" onContextMenu={event => { event.preventDefault(); open(event.currentTarget, false, { x: event.clientX, y: event.clientY }); }} tabIndex={0}
      onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); open(event.currentTarget); } }}>
      Right-click here for a context menu
    </div>
    <p className="qt-menu-demo-result" role="status">{result}</p>
    <p className="qt-menu-demo-help">↑ ↓ navigate · → open submenu · ← return · type to find · Esc close · Tab continue</p>
    {dialog && <ModalSurface title="Menu inside a dialog" onClose={() => { setMenu(null); setDialog(false); }}>
      <div className="qt-overlay-body">{trigger("Dialog actions")}{menuContent}</div>
    </ModalSurface>}
  </main>;
}
